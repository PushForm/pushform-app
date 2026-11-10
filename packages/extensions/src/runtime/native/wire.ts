// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// Binary values cross the native pipe as tagged JSON, without treating payload object keys as control fields.
export const NATIVE_WIRE_LIMITS = { chars: 192 * 1024 * 1024, binaryBytes: 128 * 1024 * 1024, nodes: 200_000, depth: 64, frameChars: 256 * 1024 } as const;
const VIEWS: Readonly<Record<string, new (buffer: ArrayBuffer) => ArrayBufferView>> = { Int8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array, DataView };
type Encoded = null | boolean | number | string | [string, ...unknown[]];
function base64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32768) parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
  return btoa(parts.join(''));
}
export function encodeNativeWire(value: unknown): string {
  let nodes = 0, bytes = 0;
  const seen = new Set<object>();
  const encode = (input: unknown, depth: number): Encoded => {
    if (++nodes > NATIVE_WIRE_LIMITS.nodes || depth > NATIVE_WIRE_LIMITS.depth) throw Error('limit.exceeded: Native message is too complex.');
    if (input === undefined) return ['undefined'];
    if (input === null || typeof input === 'boolean' || typeof input === 'string') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (typeof input !== 'object' || !input) throw Error('validation.failed: Unsupported native message value.');
    if (seen.has(input)) throw Error('validation.failed: Cyclic native message.');
    seen.add(input);
    try {
      if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
        const data = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
        bytes += data.byteLength;
        if (bytes > NATIVE_WIRE_LIMITS.binaryBytes) throw Error('limit.exceeded: Native binary message is too large.');
        if (input instanceof ArrayBuffer) return ['buffer', base64(data)];
        if (input instanceof Uint8Array) return ['bytes', base64(data)];
        for (const [name, constructor] of Object.entries(VIEWS)) if (input instanceof constructor) return ['view', name, base64(data)];
        throw Error('validation.failed: Unsupported native binary view.');
      }
      if (Array.isArray(input)) return ['array', ...input.map(item => encode(item, depth + 1))];
      const prototype = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null) throw Error('validation.failed: Native messages require plain objects.');
      return ['object', ...Object.entries(input).map(([key, item]) => [key, encode(item, depth + 1)])];
    } finally { seen.delete(input); }
  };
  const text = JSON.stringify(encode(value, 0));
  if (text.length > NATIVE_WIRE_LIMITS.chars) throw Error('limit.exceeded: Native message is too large.');
  return text;
}
export function decodeNativeWire(text: string): unknown {
  if (text.length > NATIVE_WIRE_LIMITS.chars) throw Error('limit.exceeded: Native message is too large.');
  let nodes = 0, bytes = 0;
  const decode = (input: unknown, depth: number): unknown => {
    if (++nodes > NATIVE_WIRE_LIMITS.nodes || depth > NATIVE_WIRE_LIMITS.depth) throw Error('limit.exceeded: Native message is too complex.');
    if (input === null || typeof input === 'boolean' || typeof input === 'string' || (typeof input === 'number' && Number.isFinite(input))) return input;
    if (!Array.isArray(input) || typeof input[0] !== 'string') throw Error('validation.failed: Invalid native wire value.');
    const [tag, ...items] = input;
    if (tag === 'undefined' && items.length === 0) return undefined;
    const view = tag === 'view' && items.length === 2 && typeof items[0] === 'string' && Object.hasOwn(VIEWS, items[0]) ? VIEWS[items[0] as keyof typeof VIEWS] : null;
    if (((tag === 'buffer' || tag === 'bytes') && items.length === 1 && typeof items[0] === 'string') || (view && typeof items[1] === 'string')) {
      const value = (view ? items[1] : items[0]) as string;
      if (value.length > Math.ceil((NATIVE_WIRE_LIMITS.binaryBytes - bytes) / 3) * 4 || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) throw Error('validation.failed: Invalid native binary value.');
      const binary = atob(value); bytes += binary.length;
      if (bytes > NATIVE_WIRE_LIMITS.binaryBytes || btoa(binary) !== value) throw Error('limit.exceeded: Native binary message is too large or invalid.');
      const data = Uint8Array.from(binary, character => character.charCodeAt(0)); return view ? new view(data.buffer) : tag === 'buffer' ? data.buffer : data;
    }
    if (tag === 'array') return items.map(item => decode(item, depth + 1));
    if (tag === 'object') {
      const value: Record<string, unknown> = {};
      for (const item of items) {
        if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || Object.hasOwn(value, item[0])) throw Error('validation.failed: Invalid native object entry.');
        Object.defineProperty(value, item[0], { value: decode(item[1], depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return value;
    }
    throw Error('validation.failed: Unknown native wire tag.');
  };
  return decode(JSON.parse(text), 0);
}

/** A single bounded pipe frame. Only one message may be assembled at a time on a runtime's ordered channel. */
export interface NativeWireFrame { readonly id: number; readonly index: number; readonly count: number; readonly data: string }
export function* nativeWireFrames(id: number, message: string): Generator<NativeWireFrame> {
  if (!Number.isSafeInteger(id) || id < 1 || message.length > NATIVE_WIRE_LIMITS.chars) throw Error('validation.failed: Invalid native message.');
  const parts: string[] = [];
  for (let offset = 0; offset < message.length;) {
    let end = Math.min(offset + NATIVE_WIRE_LIMITS.frameChars, message.length);
    const final = message.charCodeAt(end - 1);
    if (end < message.length && final >= 0xd800 && final <= 0xdbff) end--;
    parts.push(message.slice(offset, end)); offset = end;
  }
  if (!parts.length) parts.push('');
  for (let index = 0; index < parts.length; index++) yield { id, index, count: parts.length, data: parts[index]! };
}
export class NativeWireReader {
  private pending: { id: number; count: number; parts: string[]; chars: number } | null = null;
  private last = 0;
  push(frame: NativeWireFrame): string | null {
    if (!frame || !Number.isSafeInteger(frame.id) || frame.id < 1 || !Number.isInteger(frame.index) || !Number.isInteger(frame.count)
      || frame.count < 1 || frame.count > Math.ceil(NATIVE_WIRE_LIMITS.chars / NATIVE_WIRE_LIMITS.frameChars) + 1
      || typeof frame.data !== 'string' || frame.data.length > NATIVE_WIRE_LIMITS.frameChars) throw Error('validation.failed: Invalid native frame.');
    if (!this.pending) {
      if (frame.index !== 0 || frame.id <= this.last) throw Error('validation.failed: Stale or out-of-order native frame.');
      this.pending = { id: frame.id, count: frame.count, parts: [], chars: 0 };
    }
    const current = this.pending;
    if (frame.id !== current.id || frame.count !== current.count || frame.index !== current.parts.length) throw Error('validation.failed: Interleaved native frame.');
    current.chars += frame.data.length;
    if (current.chars > NATIVE_WIRE_LIMITS.chars) throw Error('limit.exceeded: Native message is too large.');
    current.parts.push(frame.data);
    if (current.parts.length !== current.count) return null;
    this.pending = null; this.last = current.id; return current.parts.join('');
  }
  clear(): void { this.pending = null; }
}
