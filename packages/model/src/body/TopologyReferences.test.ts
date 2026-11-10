// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { meshBox, type FaceLocalId } from '@pushform/core';
import { applyKernelResult } from './Reconcile';
import { bodyFromMesh } from './BodyBuilder';
import { createDocument } from '../Document';
import type { KernelResult } from './Reconcile';
function setup() {
  const doc = createDocument();
  const id = doc.transact('Solid', draft => bodyFromMesh(draft, meshBox([0, 0, 0], [1, 1, 1]), { container: draft.definitions.get(draft.rootDefinitionId)!.entities }).id).value;
  const body = () => doc.rootDefinition.entities.bodies.get(id)!;
  doc.transact('Assignment', draft => { draft.pluginData = new Map([['io.example.parts', { dataVersion: 1, entries: new Map([['part', { target: { kind: 'document' }, payload: new Uint8Array([42]), references: [{ target: { kind: 'body', id }, element: { kind: 'face', faceId: 0, bodyVersion: body().version } }] }]]) }]]); });
  const ref = () => doc.state.pluginData!.get('io.example.parts')!.entries.get('part')!.references[0]!;
  return { doc, id, body, ref };
}
function own(mesh = meshBox([0, 0, 0], [1, 1, 2])): KernelResult {
  return { mesh, selfRunId: 7, faceOrigin: new Map([...new Set(mesh.faceId)].map(id => [id as FaceLocalId, [{ runId: 7, faceId: id as FaceLocalId }]])) };
}
it('remaps a face renamed by unique kernel provenance and includes metadata in the geometry undo entry', () => {
  const s = setup(), result = own();
  result.mesh = { ...result.mesh, faceId: result.mesh.faceId.map(id => id === 0 ? 10 : id) };
  result.faceOrigin.delete(0 as FaceLocalId); result.faceOrigin.set(10 as FaceLocalId, [{ runId: 7, faceId: 0 as FaceLocalId }]);
  const tx = s.doc.transact('Kernel edit', draft => applyKernelResult(draft, s.id, result));
  expect(s.ref().element).toEqual({ kind: 'face', faceId: 10, bodyVersion: s.body().version }); expect(s.ref().unresolved).toBeUndefined();
  s.doc.applyPatches(tx.inversePatches, tx.patches, 'undo', 'Edit'); expect(s.ref().element!.bodyVersion).toBe(s.body().version); expect(s.ref().element).toMatchObject({ kind: 'face', faceId: 0 });
  s.doc.applyPatches(tx.patches, tx.inversePatches, 'redo', 'Edit'); expect(s.ref().element!.bodyVersion).toBe(s.body().version);
});
it('retains a split assignment for explicit review instead of choosing the surviving local face id', () => {
  const s = setup(), previous = structuredClone(s.ref()), result = own();
  const ids = result.mesh.faceId.slice(); ids[0] = 6;
  result.mesh = { ...result.mesh, faceId: ids }; result.faceOrigin.set(6 as FaceLocalId, [{ runId: 7, faceId: 0 as FaceLocalId }]);
  const tx = s.doc.transact('Split', draft => applyKernelResult(draft, s.id, result));
  expect(s.ref()).toEqual({ ...previous, unresolved: true });
  s.doc.applyPatches(tx.inversePatches, tx.patches, 'undo', 'Edit'); expect(s.ref()).toEqual(previous);
  s.doc.applyPatches(tx.patches, tx.inversePatches, 'redo', 'Edit'); expect(s.ref().unresolved).toBe(true);
});
it('does not retain a face reused in a merge or in an output with foreign provenance', () => {
  for (const foreign of [false, true]) {
    const s = setup(), previous = structuredClone(s.ref()), result = own();
    result.faceOrigin.get(0 as FaceLocalId)!.push({ runId: foreign ? 8 : 7, faceId: 1 as FaceLocalId });
    s.doc.transact('Merge', draft => applyKernelResult(draft, s.id, result));
    expect(s.ref()).toEqual({ ...previous, unresolved: true });
  }
});
it('chains receipts within one transaction and refuses version changes with no topology proof', () => {
  const s = setup();
  s.doc.transact('Two edits', draft => { applyKernelResult(draft, s.id, own()); applyKernelResult(draft, s.id, own(meshBox([0, 0, 0], [1, 1, 3]))); });
  expect(s.ref().unresolved).toBeUndefined(); expect(s.ref().element!.bodyVersion).toBe(s.body().version);
  const previous = structuredClone(s.ref());
  s.doc.transact('Unproven edit', draft => { draft.definitions.get(draft.rootDefinitionId)!.entities.bodies.get(s.id)!.version++; });
  expect(s.ref()).toEqual({ ...previous, unresolved: true });
});
