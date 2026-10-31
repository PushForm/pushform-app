// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import {
  ExtensionError, RUNTIME_PROTOCOL_VERSION, measureMessage, methodPermission, runtimeMessageSchema, serviceAvailable,
  type DeactivationReason, type ExtensionErrorData, type ExtensionManifest, type ExtensionPermission,
  type ExtensionServiceName, type RuntimeMessage,
} from '@pushform/extension-protocol';
import type { RuntimePort } from './port';

/**
 * The host side of one extension runtime's lifecycle. The session never runs extension code at load: it waits for
 * the runtime to import the entry module, and activates the extension only when the first invocation needs it.
 * Every message from the runtime is validated before use, and every service request is checked again against the
 * grants, whatever the runtime's own `context` allowed. Cancelled invocations and requests are forgotten at once,
 * so a late result from the extension is dropped.
 *
 * Nothing the runtime sends can name who it is or what it may touch. Its identity is the session that owns the port,
 * and a session belongs to one runtime generation: a restarted runtime gets a new session and port, and the old
 * port is no longer listened to. Documents are reached only through opaque handles this session issued; a handle
 * names one document for as long as that document stays open here, so an invocation keeps acting on its own
 * document when the user switches tabs, and nothing can be guessed or carried over from another extension.
 */

/** What a service method learns about the call besides its input. */
export interface ServiceCall {
  readonly signal: AbortSignal;
  readonly extensionId: string;
  readonly generation: number;
  /**
   * The document a handle from the input names. Throws `permission.denied` for anything this session did not issue,
   * including handles of closed documents, so services never resolve a document id the extension supplied itself.
   */
  document(handle: unknown): string;
  /**
   * Reports progress of this call to the extension: a fraction from 0 to 1 (or null when only a partial result is
   * new), and optionally the best partial result so far. Dropped once the call has ended or been cancelled.
   */
  progress(value: number | null, partial?: unknown): void;
}

/** Implements one host service method for extensions. Must return structured-cloneable data, never live objects. */
export type ServiceMethod = (input: unknown, call: ServiceCall) => unknown;

/** Implementations keyed `service.method`, for example `model.query`. A missing one answers `unavailable`. */
export type ServiceImplementations = Readonly<Partial<Record<`${ExtensionServiceName}.${string}`, ServiceMethod>>>;

export interface SessionLimits {
  /** Time for the runtime to import its entry module. */
  readonly loadMs: number;
  /** Time for `activate(context)` to settle. */
  readonly activateMs: number;
  /** Time for `deactivate()` to settle before the runtime is treated as stopped anyway. */
  readonly deactivateMs: number;
  /** Service requests the runtime may have outstanding at once; more are refused with `limit.exceeded`. */
  readonly maxPendingRequests: number;
  /** Invalid messages tolerated before the session fails as a protocol violation and the runtime is to be ended. */
  readonly maxInvalidMessages: number;
}

export const DEFAULT_SESSION_LIMITS: SessionLimits = {
  loadMs: 10_000, activateMs: 10_000, deactivateMs: 2_000, maxPendingRequests: 32, maxInvalidMessages: 50,
};

export type SessionState = 'loading' | 'loaded' | 'activating' | 'active' | 'deactivating' | 'stopped' | 'failed';

/** Why a session failed, for the failure notice and for terminating the runtime. */
export interface SessionFailure {
  readonly kind: 'load-failed' | 'load-timeout' | 'activation-failed' | 'activation-timeout' | 'protocol-violation';
  readonly error: ExtensionErrorData;
}

