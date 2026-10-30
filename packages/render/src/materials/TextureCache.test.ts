// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { TextureLoader, Texture } from 'three';
import { TextureCache, TexturedMaterialCache } from './TextureCache';

afterEach(() => { vi.restoreAllMocks(); });

/** A 2D context over one RGBA pixel buffer, enough for drawImage / getImageData / putImageData (jsdom has none). */
function stubCanvas(pixel: [number, number, number, number]): { drawn: number[] } {
  const drawn: number[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    const data = new Uint8ClampedArray(this.width * this.height * 4);
    return {
      drawImage: () => { for (let i = 0; i < data.length; i += 4) data.set(pixel, i); },
      getImageData: () => ({ data }),
      putImageData: (image: { data: Uint8ClampedArray }) => { drawn.push(...image.data.subarray(0, 4)); },
    } as unknown as CanvasRenderingContext2D;
  });
  return { drawn };
}

it('colorizes a texture once its image loads, as SketchUp does, keeping the plain texture apart', () => {
  const { drawn } = stubCanvas([100, 100, 100, 255]);
  const cache = new TextureCache();
  const plain = cache.get('blob:wood');
  const tan = cache.colorized('blob:wood', '#d2b48c', 'shift');
  expect(cache.colorized('blob:wood', '#d2b48c', 'shift')).toBe(tan);
  expect(cache.colorized('blob:wood', '#d2b48c', 'tint')).not.toBe(tan);
  expect(tan).not.toBe(plain);
  // The image arrives: each waiting colorized copy is drawn from it.
  const image = Object.assign(document.createElement('canvas'), { width: 2, height: 2 });
  plain.image = image;
  const onLoad = (cache as unknown as { waiting: Map<string, ((image: HTMLCanvasElement) => void)[]> }).waiting.get('blob:wood')!;
  onLoad.forEach((apply) => apply(image));
  expect(tan.image).toBeInstanceOf(HTMLCanvasElement);
  expect(tan.image).not.toBe(image);
  // A uniform gray texture is its own average, so it becomes the material color itself.
  expect(drawn.slice(0, 4)).toEqual([210, 180, 140, 255]);
  // Once loaded, a new colorized copy is drawn at once.
  const red = cache.colorized('blob:wood', '#c81e1e', 'tint');
  expect(red.image).toBeInstanceOf(HTMLCanvasElement);
  cache.prune(new Set());
  expect(cache.colorized('blob:wood', '#d2b48c', 'shift')).not.toBe(tan);
  cache.dispose();
});

it('maps a colorized material to its colorized texture and a plain one to the image', () => {
  stubCanvas([0, 0, 0, 255]);
  const textures = new TextureCache(), materials = new TexturedMaterialCache(textures);
  const plain = materials.get({ id: 1, color: '#d2b48c', alpha: 1, textureUrl: 'blob:a' }, 'front', false, true);
  const colorized = materials.get({ id: 2, color: '#d2b48c', alpha: 1, textureUrl: 'blob:a', colorize: 'tint' }, 'front', false, true);
  expect(plain.map).toBe(textures.get('blob:a'));
  expect(colorized.map).toBe(textures.colorized('blob:a', '#d2b48c', 'tint'));
  expect(colorized.color.getHex()).toBe(0xffffff);
  materials.dispose(); textures.dispose();
});


it('waits for texture decoding before export and reports failed images', async () => {
  const loads: (() => void)[] = [], errors: (() => void)[] = [];
  vi.spyOn(TextureLoader.prototype, 'load').mockImplementation((_url, onLoad, _progress, onError) => {
    const texture = new Texture(); loads.push(() => onLoad?.(texture)); errors.push(() => onError?.(new Error('missing'))); return texture;
  });
  const cache = new TextureCache(); cache.get('a'); cache.get('b');
  const finished = vi.fn(); const ready = cache.whenReady().then(finished);
  loads[0]!(); await Promise.resolve(); expect(finished).not.toHaveBeenCalled();
  loads[1]!(); await ready; expect(finished).toHaveBeenCalledOnce();
  cache.get('missing'); errors[2]!(); await expect(cache.whenReady()).rejects.toThrow('could not be loaded');
  cache.prune(new Set(['a', 'b'])); await expect(cache.whenReady()).resolves.toBeUndefined(); cache.dispose();
});
