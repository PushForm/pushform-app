// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it, vi } from 'vitest';
import { createCommonsBrowseLoader, createCommonsModelsLoader } from './CommonsBrowse';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './db.types';
const filters = { query: 'cabinet', category: 'Furniture', license: 'CC0', commercial: true };
const model = (id: string) => ({ id, revision: '1', title: id, description: '', creator: 'Maker', category: 'Furniture', tags: [], formats: ['STL'], imageUrl: null, source: null, publishedAt: '2026-01-01T00:00:00Z', files: [], licenses: [{ name: 'CC0', url: null, commercialUse: 'allowed', conditions: [] }], credits: [{ name: 'Maker', url: null, text: 'Original' }] });
function fixture(data: unknown) {
  const rpc = vi.fn(() => ({ abortSignal: () => Promise.resolve({ data, error: null }) }));
  return { rpc, client: { rpc } as unknown as SupabaseClient<Database> };
}
it('requests a bounded filtered page and carries the snapshot cursor forward', async () => {
  const nextCursor = { id: 'cabinet', publishedAt: '2026-01-01T00:00:00Z' }, asOf = '2026-11-05T00:00:00Z';
  const f = fixture({ version: 1, models: [model('cabinet')], nextCursor, asOf, total: 30, categories: ['Furniture'], licenses: ['CC0'] });
  const page = await createCommonsBrowseLoader(f.client)(filters, null, new AbortController().signal);
  expect(page.next).toEqual({ ...nextCursor, asOf });
  expect(f.rpc).toHaveBeenCalledWith('commons_browse', { p_query: 'cabinet', p_category: 'Furniture', p_license: 'CC0', p_commercial: true, p_limit: 24 });
});
it('rejects pages with duplicate models or a cursor that does not advance', async () => {
  const data = { version: 1, models: [model('cabinet'), model('cabinet')], nextCursor: null, asOf: '2026-11-05T00:00:00Z', total: 2, categories: [], licenses: [] };
  await expect(createCommonsBrowseLoader(fixture(data).client)(filters, null, new AbortController().signal)).rejects.toThrow('out of order');
  await expect(createCommonsBrowseLoader(fixture({ ...data, models: [model('cabinet')], nextCursor: { id: 'wrong', publishedAt: '2026-01-01T00:00:00Z' } }).client)(filters, null, new AbortController().signal)).rejects.toThrow('did not advance');
});
it('loads explicit featured model IDs without fetching the entire catalog', async () => {
  const f = fixture([model('cabinet')]);
  const models = await createCommonsModelsLoader(f.client)(['cabinet', 'cabinet'], new AbortController().signal);
  expect(models).toHaveLength(1); expect(f.rpc).toHaveBeenCalledWith('commons_catalog_models', { p_ids: ['cabinet'] });
});
