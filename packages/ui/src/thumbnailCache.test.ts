// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { LocalThumbnailCache } from './thumbnailCache';

it('persists image bytes and pending uploads across instances, isolated by account', async () => {
  const factory = new IDBFactory(), cache = new LocalThumbnailCache(factory);
  const entry = { ownerId: 'alice', fileId: 'a', revisionId: 'r', jpeg: new Uint8Array([255, 216, 255, 217]), pendingUpload: true, touched: 1 };
  await cache.put(entry);
  const restarted = new LocalThumbnailCache(factory);
  expect(await restarted.get('alice', 'a')).toMatchObject(entry);
  expect(await restarted.get('bob', 'a')).toBeUndefined(); expect(await restarted.pending('bob')).toEqual([]);
  expect(await restarted.pending('alice')).toHaveLength(1);
  await restarted.put({ ...entry, pendingUpload: false });
  expect(await cache.pending('alice')).toEqual([]);
});

it('bounds the display cache without evicting pending uploads', async () => {
  const cache = new LocalThumbnailCache(new IDBFactory());
  const entry = { ownerId: 'alice', fileId: 'pending', revisionId: 'r', jpeg: new Uint8Array([1]), pendingUpload: true, touched: 0 };
  await cache.put(entry);
  for (let i = 0; i < 257; i++) await cache.put({ ...entry, fileId: String(i), pendingUpload: false, touched: i });
  expect(await cache.get('alice', '0')).toBeUndefined();
  expect(await cache.get('alice', '256')).toBeDefined();
  expect(await cache.pending('alice')).toHaveLength(1);
});
