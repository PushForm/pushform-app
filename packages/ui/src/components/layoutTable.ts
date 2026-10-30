// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { tableCellEntities, tableCells, tableFrame, tableGridLines, type LayoutEntity, type LayoutPage, type LayoutDocumentState } from '@pushform/layout';
import { paintLayoutText, type LayoutTextBlockPainter } from './layoutText';

/** One painter for the workspace, thumbnails, presentation, and print. */
export function paintLayoutTable(ctx: CanvasRenderingContext2D, entity: LayoutEntity, page: LayoutPage, state: LayoutDocumentState, selected: boolean, paintTextBlock?: LayoutTextBlockPainter): void {
  const { a, b, d, width, height } = tableFrame(entity);
  if (!width || !height) return;
  ctx.save();
  ctx.transform((b[0] - a[0]) / width, (b[1] - a[1]) / width, (d[0] - a[0]) / height, (d[1] - a[1]) / height, ...a);
  // Fill before stroking, so adjacent backgrounds cannot obscure half a grid line.
  for (const { box: [p, q], fillColor } of tableCells(entity)) {
    if (fillColor) { ctx.fillStyle = fillColor; ctx.fillRect(...p, q[0] - p[0], q[1] - p[1]); }
  }
  // Like paths, no line is thinner than one device pixel.
  const transform = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
  const devicePixelMm = transform ? 1 / (Math.hypot(transform.a, transform.b) || 1) : 0;
  for (const line of tableGridLines(entity)) {
    if (/^#[0-9a-f]{6}00$/i.test(line.style.strokeColor)) continue;
    ctx.strokeStyle = selected ? '#1e63d1' : line.style.strokeColor;
    ctx.lineWidth = Math.max(line.style.strokeWeightPt * 25.4 / 72, devicePixelMm);
    ctx.setLineDash(line.style.strokeDashMm ?? []);
    ctx.beginPath();
    line.points.forEach((point, i) => (i ? ctx.lineTo(...point) : ctx.moveTo(...point)));
    if (line.closed) ctx.closePath();
    ctx.stroke();
  }
  ctx.setLineDash([]);
  for (const cell of tableCellEntities(entity)) paintLayoutText(ctx, cell, page, state, false, paintTextBlock);
  ctx.restore();
}
