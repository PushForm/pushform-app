// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// Trusted helper-view bootstrap. Package code runs only in its worker, which never receives this native bridge.
import { measureMessage } from '@pushform/extension-protocol';
import { decodeNativeWire, encodeNativeWire, nativeWireFrames, NativeWireReader, type NativeWireFrame } from './wire';
interface NativeParent extends Window { ipc: { postMessage(message: string): void }; __pfRuntimeReceive?: (frame: NativeWireFrame) => void }
interface Init { type: 'init'; worker: string; compute: string | null; main: string }
const parent = window as unknown as NativeParent;
const reader = new NativeWireReader();
let next = 0, initialized = false, started = false;
let init: Init | null = null, worker: Worker | null = null, protocol: MessagePort | null = null;
let fileBytes = 0;
const files = new Map<string, { data: Uint8Array; written: number }>();
const computes = new Map<number, { worker: Worker; port: MessagePort }>();
function send(message: unknown): void {
  for (const frame of nativeWireFrames(++next, encodeNativeWire(message))) parent.ipc.postMessage(JSON.stringify(frame));
}
function fail(message: string): void { send({ channel: 'error', message: message.slice(0, 500) }); }
function spawn(source: string, name: string): Worker {
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try { return new Worker(url, { name }); } finally { URL.revokeObjectURL(url); }
}
function receive(input: unknown): void {
  if (!input || typeof input !== 'object') throw Error('Invalid native runtime input.');
  const message = input as Record<string, unknown>;
  if (message.type === 'init') {
    if (initialized || typeof message.worker !== 'string' || (message.compute !== null && typeof message.compute !== 'string') || typeof message.main !== 'string') throw Error('Invalid runtime initialization.');
    initialized = true; init = message as unknown as Init; return;
  }
  if (!init) throw Error('Initialize the runtime before loading files.');
  if (message.type === 'file') {
    if (started || typeof message.path !== 'string' || !message.path || files.has(message.path) || files.size >= 1001
      || typeof message.bytes !== 'number' || !Number.isSafeInteger(message.bytes) || message.bytes < 0 || message.bytes > 64 * 1024 * 1024) throw Error('Invalid runtime package file.');
    fileBytes += message.bytes; if (fileBytes > 129 * 1024 * 1024) throw Error('Runtime package is too large.');
    files.set(message.path, { data: new Uint8Array(message.bytes), written: 0 }); return;
  }
  if (message.type === 'file-data') {
    const file = typeof message.path === 'string' ? files.get(message.path) : null;
    if (started || !file || !(message.data instanceof Uint8Array) || message.offset !== file.written || file.written + message.data.byteLength > file.data.byteLength) throw Error('Invalid runtime file chunk.');
    file.data.set(message.data, file.written); file.written += message.data.byteLength; return;
  }
  if (message.type === 'load') {
    if (started || !files.has(init.main) || [...files.values()].some(file => file.written !== file.data.byteLength)) throw Error('Runtime files are incomplete.');
    started = true;
    worker = spawn(init.worker, 'extension'); const channel = new MessageChannel(); protocol = channel.port2;
    protocol.onmessage = event => { if (measureMessage(event.data) === null) { worker?.terminate(); fail('limit.exceeded: The extension sent an oversized message.'); } else send({ channel: 'protocol', data: event.data }); };
    worker.onerror = error => fail(error.message || 'The extension worker stopped.');
    const payload = Object.fromEntries([...files].map(([path, file]) => [path, file.data.buffer])); files.clear();
    worker.postMessage({ type: 'init', main: init.main, files: payload }, [channel.port1, ...Object.values(payload)]);
    send({ channel: 'ready' }); return;
  }
  if (!started || !protocol) throw Error('The extension is not loaded.');
  if (message.channel === 'protocol') { protocol.postMessage(message.data); return; }
  if (message.channel === 'compute-start') {
    const id = message.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || computes.has(id) || computes.size >= 2 || !init.compute) throw Error('Invalid compute request.');
    const compute = spawn(init.compute, 'extension-compute'), channel = new MessageChannel();
    const port = channel.port2; computes.set(id, { worker: compute, port });
    port.onmessage = event => send({ channel: 'compute', id, data: event.data });
    compute.onerror = () => send({ channel: 'compute-error', id });
    compute.postMessage({ type: 'connect' }, [channel.port1]); send({ channel: 'compute-ready', id }); return;
  }
  if (message.channel === 'compute') {
    const compute = typeof message.id === 'number' ? computes.get(message.id) : null;
    if (!compute) throw Error('Unknown compute worker.'); compute.port.postMessage(message.data); return;
  }
  if (message.channel === 'compute-stop') {
    const id = message.id; if (typeof id !== 'number') throw Error('Invalid compute identity.');
    const compute = computes.get(id); compute?.worker.terminate(); compute?.port.close(); computes.delete(id); return;
  }
  throw Error('Unknown native runtime message.');
}
Object.defineProperty(parent, '__pfRuntimeReceive', { configurable: false, writable: false, value: (frame: NativeWireFrame): void => {
  try { const text = reader.push(frame); if (text !== null) receive(decodeNativeWire(text)); }
  catch (error) { fail(error instanceof Error ? error.message : 'The native runtime message failed.'); }
} });

send({ channel: 'bootstrap-ready' });
