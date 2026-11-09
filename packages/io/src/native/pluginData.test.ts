// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createDocument, encodePluginValue, preparePluginEntry, readPluginValue, validatePluginData, type PluginData } from '@pushform/model';
import { decodeNativePluginData, encodeNativePluginData } from './pluginData';
import { decodeNativeModelFile, encodeNativeModelFile } from './modelFile';
import { modelContentIdentity } from './modelIdentity';

const records = (): PluginData => new Map([['io.example.parts', { dataVersion: 2, entries: new Map([
  ['job', preparePluginEntry({ kind: 'document' }, { units: 'model', label: 'Birch 棚' }, [], () => true)],
]) }]]);

it('round trips opaque payloads without parsing them or requiring installed plugins', () => {
  const data = records();
  data.get('io.example.parts')!.entries.get('job')!.payload = new Uint8Array([255, 0, 128]);
  data.get('io.example.parts')!.entries.get('job')!.needsReview = true;
  expect(decodeNativePluginData(encodeNativePluginData(data))).toEqual(data);
});
it('rejects non-JSON values, cycles, accessors, excessive depth and oversized entries', () => {
  const cyclic: unknown[] = []; cyclic.push(cyclic);
  for (const value of [undefined, NaN, Infinity, new Date(), { missing: undefined }, cyclic, { get value() { throw Error('Getter executed'); } }]) {
    expect(() => encodePluginValue(value)).toThrow();
  }
  let deep: unknown = null; for (let i = 0; i < 34; i++) deep = [deep];
  expect(() => encodePluginValue(deep)).toThrow(/deep/);
  expect(() => encodePluginValue('x'.repeat(256 * 1024))).toThrow(/large/);
});
it('validates schemas before creating an owned copy and refuses newer data reads', () => {
  expect(() => preparePluginEntry({ kind: 'document' }, { label: 12 }, [], () => false)).toThrow(/schema/);
  const target = { kind: 'bodyOccurrence' as const, id: 5, path: [1, 2] };
  const entry = preparePluginEntry(target, { label: 'Door' }, [], () => true);
  target.path.push(9);
  expect(entry.target).toEqual({ kind: 'bodyOccurrence', id: 5, path: [1, 2] });
  const record = records().get('io.example.parts')!;
  expect(() => readPluginValue(record, 'job', 1)).toThrow(/newer/);
  expect(readPluginValue(record, 'job', 2)).toEqual({ units: 'model', label: 'Birch 棚' });
});
it('rejects invalid envelope targets and truncated binary records', () => {
  const data = records();
  data.get('io.example.parts')!.entries.get('job')!.target = { kind: 'bodyOccurrence', id: 4, path: [-1] };
  expect(() => validatePluginData(data)).toThrow(/path/);
  const encoded = encodeNativePluginData(records());
  expect(() => decodeNativePluginData(encoded.subarray(0, encoded.length - 1))).toThrow();
  expect(() => decodeNativePluginData(new Uint8Array([255, 255, 255, 255]))).toThrow();
});
it('enforces aggregate record and document budgets even for shared byte buffers', () => {
  const payload = encodePluginValue('x'.repeat(240 * 1024));
  const entry = { target: { kind: 'document' as const }, references: [], payload };
  const record = { dataVersion: 1, entries: new Map(Array.from({ length: 18 }, (_, i) => [String(i), entry])) };
  expect(() => validatePluginData(new Map([['io.test', record]]))).toThrow(/record/);
  record.entries.delete('17'); record.entries.delete('16');
  expect(() => validatePluginData(new Map(Array.from({ length: 9 }, (_, i) => [`io.test${i}`, record])))).toThrow(/Document/);
});
it('treats an empty metadata section as absent for native content identity', async () => {
  const doc = createDocument();
  const original = modelContentIdentity(doc.state);
  doc.transact('Empty metadata index', d => { d.pluginData = new Map(); });
  expect(modelContentIdentity(doc.state)).toBe(original);
  const bytes = await encodeNativeModelFile(doc.state);
  const opened = await decodeNativeModelFile({ size: bytes.length, read: async (at, length) => bytes.subarray(at, at + length) });
  expect(modelContentIdentity(opened.state)).toBe(original);
});
it('preserves metadata through native save, geometry-independent editing, undo and reopen', async () => {
  const doc = createDocument();
  const before = modelContentIdentity(doc.state);
  const tx = doc.transact('Plugin metadata', draft => { draft.pluginData = records(); });
  expect(modelContentIdentity(doc.state)).not.toBe(before);
  const expected = modelContentIdentity(doc.state);
  const bytes = await encodeNativeModelFile(doc.state);
  const reopened = await decodeNativeModelFile({ size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) });
  expect(reopened.state.pluginData).toEqual(doc.state.pluginData);
  expect(modelContentIdentity(reopened.state)).toBe(expected);
  bytes.fill(0);
  expect(readPluginValue(reopened.state.pluginData!.get('io.example.parts')!, 'job', 2)).toEqual({ units: 'model', label: 'Birch 棚' });
  doc.applyPatches(tx.inversePatches, tx.patches, 'undo', 'Plugin metadata');
  expect(modelContentIdentity(doc.state)).toBe(before);
  doc.applyPatches(tx.patches, tx.inversePatches, 'redo', 'Plugin metadata');
  expect(modelContentIdentity(doc.state)).toBe(expected);
});

it('rejects an oversized metadata transaction atomically with its other edits', () => {
  const doc = createDocument(), before = doc.state, version = doc.version;
  expect(() => doc.transact('Invalid metadata batch', draft => {
    draft.meta.nextId += 10;
    const data = records();
    data.get('io.example.parts')!.entries.get('job')!.payload = new Uint8Array(300 * 1024);
    draft.pluginData = data;
  })).toThrow(/large/);
  expect(doc.state).toBe(before);
  expect(doc.version).toBe(version);
});