export interface ExtensionSessionOptions {
  readonly manifest: ExtensionManifest;
  /** Permissions the user granted to this release; anything the manifest did not request is ignored. */
  readonly grants: Iterable<ExtensionPermission>;
  readonly port: RuntimePort;
  readonly services?: ServiceImplementations;
  readonly limits?: Partial<SessionLimits>;
  readonly onFailure?: (failure: SessionFailure) => void;
  /** The runtime generation this session serves; a restart creates a new session with a new generation. */
  readonly generation?: number;
  /**
   * Runs before the extension activates, after its module loaded, such as migrating its settings to this release.
   * If it fails, activation fails and no extension code runs.
   */
  readonly beforeActivate?: () => Promise<void>;
}

export interface InvokeOptions {
  /** Aborting it cancels the invocation, as the user's Cancel does. */
  readonly signal?: AbortSignal;
  /** Scopes such as `panel:<id>`; `cancelScope` cancels every invocation carrying the scope. */
  readonly scopes?: readonly string[];
  /**
   * The id of the document the invocation acts on. The runtime receives this session's handle for it, never the id,
   * and closing the document (`closeDocument`) cancels the invocation.
   */
  readonly document?: string;
}

let nextGeneration = 1;
const randomHandle = (): string => `doc_${crypto.randomUUID().replaceAll('-', '')}`;

interface PendingInvocation {
  readonly scopes: readonly string[];
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: ExtensionError) => void;
  readonly cancel: () => void;
}

export class ExtensionSession {
  readonly manifest: ExtensionManifest;
  readonly grants: ReadonlySet<ExtensionPermission>;
  readonly generation: number;
  private readonly documentOfHandle = new Map<string, string>();
  private readonly handleOfDocument = new Map<string, string>();
  private readonly port: RuntimePort;
  private readonly services: ServiceImplementations;
  private readonly limits: SessionLimits;
  private readonly onFailure: ((failure: SessionFailure) => void) | undefined;
  private readonly beforeActivate: (() => Promise<void>) | undefined;
  private readonly contributions: ReadonlySet<string>;
  private currentState: SessionState = 'loading';
  private loaded: Promise<void>;
  private activation: Promise<void> | null = null;
  private settleActivation: { resolve(): void; reject(error: ExtensionError): void } | null = null;
  private stopped: { resolve(): void } | null = null;
  private nextInvocation = 1;
  private readonly invocations = new Map<number, PendingInvocation>();
  private readonly requests = new Map<number, AbortController>();
  private readonly unlisten: () => void;
  private readonly loadTimer: ReturnType<typeof setTimeout>;
  /** Messages from the runtime that failed validation and were dropped without effect. */
  invalidMessages = 0;

  constructor(options: ExtensionSessionOptions) {
    this.manifest = options.manifest;
    this.generation = options.generation ?? nextGeneration++;
    const requested = new Set(options.manifest.permissions);
    this.grants = new Set([...options.grants].filter((p) => requested.has(p)));
    this.port = options.port;
    this.services = options.services ?? {};
    this.limits = { ...DEFAULT_SESSION_LIMITS, ...options.limits };
    this.onFailure = options.onFailure;
    this.beforeActivate = options.beforeActivate;
    this.contributions = new Set(options.manifest.contributions.map((c) => c.id));
    let settleLoad!: { resolve(): void; reject(error: ExtensionError): void };
    this.loaded = new Promise<void>((resolve, reject) => { settleLoad = { resolve, reject }; });
    this.loaded.catch(() => {});
    const loadTimer = this.loadTimer = setTimeout(() => this.fail('load-timeout', new ExtensionError('extension.failed', 'The extension did not load in time.'), settleLoad.reject), this.limits.loadMs);
    this.unlisten = this.port.listen((raw) => this.receive(raw, (message) => {
      if (message.type === 'ready' && this.currentState === 'loading') {
        clearTimeout(loadTimer);
        this.currentState = 'loaded';
        settleLoad.resolve();
      } else if (message.type === 'load-failed' && this.currentState === 'loading') {
        clearTimeout(loadTimer);
        this.fail('load-failed', ExtensionError.from(message.error), settleLoad.reject);
      }
    }));
  }

