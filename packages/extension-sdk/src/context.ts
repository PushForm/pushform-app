// SPDX-License-Identifier: MIT
// Copyright 2026 PushForm contributors
import type { UiEventOnTarget, UiNode } from './ui.ts';

/**
 * What an extension's entry module receives. The module exports `activate(context)` and, optionally,
 * `deactivate()`; nothing else is called. Every host service is reached through `context`, and a service is present
 * only when the user granted the permission it needs: reading a missing one throws a `permission.denied` error
 * naming the permissions to request. Every call is asynchronous, takes and returns plain data, and fails with an
 * `ExtensionErrorData`-shaped error.
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

/** Model and selection services take and return plain data; their shapes are described with the model operations. */
export type DataService<M extends string> = Readonly<Record<M, (input?: unknown, options?: CallOptions) => Promise<unknown>>>;

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
  readonly model?: DataService<'read' | 'query' | 'subscribe' | 'apply'>;
  readonly selection?: DataService<'get' | 'set' | 'frame'>;
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
