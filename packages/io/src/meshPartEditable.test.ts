// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type { Id, MaterialId, TagId } from '@pushform/core';
import { allocId, createDocument } from '@pushform/model';
import type { MeshPart, MeshPartGeometry } from '@pushform/model';
import { makeMeshPartEditable } from './meshPartEditable';

/** A unit box of 6 source faces (two triangles each); `drop` leaves one face out so the part is open. */
function boxGeometry(materials: number[], drop = -1): MeshPartGeometry {
  const positions = Float64Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]);
  const faces = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [0, 4, 7, 3], [1, 2, 6, 5]];
  const triangles: number[] = [], triangleFace: number[] = [];
  faces.forEach((ring, f) => { if (f === drop) return; triangles.push(ring[0]!, ring[1]!, ring[2]!, ring[0]!, ring[2]!, ring[3]!); triangleFace.push(f, f); });
  return { positions, triangles: Uint32Array.from(triangles), triangleFace: Uint32Array.from(triangleFace), faceCount: 6,
    faceMaterials: Uint32Array.from(materials), edgeOffsets: new Uint32Array(0), edgePositions: new Float64Array(0), edgeFlags: new Uint8Array(0) };
}
/** A cylinder-ish prism: a 12-sided tube whose side is one curved source face, with flat caps. */
function prismGeometry(): MeshPartGeometry {
  const n = 12, pts: number[] = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; pts.push(Math.cos(a), Math.sin(a), 0, Math.cos(a), Math.sin(a), 1); }
  const triangles: number[] = [], triangleFace: number[] = [];
  for (let i = 0; i < n; i++) {
    const b0 = i * 2, t0 = i * 2 + 1, b1 = ((i + 1) % n) * 2, t1 = ((i + 1) % n) * 2 + 1;
    triangles.push(b0, b1, t1, b0, t1, t0); triangleFace.push(0, 0);
  }
  for (let i = 1; i + 1 < n; i++) { triangles.push(0, (i + 1) * 2, i * 2); triangleFace.push(1); triangles.push(1, i * 2 + 1, (i + 1) * 2 + 1); triangleFace.push(2); }
  return { positions: Float64Array.from(pts), triangles: Uint32Array.from(triangles), triangleFace: Uint32Array.from(triangleFace), faceCount: 3,
    faceMaterials: new Uint32Array(3), edgeOffsets: new Uint32Array(0), edgePositions: new Float64Array(0), edgeFlags: new Uint8Array(0) };
}

function docWithPart(geometry: (red: MaterialId, blue: MaterialId) => MeshPartGeometry) {
  const doc = createDocument();
  let id = 0 as Id, red = 0 as MaterialId, blue = 0 as MaterialId, tag = 0 as TagId;
  doc.transact('part', d => {
    const base = d.materials.get(d.defaultMaterialId)!;
    red = allocId<MaterialId>(d); d.materials.set(red, { ...base, id: red, name: 'Red', color: [1, 0, 0] });
    blue = allocId<MaterialId>(d); d.materials.set(blue, { ...base, id: blue, name: 'Blue', color: [0, 0, 1] });
    tag = allocId<TagId>(d); d.tags.set(tag, { ...d.tags.get(d.defaultTagId)!, id: tag, name: 'Imported' });
    const e = d.definitions.get(d.rootDefinitionId)!.entities;
    id = allocId<Id>(d);
    const part: MeshPart = { tagId: tag, hidden: false, locked: false, castShadows: false, receiveShadows: true, attributes: {},
      id, name: 'Leg', source: { format: 'STEP', system: 'FreeCAD' }, geometry: geometry(red, blue), materialId: blue };
    e.meshParts.set(id, part as never); e.order.push(id);
  });
  return { doc, id, red, blue, tag };
}

describe('makeMeshPartEditable', () => {
  it('turns a closed part into one solid whose faces keep their colors, the part material, tag and shadow flags', () => {
    const { doc, id, red, blue, tag } = docWithPart((r) => boxGeometry([r, 0, 0, 0, 0, 0]));
    const materialsBefore = doc.state.materials.size;
    const result = doc.transact('Make Editable', d => makeMeshPartEditable(d, [], id)).value;
    expect(result).toMatchObject({ bodies: 1, sheetFaces: 0 });
    const e = doc.rootDefinition.entities;
    expect(e.meshParts.size).toBe(0);
    expect(e.order).not.toContain(id);
    expect(e.bodies.size).toBe(1);
    const body = [...e.bodies.values()][0]!;
    expect(body.faces.size).toBe(6);
    expect(body.valid).toBe(true);
    expect(body.materialId).toBe(blue);
    expect(body.tagId).toBe(tag);
    expect(body.castShadows).toBe(false);
    expect([...body.faces.values()].filter(f => f.frontMaterialId === red)).toHaveLength(1);
    // The part's materials are reused, not copied.
    expect(doc.state.materials.size).toBe(materialsBefore);
    expect(e.order).toContain(body.id);
  });

  it('turns an open part into sheet faces with the part tag', () => {
    const { doc, id, tag } = docWithPart(() => boxGeometry([0, 0, 0, 0, 0, 0], 1));
    const result = doc.transact('Make Editable', d => makeMeshPartEditable(d, [], id)).value;
    expect(result).toMatchObject({ bodies: 0, sheetFaces: 5 });
    const sketch = doc.rootDefinition.entities.sketch;
    expect(sketch.faces.size).toBe(5);
    expect([...sketch.faces.values()].every(f => f.tagId === tag)).toBe(true);
  });

  it('keeps the facets of a curved source face apart and joins the facets of a flat one', () => {
    const { doc, id } = docWithPart(() => prismGeometry());
    doc.transact('Make Editable', d => makeMeshPartEditable(d, [], id));
    const body = [...doc.rootDefinition.entities.bodies.values()][0]!;
    // 24 side facets (two per segment) plus two flat caps joined whole; every edge between side facets is smooth.
    expect(body.faces.size).toBe(26);
    expect([...body.edges.values()].filter(e => e.smooth)).toHaveLength(24);
  });
});
