// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { LENGTH_TOL, m4transformPoint, v3addScaled, v3dot, v3normalize, v3sub, type Id, type Vec3 } from '@pushform/core';
import { bodyVertexAt, bodyVertexFaces, containerAt, pathWithin } from '@pushform/model';
import { PickService, SpatialIndex } from '@pushform/inference';
import { entitiesForLayer, flattenLayoutPath, isLayoutLayerVisible, isViewport, pointInsideLayoutPath, viewportCameraBasis, viewportPaperPoint,
  type LayoutDocumentState, type LayoutEntity, type LayoutModelAttachment, type LayoutPage } from '@pushform/layout';
import { peekLayoutViewportModel, viewGeometry, type LayoutViewportModel } from './layoutViewportRenders';

type Candidate = { point: Vec3; hidden: boolean; anchor: LayoutModelAttachment['anchor'] };
const candidates = new WeakMap<LayoutViewportModel, Map<string | null, Candidate[]>>();
const pickers = new WeakMap<LayoutViewportModel, Map<string | null, PickService>>();

/** Reuse Modeling's surface and section-cut picking with the viewport's scene tag visibility. */
function picker(model: LayoutViewportModel, scene: string | null): PickService {
  let scenes = pickers.get(model);
  if (!scenes) pickers.set(model, scenes = new Map());
  const cached = scenes.get(scene);
  if (cached) return cached;
  const saved = model.scenes.find(candidate => candidate.name === scene);
  const hidden = new Set(saved?.hiddenTags);
  const state = saved?.usesTags ? { ...model.state,
    tags: new Map([...model.state.tags].map(([id, tag]) => [id, { ...tag, visible: !hidden.has(tag.name) }])),
  } : model.state;
  const index = new SpatialIndex();
  index.setState(state);
  const result = new PickService(index);
  scenes.set(scene, result);
  return result;
}

function vertices(model: LayoutViewportModel, scene: string | null): Candidate[] {
  let scenes = candidates.get(model);
  if (!scenes) candidates.set(model, scenes = new Map());
  const cached = scenes.get(scene);
  if (cached) return cached;
  const result: Candidate[] = [], geometry = viewGeometry(model, scene);
  for (const rendered of geometry.sketches) {
    const path = [...rendered.path] as Id[], sketch = containerAt(model.state, path).sketch;
    const seen = new Map<number, Candidate>();
    for (const edge of rendered.edges) {
      const source = sketch.edges.get(edge.id as Id);
      if (!source) continue;
      for (const [id, point] of [[source.a, edge.a], [source.b, edge.b]] as const) {
        const hidden = edge.hidden || edge.soft, existing = seen.get(id);
        if (existing) { existing.hidden &&= hidden; continue; }
        const candidate: Candidate = { point, hidden, anchor: { kind: 'sketchVertex', path, id } };
        seen.set(id, candidate); result.push(candidate);
      }
    }
  }
  for (const rendered of geometry.bodies) {
    const path = [...rendered.path] as Id[], body = containerAt(model.state, path).bodies.get(rendered.entityId as Id);
    if (!body) continue;
    const seen = new Map<string, Candidate>();
    // Boundary edges determine which corners are visible; soft tessellation edges are not normal snap targets.
    const edges = rendered.edges ?? [...body.faces.values()].flatMap(face => face.loops.map(points => ({ points, hidden: face.hidden, soft: false })));
    for (const edge of edges) {
      for (const point of edge.points) {
        const faceIds = bodyVertexFaces(body, point), key = faceIds.join(',');
        const hidden = edge.hidden || edge.soft, existing = seen.get(key);
        if (existing) { existing.hidden &&= hidden; continue; }
        if (!bodyVertexAt(body, faceIds)) continue;
        const candidate: Candidate = { point: m4transformPoint(rendered.transform, point), hidden,
          anchor: { kind: 'bodyVertex', path, bodyId: body.id, faceIds } };
        seen.set(key, candidate); result.push(candidate);
      }
    }
  }
  scenes.set(scene, result);
  return result;
}

function insideView(view: LayoutEntity, point: [number, number]): boolean {
  if (!pointInsideLayoutPath(point, view.points)) return false;
  const clip = view.image?.clip;
  if (!clip) return true;
  const [a, b, , d] = view.points;
  if (!a || !b || !d) return false;
  const paper = ([u, v]: [number, number]): [number, number] => [a[0] + u * (b[0] - a[0]) + v * (d[0] - a[0]), a[1] + u * (b[1] - a[1]) + v * (d[1] - a[1])];
  return pointInsideLayoutPath(point, flattenLayoutPath(clip.points.map(paper), clip.handles?.map(h => ({
    ...(h.in ? { in: paper(h.in) } : {}), ...(h.out ? { out: paper(h.out) } : {}),
  })), true));
}

/** Snap only to the topmost visible view under the pointer, using its scene's rendered geometry. */
export function snapLayoutModelVertex(point: [number, number], page: LayoutPage, state: LayoutDocumentState, tolerance: number):
  { point: [number, number]; attachment: LayoutModelAttachment } | { unavailable: true } | null {
  if (state.settings.objectSnap === false) return null;
  for (const layer of [...state.layerOrder].reverse()) {
    if (!isLayoutLayerVisible(page, state, layer)) continue;
    for (const view of entitiesForLayer(page, state, layer).reverse()) {
      if (!isViewport(view) || view.hidden || !insideView(view, point)) continue;
      const viewport = view.image.viewport, model = peekLayoutViewportModel(state, viewport.source);
      if (!model) return { unavailable: true };
      const display = { ...model.display, ...viewport.display }, { forward } = viewportCameraBasis(viewport.camera);
      const picking = picker(model, viewport.scene);
      let best: { point: [number, number]; candidate: Candidate; distance: number; depth: number } | null = null;
      for (const candidate of vertices(model, viewport.scene)) {
        if (candidate.hidden && !display.hiddenGeometry) continue;
        const paper = viewportPaperPoint(view.points, viewport.camera, [...candidate.point]);
        if (!paper || !insideView(view, paper)) continue;
        const distance = Math.hypot(paper[0] - point[0], paper[1] - point[1]);
        if (distance > tolerance) continue;
        if (picking.index.cuts().some(cut => pathWithin(candidate.anchor.path, cut.path) &&
          v3dot(cut.normal, candidate.point) + cut.d < -LENGTH_TOL)) continue;
        const depth = v3dot(v3sub(candidate.point, viewport.camera.eye), forward);
        if (!display.xray && display.faceStyle !== 'wireframe' && !display.backEdges) {
          const perspective = viewport.camera.projection === 'perspective';
          const origin = perspective ? viewport.camera.eye : v3addScaled(candidate.point, forward, -depth);
          const dir = perspective ? v3normalize(v3sub(candidate.point, origin)) : forward;
          const surface = picking.candidates({ ray: { origin, dir }, screen: [0, 0], pixelSizeAt: () => 0 },
            { kinds: ['face', 'sketchFace', 'image'] }).surface;
          if (surface && surface.t < v3dot(v3sub(candidate.point, origin), dir) - LENGTH_TOL) continue;
        }
        const samePaperPoint = best && Math.hypot(best.point[0] - paper[0], best.point[1] - paper[1]) <= LENGTH_TOL * 1000;
        if (!best || (samePaperPoint ? depth < best.depth : distance < best.distance))
          best = { point: paper, candidate, distance, depth };
      }
      return best ? { point: best.point, attachment: { viewportId: view.id, source: { ...viewport.source },
        modelGuid: model.state.meta.guid, anchor: best.candidate.anchor } } : null;
    }
  }
  return null;
}
