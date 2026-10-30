// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createLayoutDocument } from '@pushform/layout';
import { validateImportedLayoutState } from './layoutImportValidation';

it('accepts exact valid state without cloning it or interpreting opaque strings', () => {
  const state = structuredClone(createLayoutDocument().state);
  state.customFields.set('note', 'NaN and Infinity are ordinary text here');
  expect(validateImportedLayoutState(state)).toBe(state);
});

it.each([NaN, Infinity, -Infinity])('rejects nonfinite imported geometry before installation (%s)', bad => {
  const state = structuredClone(createLayoutDocument().state), page = state.pages.get(state.pageOrder[0]!)!;
  const id = state.meta.nextId++;
  page.entities.set(id, { id, kind: 'path', layerId: state.activeLayerId, points: [[0, 0], [1, bad]], closed: false });
  page.entityOrder.push(id);
  expect(() => validateImportedLayoutState(state)).toThrow(`entities[${id}].points[1][1]`);
  expect(page.entities.get(id)!.points[1]![1]).toBe(bad);
});

it('rejects the infinite parallel scale produced by a zero source camera height', () => {
  const state = structuredClone(createLayoutDocument().state), page = state.pages.get(state.pageOrder[0]!)!;
  const id = state.meta.nextId++;
  page.entities.set(id, { id, kind: 'image', layerId: state.activeLayerId, points: [[0, 0], [10, 10]], closed: true,
    image: { src: '', viewport: { source: { archiveId: 'source', modelReferenceId: 'model' }, templateId: 'view', originalId: 'view',
      camera: { eye: [1, 0, 0], target: [0, 0, 0], up: [0, 0, 1], projection: 'parallel', fov: 30, scale: Infinity },
      scene: null, background: null, cache: null } } });
  page.entityOrder.push(id);
  expect(() => validateImportedLayoutState(state)).toThrow('viewport.camera.scale');
});

it('rejects cycles without retaining a document-sized visited set', () => {
  const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
  expect(() => validateImportedLayoutState(cyclic)).toThrow('cyclic');
});
