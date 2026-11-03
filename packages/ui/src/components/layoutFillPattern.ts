// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { layoutFillPatternMatrix, type LayoutFillPattern } from '@pushform/layout';
import { layoutPicture } from './layoutImage';

/** A painting context that records pattern fills itself (the vector recorder) instead of rasterizing them. */
interface PatternRecorder { fillPattern(pattern: LayoutFillPattern, evenodd: boolean): void }

/**
 * Fill the current path with a pattern: its picture repeated from the pattern's origin, scaled and turned
 * (`layoutFillPatternMatrix`), clipped to the path. Painted after the shape's fill color and before its stroke.
 * A picture still loading paints nothing yet; the page repaints once it has loaded.
 */
export function paintLayoutFillPattern(ctx: CanvasRenderingContext2D, pattern: LayoutFillPattern | undefined, evenodd: boolean): void {
  if (!pattern) return;
  const recorder = ctx as unknown as Partial<PatternRecorder>;
  if (typeof recorder.fillPattern === 'function') { recorder.fillPattern(pattern, evenodd); return; }
  const picture = layoutPicture(pattern.src);
  if (!picture || typeof ctx.createPattern !== 'function') return;
  const width = picture instanceof HTMLImageElement ? picture.naturalWidth : picture.width;
  const height = picture instanceof HTMLImageElement ? picture.naturalHeight : picture.height;
  const fill = width > 0 && height > 0 ? ctx.createPattern(picture, 'repeat') : null;
  if (!fill) return;
  // The pattern's own space is the picture's pixels; one picture is one tile.
  const [a, b, c, d, e, f] = layoutFillPatternMatrix(pattern);
  fill.setTransform?.({ a: a / width, b: b / width, c: c / height, d: d / height, e, f });
  ctx.save();
  ctx.fillStyle = fill;
  ctx.fill(evenodd ? 'evenodd' : 'nonzero');
  ctx.restore();
}
