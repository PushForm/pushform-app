// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { ExtensionError } from '@pushform/extension-protocol';
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
      control.onmessage = (message: MessageEvent) => {
        const report = message.data as { type?: unknown; message?: unknown } | null;
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
          remove();
        },
      });
    };
    window.addEventListener('message', onMessage);
    frame.addEventListener('load', () => {
      const files: Record<string, ArrayBuffer> = {};
      for (const [path, bytes] of options.files) files[path] = bytes.slice().buffer;
      frame.contentWindow?.postMessage({ type: 'load', nonce, worker: options.workerSource, main: options.main, files }, '*', Object.values(files));
    }, { once: true });
    (options.container ?? document.body).append(frame);
  });
}
