// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { hostOf, type CommandRegistry } from '@pushform/commands';
import {
  ExtensionError, HOST_EVENTS, documentHandleSchema, documentTargetSchema, modelBatchSchema, modelQuerySchema, selectionFrameSchema,
  selectionSetSchema, type DocumentUnits, type DocumentUnitsEvent, type ExtensionErrorCode, type ExtensionManifest, type ExtensionPermission,
  type ModelApiErrorCode, type ModelBatchResult, type ModelChangeEvent, type ModelDocumentSnapshot, type ModelQuery, type ModelQueryResult,
  type ModelRef, type ModelRefInput,
} from '@pushform/extension-protocol';
import type { UnitSettings } from '@pushform/core';
import { ModelApiFailure, ModelDocumentApi } from '../modelApi';
import type { ExtensionSession, ServiceCall, ServiceImplementations } from './host';

/**
 * The document services of one extension session: `model`, `selection` and `document`. Each call acts on one open
 * document, named by an invocation's handle or, without one, the document of the extension's latest invocation; the
 * session resolves it, so an extension can never name a document by id. The model operations are those of the model
 * document API, with the same validation and bounds; a batch is one undo entry named after the extension.
 *
 * The session also tells the extension about changes, as host events: the units of any document it acted on, when
 * they change or when it starts acting on another document, and model and selection changes of documents it
 * subscribed to. Events are coalesced, and stop when the document closes or the session ends.
 */

/** The model operations of one open model, as the services use them. `ModelDocumentApi` is the real one. */
export interface ExtensionModelAccess {
  readonly revision: number;
  getDocument(): ModelDocumentSnapshot;
  query(input: ModelQuery): ModelQueryResult;
  /** Validates and applies a batch as one undo entry. */
  apply(input: unknown, signal?: AbortSignal): Promise<ModelBatchResult>;
  selection(): ModelRef[];
  /** Replaces the selection; returns it as it is now. */
  select(refs: readonly ModelRefInput[]): ModelRef[];
  /** Frames the camera on the entities. */
  frame(refs: readonly ModelRefInput[]): unknown;
}

export type DocumentChange = 'model' | 'selection' | 'units';

/** One open document as extensions reach it. */
export interface ExtensionDocument {
  /** The units PushForm formats this document's quantities in. */
  units(): DocumentUnits;
  /** The model operations, acting for `client` (the name undo entries carry); null when it is not a 3D model. */
  model(client: string): ExtensionModelAccess | null;
  /** Calls `listener` after each change; returns a function that stops listening. */
  listen(listener: (change: DocumentChange) => void): () => void;
}

/** The open documents, by the ids the host passes to `invoke`. */
export interface ExtensionDocuments {
  /** The document with this id, or null when it is not open. */
  get(documentId: string): ExtensionDocument | null;
}

/** How long changes are gathered into one event, so a burst of edits is one notification. */
export const DOCUMENT_EVENT_COALESCE_MS = 50;

const METRIC = new Set(['mm', 'cm', 'm']);

/** The units extensions see for a document's unit settings. Yards, which extensions do not offer, read as feet. */
export function documentUnitsOf(units: Pick<UnitSettings, 'format' | 'lengthUnit' | 'lengthPrecision'>): DocumentUnits {
  const lengthUnit = units.lengthUnit === 'yd' ? 'ft' : units.lengthUnit;
  return { system: METRIC.has(lengthUnit) ? 'metric' : 'imperial', lengthUnit, format: units.format, lengthPrecision: units.lengthPrecision };
}

const sameUnits = (a: DocumentUnits, b: DocumentUnits): boolean =>
  a.system === b.system && a.lengthUnit === b.lengthUnit && a.format === b.format && a.lengthPrecision === b.lengthPrecision;

/** The open model of a command registry, as extensions reach it. */
export function commandsDocument(commands: CommandRegistry): ExtensionDocument {
  const host = hostOf(commands.ctx);
  const units = () => documentUnitsOf(host.doc.state.meta.units);
  return {
    units,
    model: (client) => new ModelDocumentApi(commands, client),
    listen(listener) {
      let shown = units();
      const offDocument = host.doc.events.on('change', () => {
        listener('model');
        const now = units();
        if (!sameUnits(now, shown)) { shown = now; listener('units'); }
      });
      const offSelection = host.selection.events.on('change', () => listener('selection'));
      return () => { offDocument(); offSelection(); };
    },
  };
}

