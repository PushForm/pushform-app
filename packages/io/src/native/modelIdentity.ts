// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { Hash } from 'fast-sha256';
import type { ComponentDefinition, DocumentState } from '@pushform/model';

const identities = new WeakMap<DocumentState, string>();
const definitions = new WeakMap<ComponentDefinition, Uint8Array>();
const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const hex = (bytes: Uint8Array): string => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
type Key = string | number;
function compare(a: Key, b: Key): number {
  if (typeof a !== typeof b) return typeof a === 'number' ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Canonical typed value stream, fed directly to SHA-256 with 64 KiB scratch.
 * This is a versioned saved-state fingerprint, not a second portable file encoding. */
export class Fingerprint {
  private readonly hash = new Hash();
  private readonly scratch = new Uint8Array(64 * 1024);
  private readonly view = new DataView(this.scratch.buffer);
  private at = 0;
  private readonly active = new Set<object>();
  constructor(private readonly omit: (object: object, key: string) => boolean,
    private readonly definitionMap?: DocumentState['definitions']) {}
  private flush(): void { if (this.at) { this.hash.update(this.scratch.subarray(0, this.at)); this.at = 0; } }
  private tag(value: number): void { if (this.at === this.scratch.length) this.flush(); this.scratch[this.at++] = value; }
  private number(value: number): void {
    if (this.at + 8 > this.scratch.length) this.flush();
    this.view.setFloat64(this.at, value, true); this.at += 8;
  }
  private text(value: string): void {
    // UTF-16 code units preserve lone surrogates as well as ordinary Unicode strings.
    this.number(value.length);
    for (let i = 0; i < value.length; i++) {
      if (this.at + 2 > this.scratch.length) this.flush();
      this.view.setUint16(this.at, value.charCodeAt(i), true); this.at += 2;
    }
  }
  private bytes(value: Uint8Array): void { this.flush(); this.hash.update(value); }
  write(value: unknown): void {
    if (value === undefined) { this.tag(0); return; }
    if (value === null) { this.tag(1); return; }
    if (typeof value === 'boolean') { this.tag(value ? 3 : 2); return; }
    if (typeof value === 'number') { this.tag(4); this.number(value); return; }
    if (typeof value === 'string') { this.tag(5); this.text(value); return; }
    if (typeof value !== 'object') throw new Error('Unsupported model fingerprint value');
    if (ArrayBuffer.isView(value)) {
      const kind = Object.prototype.toString.call(value);
      if (kind !== '[object Float64Array]' && kind !== '[object Uint32Array]' && kind !== '[object Uint8Array]') throw new Error('Unsupported model fingerprint array');
      this.tag(kind === '[object Float64Array]' ? 6 : kind === '[object Uint32Array]' ? 7 : 8);
      this.number(value.byteLength);
      if (littleEndian || kind === '[object Uint8Array]') this.bytes(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      else {
        const data = new DataView(value.buffer, value.byteOffset, value.byteLength), width = kind === '[object Float64Array]' ? 8 : 4;
        for (let i = 0; i < data.byteLength; i += width) {
          if (this.at + width > this.scratch.length) this.flush();
          if (width === 8) this.view.setFloat64(this.at, data.getFloat64(i, false), true);
          else this.view.setUint32(this.at, data.getUint32(i, false), true);
          this.at += width;
        }
      }
      return;
    }
    if (this.active.has(value) || this.active.size >= 256) throw new Error('Cyclic or excessively nested model fingerprint');
    this.active.add(value);
    try {
      if (Array.isArray(value)) {
        this.tag(9); this.number(value.length); for (const item of value) this.write(item);
      } else if (value instanceof Map) {
        this.tag(10); this.number(value.size);
        const keys = [...value.keys()] as unknown[];
        if (keys.some(key => typeof key !== 'string' && (typeof key !== 'number' || !Number.isFinite(key)))) throw new Error('Unsupported model map key');
        for (const key of (keys as Key[]).sort(compare)) {
          this.write(key);
          if (value === this.definitionMap) {
            this.tag(12); this.bytes(definitionDigest(value.get(key) as ComponentDefinition));
          } else this.write(value.get(key));
        }
      } else {
        const prototype = Object.getPrototypeOf(value) as unknown;
        if (prototype !== null && Object.prototype.toString.call(value) !== '[object Object]') throw new Error('Unsupported model fingerprint object');
        this.tag(11);
        const keys = Object.keys(value).filter(key => !this.omit(value, key)).sort(); this.number(keys.length);
        for (const key of keys) { this.text(key); this.write((value as Record<string, unknown>)[key]); }
      }
    } finally { this.active.delete(value); }
  }
  finish(): Uint8Array { this.flush(); return this.hash.digest(); }
}
function definitionDigest(definition: ComponentDefinition): Uint8Array {
  const cached = definitions.get(definition); if (cached) return cached;
  const stream = new Fingerprint((object, key) => (object === definition && key === 'bounds') ||
    (object === definition.entities.sketch && (key === 'vertexHash' || key === 'packedVertexIndex')));
  stream.write(definition); const digest = stream.finish();
  // Cache only immutable owner records, not millions of per-vertex/face facades.
  if (Object.isFrozen(definition)) definitions.set(definition, digest);
  return digest;
}

/** Semantic content identity for immutable model revisions.
 * Derived bounds/vertex hashes and the monotonic global ID allocator do not make a model dirty.
 * Map insertion order is ignored; entity/scene order arrays, field presence and Float64 bits remain significant.
 * Mesh buffers follow the model's immutable ownership contract. No JSON or serialized graph is retained. */
export function modelContentIdentity(state: DocumentState): string {
  const cached = identities.get(state); if (cached) return cached;
  const stream = new Fingerprint((object, key) => object === state.meta && key === 'nextId', state.definitions);
  stream.write('pushform-model-content-v1'); stream.write(state);
  const result = `pf-model-v1-sha256:${hex(stream.finish())}`;
  if (Object.isFrozen(state)) identities.set(state, result);
  return result;
}
