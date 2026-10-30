// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * Web Worker entry: `{ id, req }` in, `{ id, ok, result }` / `{ id, ok: false, error }` out.
 * Requests are answered in arrival order; result buffers are transferred, not copied.
 */
import type { KernelRequestEnvelope, KernelResponseEnvelope } from '../protocol';
import { toKernelErrorInfo } from '../protocol';
import { createKernelContext, type KernelContext } from './context';
import { collectTransferables, dispatch } from './dispatch';

interface WorkerScope {
  onmessage: ((ev: MessageEvent<KernelRequestEnvelope>) => void) | null;
  postMessage(message: KernelResponseEnvelope, transfer?: ArrayBuffer[]): void;
}

const scope = self as unknown as WorkerScope;
const contextPromise: Promise<KernelContext> = createKernelContext();
let queue: Promise<void> = Promise.resolve();

async function handle(envelope: KernelRequestEnvelope): Promise<void> {
  const { id, req } = envelope;
  try {
    const ctx = await contextPromise;
    const result = dispatch(ctx, req);
    scope.postMessage({ id, ok: true, result }, collectTransferables(result));
  } catch (e) {
    scope.postMessage({ id, ok: false, error: toKernelErrorInfo(e) });
  }
}

scope.onmessage = (ev) => {
  const envelope = ev.data;
  queue = queue.then(() => handle(envelope));
};
