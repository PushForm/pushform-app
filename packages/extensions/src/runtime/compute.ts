// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { ExtensionError, type ExtensionManifest } from '@pushform/extension-protocol';
import type { ServiceCall, ServiceImplementations } from './host';

/**
 * The host side of extension compute. Each job runs in its own compute worker, never in the extension's runtime or
 * on the editor's thread, from the module bytes of the verified package. The host enforces the module's declared
 * time limit by ending the worker, refuses jobs beyond a small concurrency limit, and relays the module's progress
 * and partial results to the extension while it runs.
 *
 * - `compute.run({ module, data | json })`: a one-shot job in a fresh worker, ended afterwards.
 * - `wasm.load({ module })` → `{ instance }`, then `wasm.call({ instance, data | json })` and `wasm.unload({ instance })`:
 *   a module kept loaded across calls, in its own worker, for state that is expensive to rebuild.
 *
 * Input is bytes (`data`, a Uint8Array or ArrayBuffer) or `json`, sent as UTF-8; the output comes back in the same
 * form. Output that is not valid JSON for a JSON call fails with `validation.failed`.
 */

/** A compute worker as the host sees it. `terminate` ends it at once, whatever the module is doing. */
export interface ComputeWorkerHandle {
  post(message: unknown, transfer?: Transferable[]): void;
  listen(handler: (message: unknown) => void): void;
  terminate(): void;
}

/** Starts a new compute worker. On the web it runs inside the extension's sandbox (see `webRuntime.ts`). */
export type SpawnComputeWorker = () => Promise<ComputeWorkerHandle>;

export interface ComputeHostOptions {
  readonly manifest: ExtensionManifest;
  /** The verified package files, from which module bytes are taken. */
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly spawn: SpawnComputeWorker;
  /** Jobs and loaded instances an extension may have at once. */
  readonly maxWorkers?: number;
}

/** A module's run must leave this much of its time limit, after `pf.should_stop()` turns true, to return its result. */
const SOFT_LIMIT_FRACTION = 0.9;
const INIT_MS = 10_000;

interface Instance {
  readonly module: string;
  readonly worker: ComputeWorkerHandle;
  readonly timeoutMs: number;
  busy: boolean;
  next: number;
  readonly pending: Map<number, (message: Record<string, unknown>) => void>;
}

export class ComputeHost {
  private readonly modules: Map<string, { bytes: Uint8Array; maxPages: number; timeoutMs: number }>;
  private readonly spawn: SpawnComputeWorker;
  private readonly maxWorkers: number;
  private readonly instances = new Map<string, Instance>();
  private running = 0;

  constructor(options: ComputeHostOptions) {
    this.modules = new Map(options.manifest.wasm.map((m) => {
      const bytes = options.files.get(m.file);
      if (!bytes) throw new ExtensionError('validation.failed', `The WASM module "${m.name}" has no file.`);
      return [m.name, { bytes, maxPages: m.maxMemoryPages, timeoutMs: m.timeoutMs }] as const;
    }));
    this.spawn = options.spawn;
    this.maxWorkers = options.maxWorkers ?? 2;
  }

  services(): ServiceImplementations {
    return {
      'compute.run': async (input, call) => {
        const { module, payload, json } = this.parseInput(input, 'module');
        const instance = await this.start(module, call.signal);
        try {
          return await this.execute(instance, payload, json, call);
        } finally {
          this.stop(instance);
        }
      },
      'wasm.load': async (input, call) => {
        const module = (input as { module?: unknown } | null)?.module;
        if (typeof module !== 'string' || !this.modules.has(module))
          throw new ExtensionError('validation.failed', 'wasm.load needs the name of a WASM module declared in the manifest.');
        const instance = await this.start(module, call.signal);
        const handle = `wasm_${crypto.randomUUID().replaceAll('-', '')}`;
        this.instances.set(handle, instance);
        return { instance: handle };
      },
      'wasm.call': async (input, call) => {
        const { module: handle, payload, json } = this.parseInput(input, 'instance');
        const instance = this.instances.get(handle);
        if (!instance) throw new ExtensionError('validation.failed', 'There is no loaded module with that handle; it may have been unloaded or ended by a limit.');
        if (instance.busy) throw new ExtensionError('limit.exceeded', 'The loaded module is already running a call.');
        try {
          return await this.execute(instance, payload, json, call);
        } catch (error) {
          // A call that hit a limit or was cancelled ended the worker, so the instance is gone too.
          if (error instanceof ExtensionError && (error.code === 'limit.exceeded' || error.code === 'cancelled')) this.unload(handle);
          throw error;
        }
      },
      'wasm.unload': (input) => {
        const handle = (input as { instance?: unknown } | null)?.instance;
        if (typeof handle === 'string') this.unload(handle);
        return null;
      },
    };
  }

  /** Ends every worker, as when the extension stops. */
  terminateAll(): void {
    for (const handle of [...this.instances.keys()]) this.unload(handle);
  }

  private unload(handle: string): void {
    const instance = this.instances.get(handle);
    if (!instance) return;
    this.instances.delete(handle);
    this.stop(instance);
  }

