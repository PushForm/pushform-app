// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { BrowseImageCache, BrowseImagesProvider } from '@pushform/commons-ui/BrowseImages';
import { commonsImageSources } from '@pushform/commons-ui/modelImages';
import { CommonsThumbnail } from './CommonsPreview';
import { exampleModel } from './catalog.fixture';

const caches: BrowseImageCache[] = [];
let createUrl = vi.fn((_blob: Blob | MediaSource) => '');
let revokeUrl = vi.fn((_url: string) => {});
beforeEach(() => {
  let id = 0; createUrl = vi.fn((_blob: Blob | MediaSource) => `blob:image-${++id}`); revokeUrl = vi.fn((_url: string) => {});
  vi.stubGlobal('URL', class extends URL { static override createObjectURL = createUrl; static override revokeObjectURL = revokeUrl; });
  vi.stubGlobal('Image', class { src = ''; decode = () => Promise.resolve(); removeAttribute() {} });
});
afterEach(() => { cleanup(); for (const cache of caches.splice(0)) cache.dispose(); vi.unstubAllGlobals(); });
const cache = () => { const value = new BrowseImageCache(); caches.push(value); return value; };
const imageModel = (id: number) => exampleModel({ id: `model-${id}`, imageUrl: `https://example.com/image-${id}.png` });
const imageResponse = (size = 10) => new Response(new Uint8Array(size), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } });

it('reuses a decoded no-store thumbnail without another image or status request', async () => {
  const fetcher = vi.fn().mockImplementation(async () => imageResponse()); vi.stubGlobal('fetch', fetcher);
  const files = ['a-notices.zip', 'b-source.FCStd', 'c-model.step', 'd-model.pf'].map((name, i) => ({ name, id: `11111111-1111-4111-8111-11111111111${i}`, format: name.split('.').at(-1)!, sizeBytes: 10, sha256: 'a'.repeat(64) }));
  const model = exampleModel({ files }); const value = cache(); const base = 'https://files.example.com';
  const url = commonsImageSources(model, base)[0]!;
  value.prefetch([model], base);
  await waitFor(() => expect(value.get(url)?.status).toBe('ready'));
  const view = render(<BrowseImagesProvider value={value}><CommonsThumbnail model={model} filesUrl={base}/></BrowseImagesProvider>);
  expect([...view.container.querySelectorAll('img')].map(image => image.getAttribute('src'))).toEqual(['blob:image-1']);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledWith(`${base}/thumbnails/${files[3]!.id}`, expect.objectContaining({ credentials: 'omit', priority: 'low' }));
  value.prefetch([model], base); expect(fetcher).toHaveBeenCalledTimes(1);
});

it('warms the entire next page with bounded concurrency and cancels queued work on disposal', async () => {
  const signals: AbortSignal[] = [];
  const fetcher = vi.fn((_url, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init.signal!; signals.push(signal);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  })); vi.stubGlobal('fetch', fetcher);
  const value = cache(), models = Array.from({ length: 24 }, (_, i) => imageModel(i));
  value.prefetch(models);
  expect(fetcher).toHaveBeenCalledTimes(8);
  expect(value.get(models[23]!.imageUrl!)?.status).toBe('loading');
  value.dispose(); await Promise.resolve();
  expect(signals.every(signal => signal.aborted)).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(8);
});

it('warms every thumbnail, falls back for pending renders, and releases URLs when browsing ends', async () => {
  const fetcher = vi.fn().mockImplementation(async () => imageResponse()); vi.stubGlobal('fetch', fetcher);
  const value = cache(), models = Array.from({ length: 24 }, (_, i) => imageModel(i));
  value.prefetch(models);
  await waitFor(() => expect(value.get(models[23]!.imageUrl!)?.status).toBe('ready'));
  expect(fetcher).toHaveBeenCalledTimes(24);
  fetcher.mockResolvedValueOnce(new Response('{"status":"queued"}', { status: 202, headers: { 'Content-Type': 'application/json' } }));
  const pending = imageModel(25); value.prefetch([pending]);
  await waitFor(() => expect(value.get(pending.imageUrl!)?.status).toBe('error'));
  expect(createUrl).toHaveBeenCalledTimes(24);
  value.dispose(); expect(revokeUrl).toHaveBeenCalledTimes(24);
});

it('evicts unused images at the memory limit while keeping images used by mounted cards', async () => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => imageResponse(8 * 1024 * 1024)));
  const value = cache(), first = imageModel(0); value.prefetch([first]);
  await waitFor(() => expect(value.get(first.imageUrl!)?.status).toBe('ready'));
  const release = value.retain(first.imageUrl!);
  for (let i = 1; i <= 4; i++) {
    const model = imageModel(i); value.prefetch([model]);
    await waitFor(() => expect(value.get(model.imageUrl!)?.status).toBe('ready'));
  }
  expect(value.get(first.imageUrl!)?.status).toBe('ready');
  expect(value.get(imageModel(1).imageUrl!)).toBeUndefined();
  expect(revokeUrl).toHaveBeenCalledTimes(1); release();
});
