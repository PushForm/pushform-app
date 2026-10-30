// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { isLayoutLayerVisible, entitiesForLayer, entityOnPage, type LayoutDocumentState, type LayoutPage, type LayoutDimensionAnchor, type LayoutEntity, type LayoutText } from './LayoutDocument';
import { layoutTextCenter, layoutTextCorners, rotateLayoutPoint } from './rotation';
import { layoutAnchorOnPath, layoutPathAnchorAt } from './anchors';
import { bakeLayoutModelText } from './text';
import { layoutModelFields } from './modelAttachments';

type Point = [number, number];
export interface LayoutLabelLeader { tip: Point; bend: Point; start: Point }
export type LayoutLabelDragPart = 'text' | 'leader' | 'tip';

/** Text exposes its rotated box corners; other objects expose their stored vertices. */
export function layoutLabelVertices(entity: LayoutEntity): readonly Point[] {
  return entity.text ? layoutTextCorners(entity) : entity.points;
}

/**
 * The label tip's attachment: a vertex of any visible object first, otherwise the topmost path
 * segment the tip lies on.
 */
export function labelAnchorAt(point: Point, page: LayoutPage, state: LayoutDocumentState): LayoutDimensionAnchor | null {
  const entities: LayoutEntity[] = [];
  for (const layerId of [...state.layerOrder].reverse()) {
    if (!isLayoutLayerVisible(page, state, layerId)) continue;
    entities.push(...entitiesForLayer(page, state, layerId).reverse());
  }
  for (const entity of entities) {
    const vertices = layoutLabelVertices(entity);
    const pointIndex = vertices.findIndex(vertex => Math.hypot(vertex[0] - point[0], vertex[1] - point[1]) < 1e-6);
    if (pointIndex >= 0) return { entityId: entity.id, pointIndex, pointCount: vertices.length };
  }
  for (const entity of entities) {
    const anchor = layoutPathAnchorAt(entity, point);
    if (anchor) return anchor;
  }
  return null;
}

export function resolveLayoutLabelAnchor(entity: LayoutEntity, lookup: (id: number) => LayoutEntity | undefined): Point | null {
  const anchor = entity.labelAnchor;
  if (entity.kind !== 'label' || !anchor || !entity.text || entity.points.length < 3 || anchor.entityId === entity.id) return null;
  const source = lookup(anchor.entityId);
  const vertices = source ? layoutLabelVertices(source) : [];
  const vertex = anchor.t !== undefined ? source && layoutAnchorOnPath(source, anchor)
    : vertices.length === anchor.pointCount ? vertices[anchor.pointIndex] : undefined;
  return vertex ? rotateLayoutPoint(vertex, layoutTextCenter(entity), -(entity.text.rotationDeg ?? 0)) : null;
}

export function previewLayoutLabel(entity: LayoutEntity, lookup: (id: number) => LayoutEntity | undefined): LayoutEntity {
  const tip = resolveLayoutLabelAnchor(entity, lookup);
  return tip ? { ...entity, points: entity.points.map((point, index) => index === 2 ? tip : point) } : entity;
}

/** Keep the relationship and its resolved paper point in the source edit's transaction. */
export function refreshLayoutLabels(state: LayoutDocumentState): void {
  const refresh = (entity: LayoutEntity, page: LayoutPage, shared: boolean) => {
    if (!entity.labelAnchor || entity.modelAnnotation) return;
    const tip = resolveLayoutLabelAnchor(entity, id => shared ? state.sharedEntities.get(id) : entityOnPage(page, state, id));
    if (!tip) { delete entity.labelAnchor; return; }
    if (entity.points[2]![0] !== tip[0] || entity.points[2]![1] !== tip[1]) entity.points[2] = tip;
  };
  for (const page of state.pages.values()) for (const entity of page.entities.values()) refresh(entity, page, false);
  const page = state.pages.get(state.pageOrder[0]!);
  if (page) for (const entity of state.sharedEntities.values()) refresh(entity, page, true);
}

export function layoutLabelDragPart(entity: LayoutEntity, point: Point, tipToleranceMm: number): LayoutLabelDragPart {
  const local = rotateLayoutPoint(point, layoutTextCenter(entity), -(entity.text?.rotationDeg ?? 0));
  const tip = entity.points[2]!;
  if (Math.hypot(local[0] - tip[0], local[1] - tip[1]) <= tipToleranceMm) return 'tip';
  const [a, b] = entity.points;
  return a && b && local[0] >= Math.min(a[0], b[0]) && local[0] <= Math.max(a[0], b[0]) &&
    local[1] >= Math.min(a[1], b[1]) && local[1] <= Math.max(a[1], b[1]) ? 'text' : 'leader';
}

