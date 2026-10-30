// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { allocId } from '@pushform/model';
import { isLayoutLayerVisible, type LayoutDocumentState, type LayoutEntity, type LayoutPathHandle } from './LayoutDocument';
import { flattenLayoutPath, isSimpleLayoutLoop, type PaperPathPoint as Point } from './path';

/** Weld unambiguous open endpoints on the active layer. Call within a document transaction. */
export function addLayoutLine(state: LayoutDocumentState, pageId: number, a: Point, b: Point): number {
  const page = state.pages.get(pageId);
  if (!page) throw new Error('Unknown page');
  const layer = state.layers.get(state.activeLayerId);
  if (!layer || layer.locked || !isLayoutLayerVisible(page, state, layer.id)) throw new Error('Active layer is unavailable');
  const same = (p: Point, q: Point): boolean => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6;
  if (same(a, b)) throw new Error('Line needs two distinct endpoints');
  const entities = layer.shared ? state.sharedEntities : page.entities;
  const order = layer.shared ? state.sharedEntityOrder : page.entityOrder;
  const match = (p: Point): { entity: LayoutEntity; first: boolean } | null => {
    const matches: { entity: LayoutEntity; first: boolean }[] = [];
    for (const entity of entities.values()) {
      if (entity.locked || entity.hidden || entity.groupId !== undefined || entity.kind !== 'path' || entity.closed || entity.layerId !== layer.id || entity.points.length < 2) continue;
      if (same(p, entity.points[0]!)) matches.push({ entity, first: true });
      if (same(p, entity.points.at(-1)!)) matches.push({ entity, first: false });
    }
    return matches.length === 1 ? matches[0]! : null;
  };
  const start = match(a), end = match(b);
  const primary = start?.entity ?? end?.entity;
  const entityId = primary?.id ?? allocId(state);
  const mappings = new Map<number, number[]>();
  const orient = (entity: LayoutEntity, reverse: boolean, offset: number): { points: Point[]; handles: LayoutPathHandle[] } => {
    mappings.set(entity.id, entity.points.map((_, i) => offset + (reverse ? entity.points.length - 1 - i : i)));
    const points = entity.points.map((p): Point => [...p]);
    const handles = entity.points.map((_, i): LayoutPathHandle => ({ ...entity.handles?.[i] }));
    if (reverse) { points.reverse(); handles.reverse(); for (const h of handles) [h.in, h.out] = [h.out, h.in]; }
    // The new connecting segment must be straight; retain all existing interior controls.
    return { points, handles };
  };
  let points: Point[], handles: LayoutPathHandle[];
  const closes = Boolean(start && end && start.entity.id === end.entity.id);
  if (closes) {
    const oriented = orient(start!.entity, start!.first, 0);
    points = oriented.points; handles = oriented.handles;
    handles[0]!.in = undefined; handles.at(-1)!.out = undefined;
  } else {
    const before = start ? orient(start.entity, start.first, 0) : { points: [[...a] as Point], handles: [{}] };
    const after = end ? orient(end.entity, !end.first, before.points.length) : { points: [[...b] as Point], handles: [{}] };
    before.handles.at(-1)!.out = undefined; after.handles[0]!.in = undefined;
    points = [...before.points, ...after.points]; handles = [...before.handles, ...after.handles];
  }
  const samples = closes ? flattenLayoutPath(points, handles, true) : [];
  const closed = closes && isSimpleLayoutLoop(samples.slice(0, -1));
  if (closes && !closed) { points.push([...points[0]!] as Point); handles.push({}); }
  const style = { ...(primary?.style ?? state.defaultStyle) };
  if (closed) style.fillColor ??= state.defaultStyle.fillColor ?? '#ffffff';
  else if (!primary) style.fillColor = null;
  // Each free end keeps its source path's arrow; extending a path past an end carries that end's arrow to
  // the new tip, and a new line takes the default arrows. A path joined into a loop has none.
  const far = (m: { entity: LayoutEntity; first: boolean }) => m.first ? m.entity.style?.endArrow : m.entity.style?.startArrow;
  const joined = (m: { entity: LayoutEntity; first: boolean }) => m.first ? m.entity.style?.startArrow : m.entity.style?.endArrow;
  const startArrow = closes ? undefined : start ? far(start) : end ? joined(end) : state.defaultStyle.startArrow;
  const endArrow = closes ? undefined : end ? far(end) : start ? joined(start) : state.defaultStyle.endArrow;
  delete style.startArrow; delete style.endArrow;
  if (startArrow) style.startArrow = { ...startArrow };
  if (endArrow) style.endArrow = { ...endArrow };
  const entity: LayoutEntity = { id: entityId, kind: 'path', layerId: layer.id, points, closed, style,
    ...(handles.some((h) => h.in || h.out) ? { handles } : {}) };
  entities.set(entityId, entity);
  if (!primary) order.push(entityId);
  if (end && end.entity.id !== entityId) {
    entities.delete(end.entity.id); order.splice(order.indexOf(end.entity.id), 1);
  }
  // Welding has an exact vertex mapping, so existing dimensions can keep their associations.
  const annotations = [...state.sharedEntities.values(), ...[...state.pages.values()].flatMap((p) => [...p.entities.values()])];
  for (const annotation of annotations) for (const anchor of [...((annotation.dimension ?? annotation.angularDimension)?.anchors ?? []), ...(annotation.angularDimension?.rayDefinition?.anchors ?? []), annotation.labelAnchor]) {
    if (!anchor) continue;
    const mapping = mappings.get(anchor.entityId);
    if (!mapping || anchor.pointCount !== mapping.length || mapping[anchor.pointIndex] === undefined) continue;
    if (anchor.t !== undefined) {
      // A point along a segment keeps its place when both of the segment's ends map to consecutive vertices; a
      // reversed segment starts at the other end.
      const from = mapping[anchor.pointIndex]!, to = mapping[anchor.pointIndex + 1];
      if (to === from + 1) anchor.pointIndex = from;
      else if (to === from - 1) { anchor.pointIndex = to; anchor.t = 1 - anchor.t; }
      else continue;
      anchor.entityId = entityId; anchor.pointCount = points.length;
      continue;
    }
    anchor.entityId = entityId; anchor.pointIndex = mapping[anchor.pointIndex]!; anchor.pointCount = points.length;
  }
  return entityId;
}
