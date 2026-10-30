// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import protobuf from 'protobufjs/minimal';
import type { AttrValue, AttributeDictionaries } from '@pushform/model';
import { NativeChunkError } from './chunks';

export type AttributeExtensions = Map<string, Uint8Array[]>;
const MAX_BYTES = 1024 * 1024, MAX_DEPTH = 64, MAX_NODES = 100_000;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const fail = (): never => { throw new NativeChunkError('Invalid native attributes'); };
const keyPath = (path: string, key: string): string => `${path}/${JSON.stringify(key)}`;
function uint(r: protobuf.Reader, end: number): number {
  let n = 0;
  for (let i = 0; i < 5; i++) {
    if (r.pos >= end) return fail(); const b = r.buf[r.pos++]!;
    if (i === 4 && b > 15) return fail(); n += (b & 127) * 2 ** (7 * i);
    if (!(b & 128)) return n;
  }
  return fail();
}
function limit(r: protobuf.Reader, end: number): number {
  const size = uint(r, end), stop = r.pos + size; if (stop > end) return fail(); return stop;
}
function skip(r: protobuf.Reader, wire: number, end: number): void {
  if (wire === 2) r.pos = limit(r, end);
  else if (wire === 1 || wire === 5) r.pos += wire === 1 ? 8 : 4;
  else if (wire === 0) {
    let done = false;
    for (let i = 0; i < 10; i++) {
      if (r.pos >= end) return fail(); const b = r.buf[r.pos++]!;
      if (i === 9 && b > 1) return fail(); if (!(b & 128)) { done = true; break; }
    }
    if (!done) return fail();
  } else return fail();
  if (r.pos > end) return fail();
}
function put<T>(object: Record<string, T>, key: string, value: T): void {
  if (Object.hasOwn(object, key)) return fail();
  Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
}

/** One reader over the input: nested known messages never copy their byte ranges. */
export function decodeNativeAttributes(bytes: Uint8Array): { value: AttributeDictionaries; extensions: AttributeExtensions } {
  if (bytes.length > MAX_BYTES) return fail();
  const r = protobuf.Reader.create(bytes), extensions: AttributeExtensions = new Map(); let nodes = 0, fieldCount = 0;
  const tick = (depth: number): void => { if (depth > MAX_DEPTH || ++nodes > MAX_NODES) fail(); };
  const save = (path: string, unknown: Uint8Array[]): void => { if (unknown.length) extensions.set(path, unknown); };
  function fields(end: number, known: (id: number, wire: number) => boolean): Uint8Array[] {
    const unknown: Uint8Array[] = [];
    while (r.pos < end) {
      if (++fieldCount > MAX_NODES) return fail();
      const start = r.pos, tag = uint(r, end), id = tag >>> 3, wire = tag & 7; if (!id) return fail();
      if (!known(id, wire)) { tick(0); skip(r, wire, end); unknown.push(new Uint8Array(bytes.subarray(start, r.pos))); }
      if (r.pos > end) return fail();
    }
    return unknown;
  }
  function string(end: number): string { const stop = limit(r, end), value = utf8.decode(bytes.subarray(r.pos, stop)); r.pos = stop; return value; }
  function object(end: number, path: string, depth: number, dictionaries = false): Record<string, AttrValue> | AttributeDictionaries {
    tick(depth); const result: Record<string, AttrValue> = {};
    const unknown = fields(end, (id, wire) => {
      if (id !== 1) return false; if (wire !== 2) return fail();
      tick(depth); const stop = limit(r, end); let key: string | undefined, start = -1, valueEnd = -1;
      const entryUnknown = fields(stop, (field, type) => {
        if (field !== 1 && field !== 2) return false; if (type !== 2) return fail();
        if (field === 1) { if (key !== undefined) return fail(); key = string(stop); }
        else { if (start !== -1) return fail(); valueEnd = limit(r, stop); start = r.pos; r.pos = valueEnd; }
        return true;
      });
      if (key === undefined || start < 0) return fail();
      const child = keyPath(path, key); save(`${child}/entry`, entryUnknown); r.pos = start;
      const decoded = dictionaries ? object(valueEnd, `${child}/object`, depth + 1) : value(valueEnd, child, depth + 1);
      r.pos = stop; put(result, key, decoded); return true;
    });
    save(path, unknown); return result;
  }
  function value(end: number, path: string, depth: number): AttrValue {
    tick(depth); let selected = false, result: AttrValue = null;
    const unknown = fields(end, (id, wire) => {
      if (id > 6) return false;
      if (selected || wire !== (id === 3 ? 1 : id === 4 ? 0 : 2)) return fail(); selected = true;
      if (id === 1) save(`${path}/null`, fields(limit(r, end), () => false));
      else if (id === 2) result = string(end);
      else if (id === 3) { if (end - r.pos < 8) return fail(); result = r.double(); if (!Number.isFinite(result)) return fail(); }
      else if (id === 4) { const n = uint(r, end); if (n > 1) return fail(); result = n === 1; }
      else if (id === 6) result = object(limit(r, end), `${path}/object`, depth + 1);
      else {
        const stop = limit(r, end), list: AttrValue[] = [];
        save(`${path}/list`, fields(stop, (field, type) => {
          if (field !== 1) return false; if (type !== 2) return fail();
          list.push(value(limit(r, stop), `${path}/list/${list.length}`, depth + 1)); return true;
        })); result = list;
      }
      return true;
    });
    if (!selected) return fail(); save(path, unknown); return result;
  }
  try { return { value: object(bytes.length, '', 0, true) as AttributeDictionaries, extensions }; } catch { return fail(); }
}