/**
 * How a label moves when it moves whole with other objects (the Move tool): it keeps an attachment only
 * to an object moving with it, so its tip follows that object; otherwise its tip detaches and moves with the text.
 */
export function layoutLabelWholeMovePart(entity: LayoutEntity, movingIds: ReadonlySet<number>): LayoutLabelDragPart {
  const sourceId = entity.modelAnnotation?.attachments[0]?.viewportId ?? entity.labelAnchor?.entityId;
  return sourceId !== undefined && !movingIds.has(sourceId) ? 'tip' : 'leader';
}

/** Text drags stretch the leader; tip drags detach and translate the whole label. */
export function moveLayoutLabel(entity: LayoutEntity, delta: Point, part: LayoutLabelDragPart): LayoutEntity {
  if (entity.kind !== 'label' || !entity.text || entity.points.length < 3) throw new Error('Entity is not a label');
  const points = entity.points.map(([x, y]): Point => [x + delta[0], y + delta[1]]);
  const moved = { ...entity, points };
  if (part === 'tip') {
    delete moved.labelAnchor;
    moved.text = bakeLayoutModelText(entity.text, layoutModelFields(entity));
    delete moved.modelAnnotation;
    delete moved.preservedModelConnections;
  } else if (part === 'text' || entity.labelAnchor || entity.modelAnnotation) {
    const angle = entity.text.rotationDeg ?? 0;
    const tip = rotateLayoutPoint(entity.points[2]!, layoutTextCenter(entity), angle);
    points[2] = rotateLayoutPoint(tip, layoutTextCenter(moved), -angle);
    if (part === 'text' && entity.text.leader === 'elbow') {
      const bend = layoutLabelLeader(entity)!.bend;
      const localDelta = rotateLayoutPoint(delta, [0, 0], -angle);
      points[3] = [bend[0] + delta[0] - localDelta[0], bend[1] + delta[1]];
    }
  }
  if (!points.every(point => point.every(Number.isFinite))) throw new Error('Label move exceeds coordinate range');
  return moved;
}

/** Bounds, arrow tip, and an explicit bend. The text attaches at the third click's horizontal projection. */
export function createLayoutLabelGeometry(tip: Point, bend: Point, end: Point, widthMm = 50, heightMm = 20): {
  points: Point[]; align: LayoutText['align']; vertical: 'middle';
} {
  if (![...tip, ...bend, ...end, widthMm, heightMm].every(Number.isFinite) || widthMm <= 0 || heightMm <= 0)
    throw new Error('Invalid label coordinates or size.');
  if (Math.hypot(tip[0] - bend[0], tip[1] - bend[1]) < 1e-6) throw new Error('Place the bend away from the arrow tip.');
  if (Math.abs(end[0] - bend[0]) < 1e-6) throw new Error('Move left or right to place the horizontal leader.');
  const right = end[0] > bend[0], x = right ? end[0] : end[0] - widthMm, y = bend[1] - heightMm / 2;
  return { points: [[x, y], [x + widthMm, y + heightMm], [...tip], [...bend]], align: right ? 'left' : 'right', vertical: 'middle' };
}

/** Three-point legacy labels retain their automatic elbow; new labels keep the chosen fourth-point bend. */
export function layoutLabelLeader(entity: LayoutEntity): LayoutLabelLeader | null {
  if (entity.kind !== 'label' || !entity.text || entity.text.leader === 'none' || !entity.points[2]) return null;
  const a = entity.points[0]!, b = entity.points[1]!, tip = entity.points[2]!;
  const x = Math.min(a[0], b[0]), right = Math.max(a[0], b[0]), y = (a[1] + b[1]) / 2 + (entity.text.leaderOffsetMm ?? 0);
  const explicit = entity.text.leader === 'elbow' ? entity.points[3] : undefined;
  const left = explicit ? explicit[0] < (x + right) / 2 : tip[0] < x;
  const start: Point = [left ? x : right, y];
  const bend: Point = entity.text.leader === 'elbow' ? explicit ?? [start[0] + (left ? -5 : 5), y] : start;
  return { tip, bend, start };
}
