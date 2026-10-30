// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import type { LayoutEntity } from '@pushform/layout';
import { prepareLayoutImages } from './layoutImage';

afterEach(() => { vi.unstubAllGlobals(); });
function picture(src: string): LayoutEntity {
  return { id: 1, layerId: 1, kind: 'image', points: [[0, 0], [10, 0], [10, 10], [0, 10]], closed: true, image: { src } };
}
function images() {
  const created: FakeImage[] = [];
  class FakeImage extends EventTarget {
    complete = false; naturalWidth = 0; decoding = ''; src = '';
    onload: unknown; onerror: unknown;
    decode = vi.fn().mockResolvedValue(undefined);
    constructor() { super(); created.push(this); }
  }
  vi.stubGlobal('Image', FakeImage);
  return created;
}
it('waits for each unique image to load and decode before printing', async () => {
  const created = images();
  let finished = false;
  const promise = prepareLayoutImages([picture('print-image-ready'), picture('print-image-ready')]).then(() => { finished = true; });
  expect(created).toHaveLength(1);
  await Promise.resolve(); expect(finished).toBe(false);
  created[0]!.complete = true; created[0]!.naturalWidth = 100;
  created[0]!.dispatchEvent(new Event('load'));
  await promise;
  expect(created[0]!.decode).toHaveBeenCalledOnce(); expect(finished).toBe(true);
});
it('reports an image failure instead of printing a loading placeholder', async () => {
  const created = images();
  const promise = prepareLayoutImages([picture('print-image-failed')]);
  const assertion = expect(promise).rejects.toThrow('A picture could not be loaded');
  created[0]!.dispatchEvent(new Event('error'));
  await assertion;
});
