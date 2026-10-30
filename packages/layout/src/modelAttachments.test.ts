// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import type { Id } from '@pushform/core';
import { createDocument, UndoStack } from '@pushform/model';
import type { LayoutEntity } from './LayoutDocument';
import { previewLayoutModelAnnotation, resolveLayoutModelAttachment, type LayoutModelAttachment } from './modelAttachments';
import { createLinearDimension, formatLinearDimension } from './dimensions';

function fixture() {
  const doc = createDocument();
  const undo = new UndoStack(doc);
  const vertexId = 100 as Id;
  doc.transact('Vertex', state => {
    state.definitions.get(state.rootDefinitionId)!.entities.sketch.vertices.set(vertexId, { id: vertexId, p: [1, 0, 0] });
  });
  const view: LayoutEntity = { id: 10, layerId: 1, kind: 'image', closed: true,
    points: [[0, 0], [100, 0], [100, 100], [0, 100]], image: { src: '', viewport: {
      source: { referenceId: 1 }, templateId: null, originalId: null, scene: null, background: null, cache: null,
      camera: { eye: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], projection: 'parallel', scale: 0.02, fov: 30 },
    } } };
  const attachment: LayoutModelAttachment = { viewportId: view.id, source: { referenceId: 1 },
    modelGuid: doc.state.meta.guid, anchor: { kind: 'sketchVertex', path: [], id: vertexId } };
  const resolve = () => resolveLayoutModelAttachment(attachment, id => id === view.id ? view : undefined, doc.state);
  return { doc, undo, view, attachment, vertexId, resolve };
}

it('follows a saved vertex edit and view scale while undo restores the identity', () => {
  const { undo, view, vertexId, resolve } = fixture();
  expect(resolve()).toEqual({ status: 'resolved', modelPoint: [1, 0, 0], paperPoint: [70, 50] });
  undo.transact('Move', state => { state.definitions.get(state.rootDefinitionId)!.entities.sketch.vertices.get(vertexId)!.p = [2, 0, 0]; });
  expect(resolve()).toEqual({ status: 'resolved', modelPoint: [2, 0, 0], paperPoint: [90, 50] });
  view.image!.viewport!.camera.scale = 0.01;
  expect(resolve()).toMatchObject({ paperPoint: [70, 50] });
  undo.undo();
  expect(resolve()).toMatchObject({ paperPoint: [60, 50] });
});

it('never substitutes a coincident vertex when the attached identity is deleted', () => {
  const { undo, vertexId, resolve } = fixture();
  undo.transact('Replace vertex', state => {
    const vertices = state.definitions.get(state.rootDefinitionId)!.entities.sketch.vertices;
    vertices.delete(vertexId);
    vertices.set(101 as Id, { id: 101 as Id, p: [1, 0, 0] });
  });
  expect(resolve()).toEqual({ status: 'detached' });
  undo.undo();
  expect(resolve().status).toBe('resolved');
});

it('distinguishes unloaded models from a replaced source or a removed viewport', () => {
  const { doc, view, attachment, resolve } = fixture();
  expect(resolveLayoutModelAttachment(attachment, () => view, undefined)).toEqual({ status: 'unavailable' });
  expect(resolveLayoutModelAttachment(attachment, () => undefined, doc.state)).toEqual({ status: 'detached' });
  expect(resolveLayoutModelAttachment(attachment, () => view, createDocument().state)).toEqual({ status: 'detached' });
  view.image!.viewport!.source = { referenceId: 2 };
  expect(resolve()).toEqual({ status: 'detached' });
});

it('previews model measurements and camera changes without changing saved annotation state', () => {
  const { doc, view, attachment } = fixture();
  doc.transact('Second vertex', state => {
    state.definitions.get(state.rootDefinitionId)!.entities.sketch.vertices.set(101 as Id, { id: 101 as Id, p: [3, 0, 2] });
  });
  const dimension = createLinearDimension();
  const entity: LayoutEntity = { id: 20, kind: 'dimension', layerId: 1, closed: false,
    points: [[70, 50], [110, 50], [80, 60]], dimension,
    modelAnnotation: { status: 'resolved', attachments: [attachment,
      { ...attachment, anchor: { kind: 'sketchVertex', path: [], id: 101 as Id } }] } };
  const before = structuredClone(entity);
  const preview = () => previewLayoutModelAnnotation(entity, () => view, () => doc.state);
  expect(formatLinearDimension(preview().dimension!)).toBe('2000.0 mm');
  view.image!.viewport!.camera.scale = 0.01;
  expect(preview().points.slice(0, 2)).toEqual([[60, 50], [80, 50]]);
  expect(formatLinearDimension(preview().dimension!)).toBe('2000.0 mm');
  view.image!.viewport!.camera.projection = 'perspective';
  expect(preview().dimension!.cachedValueMm).toBeCloseTo(Math.sqrt(8) * 1000);
  expect(entity).toEqual(before);
  expect(doc.state.definitions.get(doc.state.rootDefinitionId)!.entities.sketch.vertices.get(101 as Id)!.p).toEqual([3, 0, 2]);
});