  get state(): SessionState {
    return this.currentState;
  }

  /** Activates the extension if it is not active yet, as the first matching user action or declared event does. */
  activate(): Promise<void> {
    if (this.activation) return this.activation;
    if (this.currentState === 'deactivating' || this.currentState === 'stopped' || this.currentState === 'failed')
      return Promise.reject(new ExtensionError('unavailable', 'The extension is not running.'));
    const prepared = this.loaded.then(async () => {
      if (!this.beforeActivate) return;
      try {
        await this.beforeActivate();
      } catch (error) {
        const failure = error instanceof ExtensionError ? error : new ExtensionError('extension.failed', 'The extension could not be prepared to start.');
        this.fail('activation-failed', failure, () => {});
        throw failure;
      }
    });
    this.activation = prepared.then(() => new Promise<void>((resolve, reject) => {
      this.currentState = 'activating';
      const timer = setTimeout(() => this.fail('activation-timeout', new ExtensionError('extension.failed', 'The extension did not start in time.'), reject), this.limits.activateMs);
      this.settleActivation = {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
      this.port.post({ type: 'activate', v: RUNTIME_PROTOCOL_VERSION, extensionId: this.manifest.id, grants: [...this.grants],
        wasm: this.manifest.wasm.length > 0, contributions: [...this.contributions] });
    }));
    // Callers see a failure through the promise they were given; the shared one must not report it again.
    this.activation.catch(() => {});
    return this.activation;
  }

  /**
   * Runs a contribution's handler, activating the extension first when needed. Resolves with the handler's result
   * or rejects with a structured error; after cancellation it rejects with `cancelled` and ignores any late result.
   */
  async invoke(contributionId: string, params: unknown, options: InvokeOptions = {}): Promise<unknown> {
    if (!this.contributions.has(contributionId))
      throw new ExtensionError('validation.failed', `"${contributionId}" is not a contribution of ${this.manifest.id}.`);
    if (options.signal?.aborted) throw new ExtensionError('cancelled', 'The operation was cancelled.');
    await this.activate();
    if (this.currentState !== 'active') throw new ExtensionError('unavailable', 'The extension is not running.');
    if (options.signal?.aborted) throw new ExtensionError('cancelled', 'The operation was cancelled.');
    const invocation = this.nextInvocation++;
    const scopes = options.document === undefined ? options.scopes ?? [] : [...(options.scopes ?? []), `document:${options.document}`];
    const document = options.document === undefined ? undefined : this.openDocument(options.document);
    return new Promise((resolve, reject) => {
      const onAbort = () => this.cancelInvocation(invocation);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      const done = () => options.signal?.removeEventListener('abort', onAbort);
      this.invocations.set(invocation, {
        scopes,
        resolve: (value) => { done(); resolve(value); },
        reject: (error) => { done(); reject(error); },
        cancel: () => this.port.post({ type: 'cancel', invocation }),
      });
      this.port.post({ type: 'invoke', invocation, contribution: contributionId, params, ...(document === undefined ? {} : { document }) });
    });
  }

  /** Sends a user event on a mounted interface to the runtime; dropped unless the extension is active. */
  postEvent(event: { readonly target: string; readonly component: string; readonly event: string }): void {
    if (this.currentState === 'active') this.port.post({ ...event, type: 'event' });
  }

  /** Cancels every running invocation that carries `scope`, as closing its panel does. */
  cancelScope(scope: string): void {
    for (const [invocation, pending] of this.invocations) if (pending.scopes.includes(scope)) this.cancelInvocation(invocation);
  }

  /** The handle this session uses for `documentId`, issued on first use. Handles are random and per session. */
  openDocument(documentId: string): string {
    let handle = this.handleOfDocument.get(documentId);
    if (handle === undefined) {
      handle = randomHandle();
      this.handleOfDocument.set(documentId, handle);
      this.documentOfHandle.set(handle, documentId);
    }
    return handle;
  }

  /** The document closed: its handle stops resolving, and invocations acting on it are cancelled. */
  closeDocument(documentId: string): void {
    const handle = this.handleOfDocument.get(documentId);
    if (handle !== undefined) {
      this.handleOfDocument.delete(documentId);
      this.documentOfHandle.delete(handle);
    }
    this.cancelScope(`document:${documentId}`);
  }

  private resolveDocument(handle: unknown): string {
    const documentId = typeof handle === 'string' ? this.documentOfHandle.get(handle) : undefined;
    if (documentId === undefined) throw new ExtensionError('permission.denied', 'The document handle is not valid for this extension; the document may have closed.');
    return documentId;
  }

  /**
   * Stops the extension: cancels all invocations and service requests, then lets `deactivate()` run for a bounded
   * time. Resolves `true` when the runtime confirmed, `false` when it did not answer in time and must be terminated.
   */
  async deactivate(reason: DeactivationReason): Promise<boolean> {
    if (this.currentState === 'stopped' || this.currentState === 'failed') return true;
    clearTimeout(this.loadTimer);
    const wasRunning = this.currentState === 'active' || this.currentState === 'activating';
    this.currentState = 'deactivating';
    this.settleActivation?.reject(new ExtensionError('cancelled', 'The extension was stopped while starting.'));
    for (const invocation of [...this.invocations.keys()]) this.cancelInvocation(invocation);
    for (const controller of this.requests.values()) controller.abort();
    this.requests.clear();
    let confirmed = !wasRunning;
    if (wasRunning) {
      confirmed = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), this.limits.deactivateMs);
        this.stopped = { resolve: () => { clearTimeout(timer); resolve(true); } };
        this.port.post({ type: 'deactivate', reason });
      });
    }
    this.currentState = 'stopped';
    this.documentOfHandle.clear();
    this.handleOfDocument.clear();
    this.unlisten();
    this.port.close();
    return confirmed;
  }

  private cancelInvocation(invocation: number): void {
    const pending = this.invocations.get(invocation);
    if (!pending) return;
    this.invocations.delete(invocation);
    pending.cancel();
    pending.reject(new ExtensionError('cancelled', 'The operation was cancelled.'));
  }

  private fail(kind: SessionFailure['kind'], error: ExtensionError, reject: (error: ExtensionError) => void): void {
    if (this.currentState === 'failed' || this.currentState === 'stopped') return;
    this.currentState = 'failed';
    this.documentOfHandle.clear();
    this.handleOfDocument.clear();
    for (const invocation of [...this.invocations.keys()]) this.cancelInvocation(invocation);
    for (const controller of this.requests.values()) controller.abort();
    this.requests.clear();
    reject(error);
    this.unlisten();
    this.onFailure?.({ kind, error: error.toJSON() });
  }

  private receive(raw: unknown, lifecycle: (message: RuntimeMessage) => void): void {
    if (this.currentState === 'stopped' || this.currentState === 'failed') return;
    // Size first, before anything reads the message. An oversized request or result still gets its structured
    // answer, so the extension learns why instead of waiting forever.
    if (measureMessage(raw) === null) {
      this.invalid();
      const fields = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
      const tooLarge = new ExtensionError('limit.exceeded', 'The message is larger than an extension may send.');
      if (fields.type === 'request' && Number.isSafeInteger(fields.id)) this.port.post({ type: 'response', id: fields.id, ok: false, error: tooLarge.toJSON() });
      if (fields.type === 'result' && typeof fields.invocation === 'number') {
        const pending = this.invocations.get(fields.invocation);
        this.invocations.delete(fields.invocation);
        pending?.reject(tooLarge);
      }
      return;
    }
    const parsed = runtimeMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.invalid();
      return;
    }
    const message = parsed.data;
    switch (message.type) {
      case 'ready':
      case 'load-failed':
        lifecycle(message);
        return;
      case 'activated':
        if (this.currentState !== 'activating') return;
        this.currentState = 'active';
        this.settleActivation?.resolve();
        this.settleActivation = null;
        return;
      case 'activation-failed':
        if (this.currentState !== 'activating') return;
        this.fail('activation-failed', ExtensionError.from(message.error), (error) => this.settleActivation?.reject(error));
        return;
      case 'result': {
        const pending = this.invocations.get(message.invocation);
        if (!pending) return;
        this.invocations.delete(message.invocation);
        if (message.ok) pending.resolve(message.value);
        else pending.reject(ExtensionError.from(message.error));
        return;
      }
      case 'request':
        void this.serve(message);
        return;
      case 'cancel-request':
        this.requests.get(message.id)?.abort();
        this.requests.delete(message.id);
        return;
      case 'deactivated':
        this.stopped?.resolve();
        return;
    }
  }

  /** Counts a dropped message; a runtime that keeps sending them is treated as hostile and its session fails. */
  private invalid(): void {
    this.invalidMessages++;
    if (this.invalidMessages === this.limits.maxInvalidMessages)
      this.fail('protocol-violation', new ExtensionError('extension.failed', 'The extension sent too many invalid messages and was stopped.'), () => {});
  }

  private async serve(message: Extract<RuntimeMessage, { type: 'request' }>): Promise<void> {
    const respondError = (error: ExtensionError) => this.port.post({ type: 'response', id: message.id, ok: false, error: error.toJSON() });
    if (this.currentState !== 'active' && this.currentState !== 'activating') return respondError(new ExtensionError('unavailable', 'The extension is not running.'));
    if (this.requests.has(message.id)) return respondError(new ExtensionError('validation.failed', 'A request with this id is already running.'));
    if (this.requests.size >= this.limits.maxPendingRequests)
      return respondError(new ExtensionError('limit.exceeded', `An extension may have at most ${this.limits.maxPendingRequests} host calls running at once.`));
    const permission = methodPermission(message.service, message.method);
    if (permission === undefined) return respondError(new ExtensionError('validation.failed', `There is no ${message.service}.${message.method}.`));
    const service = message.service as ExtensionServiceName;
    if (!serviceAvailable(service, { grants: this.grants, wasm: this.manifest.wasm.length > 0 }) || (permission !== null && !this.grants.has(permission)))
      return respondError(new ExtensionError('permission.denied', `${message.service}.${message.method} needs ${permission ?? 'a declared WASM module'}.`,
        permission ? { permission } : undefined));
    const implementation = this.services[`${service}.${message.method}`];
    if (!implementation) return respondError(new ExtensionError('unavailable', `${message.service}.${message.method} is not available in this version of PushForm.`));
    const controller = new AbortController();
    this.requests.set(message.id, controller);
    let reply: Record<string, unknown>;
    try {
      const result = await implementation(message.input, {
        signal: controller.signal, extensionId: this.manifest.id, generation: this.generation,
        document: (handle) => this.resolveDocument(handle),
        progress: (value, partial) => {
          if (this.requests.get(message.id) !== controller || controller.signal.aborted) return;
          const update = { type: 'progress', id: message.id, value: value === null ? null : Math.min(1, Math.max(0, value)), ...(partial === undefined ? {} : { partial }) };
          if (measureMessage(update) !== null) this.port.post(update);
        },
      });
      reply = { type: 'response', id: message.id, ok: true, result: result ?? null };
    } catch (error) {
      const failure = error instanceof ExtensionError ? error : new ExtensionError('unavailable', 'The host could not complete the request.');
      reply = { type: 'response', id: message.id, ok: false, error: failure.toJSON() };
    }
    // A cancelled request's late result is dropped, as is anything finishing after the session stopped.
    if (!this.requests.delete(message.id) || controller.signal.aborted) return;
    this.port.post(reply);
  }
}
