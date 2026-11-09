// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { ExtensionError } from '@pushform/extension-protocol';
import type { RuntimeHandle } from '../../platform/platform';
import type { ComputeWorkerHandle } from '../compute';
import { decodeNativeWire, encodeNativeWire, nativeWireFrames, NativeWireReader, type NativeWireFrame } from './wire';

/** A host-owned native process transport. It carries no shell commands or caller-selected file paths. */
export interface NativeTransport {
  post(frame: string): Promise<void>;
  listen(handler: (frame: NativeWireFrame) => void): () => void;
  stop(): void;
}
export interface NativeRuntimeOptions {
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly main: string;
  readonly workerSource: string;
  readonly computeSource?: string;
  readonly transport: NativeTransport;
}
export async function startNativeRuntime(options: NativeRuntimeOptions): Promise<RuntimeHandle> {
  const { transport } = options;
  const reader = new NativeWireReader();
  let ended = false, next = 0, nextCompute = 0;
  let writes = Promise.resolve();
  let listener: ((message: unknown) => void) | null = null;
  let bufferedBytes = 0;
  const buffered: unknown[] = [];
  const computes = new Map<number, { ready(handle: ComputeWorkerHandle): void; reject(error: Error): void; listener: ((message: unknown) => void) | null; timer: ReturnType<typeof setTimeout> }>();
  let ready: () => void = () => {}, rejectReady: (error: Error) => void = () => {};
  const loaded = new Promise<void>((resolve, reject) => { ready = resolve; rejectReady = reject; });
  const timer = setTimeout(() => fail(Error('The native runtime did not start in time.')), 15_000);
  let unlisten = (): void => {};
  const stop = (): void => {
    if (ended) return; ended = true; clearTimeout(timer); unlisten(); reader.clear(); buffered.length = 0;
    const error = new ExtensionError('cancelled', 'The extension runtime stopped.'); rejectReady(error);
    for (const compute of computes.values()) { clearTimeout(compute.timer); compute.reject(error); compute.listener?.({ type: 'failed', message: error.message }); }
    computes.clear(); transport.stop();
  };
  const fail = (cause: unknown): void => {
    const error = cause instanceof ExtensionError ? cause : new ExtensionError('extension.failed', cause instanceof Error ? cause.message : 'The native runtime stopped.');
    rejectReady(error); stop();
  };
  // A failed startup may arrive while files are being streamed, before the final await below.
  void loaded.catch(() => {});
  const send = (message: unknown): Promise<void> => {
    const work = writes.then(async () => {
      if (ended) throw new ExtensionError('cancelled', 'The extension runtime stopped.');
      for (const frame of nativeWireFrames(++next, encodeNativeWire(message))) await transport.post(JSON.stringify(frame));
    });
    writes = work.catch(fail); return work;
  };
  const post = (message: unknown): void => { if (!ended) void send(message).catch(() => {}); };
  unlisten = transport.listen(frame => {
    if (ended) return;
    try {
      const text = reader.push(frame); if (text === null) return;
      const message = decodeNativeWire(text) as { channel?: unknown; id?: unknown; data?: unknown; message?: unknown } | null;
      if (!message || typeof message !== 'object') throw Error('Invalid native runtime response.');
      if (message.channel === 'bootstrap-ready') return;
      if (message.channel === 'ready') { clearTimeout(timer); ready(); return; }
      if (message.channel === 'error') throw Error(typeof message.message === 'string' ? message.message : 'The native worker stopped.');
      if (message.channel === 'protocol') {
        if (listener) listener(message.data);
        else {
          bufferedBytes += text.length * 2;
          if (buffered.length >= 64 || bufferedBytes > 8 * 1024 * 1024) throw Error('The native startup message queue is full.');
          buffered.push(message.data);
        }
        return;
      }
      if (typeof message.id !== 'number') throw Error('A native compute response has no identity.');
      const compute = computes.get(message.id); if (!compute) return;
      if (message.channel === 'compute-ready') {
        clearTimeout(compute.timer); const id = message.id;
        compute.ready({
          post: data => post({ channel: 'compute', id, data }),
          listen: handler => { compute.listener = handler; },
          terminate: () => { if (!computes.delete(id)) return; clearTimeout(compute.timer); post({ channel: 'compute-stop', id }); },
        });
      } else if (message.channel === 'compute') compute.listener?.(message.data);
      else if (message.channel === 'compute-error') { compute.reject(Error('The native compute worker stopped.')); compute.listener?.({ type: 'failed', message: 'The native compute worker stopped.' }); }
      else throw Error('Unknown native runtime response.');
    } catch (error) { fail(error); }
  });
  try {
    await send({ type: 'init', worker: options.workerSource, compute: options.computeSource ?? null, main: options.main });
    for (const [path, bytes] of options.files) {
      await send({ type: 'file', path, bytes: bytes.byteLength });
      for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1024) await send({ type: 'file-data', path, offset, data: bytes.subarray(offset, offset + 64 * 1024) });
    }
    await send({ type: 'load' }); await loaded;
  } catch (error) { stop(); throw error; }
  return {
    port: {
      post: message => post({ channel: 'protocol', data: message }),
      listen: handler => {
        listener = handler; for (const message of buffered.splice(0)) handler(message); bufferedBytes = 0;
        return () => { if (listener === handler) listener = null; };
      },
      close: stop,
    },
    terminate: stop,
    startCompute: () => new Promise<ComputeWorkerHandle>((resolve, reject) => {
      if (ended) { reject(new ExtensionError('unavailable', 'The native runtime stopped.')); return; }
      const id = ++nextCompute;
      const deadline = setTimeout(() => { computes.delete(id); reject(new ExtensionError('extension.failed', 'The native compute worker did not start.')); post({ channel: 'compute-stop', id }); }, 5000);
      computes.set(id, { ready: resolve, reject, listener: null, timer: deadline }); post({ channel: 'compute-start', id });
    }),
  };
}
