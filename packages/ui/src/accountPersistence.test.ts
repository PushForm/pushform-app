// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import { IndexedDbLayoutRecoveryStore } from '@pushform/io';
import type { LayoutRecoveryRecord, LayoutRecoveryStore } from '@pushform/io';
import { accountRecoveryStore, accountSessionStorage } from './accountPersistence';
it('isolates refresh snapshots without deleting another account or legacy data', () => {
  const data = new Map<string, string>([['draft', 'legacy']]);
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  const alice = accountSessionStorage('alice', storage), bob = accountSessionStorage('bob', storage);
  alice.setItem('draft', 'Alice private'); bob.setItem('draft', 'Bob private');
  expect(alice.getItem('draft')).toBe('Alice private'); expect(bob.getItem('draft')).toBe('Bob private');
  expect(storage.getItem('draft')).toBe('legacy');
  alice.removeItem('draft'); expect(alice.getItem('draft')).toBeNull(); expect(bob.getItem('draft')).toBe('Bob private');
});

it('restricts binary draft reads in IndexedDB before returning payloads', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  const reads = vi.spyOn(IDBObjectStore.prototype, 'getAll');
  try {
    const store = new IndexedDbLayoutRecoveryStore();
    const alice = accountRecoveryStore('alice', store)!;
    const record = { id: 'draft', name: 'Private.pfl', savedContent: '', modifiedAt: 0, bytes: new Uint8Array([1, 2, 3]) };
    await alice.put(record);
    for (const id of ['legacy', 'account:alice-other:draft', 'account:bob:draft']) {
      await store.put({ ...record, id, bytes: new Uint8Array(1024 * 1024) });
    }
    const listed = await alice.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual({ id: record.id, name: record.name, savedContent: '', modifiedAt: 0 });
    expect((reads.mock.instances[0] as IDBObjectStore).name).toBe('metadata');
    const loaded = await alice.read('draft');
    expect(Array.from(loaded!.bytes)).toEqual([1, 2, 3]);
    const range = reads.mock.calls[0]![0] as IDBKeyRange;
    expect(range).toBeInstanceOf(IDBKeyRange);
    expect(range.includes('account:alice:draft')).toBe(true);
    expect(range.includes('account:alice:\uffffsuffix')).toBe(true);
    expect(range.includes('account:alice-other:draft')).toBe(false);
    expect(range.includes('account:bob:draft')).toBe(false);
    expect(range.includes('legacy')).toBe(false);
    await alice.delete('draft');
    expect(await alice.list()).toEqual([]);
    expect(await alice.read('draft')).toBeUndefined();
    expect(await store.list()).toHaveLength(3);
  } finally {
    reads.mockRestore();
    vi.unstubAllGlobals();
  }
});

it.each(['synchronous', 'asynchronous'])('retains the previous binary draft when its metadata write fails (%s)', async failure => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  try {
    const store = new IndexedDbLayoutRecoveryStore();
    const record = { id: 'draft', name: 'Before.pfl', savedContent: '', modifiedAt: 1, bytes: new Uint8Array([1]) };
    await store.put(record);
    const original = IDBObjectStore.prototype.put;
    const writes = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === 'metadata') {
        if (failure === 'asynchronous') return this.add(value); // Duplicate primary key aborts the transaction.
        throw new DOMException('Metadata write failed', 'DataCloneError');
      }
      return original.call(this, value, key);
    });
    try {
      await expect(store.put({ ...record, name: 'After.pfl', bytes: new Uint8Array([2]) })).rejects.toThrow();
    } finally { writes.mockRestore(); }
    const restored = await store.read(record.id);
    expect(restored!.name).toBe('Before.pfl');
    expect(Array.from(restored!.bytes)).toEqual([1]);
    expect(await store.list()).toEqual([{ id: 'draft', name: 'Before.pfl', savedContent: '', modifiedAt: 1 }]);
  } finally { vi.unstubAllGlobals(); }
});
it('partitions recovery listing, writes, and deletes by account', async () => {
  const data = new Map<string, LayoutRecoveryRecord>();
  const storage: LayoutRecoveryStore = { list: async () => [...data.values()], read: async id => data.get(id), put: async record => { data.set(record.id, record); }, delete: async id => { data.delete(id); } };
  const alice = accountRecoveryStore('alice', storage)!, bob = accountRecoveryStore('bob', storage)!;
  const record = { id: 'draft', name: 'Private.pfl', savedContent: '', modifiedAt: 0, bytes: new Uint8Array() };
  await alice.put(record); expect(await bob.list()).toEqual([]); expect(await alice.list()).toEqual([record]);
  await bob.delete('draft'); expect(await alice.list()).toHaveLength(1);
  await alice.delete('draft'); expect(await storage.list()).toEqual([]);
});
