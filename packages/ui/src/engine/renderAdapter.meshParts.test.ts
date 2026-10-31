// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type { Id, MaterialId } from '@pushform/core';
import { allocId, createDocument } from '@pushform/model';
import type { MeshPart, MeshPartGeometry } from '@pushform/model';
import { renderKey } from '@pushform/render';
import { bodiesToRender, highlightFor } from './renderAdapter';

/** A unit box: 6 source faces of two triangles, 12 edges, the top face colored. */
function boxGeometry(top: MaterialId): MeshPartGeometry {
  const positions = Float64Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]);
  const faces = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [0, 4, 7, 3], [1, 2, 6, 5]];
  const triangles: number[] = [], triangleFace: number[] = [];
  faces.forEach((ring, f) => { triangles.push(ring[0]!, ring[1]!, ring[2]!, ring[0]!, ring[2]!, ring[3]!); triangleFace.push(f, f); });
  const edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  const edgePositions: number[] = [], edgeOffsets = [0];
  for (const [a, b] of edges) { edgePositions.push(...positions.subarray(a! * 3, a! * 3 + 3), ...positions.subarray(b! * 3, b! * 3 + 3)); edgeOffsets.push(edgePositions.length / 3); }
  return { positions, triangles: Uint32Array.from(triangles), triangleFace: Uint32Array.from(triangleFace), faceCount: 6,
    faceMaterials: Uint32Array.from([0, top, 0, 0, 0, 0]), edgeOffsets: Uint32Array.from(edgeOffsets), edgePositions: Float64Array.from(edgePositions),
    edgeFlags: Uint8Array.from([0, 0, 0, 0, 1, 2, 0, 0, 0, 0, 0, 0]) };
}

function docWithPart() {
  const doc = createDocument();
  let id = 0 as Id, red = 0 as MaterialId;
  doc.transact('part', d => {
    red = allocId<MaterialId>(d);
    d.materials.set(red, { ...d.materials.get(d.defaultMaterialId)!, id: red, name: 'Red', color: [1, 0, 0] });
    const e = d.definitions.get(d.rootDefinitionId)!.entities;
    id = allocId<Id>(d);
    const part: MeshPart = { tagId: d.defaultTagId, hidden: false, locked: false, castShadows: true, receiveShadows: true, attributes: {},
      id, name: 'Seat', source: { format: 'STEP', system: 'FreeCAD' }, geometry: boxGeometry(red), materialId: null };
    e.meshParts.set(id, part as never); e.order.push(id);
  });
  return { doc, id, red };
}

describe('mesh parts in the render adapter', () => {
  it('draws a mesh part as a body: its arrays as the mesh, its source edges with flags, its colored faces, one smooth group per curved face', () => {
    const { doc, id } = docWithPart();
    const bodies = bodiesToRender(doc.state);
    expect(bodies).toHaveLength(1);
    const part = doc.rootDefinition.entities.meshParts.get(id)!, rendered = bodies[0]!;
    expect(rendered.id).toBe(renderKey([], id));
    expect(rendered.mesh.verts).toBe(part.geometry.positions);
    expect(rendered.mesh.tris).toBe(part.geometry.triangles);
    expect(rendered.mesh.faceId).toBe(part.geometry.triangleFace);
    expect(rendered.edges).toHaveLength(12);
    expect(rendered.edges![4]).toMatchObject({ soft: true, smooth: false, points: [[0, 0, 1], [1, 0, 1]] });
    expect(rendered.edges![5]).toMatchObject({ soft: false, smooth: true });
    // Every box face has two facets, so each shades across its own facets.
    expect(rendered.surfaces).toHaveLength(6);
    expect(rendered.faceMaterials!.size).toBe(1);
    expect(rendered.faceMaterials!.get(1)!.front!.color).toBe('#ff0000');
    // Derived objects keep their identity while the geometry is unchanged, so the renderer sees no change.
    const again = bodiesToRender(doc.state)[0]!;
    expect(again.mesh).toBe(rendered.mesh);
    expect(again.edges).toBe(rendered.edges);
    expect(again.surfaces).toBe(rendered.surfaces);
    expect(again.faceMaterials).toBe(rendered.faceMaterials);
  });

  it('hides a mesh part with itself or its tag, and highlights it whole', () => {
    const { doc, id } = docWithPart();
    expect(highlightFor(doc.state, { kind: 'meshPart', path: [], id })).toEqual({ kind: 'body', key: renderKey([], id) });
    expect(highlightFor(doc.state, { kind: 'meshPart', path: [], id: (id + 1) as Id })).toBeNull();
    doc.transact('hide', d => { d.definitions.get(d.rootDefinitionId)!.entities.meshParts.get(id)!.hidden = true; });
    expect(bodiesToRender(doc.state)).toHaveLength(0);
  });
});
