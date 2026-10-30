// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { pathSegment, type LayoutEntity } from '@pushform/layout';

type Point = [number, number];

const images = new Map<string, HTMLImageElement>();
/** Pictures drawn straight into a canvas (model view navigation previews), painted without decoding. */
const canvases = new Map<string, HTMLCanvasElement>();
const listeners = new Set<() => void>();
let generation = 0;

/** Repaint pages that show pictures: a picture finished decoding, or a viewport render finished. */
export function notifyLayoutImages(): void {
  generation++;
  for (const listener of listeners) listener();
}

/** Changes whenever a pending image finishes decoding, so pages repaint once pictures arrive. */
export const layoutImageLoads = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  version: (): number => generation,
};

export type LayoutImageState = 'loaded' | 'failed' | 'pending';

/** How a picture would paint right now: decoded, its error placeholder, or (not yet requested or still loading) its loading placeholder. */
export function layoutImageState(src: string): LayoutImageState {
  if (canvases.has(src)) return 'loaded';
  const image = images.get(src);
  if (!image || !image.complete) return 'pending';
  return image.naturalWidth > 0 ? 'loaded' : 'failed';
}

/** Paints `canvas` wherever `src` is painted, as it currently looks, until `forgetLayoutImage(src)`. */
export function setLayoutCanvasPicture(src: string, canvas: HTMLCanvasElement): void {
  canvases.set(src, canvas);
}

/** Whether `src` would paint now; starts loading it otherwise, and repaints once it has. */
export function layoutImageReady(src: string): boolean {
  return loadedImage(src) !== null;
}

/** Drops a picture nothing paints anymore, so finished viewport renders do not accumulate. */
export function forgetLayoutImage(src: string): void {
  images.delete(src);
  canvases.delete(src);
}

function loadedImage(src: string): HTMLImageElement | HTMLCanvasElement | null {
  const canvas = canvases.get(src);
  if (canvas) return canvas;
  let image = images.get(src);
  if (!image) {
    image = new Image();
    image.decoding = 'async';
    image.onload = image.onerror = notifyLayoutImages;
    image.src = src;
    images.set(src, image);
  }
  return image.complete && image.naturalWidth > 0 ? image : null;
}

/**
 * Paint an image entity into its frame (top-left, top-right, bottom-right, bottom-left), cropped by its clip.
 * A viewport paints `src`, the picture its renderer chose (`layoutViewportPicture`), over its background.
 */
export function paintLayoutImage(ctx: CanvasRenderingContext2D, entity: LayoutEntity, selected: boolean, src = entity.image?.src ?? ''): void {
  const image = entity.image;
  const [topLeft, topRight, , bottomLeft] = entity.points as Point[];
  if (!image || !topLeft || !topRight || !bottomLeft) return;
  ctx.save();
  ctx.transform(topRight[0] - topLeft[0], topRight[1] - topLeft[1], bottomLeft[0] - topLeft[0], bottomLeft[1] - topLeft[1], ...topLeft);
  if (image.clip && image.clip.points.length >= 3) {
    const { points, handles } = image.clip;
    ctx.beginPath();
    ctx.moveTo(...points[0]!);
    for (let index = 0; index < points.length; index++) {
      const segment = pathSegment(points, handles, index, true);
      if (segment.curved) ctx.bezierCurveTo(...segment.c1, ...segment.c2, ...segment.b);
      else ctx.lineTo(...segment.b);
    }
    ctx.closePath();
    ctx.clip();
  }
  const background = image.viewport?.background;
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, 1, 1);
  }
  const loaded = src ? loadedImage(src) : null;
  if (loaded) ctx.drawImage(loaded, 0, 0, 1, 1);
  else if (!background) {
    ctx.fillStyle = '#eef1f5';
    ctx.fillRect(0, 0, 1, 1);
  }
  ctx.restore();
  if (selected) {
    ctx.save();
    ctx.strokeStyle = '#1e63d1';
    ctx.lineWidth = 0.4;
    ctx.setLineDash([1, 1]);
    ctx.beginPath();
    ctx.moveTo(...topLeft);
    for (const point of entity.points.slice(1)) ctx.lineTo(...point);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }
}

/** Printing waits for visible pictures instead of emitting their loading placeholders. */
export async function prepareLayoutImages(entities: readonly LayoutEntity[], source = (entity: LayoutEntity) => entity.image?.src ?? ''): Promise<void> {
  const sources = new Set(entities.flatMap(entity => entity.image && source(entity) ? [source(entity)] : []));
  await Promise.all([...sources].map(async src => {
    if (canvases.has(src)) return;
    loadedImage(src);
    const image = images.get(src)!;
    if (!image.complete) await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        image.removeEventListener('load', loaded);
        image.removeEventListener('error', failed);
        if (error) reject(error); else resolve();
      };
      const loaded = () => finish();
      const failed = () => finish(new Error('A picture could not be loaded. Check the document images and try again.'));
      const timeout = setTimeout(() => finish(new Error('A picture is still loading. Try printing again when it is ready.')), 30000);
      image.addEventListener('load', loaded, { once: true });
      image.addEventListener('error', failed, { once: true });
    });
    if (!image.naturalWidth) throw new Error('A picture could not be loaded. Check the document images and try again.');
    if (image.decode) await image.decode();
  }));
}