/** Writes nested messages into one Protobuf writer, without nested encode/decode replicas. */
export function encodeNativeAttributes(value: AttributeDictionaries, extensions: AttributeExtensions = new Map()): Uint8Array {
  const w = protobuf.Writer.create(), ancestors = new Set<object>(); let nodes = 0, fieldCount = 0;
  function tick(depth: number): void { if (depth > MAX_DEPTH || ++nodes > MAX_NODES || w.len > MAX_BYTES) fail(); }
  function tag(value: number): void { if (++fieldCount > MAX_NODES) fail(); w.uint32(value); }
  function string(value: string): void {
    // UTF-8 cannot represent lone UTF-16 surrogates. Reject rather than silently replacing them.
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) fail();
      } else if (code >= 0xdc00 && code <= 0xdfff) fail();
    }
    w.string(value);
  }
  function unknown(path: string, maxKnown: number): void {
    for (const bytes of extensions.get(path) ?? []) {
      tick(0);
      if (!bytes.length) return fail(); const r = protobuf.Reader.create(bytes);
      const tag = uint(r, r.len), id = tag >>> 3;
      if (id <= maxKnown) return fail(); skip(r, tag & 7, r.len); if (r.pos !== r.len) return fail();
      if (++fieldCount > MAX_NODES) return fail();
      w.raw(bytes); if (w.len > MAX_BYTES) return fail();
    }
  }
  function enter(v: object): void { if (ancestors.has(v)) fail(); ancestors.add(v); }
  function message(field: number, emit: () => void): void { tag(field); w.fork(); emit(); w.ldelim(); if (w.len > MAX_BYTES) fail(); }
  function object(v: Record<string, AttrValue> | AttributeDictionaries, path: string, depth: number, dictionaries = false): void {
    tick(depth); if (v === null || typeof v !== 'object' || Array.isArray(v)) return fail(); enter(v);
    for (const key of Object.keys(v)) {
      tick(depth); const child = keyPath(path, key);
      message(10, () => {
        tag(10); string(key);
        message(18, () => dictionaries ? object(v[key] as Record<string, AttrValue>, `${child}/object`, depth + 1) : item(v[key]!, child, depth + 1));
        unknown(`${child}/entry`, 2);
      });
    }
    unknown(path, 1); ancestors.delete(v);
  }
  function item(v: AttrValue, path: string, depth: number): void {
    tick(depth);
    if (v === null) message(10, () => unknown(`${path}/null`, 0));
    else if (typeof v === 'string') { tag(18); string(v); }
    else if (typeof v === 'number') { if (!Number.isFinite(v)) return fail(); tag(25); w.double(v); }
    else if (typeof v === 'boolean') { tag(32); w.bool(v); }
    else if (Array.isArray(v)) {
      enter(v); message(42, () => { for (let i = 0; i < v.length; i++) message(10, () => item(v[i]!, `${path}/list/${i}`, depth + 1)); unknown(`${path}/list`, 1); }); ancestors.delete(v);
    } else if (typeof v === 'object') message(50, () => object(v, `${path}/object`, depth + 1));
    else return fail();
    unknown(path, 6);
  }
  object(value, '', 0, true); if (w.len > MAX_BYTES) return fail();
  return new Uint8Array(w.finish());
}
