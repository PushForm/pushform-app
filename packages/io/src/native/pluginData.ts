// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { PLUGIN_DATA_LIMITS, validatePluginData, type PluginData, type PluginEntry } from '@pushform/model';
import { NativeChunkError } from './chunks';

const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
/** Each record has a JSON ownership/reference envelope followed by opaque entry payloads. */
export function encodeNativePluginData(data: PluginData): Uint8Array {
  validatePluginData(data);
  const pieces: Uint8Array[] = [];
  const append = (bytes: Uint8Array): void => {
    const size = new Uint8Array(4); new DataView(size.buffer).setUint32(0, bytes.length, true);
    pieces.push(size, bytes);
  };
  for (const [owner, record] of data) {
    append(encoder.encode(JSON.stringify({ owner, dataVersion: record.dataVersion, entries: [...record.entries].map(([id, e]) => ({ id, target: e.target, references: e.references, needsReview: e.needsReview })) })));
    for (const entry of record.entries.values()) append(entry.payload);
  }
  const length = pieces.reduce((n, p) => n + p.length, 0);
  if (length > PLUGIN_DATA_LIMITS.document) throw new NativeChunkError('Plugin data section is too large');
  const out = new Uint8Array(length); let at = 0;
  for (const p of pieces) { out.set(p, at); at += p.length; }
  return out;
}
export function decodeNativePluginData(bytes: Uint8Array): PluginData {
  if (bytes.length > PLUGIN_DATA_LIMITS.document) throw new NativeChunkError('Plugin data section is too large');
  let at = 0;
  const take = (limit: number): Uint8Array => {
    if (at + 4 > bytes.length) throw new NativeChunkError('Truncated plugin data');
    const length = new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0, true); at += 4;
    if (length > limit || at + length > bytes.length) throw new NativeChunkError('Invalid plugin data length');
    const value = bytes.slice(at, at + length); at += length; return value;
  };
  const data: PluginData = new Map();
  try {
    while (at < bytes.length) {
      const envelope = JSON.parse(decoder.decode(take(PLUGIN_DATA_LIMITS.record))) as { owner: string; dataVersion: number; entries: { id: string; target: PluginEntry['target']; references: PluginEntry['references']; needsReview?: boolean }[] };
      if (!envelope || typeof envelope.owner !== 'string' || !Array.isArray(envelope.entries) || data.has(envelope.owner)) throw new Error('Invalid plugin ownership');
      const entries = new Map<string, PluginEntry>();
      for (const entry of envelope.entries) {
        if (!entry || entries.has(entry.id)) throw new Error('Duplicate plugin entry');
        entries.set(entry.id, { target: entry.target, references: entry.references, ...(entry.needsReview !== undefined ? { needsReview: entry.needsReview } : {}), payload: take(PLUGIN_DATA_LIMITS.entry) });
      }
      data.set(envelope.owner, { dataVersion: envelope.dataVersion, entries });
    }
    validatePluginData(data);
    return data;
  } catch { throw new NativeChunkError('Invalid native plugin data'); }
}
