// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { ExtensionError } from '@pushform/extension-protocol';
import type { ComputeWorkerHandle } from '../compute';
import { messagePortTransport, type RuntimePort } from '../port';
import { runtimeFrameDocument } from './frameBootstrap';

/**
 * Starts one extension runtime in the browser: a hidden sandboxed frame with its own opaque origin, which starts a
 * worker from the bootstrap source and the verified package files. The host and the frame meet through a single
 * `load` message carrying a fresh nonce; the frame's answer is accepted only from that frame's window and only with
 * that nonce, and it delivers the two ports the runtime is reached by. Nothing else from the frame is accepted.
 * Removing the frame ends the worker with it, so termination never depends on the extension's cooperation.
 */

export interface WebRuntimeOptions {
  /** Verified package files by path. They are copied, so the caller's bytes stay usable. */
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly main: string;
  /** Whether the package declares WASM modules, which the frame's policy then allows to compile. */
  readonly wasm: boolean;
  /** Source of the worker bootstrap, a classic script (see `workerBootstrap.ts`). */
  readonly workerSource: string;
  /** Source of the compute bootstrap (see `computeBootstrap.ts`); used only when `wasm` is true. */
  readonly computeSource?: string;
  /** Where the hidden frame is attached; the document body by default. */
  readonly container?: HTMLElement;
  /** Time allowed for the frame to answer the handshake. */
  readonly handshakeMs?: number;
  /** Called once if the worker fails to start or crashes, for example when the browser refuses the worker. */
  readonly onError?: (error: ExtensionError) => void;
}

export interface WebRuntime {
  /** The protocol port of the runtime, for an `ExtensionSession`. */
  readonly port: RuntimePort;
  /** Stops the worker and removes the frame. Safe to call more than once. */
  terminate(): void;
  /**
   * Starts a compute worker in the runtime's frame, under the same policy and origin but apart from the extension's
   * worker. Fails when the package declares no WebAssembly modules or the browser refuses the worker.
   */
  startCompute(): Promise<ComputeWorkerHandle>;
}

export const DEFAULT_HANDSHAKE_MS = 5000;

export function startWebRuntime(options: WebRuntimeOptions): Promise<WebRuntime> {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('tabindex', '-1');
  frame.title = 'Extension runtime';
  frame.style.display = 'none';
  frame.srcdoc = runtimeFrameDocument({ wasm: options.wasm });
  const nonce = crypto.randomUUID();
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    frame.remove();
  };

  return new Promise<WebRuntime>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      remove();
      reject(new ExtensionError('extension.unsupported', 'The extension runtime did not start in this browser.'));
    }, options.handshakeMs ?? DEFAULT_HANDSHAKE_MS);
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return;
      const data = event.data as { type?: unknown; nonce?: unknown } | null;
      if (data?.type !== 'ready' || data.nonce !== nonce || event.ports.length !== 2) return;
      cleanup();
      const [protocol, control] = event.ports as unknown as [MessagePort, MessagePort];
      let reported = false;
      let nextCompute = 1;
      const computeRequests = new Map<number, { resolve(port: MessagePort): void; reject(error: ExtensionError): void }>();
      const computeErrors = new Map<number, () => void>();
      control.onmessage = (message: MessageEvent) => {
        const report = message.data as { type?: unknown; message?: unknown; id?: unknown } | null;
        const id = typeof report?.id === 'number' ? report.id : -1;
        if (report?.type === 'compute' && message.ports[0]) { computeRequests.get(id)?.resolve(message.ports[0]); computeRequests.delete(id); return; }
        if (report?.type === 'compute-failed') { computeRequests.get(id)?.reject(new ExtensionError('unavailable', 'The compute worker could not start.')); computeRequests.delete(id); return; }
        if (report?.type === 'compute-error') { computeErrors.get(id)?.(); return; }
        if (report?.type !== 'error' || reported) return;
        reported = true;
        options.onError?.(new ExtensionError('extension.failed', typeof report.message === 'string' ? report.message.slice(0, 500) : 'The extension runtime failed.'));
      };
      resolve({
        port: messagePortTransport(protocol),
        terminate() {
          if (removed) return;
          control.postMessage({ type: 'terminate' });
          protocol.close();
          control.close();
          for (const pending of computeRequests.values()) pending.reject(new ExtensionError('cancelled', 'The extension stopped.'));
          computeRequests.clear();
          remove();
        },
        startCompute() {
          if (removed) return Promise.reject(new ExtensionError('unavailable', 'The extension runtime has stopped.'));
          const id = nextCompute++;
          return new Promise<MessagePort>((resolveCompute, rejectCompute) => {
            computeRequests.set(id, { resolve: resolveCompute, reject: rejectCompute });
            control.postMessage({ type: 'compute', id });
          }).then((port): ComputeWorkerHandle => {
            let ended = false;
            const end = () => {
              if (ended) return;
              ended = true;
              computeErrors.delete(id);
              port.close();
              if (!removed) control.postMessage({ type: 'compute-terminate', id });
            };
            let listener: ((message: unknown) => void) | null = null;
            // A worker that fails to load reports an error event; tell the listener as the module failing to start.
            computeErrors.set(id, () => listener?.({ type: 'failed', message: 'The compute worker could not start in this browser.' }));
            return {
              post: (message, transfer) => { if (!ended) port.postMessage(message, transfer ?? []); },
              listen: (handler) => { listener = handler; port.onmessage = (e) => handler(e.data); },
              terminate: end,
            };
          });
        },
      });
    };
    window.addEventListener('message', onMessage);
    frame.addEventListener('load', () => {
      const files: Record<string, ArrayBuffer> = {};
      for (const [path, bytes] of options.files) files[path] = bytes.slice().buffer;
      const compute = options.wasm && options.computeSource !== undefined ? { compute: options.computeSource } : {};
      frame.contentWindow?.postMessage({ type: 'load', nonce, worker: options.workerSource, main: options.main, files, ...compute }, '*', Object.values(files));
    }, { once: true });
    (options.container ?? document.body).append(frame);
  });
}
