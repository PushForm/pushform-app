// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { meshBox, type FaceLocalId, type Id } from '@pushform/core';
import { createDocument, createDocumentState, Document, setDocumentAutoFreeze, type DocumentDraft } from './Document';
import { UndoStack } from './UndoStack';
import { bodyFromMesh } from './body/BodyBuilder';
import type { Body } from './entities/body';

const FACE = 0 as FaceLocalId;

function makeBox(): { doc: Document; undo: UndoStack; id: Id; body: () => Body } {
  const doc = createDocument();
  const undo = new UndoStack(doc);
  const id = doc.transact('box', (d) => bodyFromMesh(d, meshBox([0, 0, 0], [1, 1, 1]), { container: d.definitions.get(d.rootDefinitionId)!.entities }).id).value;
  return { doc, undo, id, body: () => doc.rootDefinition.entities.bodies.get(id)! };
}

const bodyDraft = (d: DocumentDraft, id: Id): Body => d.definitions.get(d.rootDefinitionId)!.entities.bodies.get(id) as unknown as Body;

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
});
