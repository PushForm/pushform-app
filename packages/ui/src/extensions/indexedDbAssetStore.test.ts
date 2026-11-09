// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { indexedDbAssetStore } from './indexedDbAssetStore';
const description = (key: string, count=3) => ({key,version:1,contentType:'application/octet-stream',byteLength:count,sha256:'a'.repeat(64)});
it('persists named bytes across store instances and isolates accounts and extension namespaces', async () => {
  const factory = new IDBFactory(), a = indexedDbAssetStore('alice',factory), b = indexedDbAssetStore('bob',factory), data = new Uint8Array([1,2,3]);
  const first = await a.put('com.example.a',description('Library'),data,null); data.fill(9);
  const reopened = indexedDbAssetStore('alice',factory);
  expect(Array.from((await reopened.read('com.example.a','Library'))!.bytes)).toEqual([1,2,3]);
  expect((await reopened.list('com.example.a',null,1)).entries[0]).toEqual(first);
  expect(await b.read('com.example.a','Library')).toBeNull(); expect(await a.read('com.example.b','Library')).toBeNull();
  await a.put('com.example.b',description('Library'),data,null); await reopened.clear('com.example.a');
  expect(await a.read('com.example.a','Library')).toBeNull(); expect(await a.read('com.example.b','Library')).not.toBeNull();
});
it('performs compare-and-swap in one transaction across two writers and keeps revisions monotonic after deletion', async () => {
  const factory = new IDBFactory(), a = indexedDbAssetStore('alice',factory), b = indexedDbAssetStore('alice',factory), data = new Uint8Array([1,2,3]);
  const original = await a.put('com.example.a',description('Library'),data,null);
  const race = await Promise.allSettled([a.put('com.example.a',description('Library'),data,original.revision),b.put('com.example.a',description('Library'),data,original.revision)]);
  expect(race.filter(result=>result.status==='fulfilled')).toHaveLength(1); expect(race.find(result=>result.status==='rejected')).toMatchObject({reason:{code:'revision.stale'}});
  const current = (await a.read('com.example.a','Library'))!.asset;
  await expect(a.remove('com.example.a','Library',original.revision)).rejects.toMatchObject({code:'revision.stale'});
  await b.remove('com.example.a','Library',current.revision); const again = await a.put('com.example.a',description('Library'),data,null);
  expect(again.revision).toBeGreaterThan(current.revision);
  await expect(b.put('com.example.a',description('Library'),data,original.revision)).rejects.toMatchObject({code:'revision.stale'});
});
it('rejects cancelled or inconsistent writes before changing durable catalog or bytes', async () => {
  const a = indexedDbAssetStore('alice',new IDBFactory()), data = new Uint8Array([1,2,3]);
  await expect(a.put('com.example.a',description('Library'),data,null,AbortSignal.abort())).rejects.toThrow();
  await expect(a.put('com.example.a',description('Library',4),data,null)).rejects.toMatchObject({code:'validation.failed'});
  expect((await a.list('com.example.a',null,100)).entries).toEqual([]);
});
