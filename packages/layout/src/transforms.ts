// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { LayoutEntity, LayoutLinearDimension, LayoutText } from './LayoutDocument';
import { normalizeDimensionAngle } from './dimensions';
import { layoutLabelLeader } from './labels';
import { layoutTextCenter, rotateLayoutEntity, rotateLayoutPoint } from './rotation';
import { isViewport, resizedViewportCamera } from './viewports';

type Point = [number, number];

/**
 * Objects turned together `angleDeg` clockwise about `pivot`. Most turn rigidly (`rotateLayoutEntity`); a label's
 * arrow tip and bend turn about the pivot while its text stays upright at the end of a horizontal segment.
 */
export function rotateLayoutEntities(entities: readonly LayoutEntity[], pivot: Point, angleDeg: number): LayoutEntity[] {
  return entities.map(entity => entity.kind === 'label' ? turnLayoutLabel(entity, pivot, angleDeg) : rotateLayoutEntity(entity, pivot, angleDeg));
}

/**
 * A label turned about `pivot` without tilting: the tip and bend turn, and the text box keeps its orientation and
 * its offset from the bend, so the leader's last segment stays horizontal and as long as it was. A straight leader
 * keeps its text box's offset from where the leader meets it; a label without a leader turns its box's center.
 */
export function turnLayoutLabel(entity: LayoutEntity, pivot: Point, angleDeg: number): LayoutEntity {
  const turn = (point: Point): Point => rotateLayoutPoint(point, pivot, angleDeg);
  // The point the text box keeps its offset from: the bend (where a straight leader meets the text), or the center.
  const leader = layoutLabelLeader(entity);
  const hinge: Point = leader ? leader.bend : layoutTextCenter(entity);
  const moved = turn(hinge), shift: Point = [moved[0] - hinge[0], moved[1] - hinge[1]];
  const points = entity.points.map((point, index): Point =>
    index < 2 ? [point[0] + shift[0], point[1] + shift[1]] : index === 2 || index === 3 ? turn(point) : [point[0], point[1]]);
  return { ...entity, points };
}

/** How much a page scale of `sx` by `sy` stretches a direction `angleDeg` clockwise from the page's x axis. */
function stretch(sx: number, sy: number, angleDeg: number): number {
  const radians = angleDeg * Math.PI / 180;
  return Math.hypot(sx * Math.cos(radians), sy * Math.sin(radians));
}

/** Text with its type sized by `factor`: font sizes, and line spacings and tab stops given in points. */
export function scaleLayoutTextType(text: LayoutText, factor: number): LayoutText {
  return {
    ...text,
    fontSizePt: text.fontSizePt * factor,
    ...(text.spans ? { spans: text.spans.map(span => span.fontSizePt === undefined ? { ...span } : { ...span, fontSizePt: span.fontSizePt * factor }) } : {}),
    ...(text.lineSpacing && text.lineSpacing.mode !== 'multiple' ? { lineSpacing: { ...text.lineSpacing, value: text.lineSpacing.value * factor } } : {}),
    ...(text.tabStopsPt ? { tabStopsPt: text.tabStopsPt.map(stop => stop * factor) } : {}),
  };
}

function scaleDimensionStyle<T extends Pick<LayoutLinearDimension, 'fontSizePt' | 'arrowSizeMm' | 'extensionGapMm' | 'extensionOverrunMm'>>(style: T, factor: number): T {
  return { ...style, fontSizePt: style.fontSizePt * factor, arrowSizeMm: style.arrowSizeMm * factor,
    extensionGapMm: style.extensionGapMm * factor, extensionOverrunMm: style.extensionOverrunMm * factor };
}

/**
 * Objects scaled together along the page's axes about `pivot`, `sx` across and `sy` down (both positive), as a
 * group or a multi-selection scales. Paths, labels and dimensions scale point by point. Text boxes, images, tables
 * and model views keep their rotation: their centers scale, and each side scales by how much the scale stretches
 * its direction, so an unrotated one scales exactly. Type scales by the smaller factor, so a proportional scale
 * scales it with the drawing; stroke weights stay as they are.
 */
export function scaleLayoutEntities(entities: readonly LayoutEntity[], pivot: Point, sx: number, sy: number): LayoutEntity[] {
  if (![...pivot, sx, sy].every(Number.isFinite) || sx <= 0 || sy <= 0) throw new Error('Scale must be positive and finite.');
  const type = Math.min(sx, sy);
  const map = (point: Point): Point => [pivot[0] + (point[0] - pivot[0]) * sx, pivot[1] + (point[1] - pivot[1]) * sy];
  /** An image or table frame's corners, turned `angleDeg` about `center`, with the center scaled and the sides stretched. */
  const frame = (points: readonly Point[], center: Point, angleDeg: number): Point[] => {
    const next = map(center), across = stretch(sx, sy, angleDeg), down = stretch(sx, sy, angleDeg + 90);
    return points.map(point => {
      const local = rotateLayoutPoint(point, center, -angleDeg);
      return rotateLayoutPoint([next[0] + (local[0] - center[0]) * across, next[1] + (local[1] - center[1]) * down], next, angleDeg);
    });
  };
  return entities.map((entity): LayoutEntity => {
    if (entity.image || entity.table) {
      const [a, b, c] = entity.points as [Point, Point, Point];
      const center: Point = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
      const points = frame(entity.points, center, Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI);
      const scaled: LayoutEntity = { ...entity, points };
      if (isViewport(entity)) scaled.image = { ...entity.image, viewport: { ...entity.image.viewport,
        camera: resizedViewportCamera(entity.image.viewport.camera, entity.points, points, entity.image.viewport.preserveScaleOnResize) } };
      if (entity.table) scaled.table = { ...entity.table, cells: entity.table.cells.map(cell => ({ ...cell, text: scaleLayoutTextType(cell.text, type) })) };
      return scaled;
    }
    if (entity.text && entity.kind !== 'label') {
      // A text box's corners are stored unturned about its center; its rotation is applied when it is drawn.
      const center = layoutTextCenter(entity), next = map(center), angle = entity.text.rotationDeg ?? 0;
      const across = stretch(sx, sy, angle), down = stretch(sx, sy, angle + 90);
      return { ...entity, points: entity.points.map((point, index): Point => index < 2
        ? [next[0] + (point[0] - center[0]) * across, next[1] + (point[1] - center[1]) * down] : map(point)),
        text: scaleLayoutTextType(entity.text, type) };
    }
    const scaled: LayoutEntity = { ...entity, points: entity.points.map(map),
      ...(entity.handles ? { handles: entity.handles.map(handle => ({ ...(handle.in ? { in: map(handle.in) } : {}), ...(handle.out ? { out: map(handle.out) } : {}) })) } : {}) };
    if (entity.text) scaled.text = { ...scaleLayoutTextType(entity.text, type),
      ...(entity.text.leaderOffsetMm !== undefined ? { leaderOffsetMm: entity.text.leaderOffsetMm * sy } : {}) };
    if (entity.dimension) {
      const dimension = scaleDimensionStyle(entity.dimension, type);
      if (dimension.alignment === 'rotated') {
        const radians = (dimension.angleDeg ?? 0) * Math.PI / 180, x = Math.cos(radians) * sx, y = Math.sin(radians) * sy;
        dimension.angleDeg = normalizeDimensionAngle(Math.atan2(y, x) * 180 / Math.PI);
      }
      scaled.dimension = dimension;
    }
    if (entity.angularDimension) scaled.angularDimension = scaleDimensionStyle(entity.angularDimension, type);
    return scaled;
  });
}
