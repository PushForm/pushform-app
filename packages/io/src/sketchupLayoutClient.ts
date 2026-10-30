// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { installSketchUpLayout, prepareSketchUpLayout, type PreparedSketchUpLayout, type SketchUpLayoutImport } from './sketchupLayout';
import type { LayoutWorkerRequest } from './sketchupLayoutWorker';

type WorkerMessage = { type: 'result'; prepared: PreparedSketchUpLayout } | { type: 'error'; message: string };

/**
 * Convert a .layout archive off the main thread: inflation, XML parsing and vector conversion run in
 * one disposable worker per import, and only the prepared state comes back to become a document.
 * Terminating the worker cancels a conversion in progress; a late result never resolves.
 */
export function importSketchUpLayoutInWorker(bytes: Uint8Array, fileName: string, options: {
  signal?: AbortSignal;
} = {}): Promise<SketchUpLayoutImport> {
  if (options.signal?.aborted) return Promise.reject(new DOMException('Import cancelled.', 'AbortError'));
  // Inline path for headless callers and test environments. Browsers always use the worker.
  if (typeof Worker === 'undefined') return Promise.resolve().then(() => {
    const prepared = prepareSketchUpLayout(bytes, fileName);
    if (options.signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
    return installSketchUpLayout(prepared);
  });
  return new Promise<PreparedSketchUpLayout>((resolve, reject) => {
    const worker = new Worker(new URL('./sketchupLayoutWorker.ts', import.meta.url), { type: 'module' });
    let settled = false;
    const cleanup = (): void => { settled = true; worker.terminate(); options.signal?.removeEventListener('abort', abort); };
    const abort = (): void => { if (!settled) { cleanup(); reject(new DOMException('Import cancelled.', 'AbortError')); } };
    options.signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      if (settled) return;
      cleanup();
      if (event.data.type === 'result') resolve(event.data.prepared); else reject(new Error(event.data.message));
    };
    worker.onerror = event => { if (!settled) { cleanup(); reject(new Error(event.message || 'LayOut import worker failed.')); } };
    worker.onmessageerror = () => { if (!settled) { cleanup(); reject(new Error('Could not receive the LayOut import result.')); } };
    // Do not detach the caller's input; it may be needed for retries or another reader.
    const copy = new Uint8Array(bytes);
    const request: LayoutWorkerRequest = { bytes: copy, fileName };
    try { worker.postMessage(request, [copy.buffer]); }
    catch (cause) { cleanup(); reject(cause); }
  }).then(installSketchUpLayout);
}
