// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { NativeRecoveryStore } from './nativeRecovery';
const head = (id: string) => ({ version: 1 as const, activeIndex: 0, entries: [{ id, metadata: '{"name":"Garage"}' }] });
it('publishes durable versions atomically and removes only this account/tab scope', async () => {
  const factory = new IDBFactory(), a = new NativeRecoveryStore(factory, 'account-a/tab-1'), b = new NativeRecoveryStore(factory, 'account-b/tab-1');
  const bytes = new Uint8Array([1, 2, 3]);
  await a.stage('first', bytes); bytes.fill(0); await a.publish(head('first'));
  await b.stage('first', new Uint8Array([9])); await b.publish(head('first'));
  await a.stage('next', new Uint8Array([4, 5]));
  expect(await a.head()).toEqual(head('first')); // Staging alone never changes the recovery head.
  await a.publish(head('next'));
  expect(await a.read('first')).toBeUndefined(); expect(await a.read('next')).toEqual(new Uint8Array([4, 5]));
  expect(await b.read('first')).toEqual(new Uint8Array([9])); expect(await b.head()).toEqual(head('first'));
});
it('keeps the previous head and bytes after an incomplete publication or duplicate write', async () => {
  const store = new NativeRecoveryStore(new IDBFactory(), 'tab');
  await store.stage('saved', new Uint8Array([7])); await store.publish(head('saved'));
  await expect(store.publish(head('missing'))).rejects.toThrow('not durable');
  await expect(store.stage('saved', new Uint8Array([8]))).rejects.toThrow();
  expect(await store.head()).toEqual(head('saved')); expect(await store.read('saved')).toEqual(new Uint8Array([7]));
});
it('captures head metadata before asynchronous work and supports closing all tabs', async () => {
  const store = new NativeRecoveryStore(new IDBFactory(), 'tab'); await store.stage('one', new Uint8Array([1]));
  const value = head('one'), pending = store.publish(value); value.entries[0]!.metadata = 'changed'; await pending;
  expect(await store.head()).toEqual(head('one'));
  await store.publish({ version: 1, activeIndex: -1, entries: [] }); expect(await store.read('one')).toBeUndefined();
});
it('rejects invalid or oversized heads without changing stored recovery', async () => {
  const store = new NativeRecoveryStore(new IDBFactory(), 'tab');
  await expect(store.publish({ ...head('one'), activeIndex: 2 })).rejects.toThrow('Invalid');
  await expect(store.publish({ version: 1, activeIndex: 0, entries: [head('one').entries[0]!, head('one').entries[0]!] })).rejects.toThrow('Invalid');
  await expect(store.publish({ version: 1, activeIndex: 0, entries: [{ id: 'one', metadata: 'a'.repeat(1024 * 1024 + 1) }] })).rejects.toThrow('limit');
  expect(await store.head()).toBeUndefined();
});
