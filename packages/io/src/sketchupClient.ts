// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { MeshImportOptions } from './meshImport';
import { readModelImport } from './modelImport';
import { MAX_SKETCHUP_BYTES, type ImportProgress, type SketchUpImport } from './sketchup';
import { hasNativeStepReader, isStepBytes, type StepPreviewListener } from './step';
import type { StepPreview } from './stepWasm';

type WorkerMessage = { type: 'progress'; progress: ImportProgress } | { type: 'preview'; preview: StepPreview } |
  { type: 'result'; scene: SketchUpImport } | { type: 'error'; message: string };

/**
 * Read a SketchUp, COLLADA, OBJ or 3DS model in one disposable worker per import:
 * terminating it also cancels a synchronous parser walk. `mesh` is how to read an OBJ or 3DS file's unit and up axis;
 * `maxStepBytes` is the largest STEP file to read, which the desktop app raises.
 */
export function readSketchUpInWorker(bytes: Uint8Array, options: {
  signal?: AbortSignal;
  onProgress?: (p: ImportProgress) => void;
  mesh?: MeshImportOptions | undefined;
  maxStepBytes?: number | undefined;
  /** Triangle count above which the model imports as mesh parts; tests lower it. */
  meshPartThreshold?: number | undefined;
  /** Parts of a STEP file as they are meshed, to draw before the import finishes (other formats send none). */
  onPreview?: StepPreviewListener | undefined;
} = {}): Promise<SketchUpImport> {
  if (options.signal?.aborted) return Promise.reject(new DOMException('Import cancelled.', 'AbortError'));
  const step = isStepBytes(bytes), limit = step ? options.maxStepBytes ?? MAX_SKETCHUP_BYTES : MAX_SKETCHUP_BYTES;
  if (bytes.byteLength > limit) return Promise.reject(new Error(`${step ? 'STEP' : 'Model'} files larger than ${limit / (1024 * 1024)} MiB are not supported yet.`));
  const limits = { stepBytes: options.maxStepBytes, meshPartThreshold: options.meshPartThreshold };
  // Inline path for headless callers and test environments. Browsers use the worker, except for a STEP file the host
  // converts natively: that call is made from the window and does its work outside the page.
  if (typeof Worker === 'undefined' || (step && hasNativeStepReader())) return readModelImport(bytes, options.onProgress, options.mesh, limits, options.signal, options.onPreview).then(scene => {
    if (options.signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
    return scene;
  });
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./sketchupWorker.ts', import.meta.url), { type: 'module' });
    let settled = false;
    const cleanup = (): void => { settled = true; worker.terminate(); options.signal?.removeEventListener('abort', abort); };
    const abort = (): void => { if (!settled) { cleanup(); reject(new DOMException('Import cancelled.', 'AbortError')); } };
    options.signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      if (settled) return;
      const msg = event.data;
      if (msg.type === 'progress') options.onProgress?.(msg.progress);
      else if (msg.type === 'preview') options.onPreview?.(msg.preview);
      else { cleanup(); if (msg.type === 'result') resolve(msg.scene); else reject(new Error(msg.message)); }
    };
    worker.onerror = event => { if (!settled) { cleanup(); reject(new Error(event.message || 'Model import worker failed.')); } };
    worker.onmessageerror = () => { if (!settled) { cleanup(); reject(new Error('Could not receive the model import result.')); } };
    // Do not detach the caller's input; it may be needed for retries or another reader.
    const copy = new Uint8Array(bytes);
    try { worker.postMessage({ bytes: copy, mesh: options.mesh, limits, preview: !!options.onPreview }, [copy.buffer]); }
    catch (cause) { cleanup(); reject(cause); }
  });
}
