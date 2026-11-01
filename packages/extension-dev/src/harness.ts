// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import {
  ExtensionError, extensionManifestSchema, type DocumentUnits, type ExtensionManifest, type ExtensionManifestInput, type ExtensionPermission,
  type UiEvent, type UiNode,
} from '@pushform/extension-protocol';
import {
  ComputeHost, ExtensionDocumentHost, ExtensionSession, type DocumentChange, type ExtensionDocument, type ExtensionDocuments,
  type ExtensionModelAccess, ExtensionSettingsHost, ExtensionUiHost, FetchBroker, UNNAMED_DOCUMENT, clipboardServices, fileServices, memorySettingsStore,
  vectorExportServices, vectorPrintServices, messagePortTransport, runComputeWorker, startGuest, type FetchTransport, type FilePicker, type ViewPrinter,
  type InvokeOptions, type ServiceImplementations, type SettingsStore, type SpawnComputeWorker,
} from '@pushform/extensions';

/**
 * A test host for an extension: its real entry module runs through the same lifecycle, message validation,
 * permission checks and interface, settings, compute, file, clipboard and network hosts as in PushForm, connected
 * over a MessageChannel in the same process. What the isolated runtime adds in the app (its sandbox, content
 * security policy and lockdown) is not reproduced here. Host services the harness does not provide, such as the
 * model, can be supplied as fakes through `services`.
 *
 * With `document`, the harness opens one document that invocations act on by default, and the `model`, `selection`
 * and `document` services reach it through the same handles, permission checks and validation as in PushForm. Its
 * model is a fake the test supplies; `documents` replaces the whole set of open documents.
 */

/** A document for the test host: its units, and a fake of the model operations the extension calls. */
export interface TestDocumentOptions {
  /** The id `invoke` passes; `"test-document"` by default. */
  readonly id?: string;
  /** The document's name as the user sees it; `"Untitled"` by default. */
  readonly name?: string;
  /** Millimeters, decimal, one place, by default. */
  readonly units?: DocumentUnits;
  /**
   * The model operations; methods left out answer `unavailable`. Without `model` the document is not a 3D model, as
   * a Layout document is not.
   */
  readonly model?: Partial<ExtensionModelAccess>;
}

/** The test host's document, for changing it from the test. */
export interface TestDocument {
  readonly id: string;
  /** Renames the document; the extension hears of it through `context.document.onChange`. */
  setName(name: string): void;
  /** Changes the units; the extension hears of it through `context.document.onUnitsChange` and `onChange`. */
  setUnits(units: DocumentUnits): void;
  /** Reports that the model or the selection changed, as an edit by the user would. */
  changed(change: 'model' | 'selection'): void;
  /** Closes the document: its handles stop working and invocations on it are cancelled. */
  close(): void;
}

export const TEST_DOCUMENT_UNITS: DocumentUnits = { system: 'metric', lengthUnit: 'mm', format: 'decimal', lengthPrecision: 1 };

export interface TestHostOptions {
  /** The manifest, as in `manifest.json`; the `files` list may be left out. */
  readonly manifest: Omit<ExtensionManifestInput, 'files'> & { files?: Record<string, string> };
  /** The entry module, as imported by the test (`await import('./dist/main.js')`). */
  readonly module: unknown;
  /** Permissions granted; all the manifest requests by default. */
  readonly grants?: readonly ExtensionPermission[];
  /** Package files, needed for WebAssembly modules. */
  readonly files?: ReadonlyMap<string, Uint8Array>;
  /** Further host services, or replacements, keyed `service.method`. */
  readonly services?: ServiceImplementations;
  readonly settings?: SettingsStore;
  /** Answers file prompts; by default every prompt is declined. */
  readonly picker?: FilePicker;
  /** Answers print requests; by default printing answers unavailable. */
  readonly printer?: ViewPrinter;
  /** Performs network requests that pass the broker's checks; by default requests answer unavailable. */
  readonly fetch?: FetchTransport;
  /** Opens one document that invocations act on by default. */
  readonly document?: TestDocumentOptions;
  /** The open documents, replacing `document`. */
  readonly documents?: ExtensionDocuments;
}

export interface TestHost {
  readonly manifest: ExtensionManifest;
  readonly session: ExtensionSession;
  readonly ui: ExtensionUiHost;
  /** Lines the extension wrote with `context.log.write`. */
  readonly logs: unknown[];
  /** What the extension wrote to the clipboard. */
  readonly clipboard: { text?: string; html?: string; png?: Uint8Array }[];
  /** The document opened with the `document` option, or null. */
  readonly document: TestDocument | null;
  /** Runs a contribution, as a user-started action by default, on the test document when there is one. */
  invoke(contributionId: string, params?: unknown, options?: InvokeOptions): Promise<unknown>;
  /** The tree the extension shows for a target, if any. */
  tree(target: string): UiNode | undefined;
  /** Sends user input on a mounted interface; false when it does not fit the tree shown. */
  dispatch(target: string, event: UiEvent): boolean;
  /** Presses a button. */
  press(target: string, component: string): boolean;
  /** Stops the extension, running its deactivate. */
  close(): Promise<void>;
}

