// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { NativeRecoveryStore } from './nativeRecovery';
import { loadNativeRefresh, NativeRefreshWriter } from './nativeRefresh';
import { DocumentSession } from './session';
import { createApp } from './bootstrap';
import { contentSerializations, resetContentSerializations } from './documentContent';
import { allocId } from '@pushform/model';
import type { ImageId } from '@pushform/core';
const sessions: DocumentSession[] = [];
afterEach(async () => { for (const session of sessions.splice(0)) { session.dispose(); await session.settledNativeRecovery(); } });
function storage() {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}
it('coalesces pending revisions and reuses durable bytes for metadata-only changes', async () => {
  const store = new NativeRecoveryStore(new IDBFactory(), 'tab'), errors: unknown[] = [], writer = new NativeRefreshWriter(store, e => errors.push(e));
  let unblock!: () => void, encoded = 0;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  const a = {}, b = {}, c = {};
  const snapshot = (state: object, name: string, blocked = false) => ({ activeIndex: 0, entries: [{ key: 'doc', state, metadata: name,
    encode: async () => { encoded++; if (blocked) await gate; return new Uint8Array([encoded]); } }] });
  writer.request(snapshot(a, 'a', true)); writer.request(snapshot(b, 'b')); writer.request(snapshot(c, 'c')); unblock(); await writer.settled();
  expect(encoded).toBe(2); expect((await store.head())!.entries[0]!.metadata).toBe('c');
  writer.request(snapshot(c, 'renamed')); await writer.settled(); expect(encoded).toBe(2);
  expect((await store.head())!.entries[0]!.metadata).toBe('renamed'); expect(errors).toEqual([]);
});
it('restores mixed native tabs and active selection without serializing model recovery JSON', async () => {
  const factory = new IDBFactory(), saved = storage(), native = await loadNativeRefresh(saved, factory);
  const session = new DocumentSession(createApp({ demo: false, expose: false }), () => createApp({ demo: false, expose: false }), true, null, saved, null, native);
  sessions.push(session);
  const model = session.active; if (model.type !== 'model') throw new Error('model expected');
  model.app.document.doc.transact('name', d => { d.definitions.get(d.rootDefinitionId)!.name = 'First model'; });
  const second = session.newModel(); second.app.document.doc.transact('name', d => { d.definitions.get(d.rootDefinitionId)!.name = 'Second model'; });
  session.markModelSaved(second.id, 'Second');
  const layout = session.newLayout(); session.activate(second.id);
  resetContentSerializations(); session.flushRefreshPersistence(); await session.settledNativeRecovery();
  expect(contentSerializations.modelSessionJson).toBe(0);
  expect(contentSerializations.layoutJson).toBe(0);
  expect([...saved.data.values()].join('').length).toBeLessThan(1000);
  const loaded = await loadNativeRefresh(saved, factory); expect(loaded!.head!.entries).toHaveLength(3);
  const bytes = await loaded!.store.read(loaded!.head!.entries[0]!.id);
  expect(new TextDecoder().decode(bytes!.subarray(0, 8))).toBe('PUSHFRM2');
  const layoutBytes = await loaded!.store.read(loaded!.head!.entries[2]!.id);
  expect(new TextDecoder().decode(layoutBytes!.subarray(0, 8))).toBe('PUSHFRM2');
  const restored = new DocumentSession(createApp({ demo: false, expose: false }), () => createApp({ demo: false, expose: false }), true, null, saved, null, loaded);
  sessions.push(restored);
  expect(restored.restoredForRefresh).toBe(true); expect(restored.tabs).toHaveLength(3); expect(restored.active.name).toBe('Second.pf');
  expect(restored.isDirty(restored.active)).toBe(false); expect(restored.isDirty(restored.tabs[0]!)).toBe(true);
  expect(restored.tabs[2]!.name).toBe(layout.name);
  if (restored.active.type === 'model') expect(restored.active.app.document.doc.rootDefinition.name).toBe('Second model');
});
it('keeps the previous checkpoint after an encoder failure and allows a later retry', async () => {
  const store = new NativeRecoveryStore(new IDBFactory(), 'tab'), errors: unknown[] = [], writer = new NativeRefreshWriter(store, e => errors.push(e));
  writer.request({ activeIndex: 0, entries: [{ key: 'a', state: {}, metadata: 'old', encode: async () => new Uint8Array([1]) }] }); await writer.settled();
  writer.request({ activeIndex: 0, entries: [{ key: 'a', state: {}, metadata: 'bad', encode: async () => { throw new Error('quota'); } }] }); await writer.settled();
  expect((await store.head())!.entries[0]!.metadata).toBe('old'); expect(errors).toHaveLength(1);
  writer.request({ activeIndex: 0, entries: [{ key: 'a', state: {}, metadata: 'retry', encode: async () => new Uint8Array([2]) }] }); await writer.settled();
  expect((await store.head())!.entries[0]!.metadata).toBe('retry');
});
it('recovers image bytes beyond session-storage quota without placing the bytes in metadata', async () => {
  const factory = new IDBFactory(), saved = storage(), native = await loadNativeRefresh(saved, factory);
  const session = new DocumentSession(createApp({ demo: false, expose: false }), () => createApp({ demo: false, expose: false }), true, null, saved, null, native);
  sessions.push(session); const tab = session.active; if (tab.type !== 'model') throw new Error('model expected');
  const bytes = new Uint8Array(6 * 1024 * 1024); bytes[0] = 137; bytes[bytes.length - 1] = 71;
  const asset = tab.app.document.doc.transact('image', d => {
    const id = allocId<ImageId>(d), asset = { id, name: 'large.png', mime: 'image/png', width: 1, height: 1, sha256: 'fixture-large' };
    d.images.set(id, asset); return asset;
  }).value;
  tab.app.document.images.register(asset, bytes, asset.mime);
  session.flushRefreshPersistence(); await session.settledNativeRecovery();
  expect(session.recoveryError).toBeNull(); expect([...saved.data.values()].join('').length).toBeLessThan(1000);
  const loaded = await loadNativeRefresh(saved, factory), file = [...loaded!.files.values()][0]!;
  expect(file.kind).toBe('model'); if (file.kind !== 'model') throw new Error('model expected');
  const recovered = file.file.images.get(asset.id)!.bytes;
  expect(recovered.length).toBe(bytes.length); expect(recovered.every((value, i) => value === bytes[i])).toBe(true);
  expect(loaded!.head!.entries[0]!.metadata.length).toBeLessThan(1000);
});

it('reports each recovery entry before reading it, including damaged entries', async () => {
  const factory = new IDBFactory(), saved = storage(), initial = await loadNativeRefresh(saved, factory);
  const store = initial!.store;
  await store.stage('broken-a', new Uint8Array([1]));
  await store.stage('broken-b', new Uint8Array([2]));
  await store.publish({ version: 1, activeIndex: 1, entries: [
    { id: 'broken-a', metadata: JSON.stringify({ type: 'model', name: 'Garage.pf' }) },
    { id: 'broken-b', metadata: JSON.stringify({ type: 'model', name: 'Garage V3.pf' }) },
  ] });
  const reads = vi.spyOn(NativeRecoveryStore.prototype, 'read');
  const progress: unknown[] = [];
  const loaded = await loadNativeRefresh(saved, factory, async current => {
    progress.push(current);
    expect(reads).toHaveBeenCalledTimes(current.completed);
  });
  expect(progress).toEqual([
    { name: 'Garage.pf', completed: 0, total: 2 },
    { name: 'Garage V3.pf', completed: 1, total: 2 },
    { name: null, completed: 2, total: 2 },
  ]);
  expect(loaded!.files.size).toBe(0);
  reads.mockRestore();
});
