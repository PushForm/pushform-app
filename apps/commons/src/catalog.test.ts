// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it, vi } from 'vitest';
import { catalogSchema, createCatalogLoader, filterModels } from './catalog';
import { exampleModel } from './catalog.fixture';

describe('catalog boundary', () => {
  it('retains upstream licenses and attribution without mapping to a fixed license list', () => {
    const model = exampleModel({ licenses: [{ name: 'Custom Redistribution License 2', url: 'https://example.com/custom', commercialUse: 'restricted', conditions: ['Redistribute unchanged with this notice.'] }] });
    expect(catalogSchema.parse({ version: 1, models: [model] }).models[0]).toEqual(model);
    expect(catalogSchema.safeParse({ version: 1, models: [{ ...model, licenses: [] }] }).success).toBe(false);
    expect(catalogSchema.safeParse({ version: 1, models: [{ ...model, credits: [] }] }).success).toBe(false);
  });
  it('rejects duplicate IDs, unsafe URLs, malformed dates and unsupported contract versions', () => {
    const model = exampleModel();
    for (const payload of [
      { version: 1, models: [model, model] }, { version: 2, models: [] },
      { version: 1, models: [{ ...model, imageUrl: 'javascript:alert(1)' }] },
      { version: 1, models: [{ ...model, source: { name: 'Source', url: 'https://user:password@example.com' } }] },
      { version: 1, models: [{ ...model, publishedAt: 'yesterday' }] },
    ]) expect(catalogSchema.safeParse(payload).success).toBe(false);
  });
  it('combines word search, exact facets and commercial permission across all included licenses', () => {
    const model = exampleModel();
    const mixed = exampleModel({ id: 'mixed', licenses: [...model.licenses, { name: 'Texture license', url: 'https://example.com/texture-license', commercialUse: 'unknown', conditions: [] }] });
    expect(filterModels([model, mixed], { query: 'EXAMPLE cabinet', category: 'Hardware', license: 'Attribution 3.0', commercial: true })).toEqual([model]);
    expect(filterModels([model], { query: '', category: 'Furniture', license: '', commercial: false })).toEqual([]);
    expect(filterModels([model], { query: '', category: '', license: 'Other license', commercial: false })).toEqual([]);
  });
  it('distinguishes no configuration, HTTP failure and malformed catalog data', async () => {
    expect(createCatalogLoader('')).toBeNull();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('unavailable', { status: 503 }));
    const loader = createCatalogLoader('https://example.com/catalog.json', fetcher)!;
    await expect(loader(new AbortController().signal)).rejects.toThrow('request failed');
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ version: 1, models: [{ title: 'Incomplete' }] })));
    await expect(loader(new AbortController().signal)).rejects.toThrow('metadata is invalid');
    const invalid = createCatalogLoader('http://example.com/catalog', fetcher)!;
    await expect(invalid(new AbortController().signal)).rejects.toThrow('Invalid catalog endpoint');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('fetches only public metadata without credentials and forwards cancellation', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ version: 1, models: [exampleModel()] })));
    const loader = createCatalogLoader('https://example.com/catalog.json', fetcher)!;
    expect(await loader(controller.signal)).toEqual([exampleModel()]);
    expect(fetcher).toHaveBeenCalledWith('https://example.com/catalog.json', expect.objectContaining({ credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' }));
    const pending = vi.fn<typeof fetch>().mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const request = createCatalogLoader('https://example.com/catalog.json', pending)!(controller.signal);
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  });
});
