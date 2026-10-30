// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { meshBox, type Id } from '@pushform/core';
import { addImprintEdge, bodyFromMesh, createDocument, findFaceContainingPoints } from '@pushform/model';
import { createInferenceEngine } from './InferenceEngineImpl';

function setup() {
  const doc = createDocument();
  let bodyId = 0 as Id;
  doc.transact('box', (draft) => {
    const root = draft.definitions.get(draft.rootDefinitionId)!;
    bodyId = bodyFromMesh(draft, meshBox([0, 0, 0], [2, 2, 1]), { container: root.entities }).id;
  });
  const loc = findFaceContainingPoints(doc.rootDefinition.entities, [[0.5, 1, 1], [1.5, 1, 1]])!;
  doc.transact('imprint', (draft) => {
    const body = draft.definitions.get(draft.rootDefinitionId)!.entities.bodies.get(bodyId)!;
    addImprintEdge(body, loc.faceId, [0.5, 1, 1], [1.5, 1, 1]);
  });
  const engine = createInferenceEngine();
  engine.setState(doc.state);
  const down = (x: number, y: number) => ({
    ray: { origin: [x, y, 5] as [number, number, number], dir: [0, 0, -1] as [number, number, number] },
    screen: [0, 0] as [number, number],
    pixelSizeAt: () => 0.005,
  });
  return { doc, bodyId, engine, down, faceId: loc.faceId };
}

describe('imprint edges in inference', () => {
  it('picks an imprint edge instead of the face under it', () => {
    const { engine, down, bodyId } = setup();
    const hit = engine.pick(down(1, 1.01), { pickOnly: true });
    expect(hit?.ref.kind).toBe('imprintEdge');
    expect(hit?.ref.id).toBe(bodyId);
  });
  it('snaps to imprint endpoints and midpoints', () => {
    const { engine, down } = setup();
    expect(engine.resolve(down(1.5, 1.01)).primary.kind).toBe('endpoint');
    expect(engine.resolve(down(1, 1.01)).primary.kind).toBe('midpoint');
  });
  it('rebuilds the index when imprints change without a version bump', () => {
    const { doc, engine, down, bodyId, faceId } = setup();
    doc.transact('more', (draft) => {
      const body = draft.definitions.get(draft.rootDefinitionId)!.entities.bodies.get(bodyId)!;
      addImprintEdge(body, faceId, [0.5, 1.5, 1], [1.5, 1.5, 1]);
    });
    engine.setState(doc.state);
    expect(engine.pick(down(1, 1.51), { pickOnly: true })?.ref.kind).toBe('imprintEdge');
  });
});
