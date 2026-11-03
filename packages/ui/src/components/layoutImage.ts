// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { pathSegment, type LayoutEntity } from '@pushform/layout';
import { isPdfPicture, loadPdfPicture, pdfPicture, pdfPictureState } from './layoutPdfPicture';

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

/**
 * The picture of a model view whose model shows nothing in it: the view paints only its background, if any, in the
 * workspace, print and export alike.
 */
export const LAYOUT_VIEW_EMPTY = 'pushform-view:empty';
/**
 * The picture of a model view that could not be rendered and has no earlier picture to keep: in the workspace it
 * paints the failed-picture marker, so a failure is not missed; print and export paint nothing and report it.
 */
export const LAYOUT_VIEW_FAILED = 'pushform-view:failed';
const isMarker = (src: string): boolean => src === LAYOUT_VIEW_EMPTY || src === LAYOUT_VIEW_FAILED;

export type LayoutImageState = 'loaded' | 'empty' | 'failed' | 'pending';

/**
 * How a picture would paint right now: decoded, nothing (an empty model view), its failed-picture marker, or (not yet
 * requested or still loading) its loading placeholder.
 */
export function layoutImageState(src: string): LayoutImageState {
  if (src === LAYOUT_VIEW_EMPTY) return 'empty';
  if (src === LAYOUT_VIEW_FAILED) return 'failed';
  if (canvases.has(src)) return 'loaded';
  if (isPdfPicture(src)) return pdfPictureState(src);
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
  return isMarker(src) || loadedImage(src) !== null;
}

/** Drops a picture nothing paints anymore, so finished viewport renders do not accumulate. */
export function forgetLayoutImage(src: string): void {
  images.delete(src);
  canvases.delete(src);
}

function loadedImage(src: string): HTMLImageElement | HTMLCanvasElement | null {
  if (isMarker(src)) return null;
  const canvas = canvases.get(src);
  if (canvas) return canvas;
  if (isPdfPicture(src)) return pdfPicture(src, notifyLayoutImages);
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
 * A viewport paints `src`, the picture its renderer chose (`layoutViewportPicture`), over its background. A picture
 * still loading shows the loading placeholder, an empty view nothing, and a failed one the failed-picture marker.
 * For `output` (print, page images, PDF and SVG), a view without a picture paints nothing but its background, whether
 * empty, failed or still missing its picture: the export reports failed views instead.
 */
export function paintLayoutImage(ctx: CanvasRenderingContext2D, entity: LayoutEntity, selected: boolean, src = entity.image?.src ?? '', output = false): void {
  const image = entity.image;
  const [topLeft, topRight, bottomRight, bottomLeft] = entity.points as Point[];
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
  // Placeholders are for the workspace: print and export leave a view without a picture empty.
  const placeholder = !loaded && !(output && image.viewport);
  const failed = placeholder && src === LAYOUT_VIEW_FAILED;
  if (failed) {
    // A gray box crossed in red, as a picture that cannot be shown; the cross is drawn below, in page units.
    ctx.fillStyle = '#c8c8c8';
    ctx.fillRect(0, 0, 1, 1);
  } else if (placeholder && src !== LAYOUT_VIEW_EMPTY && !background) {
    ctx.fillStyle = '#eef1f5';
    ctx.fillRect(0, 0, 1, 1);
  }
  ctx.restore();
  if (failed && bottomRight) {
    ctx.save();
    ctx.strokeStyle = '#d81e1e';
    ctx.lineWidth = 0.5 * 25.4 / 72;
    ctx.beginPath();
    ctx.moveTo(...topLeft); ctx.lineTo(...bottomRight);
    ctx.moveTo(...topRight); ctx.lineTo(...bottomLeft);
    ctx.stroke();
    ctx.restore();
  }
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
  const sources = new Set(entities.flatMap(entity => entity.image && source(entity) && !isMarker(source(entity)) ? [source(entity)] : []));
  await Promise.all([...sources].map(async src => {
    if (canvases.has(src)) return;
    if (isPdfPicture(src)) {
      await loadPdfPicture(src).catch(() => { throw new Error('A picture could not be loaded. Check the document images and try again.'); });
      return;
    }
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
