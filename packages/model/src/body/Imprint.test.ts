// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { meshBox } from '@pushform/core';
import type { FaceLocalId, Id } from '@pushform/core';
import { createDocument } from '../Document';
import { bodyFromMesh } from './BodyBuilder';
import { computeRegions } from './Regions';
import { addImprintEdge, faceContainsPoint, findFaceContainingPoints, imprintEdgesWorld, removeImprintEdge } from './Imprint';

function boxDoc() {
  const doc = createDocument();
  let bodyId = 0 as Id;
  doc.transact('box', (draft) => {
    const root = draft.definitions.get(draft.rootDefinitionId)!;
    bodyId = bodyFromMesh(draft, meshBox([0, 0, 0], [1, 1, 1]), { container: root.entities }).id;
  });
  return { doc, bodyId };
}

describe('imprints', () => {
  it('finds the face containing points and rejects off-face points', () => {
    const { doc, bodyId } = boxDoc();
    const root = doc.rootDefinition.entities;
    const loc = findFaceContainingPoints(root, [[0.2, 0.2, 1], [0.8, 0.8, 1]]);
    expect(loc?.bodyId).toBe(bodyId);
    const top = root.bodies.get(bodyId)!.faces.get(loc!.faceId)!;
    expect(top.plane.n[2]).toBeCloseTo(1);
    expect(faceContainsPoint(top, [1, 1, 1])).toBe(true); // corner on boundary
    expect(findFaceContainingPoints(root, [[0.2, 0.2, 1], [0.5, 0.5, 0.5]])).toBeNull();
    expect(findFaceContainingPoints(root, [[2, 2, 1]])).toBeNull();
  });

  it('adds imprint edges that split the face into regions, and removes them', () => {
    const { doc, bodyId } = boxDoc();
    const root = doc.rootDefinition.entities;
    const { faceId } = findFaceContainingPoints(root, [[0.5, 0.5, 1]])!;
    const sq: [number, number, number][] = [[0.2, 0.2, 1], [0.6, 0.2, 1], [0.6, 0.6, 1], [0.2, 0.6, 1]];
    const ids: number[] = [];
    doc.transact('imprint', (draft) => {
      const body = draft.definitions.get(draft.rootDefinitionId)!.entities.bodies.get(bodyId)!;
      for (let i = 0; i < 4; i++) ids.push(...addImprintEdge(body, faceId as FaceLocalId, sq[i]!, sq[(i + 1) % 4]!));
    });
    const body = doc.rootDefinition.entities.bodies.get(bodyId)!;
    expect(body.imprints.get(faceId)!.edges.size).toBe(4);
    expect(body.imprints.get(faceId)!.vertices.size).toBe(4);
    expect(computeRegions(body, faceId)).toHaveLength(2);
    const world = imprintEdgesWorld(body);
    expect(world).toHaveLength(4);
    expect(world[0]!.a[2]).toBeCloseTo(1);
    doc.transact('remove', (draft) => {
      const b = draft.definitions.get(draft.rootDefinitionId)!.entities.bodies.get(bodyId)!;
      for (const id of ids) removeImprintEdge(b, faceId as FaceLocalId, id);
    });
    expect(doc.rootDefinition.entities.bodies.get(bodyId)!.imprints.has(faceId)).toBe(false);
  });
});

describe('imprint sticky geometry', () => {
  function top() {
    const { doc, bodyId } = (() => {
      const doc = createDocument();
      let bodyId = 0 as Id;
      doc.transact('box', (draft) => {
        const root = draft.definitions.get(draft.rootDefinitionId)!;
        bodyId = bodyFromMesh(draft, meshBox([0, 0, 0], [2, 2, 1]), { container: root.entities }).id;
      });
      return { doc, bodyId };
    })();
    const faceId = findFaceContainingPoints(doc.rootDefinition.entities, [[1, 1, 1]])!.faceId as FaceLocalId;
    const add = (a: [number, number, number], b: [number, number, number]) => {
      let ids: number[] = [];
      doc.transact('line', (draft) => {
        ids = addImprintEdge(draft.definitions.get(draft.rootDefinitionId)!.entities.bodies.get(bodyId)!, faceId, a, b);
      });
      return ids;
    };
    const graph = () => doc.rootDefinition.entities.bodies.get(bodyId)!.imprints.get(faceId)!;
    return { add, graph };
  }

  it('a line ending on an existing line splits it (T-junction)', () => {
    const { add, graph } = top();
    const first = add([0.5, 1, 1], [1.5, 1, 1]);
    expect(first).toHaveLength(1);
    const second = add([1, 1, 1], [1, 1.5, 1]);
    expect(second).toHaveLength(1);
    expect(graph().edges.size).toBe(3);
    expect(graph().vertices.size).toBe(4);
  });

  it('a crossing line splits both lines', () => {
    const { add, graph } = top();
    add([0.5, 1, 1], [1.5, 1, 1]);
    const ids = add([1, 0.5, 1], [1, 1.5, 1]);
    expect(ids).toHaveLength(2);
    expect(graph().edges.size).toBe(4);
    expect(graph().vertices.size).toBe(5);
  });

  it('an existing vertex on the new line splits the new line', () => {
    const { add, graph } = top();
    add([1, 1, 1], [1, 1.5, 1]);
    const ids = add([0.5, 1, 1], [1.5, 1, 1]);
    expect(ids).toHaveLength(2);
    expect(graph().edges.size).toBe(3);
  });

  it('a duplicate line reuses the existing edge', () => {
    const { add, graph } = top();
    const a = add([0.5, 1, 1], [1.5, 1, 1]);
    const b = add([1.5, 1, 1], [0.5, 1, 1]);
    expect(b).toEqual(a);
    expect(graph().edges.size).toBe(1);
  });
});