/** Compute workers in this process. Fine for tests; a module that never returns blocks the test. */
const inProcessCompute: SpawnComputeWorker = async () => {
  const channel = new MessageChannel();
  runComputeWorker({
    post: (message, transfer) => channel.port2.postMessage(message, transfer ?? []),
    listen: (handler) => { channel.port2.onmessage = (e) => handler(e.data); },
  });
  return {
    post: (message, transfer) => channel.port1.postMessage(message, transfer ?? []),
    listen: (handler) => { channel.port1.onmessage = (e) => handler(e.data); },
    terminate: () => { channel.port1.close(); channel.port2.close(); },
  };
};

const declining: FilePicker = { open: async () => null, save: async () => null };

function fakeDocument(options: TestDocumentOptions): ExtensionDocument & { setName(name: string): void; setUnits(units: DocumentUnits): void; emit(change: DocumentChange): void } {
  let units = options.units ?? TEST_DOCUMENT_UNITS;
  let name = options.name ?? UNNAMED_DOCUMENT;
  const listeners = new Set<(change: DocumentChange) => void>();
  const fake = options.model;
  const missing = (name: string) => () => { throw new ExtensionError('unavailable', `The test document's model has no ${name}.`); };
  const model: ExtensionModelAccess | null = fake ? {
    get revision() { return fake.revision ?? 0; },
    getDocument: fake.getDocument?.bind(fake) ?? missing('getDocument'),
    query: fake.query?.bind(fake) ?? missing('query'),
    apply: fake.apply?.bind(fake) ?? (async () => missing('apply')()),
    selection: fake.selection?.bind(fake) ?? missing('selection'),
    select: fake.select?.bind(fake) ?? missing('select'),
    frame: fake.frame?.bind(fake) ?? missing('frame'),
  } : null;
  return {
    name: () => name,
    units: () => units,
    model: () => model,
    listen(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setName(next) { name = next; for (const listener of [...listeners]) listener('name'); },
    setUnits(next) { units = next; for (const listener of [...listeners]) listener('units'); },
    emit(change) { for (const listener of [...listeners]) listener(change); },
  };
}

export async function createTestHost(options: TestHostOptions): Promise<TestHost> {
  const manifest = extensionManifestSchema.parse({ ...options.manifest, files: options.manifest.files ?? {} });
  const grants = new Set(options.grants ?? manifest.permissions);
  const channel = new MessageChannel();
  const logs: unknown[] = [];
  const clipboard: TestHost['clipboard'] = [];
  const ref: { session?: ExtensionSession } = {};
  const documentId = options.document ? options.document.id ?? 'test-document' : null;
  const opened = options.document ? fakeDocument(options.document) : null;
  let open = true;
  const documents: ExtensionDocuments | null = options.documents
    ?? (opened ? { get: (id) => (open && id === documentId ? opened : null) } : null);
  const documentHost = documents
    ? new ExtensionDocumentHost({ manifest, grants, documents, session: () => ref.session, coalesceMs: 0 }) : null;
  const ui = new ExtensionUiHost(manifest, (event) => ref.session?.postEvent(event));
  const settings = new ExtensionSettingsHost(manifest, options.settings ?? memorySettingsStore());
  const compute = manifest.wasm.length ? new ComputeHost({ manifest, files: options.files ?? new Map(), spawn: inProcessCompute }) : null;
  const services: ServiceImplementations = {
    ...ui.services(),
    ...settings.services(),
    ...(compute?.services() ?? {}),
    ...fileServices(manifest, options.picker ?? declining),
    ...vectorExportServices(manifest, () => ui, options.picker ?? declining),
    ...vectorPrintServices(manifest, () => ui, options.printer ?? null),
    ...clipboardServices({ write: async (items) => { clipboard.push(items); } }),
    ...new FetchBroker(manifest, grants, options.fetch ?? null).services(),
    'log.write': (input) => { logs.push(input); return null; },
    ...documentHost?.services(),
    ...options.services,
  };
  const session = ref.session = new ExtensionSession({
    manifest, grants, port: messagePortTransport(channel.port1), services, beforeActivate: () => settings.prepare(),
    ...(documentHost ? { onDocument: (id: string) => documentHost.documentChanged(id) } : {}),
  });
  const document: TestDocument | null = opened && documentId !== null ? {
    id: documentId,
    setName: (name) => opened.setName(name),
    setUnits: (units) => opened.setUnits(units),
    changed: (change) => opened.emit(change),
    close() {
      open = false;
      session.closeDocument(documentId);
      documentHost?.closed(documentId);
    },
  } : null;
  void startGuest(messagePortTransport(channel.port2), async () => options.module);
  return {
    manifest, session, ui, logs, clipboard, document,
    invoke: (id, params = {}, invokeOptions = {}) => session.invoke(id, params,
      { userAction: true, ...(documentId !== null && open ? { document: documentId } : {}), ...invokeOptions }),
    tree: (target) => ui.get(target)?.tree,
    dispatch: (target, event) => ui.dispatch(target, event),
    press: (target, component) => ui.dispatch(target, { component, event: 'press' }),
    async close() {
      await session.deactivate('shutdown');
      documentHost?.dispose();
      compute?.terminateAll();
      channel.port1.close();
      channel.port2.close();
    },
  };
}
