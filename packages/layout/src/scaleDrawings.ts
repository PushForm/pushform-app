// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { createLayoutDocumentState, type LayoutDocumentState, type LayoutEntity } from './LayoutDocument';
import { entitiesForLayer, isLayoutLayerVisible } from './LayoutDocument';
import { scaleLayoutEntities } from './transforms';
import { layoutTextCenter } from './rotation';
import { rotateLayoutEntities } from './transforms';
import { flattenLayoutPath, layoutPathContours } from './path';

/** Annotation sizes in full-size drawings are authored for a 1:50 reference view. */
export const DRAWING_ANNOTATION_SCALE = 50;
export function createScaleDrawingState(): LayoutDocumentState {
  const state = createLayoutDocumentState();
  state.settings.drawing = true;
  state.settings.grid.spacingMm = 100;
  state.defaultStyle.strokeWeightPt *= DRAWING_ANNOTATION_SCALE;
  state.defaultStyle.fillColor = null;
  const page = state.pages.get(state.pageOrder[0]!)!;
  page.name = 'Drawing'; page.size = [10000, 7000];
  page.margin = { top: 0, bottom: 0, left: 0, right: 0 };
  return state;
}
export function visibleDrawingEntities(state: LayoutDocumentState, pageId: number): LayoutEntity[] {
  const page = state.pages.get(pageId);
  if (!page) throw new Error('Source drawing page is unavailable.');
  return state.layerOrder.filter(id => isLayoutLayerVisible(page, state, id))
    .flatMap(id => entitiesForLayer(page, state, id)).filter(e => !e.hidden);
}
/** Geometry is scaled into paper space; annotation type retains its printed size. */
export function drawingViewEntities(entities: readonly LayoutEntity[], denominator: number, x: number, y: number, rotation: number): LayoutEntity[] {
  if (![denominator, x, y, rotation].every(Number.isFinite) || denominator <= 0) throw new Error('Choose a positive finite scale and finite placement.');
  const scaled = scaleLayoutEntities(entities, [0, 0], 1 / denominator, 1 / denominator);
  for (const [index, entity] of scaled.entries()) {
    const original = entities[index]!;
    delete entity.drawingView; delete entity.groupId; delete entity.nestedGroupIds;
    if (entity.style) entity.style = { ...entity.style, strokeWeightPt: entity.style.strokeWeightPt / denominator,
      ...(entity.style.strokeDashMm ? { strokeDashMm: entity.style.strokeDashMm.map(n => n / denominator) } : {}),
      ...(entity.style.startArrow ? { startArrow: { ...entity.style.startArrow, sizePt: entity.style.startArrow.sizePt / DRAWING_ANNOTATION_SCALE } } : {}),
      ...(entity.style.endArrow ? { endArrow: { ...entity.style.endArrow, sizePt: entity.style.endArrow.sizePt / DRAWING_ANNOTATION_SCALE } } : {}) };
    // Embedded model references belong to the source document; this view retains their cached picture only.
    if (entity.image?.viewport) { entity.image = { ...entity.image }; delete entity.image.viewport; }
    if (entity.text && original.text) {
      const styled = scaleLayoutEntities([original], [0, 0], 1 / DRAWING_ANNOTATION_SCALE, 1 / DRAWING_ANNOTATION_SCALE)[0]!;
      entity.text = styled.text!;
      const center = layoutTextCenter(entity), styledCenter = layoutTextCenter(styled);
      entity.points = entity.points.map((point, index) => index < 2
        ? [styled.points[index]![0] + center[0] - styledCenter[0], styled.points[index]![1] + center[1] - styledCenter[1]] : point);
    }
    if (entity.dimension && original.dimension) {
      const styled = scaleLayoutEntities([original], [0, 0], 1 / DRAWING_ANNOTATION_SCALE, 1 / DRAWING_ANNOTATION_SCALE)[0]!;
      entity.dimension = { ...styled.dimension!, anchors: [null, null], scale: 1 / denominator, detached: false };
    }
    if (entity.angularDimension && original.angularDimension) {
      const styled = scaleLayoutEntities([original], [0, 0], 1 / DRAWING_ANNOTATION_SCALE, 1 / DRAWING_ANNOTATION_SCALE)[0]!;
      entity.angularDimension = { ...styled.angularDimension!, anchors: [null, null, null] };
      delete entity.angularDimension.edgeAnchors; delete entity.angularDimension.rayDefinition;
    }
    delete entity.labelAnchor; delete entity.modelAnnotation; delete entity.preservedModelConnections;
  }
  return rotateLayoutEntities(scaled, [0, 0], rotation).map(entity => ({ ...entity,
    points: entity.points.map(p => [p[0] + x, p[1] + y]),
    ...(entity.handles ? { handles: entity.handles.map(h => ({ ...(h.in ? { in: [h.in[0] + x, h.in[1] + y] as [number, number] } : {}), ...(h.out ? { out: [h.out[0] + x, h.out[1] + y] as [number, number] } : {}) })) } : {}),
  }));
}
export type DrawingPlane = 'xy' | 'xz' | 'yz';
/** Drawings are Y down in millimeters; model space is right handed, Z up, in meters. */
export function drawingSketchPaths(entities: readonly LayoutEntity[], plane: DrawingPlane, origin: [number, number, number], rotation: number) {
  if (![...origin, rotation].every(Number.isFinite)) throw new Error('Placement must be finite.');
  const angle = rotation * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  return entities.filter(e => e.kind === 'path').flatMap(e => layoutPathContours(e.points, e.handles, e.closed, e.contourStarts, e.openContours))
    .map(contour => ({ closed: contour.closed, points: (contour.closed ? flattenLayoutPath(contour.points, contour.handles, true, 32).slice(0, -1) : flattenLayoutPath(contour.points, contour.handles, false, 32)).map(([px, py]): [number, number, number] => {
      const x = (px * c + py * s) / 1000, y = (px * s - py * c) / 1000;
      const p = plane === 'xy' ? [x, y, 0] : plane === 'xz' ? [x, 0, y] : [0, x, y];
      return [p[0]! + origin[0], p[1]! + origin[1], p[2]! + origin[2]];
    }) })).filter(p => p.points.length >= 2);
}