const MODEL_ERROR_CODES: Partial<Record<ModelApiErrorCode, ExtensionErrorCode>> = {
  stale_revision: 'revision.stale', limit_exceeded: 'limit.exceeded', unavailable: 'unavailable', cancelled: 'cancelled',
};

/** A model API failure as an extension error; the model's own code, revision and operation index go in `details`. */
function extensionFailure(cause: unknown): unknown {
  if (!(cause instanceof ModelApiFailure)) return cause;
  const { code, message, revision, operationIndex } = cause.error;
  return new ExtensionError(MODEL_ERROR_CODES[code] ?? 'validation.failed', message,
    { modelCode: code, revision, ...(operationIndex === undefined ? {} : { operationIndex }) });
}

const zodMessage = (error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string =>
  error.issues.slice(0, 5).map((i) => `${i.path.map(String).join('.') || 'input'}: ${i.message}`).join('; ');

function parse<T>(schema: { safeParse(input: unknown): { success: true; data: T } | { success: false; error: { issues: readonly { code?: string; path: readonly PropertyKey[]; message: string }[] } } }, input: unknown, call: string): T {
  const parsed = schema.safeParse(input ?? {});
  if (parsed.success) return parsed.data;
  const tooBig = parsed.error.issues.some((i) => i.code === 'too_big');
  throw new ExtensionError(tooBig ? 'limit.exceeded' : 'validation.failed', `${call}: ${zodMessage(parsed.error)}`);
}

const queryInputSchema = modelQuerySchema.extend({ document: documentHandleSchema.optional() }).strict();
const QUERY_FIELDS = Object.keys(modelQuerySchema.shape);
const batchInputSchema = modelBatchSchema.extend({ document: documentHandleSchema.optional() }).strict();

interface Watch {
  stop: () => void;
  subscribed: boolean;
  readonly pending: Set<'model' | 'selection'>;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface ExtensionDocumentHostOptions {
  readonly manifest: ExtensionManifest;
  readonly grants: ReadonlySet<ExtensionPermission>;
  readonly documents: ExtensionDocuments;
  /** The session the services belong to, once it exists. */
  readonly session: () => ExtensionSession | undefined;
  readonly coalesceMs?: number;
}

export class ExtensionDocumentHost {
  private readonly watches = new Map<string, Watch>();
  private disposed = false;

  constructor(private readonly options: ExtensionDocumentHostOptions) {}

  services(): ServiceImplementations {
    return {
      'model.read': (input, call) => {
        const { document } = this.target(parse(documentTargetSchema, input, 'model.read'), call);
        const snapshot = this.model(document).getDocument();
        // The selection is for extensions that may read it.
        return this.options.grants.has('selection.read') ? snapshot : { ...snapshot, selection: [] };
      },
      'model.query': (input, call) => {
        // Fields left out read as null, the schema's defaults.
        const given = input ?? {};
        const filled = typeof given === 'object' && given !== null && !Array.isArray(given)
          ? Object.fromEntries([...QUERY_FIELDS.map((key) => [key, null] as const), ...Object.entries(given)]) : given;
        const { document: _handle, ...query } = parse(queryInputSchema, filled, 'model.query');
        const { document } = this.target(input, call);
        return this.attempt(() => this.model(document).query(query));
      },
      'model.apply': async (input, call) => {
        const { document: _handle, ...batch } = parse(batchInputSchema, input, 'model.apply');
        const { document } = this.target(input, call);
        try {
          return await this.model(document).apply(batch, call.signal);
        } catch (cause) {
          throw extensionFailure(cause);
        }
      },
      'model.subscribe': (input, call) => {
        const { id, document } = this.target(parse(documentTargetSchema, input, 'model.subscribe'), call);
        const revision = this.model(document).revision;
        this.watches.get(id)!.subscribed = true;
        return { document: this.handle(id), revision };
      },
      'selection.get': (input, call) => {
        const { document } = this.target(parse(documentTargetSchema, input, 'selection.get'), call);
        return { refs: this.model(document).selection() };
      },
      'selection.set': (input, call) => {
        const { refs } = parse(selectionSetSchema, input, 'selection.set');
        const { document } = this.target(input, call);
        return this.attempt(() => ({ refs: this.model(document).select(refs) }));
      },
      'selection.frame': (input, call) => {
        const { refs } = parse(selectionFrameSchema, input, 'selection.frame');
        const { document } = this.target(input, call);
        this.attempt(() => this.model(document).frame(refs));
        return null;
      },
      'document.units': (input, call) => {
        const { document } = this.target(parse(documentTargetSchema, input, 'document.units'), call);
        return document.units();
      },
    };
  }

  /**
   * The extension started acting on `documentId` (the session's `onDocument`): it hears that document's units, and
   * from now on about changes to them.
   */
  documentChanged(documentId: string): void {
    const document = this.options.documents.get(documentId);
    if (!document) return;
    this.watch(documentId, document);
    this.sendUnits(documentId, document.units());
  }

  /** The document closed: no more events about it. */
  closed(documentId: string): void {
    const watch = this.watches.get(documentId);
    if (!watch) return;
    this.watches.delete(documentId);
    watch.stop();
    if (watch.timer !== null) clearTimeout(watch.timer);
  }

  /** The session ended. */
  dispose(): void {
    this.disposed = true;
    for (const id of [...this.watches.keys()]) this.closed(id);
  }

  private target(input: unknown, call: ServiceCall): { id: string; document: ExtensionDocument } {
    const handle = typeof input === 'object' && input !== null ? (input as { document?: unknown }).document : undefined;
    const id = handle === undefined ? call.currentDocument() : call.document(handle);
    const document = this.options.documents.get(id);
    if (!document) throw new ExtensionError('document.closed', 'The document has closed.');
    this.watch(id, document);
    return { id, document };
  }

  private model(document: ExtensionDocument) {
    const model = document.model(this.options.manifest.name);
    if (!model) throw new ExtensionError('unavailable', 'This document is not a 3D model.');
    return model;
  }

  private attempt<T>(run: () => T): T {
    try {
      return run();
    } catch (cause) {
      throw extensionFailure(cause);
    }
  }

  private handle(documentId: string): string {
    const session = this.options.session();
    if (!session) throw new ExtensionError('unavailable', 'The extension is not running.');
    return session.openDocument(documentId);
  }

  private watch(documentId: string, document: ExtensionDocument): void {
    if (this.disposed || this.watches.has(documentId)) return;
    const watch: Watch = { subscribed: false, pending: new Set(), timer: null, stop: () => {} };
    this.watches.set(documentId, watch);
    const stop = document.listen((change) => {
      if (this.watches.get(documentId) !== watch) return;
      if (change === 'units') return this.sendUnits(documentId, document.units());
      if (!watch.subscribed || (change === 'selection' && !this.options.grants.has('selection.read'))) return;
      watch.pending.add(change);
      watch.timer ??= setTimeout(() => {
        watch.timer = null;
        const changes = [...watch.pending];
        watch.pending.clear();
        const session = this.options.session(), model = document.model(this.options.manifest.name);
        if (!session || session.state !== 'active' || !model || this.watches.get(documentId) !== watch) return;
        const event: ModelChangeEvent = { document: session.openDocument(documentId), revision: model.revision, changes };
        session.notify(HOST_EVENTS.modelChange.component, HOST_EVENTS.modelChange.event, { ...event });
      }, this.options.coalesceMs ?? DOCUMENT_EVENT_COALESCE_MS);
    });
    watch.stop = stop;
  }

  private sendUnits(documentId: string, units: DocumentUnits): void {
    const session = this.options.session();
    if (!session || session.state !== 'active') return;
    const event: DocumentUnitsEvent = { document: session.openDocument(documentId), units };
    session.notify(HOST_EVENTS.units.component, HOST_EVENTS.units.event, { ...event });
  }
}
