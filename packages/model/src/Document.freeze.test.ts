// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isDraft } from 'immer';
import { meshBox, type FaceLocalId, type Id } from '@pushform/core';
import { createDocument, createDocumentState, Document, setDocumentAutoFreeze, type DocumentDraft } from './Document';
import { UndoStack } from './UndoStack';
import { bodyFromMesh } from './body/BodyBuilder';
import { applyKernelResult } from './body/Reconcile';
import type { Body, EdgeKey, EdgeRecord, FaceRecord } from './entities/body';

const FACE = 0 as FaceLocalId;

function makeBox(): { doc: Document; undo: UndoStack; id: Id; body: () => Body } {
  const doc = createDocument();
  const undo = new UndoStack(doc);
  const id = doc.transact('box', (d) => bodyFromMesh(d, meshBox([0, 0, 0], [1, 1, 1]), { container: d.definitions.get(d.rootDefinitionId)!.entities }).id).value;
  return { doc, undo, id, body: () => doc.rootDefinition.entities.bodies.get(id)! };
}

const bodyDraft = (d: DocumentDraft, id: Id): Body => d.definitions.get(d.rootDefinitionId)!.entities.bodies.get(id) as unknown as Body;

/** A box of a different size with the same face and triangle layout. */
const resized = (x: number) => ({ mesh: meshBox([0, 0, 0], [x, 1, 1]), faceOrigin: new Map() });

describe('with auto-freeze off (production)', () => {
  beforeEach(() => setDocumentAutoFreeze(false));
  afterEach(() => setDocumentAutoFreeze(true));

  it('keeps committed state frozen where code relies on it', () => {
    const { doc, id, body } = makeBox();
    doc.transact('paint', (d) => { bodyDraft(d, id).faces.get(FACE)!.frontMaterialId = doc.state.defaultMaterialId; });
    expect(Object.isFrozen(doc.state)).toBe(true);
    expect(Object.isFrozen(doc.rootDefinition)).toBe(true);
    expect(Object.isFrozen(body())).toBe(true);
    expect(Object.isFrozen(body().faces)).toBe(true);
    for (const face of body().faces.values()) expect(Object.isFrozen(face)).toBe(true);
    for (const edge of body().edges.values()) expect(Object.isFrozen(edge)).toBe(true);
  });

  it('seals the records of a state installed whole, below the Maps Immer does not freeze into', () => {
    const { body } = makeBox();
    const source = body();
    const copy: Body = { ...source, faces: new Map([...source.faces].map(([k, f]) => [k, { ...f }])), edges: new Map([...source.edges].map(([k, e]) => [k, { ...e }])) };
    const state = createDocumentState();
    state.definitions.get(state.rootDefinitionId)!.entities.bodies.set(copy.id, copy);
    const loaded = new Document(createDocumentState());
    loaded.replaceState(state);
    const installed = loaded.rootDefinition.entities.bodies.get(copy.id)!;
    expect(Object.isFrozen(installed.faces)).toBe(true);
    expect(Object.isFrozen(installed.faces.get(FACE))).toBe(true);
    expect(Object.isFrozen(installed.edges)).toBe(true);
  });

  it('records a single-face edit as a patch on that face, without touching its siblings', () => {
    const { doc, undo, id, body } = makeBox();
    const before = body();
    const sibling = before.faces.get(1 as FaceLocalId)!;
    let patches: { path: (string | number)[] }[] = [];
    doc.events.on('change', (e) => { patches = e.patches; });
    undo.transact('paint', (d) => { bodyDraft(d, id).faces.get(FACE)!.frontMaterialId = doc.state.defaultMaterialId; });
    expect(patches.map((p) => p.path.slice(-3))).toEqual([['faces', FACE, 'frontMaterialId']]);
    expect(body().faces).not.toBe(before.faces);
    expect(body().faces.get(1 as FaceLocalId)).toBe(sibling);
    undo.undo();
    expect(body().faces.get(FACE)!.frontMaterialId).toBeNull();
    expect(body().faces.get(1 as FaceLocalId)).toBe(sibling);
  });

  it('finalizes a draft that a command copied into a rebuilt record', () => {
    const { doc, id, body } = makeBox();
    doc.transact('copy draft', (d) => {
      const draft = bodyDraft(d, id);
      const uv = draft.faces.get(FACE)!.uv;
      applyKernelResult(d, id, resized(2));
      // an unchanged draft of the old record's mapping, assigned into a record rebuilt above
      bodyDraft(d, id).faces.get(1 as FaceLocalId)!.uv = uv;
    });
    const uv = body().faces.get(1 as FaceLocalId)!.uv;
    expect(isDraft(uv)).toBe(false);
    expect(uv).toEqual(body().faces.get(FACE)!.uv);
  });
});

describe.each([
  ['on', true],
  ['off', false],
])('undo of a whole-table replacement, auto-freeze %s', (_name, autoFreeze) => {
  beforeEach(() => setDocumentAutoFreeze(autoFreeze));
  afterEach(() => setDocumentAutoFreeze(true));

  it('swaps the recorded tables back rather than cloning them', () => {
    const { undo, id, body } = makeBox();
    const before = body();
    undo.transact('resize', (d) => applyKernelResult(d, id, resized(2)));
    const after = body();
    expect(after.faces).not.toBe(before.faces);
    undo.undo();
    expect(body().faces).toBe(before.faces);
    expect(body().edges).toBe(before.edges);
    expect(body().version).toBe(before.version);
    undo.redo();
    expect(body().faces).toBe(after.faces);
    expect(body().edges).toBe(after.edges);
  });

  it('restores the same records and ids across undo and redo cycles', () => {
    const { undo, id, body } = makeBox();
    const snapshot = (b: Body): [FaceLocalId, FaceRecord][] => [...b.faces];
    const edgesOf = (b: Body): [EdgeKey, EdgeRecord][] => [...b.edges];
    const beforeFaces = snapshot(body()), beforeEdges = edgesOf(body());
    undo.transact('resize', (d) => applyKernelResult(d, id, resized(3)));
    const afterFaces = snapshot(body()), afterEdges = edgesOf(body());
    for (let i = 0; i < 3; i++) {
      undo.undo();
      expect(snapshot(body())).toEqual(beforeFaces);
      expect(edgesOf(body())).toEqual(beforeEdges);
      undo.redo();
      expect(snapshot(body())).toEqual(afterFaces);
      expect(edgesOf(body())).toEqual(afterEdges);
    }
  });

  it('keeps a recorded table intact when a later patch in the same entry edits inside it', () => {
    const { doc, undo, id, body } = makeBox();
    undo.beginGroup('group');
    undo.withinGroup(() => undo.transact('resize', (d) => applyKernelResult(d, id, resized(2))));
    const recorded = body().faces;
    const material = doc.state.defaultMaterialId;
    undo.withinGroup(() => undo.transact('paint', (d) => { bodyDraft(d, id).faces.get(FACE)!.frontMaterialId = material; }));
    undo.endGroup(true);

    undo.undo();
    expect(recorded.get(FACE)!.frontMaterialId).toBeNull();
    undo.redo();
    expect(body().faces.get(FACE)!.frontMaterialId).toBe(material);
    expect(recorded.get(FACE)!.frontMaterialId).toBeNull();
    undo.undo();
    expect(body().faces.get(FACE)!.frontMaterialId).toBeNull();
  });
});