  private parseInput(input: unknown, key: 'module' | 'instance'): { module: string; payload: Uint8Array; json: boolean } {
    const fields = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
    const name = fields[key];
    if (typeof name !== 'string') throw new ExtensionError('validation.failed', `The call needs a ${key}.`);
    if (key === 'module' && !this.modules.has(name)) throw new ExtensionError('validation.failed', `"${name}" is not a WASM module declared in the manifest.`);
    const hasData = 'data' in fields && fields.data !== undefined;
    const hasJson = 'json' in fields && fields.json !== undefined;
    if (hasData === hasJson) throw new ExtensionError('validation.failed', 'Pass the input as either data (bytes) or json, not both.');
    if (hasData) {
      const data = fields.data;
      if (data instanceof Uint8Array) return { module: name, payload: data.slice(), json: false };
      if (data instanceof ArrayBuffer) return { module: name, payload: new Uint8Array(data.slice(0)), json: false };
      throw new ExtensionError('validation.failed', 'data must be a Uint8Array or an ArrayBuffer.');
    }
    return { module: name, payload: new TextEncoder().encode(JSON.stringify(fields.json)), json: true };
  }

  private async start(module: string, signal: AbortSignal): Promise<Instance> {
    if (this.running >= this.maxWorkers)
      throw new ExtensionError('limit.exceeded', `An extension may run at most ${this.maxWorkers} compute jobs or loaded modules at once.`);
    const declared = this.modules.get(module)!;
    this.running++;
    let worker: ComputeWorkerHandle;
    try {
      worker = await this.spawn();
    } catch {
      this.running--;
      throw new ExtensionError('unavailable', 'Compute workers cannot start in this browser.');
    }
    const instance: Instance = { module, worker, timeoutMs: declared.timeoutMs, busy: false, next: 1, pending: new Map() };
    const outcome = await new Promise<Record<string, unknown>>((resolve) => {
      const settle = (message: Record<string, unknown>) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(message);
      };
      const onAbort = () => settle({ type: 'cancelled' });
      const timer = setTimeout(() => settle({ type: 'failed', message: 'The module did not load in time.' }), INIT_MS);
      signal.addEventListener('abort', onAbort, { once: true });
      worker.listen((raw) => {
        const message = (raw ?? {}) as Record<string, unknown>;
        if (message.type === 'ready' || message.type === 'failed') settle(message);
        else if (typeof message.id === 'number') instance.pending.get(message.id)?.(message);
      });
      const bytes = declared.bytes.slice().buffer;
      worker.post({ type: 'init', module: bytes, maxPages: declared.maxPages, softMs: declared.timeoutMs * SOFT_LIMIT_FRACTION }, [bytes]);
    });
    if (outcome.type !== 'ready') {
      this.stop(instance);
      if (outcome.type === 'cancelled') throw new ExtensionError('cancelled', 'The operation was cancelled.');
      throw new ExtensionError('extension.failed', `The WASM module "${module}" could not start: ${String(outcome.message ?? 'unknown error')}`.slice(0, 500));
    }
    return instance;
  }

  private stop(instance: Instance): void {
    if (!instance.pending.has(-1)) {
      instance.pending.set(-1, () => {});
      instance.worker.terminate();
      this.running--;
    }
  }

  private execute(instance: Instance, payload: Uint8Array, json: boolean, call: ServiceCall): Promise<unknown> {
    if (instance.pending.has(-1)) return Promise.reject(new ExtensionError('unavailable', 'The module has ended.'));
    const id = instance.next++;
    instance.busy = true;
    const decode = (buffer: unknown): unknown => {
      const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : null;
      if (!bytes) return undefined;
      if (!json) return bytes;
      try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch {
        return undefined;
      }
    };
    return new Promise((resolve, reject) => {
      const finish = (action: () => void) => {
        clearTimeout(timer);
        call.signal.removeEventListener('abort', onAbort);
        instance.pending.delete(id);
        instance.busy = false;
        action();
      };
      const onAbort = () => finish(() => { this.stop(instance); reject(new ExtensionError('cancelled', 'The operation was cancelled.')); });
      const timer = setTimeout(() => finish(() => {
        this.stop(instance);
        reject(new ExtensionError('limit.exceeded', `The WASM module "${instance.module}" ran longer than its ${instance.timeoutMs} ms limit and was stopped.`));
      }), instance.timeoutMs);
      call.signal.addEventListener('abort', onAbort, { once: true });
      instance.pending.set(id, (message) => {
        switch (message.type) {
          case 'progress':
            if (typeof message.value === 'number') call.progress(message.value);
            return;
          case 'partial': {
            const partial = decode(message.data);
            if (partial !== undefined) call.progress(null, partial);
            return;
          }
          case 'result': {
            const output = decode(message.output);
            finish(() => output === undefined
              ? reject(new ExtensionError('validation.failed', `The WASM module "${instance.module}" returned output that is not valid JSON.`))
              : resolve(output));
            return;
          }
          case 'error':
            finish(() => reject(new ExtensionError('extension.failed', `The WASM module "${instance.module}" failed: ${String(message.message ?? 'unknown error')}`.slice(0, 500))));
            return;
        }
      });
      const buffer = payload.buffer as ArrayBuffer;
      instance.worker.post({ type: 'run', id, input: buffer }, [buffer]);
    });
  }
}
