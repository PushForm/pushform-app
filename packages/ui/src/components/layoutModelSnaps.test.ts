// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { meshBox, type Id, type Vec3 } from '@pushform/core';
import { bodyFromMesh, createDocument, ImageStore } from '@pushform/model';
import { createLayoutDocumentState, type LayoutEntity } from '@pushform/layout';
import type { LayoutViewportModel } from './layoutViewportRenders';
import { snapLayoutModelVertex } from './layoutModelSnaps';

const loaded = vi.hoisted(() => ({ model: undefined as LayoutViewportModel | undefined }));
vi.mock('./layoutViewportRenders', () => ({ peekLayoutViewportModel: () => loaded.model, viewGeometry: (model: LayoutViewportModel) => model }));
afterEach(() => { loaded.model = undefined; });

function fixture(edges: { a: Vec3; b: Vec3; hidden?: boolean; soft?: boolean }[]) {
  const model = createDocument(), state = createLayoutDocumentState(), page = state.pages.get(state.pageOrder[0]!)!;
  const rendered = edges.map(({ a, b, hidden = false, soft = false }, index) => ({ id: 100 + index * 3, a, b, hidden, soft, smooth: false }));
  model.transact('Geometry', draft => {
    const sketch = draft.definitions.get(draft.rootDefinitionId)!.entities.sketch;
    for (const edge of rendered) {
      const a = (edge.id + 1) as Id, b = (edge.id + 2) as Id;
      sketch.vertices.set(a, { id: a, p: [...edge.a] }); sketch.vertices.set(b, { id: b, p: [...edge.b] });
      sketch.edges.set(edge.id as Id, { id: edge.id as Id, a, b, hidden: edge.hidden, soft: edge.soft, smooth: false,
        curveId: null, locked: false, tagId: draft.defaultTagId, castShadows: true, receiveShadows: true, attributes: {} });
    }
  });
  loaded.model = { state: model.state, images: new ImageStore(), scenes: [], bounds: null, bodies: [], pictures: [],
    display: { hiddenGeometry: false } as LayoutViewportModel['display'], sketches: [{ id: '', path: [], version: 1, faces: [], edges: rendered }] };
  const view: LayoutEntity = { id: state.meta.nextId++, kind: 'image', layerId: state.activeLayerId, closed: true,
    points: [[0, 0], [100, 0], [100, 100], [0, 100]], image: { src: '', viewport: {
      source: { referenceId: 7 }, templateId: null, originalId: null, scene: null, background: null, cache: null,
      camera: { eye: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], projection: 'parallel', scale: 0.02, fov: 30 },
    } } };
  page.entities.set(view.id, view); page.entityOrder.push(view.id);
  const snap = (point: [number, number] = [50, 50]) => snapLayoutModelVertex(point, page, state, 2);
  return { state, page, view, snap, model };
}

it('chooses the frontmost identity when different model vertices project to the same paper point', () => {
  const { snap } = fixture([{ a: [0, 0, 0], b: [2, 0, 0] }, { a: [0, 0, 3], b: [2, 0, 3] }]);
  expect(snap([50.5, 50.5])).toMatchObject({ point: [50, 50], attachment: { anchor: { kind: 'sketchVertex', id: 104 } } });
});

it('respects hidden geometry display overrides without stale candidate caching', () => {
  const { snap, view } = fixture([{ a: [0, 0, 0], b: [2, 0, 0], soft: true }]);
  expect(snap()).toBeNull();
  view.image!.viewport!.display = { hiddenGeometry: true, faceStyle: 'shaded', edges: true, profiles: true, backEdges: false, xray: false };
  expect(snap()).toMatchObject({ attachment: { anchor: { id: 101 } } });
  view.image!.viewport!.display!.hiddenGeometry = false;
  expect(snap()).toBeNull();
});

it('excludes clipped vertices even when the cursor is within snap tolerance', () => {
  const { snap, view } = fixture([{ a: [0, 0, 0], b: [2, 0, 0] }]);
  view.image!.clip = { points: [[0, 0], [0.49, 0], [0.49, 1], [0, 1]] };
  expect(snap([48.5, 50])).toBeNull();
});

it('does not snap through a solid surface, but allows visible back edges and X-ray geometry', () => {
  const { snap, view, model } = fixture([{ a: [0, 0, 0], b: [2, 0, 0] }]);
  model.transact('Occluding solid', draft => {
    bodyFromMesh(draft, meshBox([-1, -1, 1], [1, 1, 2]), { container: draft.definitions.get(draft.rootDefinitionId)!.entities });
  });
  loaded.model!.state = model.state;
  expect(snap()).toBeNull();
  view.image!.viewport!.display = { hiddenGeometry: false, faceStyle: 'shaded', edges: true, profiles: true, backEdges: false, xray: true };
  expect(snap()).toMatchObject({ attachment: { anchor: { id: 101 } } });
  view.image!.viewport!.display!.xray = false;
  view.image!.viewport!.display!.backEdges = true;
  expect(snap()).toMatchObject({ attachment: { anchor: { id: 101 } } });
});

it('does not snap to a vertex removed by an active section cut', () => {
  const { snap, model } = fixture([{ a: [0, 0, 0], b: [2, 0, 0] }]);
  model.transact('Cut below z=1', draft => {
    const root = draft.definitions.get(draft.rootDefinitionId)!.entities, id = 200 as Id;
    root.sectionPlanes.set(id, { id, name: 'Cut', symbol: 'A', plane: { n: [0, 0, 1], d: -1 }, origin: [0, 0, 1],
      tagId: draft.defaultTagId, hidden: false, locked: false, castShadows: false, receiveShadows: false, attributes: {} });
    root.activeSectionPlaneId = id;
    root.order.push(id);
  });
  loaded.model!.state = model.state;
  expect(snap()).toBeNull();
});

it('uses the topmost visible viewport and distinguishes an unloaded model from a paper hit', () => {
  const { state, page, view, snap } = fixture([{ a: [0, 0, 0], b: [2, 0, 0] }]);
  const top = { ...view, id: state.meta.nextId++ };
  page.entities.set(top.id, top); page.entityOrder.push(top.id);
  expect(snap()).toMatchObject({ attachment: { viewportId: top.id } });
  top.hidden = true;
  expect(snap()).toMatchObject({ attachment: { viewportId: view.id } });
  loaded.model = undefined;
  expect(snap()).toEqual({ unavailable: true });
  state.settings.objectSnap = false;
  expect(snap()).toBeNull();
});
