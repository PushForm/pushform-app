// SPDX-License-Identifier: MIT
// Copyright 2026 PushForm contributors
import type {
  DocumentUnits, DocumentUnitsEvent, ModelBatch, ModelBatchResult, ModelChangeEvent, ModelDocumentSnapshot, ModelQuery, ModelQueryResult,
  ModelRef, ModelRefInput,
} from './model.ts';
import type { UiEventOnTarget, UiNode, UiPrintRequest } from './ui.ts';

/**
 * What an extension's entry module receives. The module exports `activate(context)` and, optionally,
 * `deactivate()`; nothing else is called. Every host service is reached through `context`, and a service is present
 * only when the user granted the permission it needs: reading a missing one throws a `permission.denied` error
 * naming the permissions to request. Every call is asynchronous, takes and returns plain data, and fails with an
 * `ExtensionErrorData`-shaped error.
 *
 * `model`, `selection` and `document` act on one open document. Pass `document`, the handle a contribution handler
 * receives, to name it; without one, a call acts on the document of the extension's latest invocation that acted on
 * one, which for a panel is the document it is shown with. A handle stays bound to its document when the user switches
 * tabs; once that document closes, calls with it fail with `document.closed`.
 */

/** Permissions an extension can request in its manifest. */
export type ExtensionPermission = 'model.read' | 'model.write' | 'selection.read' | 'selection.write' | 'tool.interaction'
  | 'viewport.presentation' | 'file.read' | 'file.export' | 'settings' | 'clipboard.write' | 'network' | 'model.egress';

/** Options every host call accepts. */
export interface CallOptions {
  /** Abort to cancel the call; pass the invocation's signal so the call ends when the user cancels. */
  readonly signal?: AbortSignal;
  /** Progress of long calls such as compute jobs: a fraction (or null) and the best partial result so far. */
  readonly onProgress?: (update: { value: number | null; partial?: unknown }) => void;
}

/** Passed to each contribution handler with its parameters. */
export interface InvocationContext {
  /** Aborted when the user cancels, the panel or document closes, or the extension is stopped. */
  readonly signal: AbortSignal;
  /** The handle of the document this invocation acts on. Pass it to model calls; it stays bound to that document. */
  readonly document?: string;
}

export type ContributionHandler = (params: unknown, invocation: InvocationContext) => unknown;

export interface UiService {
  /** Shows `tree` for one of the extension's panel, inspector or settings contributions. */
  mount(input: { target: string; seq: number; tree: UiNode }, options?: CallOptions): Promise<{ seq: number }>;
  /** Replaces the tree; `seq` must be higher than the one shown, or the shown tree is kept and the call fails. */
  update(input: { target: string; seq: number; tree: UiNode }, options?: CallOptions): Promise<{ seq: number }>;
  unmount(input: { target: string }, options?: CallOptions): Promise<null>;
  /**
   * Saves a vector view that is on screen as SVG or DXF where the user chooses, after PushForm's prompt states
   * `purpose`. PushForm writes the file from the drawing itself. Needs `file.export`; declining fails with `cancelled`.
   */
  export(input: { target: string; component: string; format: 'svg' | 'dxf'; purpose: string; suggestedName?: string }, options?: CallOptions): Promise<{ name: string }>;
  /**
   * Prints components that are on screen at `page` size in meters, or saves them as a PDF, as the user chooses in
   * PushForm's dialog, which states `purpose`. Vector views print one page each: at their real size, centered, when
   * they fit, and scaled down to fit when not. Tables and text flow over as many pages as they need; see
   * `UiPrintRequest`. Needs `file.export`; cancelling fails with `cancelled`.
   */
  print(input: UiPrintRequest, options?: CallOptions): Promise<{ outcome: 'printed' | 'saved' }>;
  /** Listens for user input on mounted interfaces; returns a function that stops listening. */
  onEvent(handler: (event: UiEventOnTarget) => void): () => void;
}

export interface SettingsService {
  /** The extension's settings: the manifest's defaults overlaid with what is stored. */
  get(input?: undefined, options?: CallOptions): Promise<Record<string, unknown>>;
  /**
   * Replaces the stored settings (a plain JSON object of at most 64 KiB) and returns the result. Fails with
   * `revision.stale` if they changed on another device since they were read; read again and retry.
   */
  set(input: { value: Record<string, unknown> }, options?: CallOptions): Promise<Record<string, unknown>>;
}

export interface FileTypeFilter {
  description: string;
  /** Extensions without the dot, such as `csv`. */
  extensions: string[];
}

export interface FilesService {
  /** Asks the user for one file; fails with `cancelled` if they decline. No path is ever revealed. */
  open(input: { purpose: string; accept?: FileTypeFilter[] }, options?: CallOptions): Promise<{ name: string; type: string; data: Uint8Array }>;
  /** Asks the user where to save `data`; fails with `cancelled` if they decline. */
  save(input: { purpose: string; accept?: FileTypeFilter[]; suggestedName?: string; data: string | Uint8Array }, options?: CallOptions): Promise<{ name: string }>;
}

