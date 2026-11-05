// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { commonsDiscoverySchema, commonsCollectionError } from './CommonsCollections';
import { commonsFileUrl } from './CommonsFiles';
const collection = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: 'Fixtures', description: '', visibility: 'public', version: 1, updatedAt: '2026-11-04T00:00:00Z', curator: null, modelIds: ['example-model'] };
it('rejects private collection data, duplicate entries and malformed typed targets in public discovery', () => {
  const good = { version: 1, collections: [collection], featured: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', type: 'collection', targetId: collection.id }] };
  expect(commonsDiscoverySchema.safeParse(good).success).toBe(true);
  expect(commonsDiscoverySchema.safeParse({ ...good, collections: [{ ...collection, visibility: 'private' }] }).success).toBe(false);
  expect(commonsDiscoverySchema.safeParse({ ...good, featured: [...good.featured, ...good.featured] }).success).toBe(false);
  expect(commonsDiscoverySchema.safeParse({ ...good, featured: [{ ...good.featured[0], targetId: 'bad-collection-id' }] }).success).toBe(false);
  expect(commonsDiscoverySchema.safeParse({ ...good, collections: [{ ...collection, owner_id: 'private-user' }] }).success).toBe(false);
});
it('explains conflict and permission failures without exposing server diagnostics', () => {
  expect(commonsCollectionError({ message: 'commons_collection_conflict' }).message).toContain('another tab');
  expect(commonsCollectionError({ message: 'admin_forbidden' }).message).toContain('admin permission');
  expect(commonsCollectionError({ message: 'private database diagnostics' }).message).not.toContain('diagnostics');
});
it('treats an empty or malformed optional file origin as unconfigured', () => {
  expect(commonsFileUrl('', 'thumbnails')).toBeNull();
  expect(commonsFileUrl('not a URL', 'thumbnails')).toBeNull();
});
