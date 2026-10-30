// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { angularDimensionGeometry, formatAngularDimension, formatLinearDimension, linearDimensionGeometry, type LayoutEntity } from '@pushform/layout';

export function paintLayoutDimension(ctx: CanvasRenderingContext2D, entity: LayoutEntity, selected = false): void {
  const dim = entity.dimension;
  if (!dim) return;
  const { a, b, start, end } = linearDimensionGeometry(entity);
  const dx = end[0] - start[0], dy = end[1] - start[1], length = Math.hypot(dx, dy) || 1;
  const ux = dx / length, uy = dy / length;
  ctx.save();
  ctx.strokeStyle = dim.detached ? '#c43b32' : selected ? '#1e63d1' : entity.style?.strokeColor ?? '#222222';
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = (entity.style?.strokeWeightPt ?? 0.5) * 25.4 / 72;
  if (dim.detached) ctx.setLineDash([1.5, 1]);
  const line = (x1: number, y1: number, x2: number, y2: number): void => {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  };
  for (const [point, projected] of [[a, start], [b, end]]) {
    const ex = projected![0] - point![0], ey = projected![1] - point![1], distance = Math.hypot(ex, ey);
    if (distance < 1e-6) continue;
    const vx = ex / distance, vy = ey / distance;
    const gap = Math.min(dim.extensionGapMm, distance);
    line(point![0] + vx * gap, point![1] + vy * gap,
      projected![0] + vx * dim.extensionOverrunMm, projected![1] + vy * dim.extensionOverrunMm);
  }
  line(...start, ...end);
  ctx.setLineDash([]);
  const size = dim.arrowSizeMm;
  for (const [point, direction] of [[start, 1], [end, -1]] as const) {
    if (dim.endpoint === 'dot') { ctx.beginPath(); ctx.arc(...point, size / 4, 0, 2 * Math.PI); ctx.fill(); }
    if (dim.endpoint === 'tick') line(point[0] - (ux - uy) * size / 2, point[1] - (uy + ux) * size / 2,
      point[0] + (ux - uy) * size / 2, point[1] + (uy + ux) * size / 2);
    if (dim.endpoint === 'arrow') {
      ctx.beginPath(); ctx.moveTo(...point);
      ctx.lineTo(point[0] + direction * ux * size - uy * size * 0.3, point[1] + direction * uy * size + ux * size * 0.3);
      ctx.lineTo(point[0] + direction * ux * size + uy * size * 0.3, point[1] + direction * uy * size - ux * size * 0.3);
      ctx.closePath(); ctx.fill();
    }
  }
  ctx.translate((start[0] + end[0]) / 2, (start[1] + end[1]) / 2);
  let angle = Math.atan2(dy, dx);
  if (angle > Math.PI / 2 || angle < -Math.PI / 2) angle += Math.PI;
  ctx.rotate(angle);
  ctx.font = `${dim.fontSizePt * 25.4 / 72}px "${dim.fontFamily.replace(/["\\]/g, '')}"`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.fillText(`${dim.detached ? '⚠ ' : ''}${formatLinearDimension(dim)}`, 0, -1);
  ctx.restore();
}

export function paintAngularDimension(ctx: CanvasRenderingContext2D, entity: LayoutEntity, selected = false): void {
  const dim = entity.angularDimension;
  if (!dim) return;
  const geometry = angularDimensionGeometry(entity);
  const { vertex, radius, startAngle, sweep, start, end, text } = geometry;
  ctx.save();
  ctx.strokeStyle = dim.detached ? '#c43b32' : selected ? '#1e63d1' : entity.style?.strokeColor ?? '#222222';
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = (entity.style?.strokeWeightPt ?? 0.5) * 25.4 / 72;
  if (dim.detached) ctx.setLineDash([1.5, 1]);
  for (const [point, projected] of [[entity.points[1]!, start], [entity.points[2]!, end]]) {
    const dx = projected![0] - point![0], dy = projected![1] - point![1], distance = Math.hypot(dx, dy);
    if (distance < 1e-6) continue;
    const ux = dx / distance, uy = dy / distance, gap = Math.min(dim.extensionGapMm, distance);
    ctx.beginPath(); ctx.moveTo(point![0] + ux * gap, point![1] + uy * gap);
    ctx.lineTo(projected![0] + ux * dim.extensionOverrunMm, projected![1] + uy * dim.extensionOverrunMm); ctx.stroke();
  }
  ctx.beginPath(); ctx.arc(...vertex, radius, startAngle, startAngle + sweep, sweep < 0); ctx.stroke();
  ctx.setLineDash([]);
  for (const [point, angle, direction] of [[start, startAngle, Math.sign(sweep)], [end, startAngle + sweep, -Math.sign(sweep)]] as const) {
    const ux = -Math.sin(angle) * direction, uy = Math.cos(angle) * direction, size = dim.arrowSizeMm;
    if (dim.endpoint === 'dot') { ctx.beginPath(); ctx.arc(...point, size / 4, 0, 2 * Math.PI); ctx.fill(); }
    if (dim.endpoint === 'tick') {
      ctx.beginPath(); ctx.moveTo(point[0] - (ux - uy) * size / 2, point[1] - (uy + ux) * size / 2);
      ctx.lineTo(point[0] + (ux - uy) * size / 2, point[1] + (uy + ux) * size / 2); ctx.stroke();
    }
    if (dim.endpoint === 'arrow') {
      ctx.beginPath(); ctx.moveTo(...point);
      ctx.lineTo(point[0] + ux * size - uy * size * 0.3, point[1] + uy * size + ux * size * 0.3);
      ctx.lineTo(point[0] + ux * size + uy * size * 0.3, point[1] + uy * size - ux * size * 0.3);
      ctx.closePath(); ctx.fill();
    }
  }
  ctx.font = `${dim.fontSizePt * 25.4 / 72}px "${dim.fontFamily.replace(/["\\]/g, '')}"`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(`${dim.detached ? '⚠ ' : ''}${formatAngularDimension(dim)}`, ...text);
  ctx.restore();
}
