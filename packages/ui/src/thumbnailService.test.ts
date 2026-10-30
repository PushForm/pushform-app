// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import type { CloudFile, CloudFilesApi } from '@pushform/cloud';
import { ThumbnailService, THUMBNAIL_INTERVAL_MS } from './thumbnailService';
import { LocalThumbnailCache } from './thumbnailCache';

const file = (id = 'a', revision = 1): CloudFile => ({ id, project_id: 'p', folder_id: null, name: `${id}.pf`, kind: 'model', current_revision_id: `r${revision}`, revision_number: revision, size_bytes: 1, updated_at: '' });
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const entry = (pendingUpload = false) => ({ ownerId: 'alice', fileId: 'a', revisionId: 'r1', jpeg, pendingUpload, touched: 0 });
const services: ThumbnailService[] = [];
afterEach(() => { for (const service of services) service.dispose(); services.length = 0; vi.useRealTimers(); });
function setup(options: Partial<ConstructorParameters<typeof ThumbnailService>[0]> = {}) {
  const api = { thumbnailUrls: vi.fn().mockResolvedValue(new Map()), head: vi.fn().mockResolvedValue({ file: file() }), saveThumbnail: vi.fn().mockResolvedValue(undefined) };
  const render = vi.fn().mockResolvedValue(jpeg), cache = new LocalThumbnailCache(undefined);
  const service = new ThumbnailService({ api: api as unknown as CloudFilesApi, render, cache, ownerId: 'alice', online: () => true, ...options });
  services.push(service); return { service, api, render, cache };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

it('serves cached bytes offline without cloud requests or rendering', async () => {
  const { service, api, render, cache } = setup({ online: () => false });
  await cache.put(entry());
  expect(await service.request(file())).toEqual(jpeg);
  expect(api.thumbnailUrls).not.toHaveBeenCalled(); expect(render).not.toHaveBeenCalled();
});

it('downloads cloud bytes before generating, and keeps them for offline use', async () => {
  let online = true;
  const fetcher = vi.fn().mockResolvedValue({ ok: true, headers: new Headers(), arrayBuffer: async () => jpeg.buffer });
  const { service, api, render, cache } = setup({ online: () => online, fetch: fetcher });
  api.thumbnailUrls.mockResolvedValue(new Map([['a', 'https://test/preview']]));
  expect(await service.request(file())).toEqual(jpeg);
  expect(render).not.toHaveBeenCalled(); expect((await cache.get('alice', 'a'))?.pendingUpload).toBe(false);
  online = false; expect(await service.request(file())).toEqual(jpeg); expect(fetcher).toHaveBeenCalledTimes(1);
});

it('deduplicates missing previews and serializes different files, even across service instances', async () => {
  const first = deferred<Uint8Array>();
  const { service, render } = setup(); render.mockReturnValueOnce(first.promise);
  const other = setup();
  const one = service.request(file()), duplicate = service.request(file()), two = other.service.request(file('b'));
  await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));
  expect(other.render).not.toHaveBeenCalled();
  first.resolve(jpeg); await Promise.all([one, duplicate, two]);
  expect(render).toHaveBeenCalledTimes(1); expect(other.render).toHaveBeenCalledTimes(1);
});

it('caches a generated preview before uploading, and retries the outbox without rendering after restart', async () => {
  const { service, api, cache } = setup();
  api.saveThumbnail.mockRejectedValue(new Error('offline'));
  const changed = vi.fn(); service.subscribe(changed);
  expect(await service.request(file())).toEqual(jpeg);
  expect((await cache.get('alice', 'a'))?.pendingUpload).toBe(true);
  const restarted = setup({ cache });
  await restarted.service.sync();
  expect(restarted.api.saveThumbnail).toHaveBeenCalledWith('a', jpeg); expect(restarted.render).not.toHaveBeenCalled();
  expect((await cache.get('alice', 'a'))?.pendingUpload).toBe(false);
  expect(changed).toHaveBeenCalledTimes(1);
});

it('does not upload an obsolete queued revision', async () => {
  const { service, api, cache } = setup(); await cache.put(entry(true));
  api.head.mockResolvedValue({ file: file('a', 2) });
  await service.sync(); expect(api.saveThumbnail).not.toHaveBeenCalled();
  expect((await cache.get('alice', 'a'))?.pendingUpload).toBe(false);
});

it('cancels a former account job after sign-out, without uploading or publishing its result', async () => {
  const waiting = deferred<Uint8Array>(); const { service, api, cache, render } = setup(); render.mockReturnValue(waiting.promise);
  const job = service.request(file()); await vi.waitFor(() => expect(render).toHaveBeenCalled());
  service.setEnabled(false); waiting.resolve(jpeg);
  expect(await job).toBeNull(); expect(await cache.get('alice', 'a')).toBeUndefined(); expect(api.saveThumbnail).not.toHaveBeenCalled();
});

it('continues after a render failure and retries a missing preview on reconnect without looping', async () => {
  const { service, render } = setup(); render.mockRejectedValueOnce(new Error('no WebGL'));
  expect(await service.request(file())).toBeNull(); expect(await service.request(file())).toBeNull();
  expect(render).toHaveBeenCalledTimes(1);
  expect(await service.request(file('b'))).toEqual(jpeg);
  service.reconnect(); expect(await service.request(file())).toEqual(jpeg);
});

it('coalesces saves but renders the last revision after the throttle interval', async () => {
  vi.useFakeTimers();
  const { service, render } = setup({ online: () => false });
  service.saved(file()); await vi.advanceTimersByTimeAsync(0);
  expect(render).toHaveBeenCalledTimes(1);
  service.saved(file('a', 2)); service.saved(file('a', 3));
  await vi.advanceTimersByTimeAsync(THUMBNAIL_INTERVAL_MS - 1); expect(render).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(render).toHaveBeenCalledTimes(2);
  expect(render).toHaveBeenLastCalledWith(file('a', 3));
});

it('a save refresh still renders when it arrives during a cloud preview download', async () => {
  const download = deferred<Map<string, string>>(); const { service, api, render } = setup();
  api.thumbnailUrls.mockReturnValue(download.promise);
  const view = service.request(file()); await vi.waitFor(() => expect(api.thumbnailUrls).toHaveBeenCalled());
  const save = service.request(file(), true); download.resolve(new Map());
  await Promise.all([view, save]); expect(render).toHaveBeenCalledTimes(2);
});

it('drops a render superseded by a newer revision while it was running', async () => {
  const waiting = deferred<Uint8Array>(); const { service, api, render, cache } = setup();
  render.mockReturnValueOnce(waiting.promise);
  const old = service.request(file()); await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
  const next = service.request(file('a', 2)); api.head.mockResolvedValue({ file: file('a', 2) });
  waiting.resolve(jpeg);
  expect(await old).toBeNull(); expect(await next).toEqual(jpeg);
  expect((await cache.get('alice', 'a'))?.revisionId).toBe('r2'); expect(api.saveThumbnail).toHaveBeenCalledOnce();
});

it('ignores a corrupt cloud JPEG and generates a usable replacement', async () => {
  vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('invalid image')));
  try {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, headers: new Headers(), arrayBuffer: async () => jpeg.buffer });
    const { service, api, render } = setup({ fetch: fetcher }); api.thumbnailUrls.mockResolvedValue(new Map([['a', 'https://test/preview']]));
    expect(await service.request(file())).toEqual(jpeg); expect(render).toHaveBeenCalledOnce();
  } finally { vi.unstubAllGlobals(); }
});
