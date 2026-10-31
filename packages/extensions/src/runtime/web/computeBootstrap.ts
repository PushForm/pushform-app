// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { runComputeWorker } from '../computeWorker';

/**
 * Entry of a compute worker, bundled as one classic script and started by the runtime frame when the host asks for
 * one. It accepts exactly one `connect` message carrying its port, then runs one WebAssembly module on that port.
 * It never sees the extension's code or runtime: its only inputs are the module bytes and job inputs the host sends.
 */
const scope = self as unknown as DedicatedWorkerGlobalScope;

function onConnect(event: MessageEvent): void {
  const port = event.ports[0];
  if ((event.data as { type?: string } | null)?.type !== 'connect' || !port) return;
  scope.removeEventListener('message', onConnect);
  runComputeWorker({
    post: (message, transfer) => port.postMessage(message, transfer ?? []),
    listen: (handler) => { port.onmessage = (e) => handler(e.data); },
  });
}

scope.addEventListener('message', onConnect);
