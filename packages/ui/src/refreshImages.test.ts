// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { bytesToBase64 } from '@pushform/model';
import {
  IndexedDbRefreshImages, loadRefreshImages, REFRESH_IMAGE_TTL_MS, REFRESH_STORAGE_KEY, refreshImageKey, SessionStorageRefreshImages,
} from './refreshImages';

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

/** Larger than a session storage's whole ~5 MB quota. */
const large = (): Uint8Array => { const bytes = new Uint8Array(6 * 1024 * 1024); for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 0xff; return bytes; };

describe('refresh images in IndexedDB', () => {
  it('keeps images larger than the old session-storage quota for the next load of the same tab', async () => {
    const factory = new IDBFactory(), bytes = large();
    const first = await IndexedDbRefreshImages.load(factory, 'tab-a', []);
    first.put('big', { mime: 'image/png', bytes });
    first.put('small', { mime: 'image/jpeg', bytes: new Uint8Array([1, 2, 3]) });
    await first.settled();
    const next = await IndexedDbRefreshImages.load(factory, 'tab-a', ['big', 'small', 'missing']);
    expect(next.get('big')?.mime).toBe('image/png');
    expect(Buffer.from(next.get('big')!.bytes).equals(Buffer.from(bytes))).toBe(true);
    expect(next.get('small')?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(next.get('missing')).toBeUndefined();
    next.delete('small');
    await next.settled();
    expect((await IndexedDbRefreshImages.load(factory, 'tab-a', ['small'])).get('small')).toBeUndefined();
  });

  it('keeps each browser tab apart and removes the images of tabs gone for a week', async () => {
    const factory = new IDBFactory();
    let now = 1_000_000;
    const old = await IndexedDbRefreshImages.load(factory, 'old', [], () => now);
    old.put('same', { mime: 'image/png', bytes: new Uint8Array([1]) });
    await old.settled();
    now += 60_000;
    const recent = await IndexedDbRefreshImages.load(factory, 'recent', [], () => now);
    recent.put('same', { mime: 'image/png', bytes: new Uint8Array([2]) });
    await recent.settled();
    // Another tab's image of the same content is not this tab's.
    expect((await IndexedDbRefreshImages.load(factory, 'other', ['same'], () => now)).get('same')).toBeUndefined();
    // Loading or writing marks a tab alive. Just over a week after `old` last did, and just under a week after
    // `recent` did, another tab's load removes the images of `old` only.
    now += REFRESH_IMAGE_TTL_MS - 30_000;
    await IndexedDbRefreshImages.load(factory, 'other', [], () => now);
    expect((await IndexedDbRefreshImages.load(factory, 'old', ['same'], () => now)).get('same')).toBeUndefined();
    expect((await IndexedDbRefreshImages.load(factory, 'recent', ['same'], () => now)).get('same')?.bytes).toEqual(new Uint8Array([2]));
  });

  it('falls back to the session storage without IndexedDB, and moves images an earlier version kept there', async () => {
    const storage = new MemoryStorage();
    expect(await loadRefreshImages(storage, null)).toBeInstanceOf(SessionStorageRefreshImages);
    storage.setItem(REFRESH_STORAGE_KEY, JSON.stringify({ version: 2, activeIndex: 0, tabs: [{ type: 'model', images: { 7: 'legacy' } }] }));
    storage.setItem(refreshImageKey('legacy'), JSON.stringify({ mime: 'image/png', data: bytesToBase64(new Uint8Array([9, 8, 7])) }));
    const factory = new IDBFactory();
    const images = await loadRefreshImages(storage, factory);
    expect(images).toBeInstanceOf(IndexedDbRefreshImages);
    expect(images.get('legacy')?.bytes).toEqual(new Uint8Array([9, 8, 7]));
    expect(storage.getItem(refreshImageKey('legacy'))).toBeNull();
    await (images as IndexedDbRefreshImages).settled();
    // The same browser tab (its id is in the session storage) finds the moved image after the next refresh.
    expect((await loadRefreshImages(storage, factory)).get('legacy')?.bytes).toEqual(new Uint8Array([9, 8, 7]));
    // Another browser tab with the same snapshot has its own namespace (and no legacy copy), so it finds nothing.
    const other = new MemoryStorage();
    other.setItem(REFRESH_STORAGE_KEY, storage.getItem(REFRESH_STORAGE_KEY)!);
    expect((await loadRefreshImages(other, factory)).get('legacy')).toBeUndefined();
  });
});