export interface ClipboardService {
  /** Writes to the clipboard; allowed only right after the user acted on the extension. Reading is not offered. */
  write(input: { text?: string; html?: string; png?: Uint8Array }, options?: CallOptions): Promise<null>;
}

export interface HttpService {
  /** A request to a destination the manifest declares and the user granted. */
  fetch(input: {
    url: string;
    method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    headers?: Record<string, string>;
    body?: string | Uint8Array;
  }, options?: CallOptions): Promise<{ status: number; url: string; headers: Record<string, string>; body: Uint8Array }>;
}

/** Input to a WebAssembly module: bytes, or JSON sent as UTF-8; the output comes back in the same form. */
export type ComputeInput = { data: Uint8Array | ArrayBuffer; json?: never } | { json: unknown; data?: never };

export interface ComputeService {
  /** Runs a declared WebAssembly module once, in its own worker, within its declared memory and time limits. */
  run(input: { module: string } & ComputeInput, options?: CallOptions): Promise<unknown>;
}

export interface WasmService {
  /** Loads a declared module and keeps it loaded, with its state, across calls. */
  load(input: { module: string }, options?: CallOptions): Promise<{ instance: string }>;
  call(input: { instance: string } & ComputeInput, options?: CallOptions): Promise<unknown>;
  unload(input: { instance: string }, options?: CallOptions): Promise<null>;
}

/** A service that takes and returns plain data. */
export type DataService<M extends string> = Readonly<Record<M, (input?: unknown, options?: CallOptions) => Promise<unknown>>>;

/** Names the document a call acts on; see `ExtensionContext`. */
export interface DocumentTarget {
  /** The handle from `InvocationContext.document`. Default: the document of the latest invocation. */
  document?: string | undefined;
}

/** The 3D model. Every method but `apply` needs `model.read`; `apply` needs `model.write`. */
export interface ModelService {
  /** The document's revision, units, open container, definitions with bounds, tags, materials, scenes and camera. */
  read(input?: DocumentTarget, options?: CallOptions): Promise<ModelDocumentSnapshot>;
  /** One page of a container's entities. Fields left out are null: the open container, every kind but faces, 50 entities. */
  query(input: Partial<ModelQuery> & DocumentTarget, options?: CallOptions): Promise<ModelQueryResult>;
  /**
   * Applies a batch atomically as one undo entry named after the extension. Fails with `revision.stale` when the
   * model changed since `expectedRevision`, and `validation.failed` for an operation that cannot apply; `details`
   * carries the model's own error code and the failing operation's index. Nothing changes when a batch fails.
   */
  apply(input: ModelBatch & DocumentTarget, options?: CallOptions): Promise<ModelBatchResult>;
  /** Asks to be told about changes to the document through `onChange`, until it closes. */
  subscribe(input?: DocumentTarget, options?: CallOptions): Promise<{ document: string; revision: number }>;
  /** Listens for changes to subscribed documents, at most one event per document every 50 ms; returns a function that stops. */
  onChange(handler: (event: ModelChangeEvent) => void): () => void;
}

/** The selection, as model references in the container open in the editor. */
export interface SelectionService {
  /** Needs `selection.read`. */
  get(input?: DocumentTarget, options?: CallOptions): Promise<{ refs: ModelRef[] }>;
  /** Replaces the selection; an empty list clears it. Needs `selection.write`. Returns the selection now. */
  set(input: { refs: ModelRefInput[] } & DocumentTarget, options?: CallOptions): Promise<{ refs: ModelRef[] }>;
  /** Frames the camera on the entities, keeping the view direction. Needs `viewport.presentation`. */
  frame(input: { refs: ModelRefInput[] } & DocumentTarget, options?: CallOptions): Promise<null>;
}

/** The document itself; needs no permission. */
export interface DocumentService {
  /** The units PushForm shows this document's lengths in. Format quantities with them; values stay meters. */
  units(input?: DocumentTarget, options?: CallOptions): Promise<DocumentUnits>;
  /** Told when the units change, or when the extension starts acting on another document; returns a function that stops. */
  onUnitsChange(handler: (event: DocumentUnitsEvent) => void): () => void;
}

export interface ExtensionContext {
  readonly extensionId: string;
  readonly commands: {
    /** Registers the handler for a contribution declared in the manifest. */
    register(contributionId: string, handler: ContributionHandler): void;
  };
  /** Aborted when the extension is stopped. */
  readonly signal: AbortSignal;
  readonly ui: UiService;
  readonly log: DataService<'write'>;
  readonly document: DocumentService;
  /** Present with `model.read` or `model.write`. */
  readonly model?: ModelService;
  /** Present with `selection.read`, `selection.write` or `viewport.presentation`. */
  readonly selection?: SelectionService;
  readonly settings?: SettingsService;
  readonly files?: FilesService;
  readonly clipboard?: ClipboardService;
  readonly http?: HttpService;
  /** Present when the manifest declares WebAssembly modules. */
  readonly compute?: ComputeService;
  readonly wasm?: WasmService;
}

/** The shape of an extension's entry module. */
export interface ExtensionModule {
  activate(context: ExtensionContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
