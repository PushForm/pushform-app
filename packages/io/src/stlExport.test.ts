// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { m4mul, m4scaling, m4translation, meshBox, type DefId, type Id, type Mat4, type MMat4, type TagId, type Vec3 } from '@pushform/core';
import { bodyFromMesh, createDocument, createEntityContainer, SketchGraph, type ComponentInstance, type Document, type DocumentDraft } from '@pushform/model';
import { exportStl, stlFileName } from './stlExport';

function addDefinition(d: DocumentDraft, name: string): DefId {
  const root = d.definitions.get(d.rootDefinitionId)!;
  const id = d.meta.nextId++ as DefId;
  d.definitions.set(id, { ...root, id, name, isGroup: false, entities: createEntityContainer(), bounds: null } as never);
  return id;
}
function addInstance(d: DocumentDraft, definitionId: DefId, transform: MMat4, extra: Partial<ComponentInstance> = {}): Id {
  const id = d.meta.nextId++ as Id;
  d.definitions.get(d.rootDefinitionId)!.entities.instances.set(id, { id, definitionId, transform: transform as unknown as Mat4, name: '',
    materialId: null, tagId: d.defaultTagId, hidden: false, locked: false, castShadows: true, receiveShadows: true, attributes: {}, ...extra } as never);
  return id;
}

/** A 1 m cube component placed at x = 2 m and, mirrored, at x = -2 m. */
function cubes(): { doc: Document; placed: Id; mirrored: Id; body: Id } {
  const doc = createDocument();
  let placed = 0 as Id, mirrored = 0 as Id, body = 0 as Id;
  doc.transact('fixture', d => {
    const def = addDefinition(d, 'Cube');
    body = bodyFromMesh(d, meshBox([0, 0, 0], [1, 1, 1]), { container: d.definitions.get(def)!.entities }).id;
    placed = addInstance(d, def, m4translation([2, 0, 0]));
    mirrored = addInstance(d, def, m4mul(m4translation([-2, 0, 0]), m4scaling([-1, 1, 1])));
  });
  return { doc, placed, mirrored, body };
}

/** Triangles of a binary STL, each as its normal and three corners. */
function readBinary(bytes: Uint8Array): { header: string; tris: { n: Vec3; p: [Vec3, Vec3, Vec3] }[] } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), count = view.getUint32(80, true);
  expect(bytes.byteLength).toBe(84 + count * 50);
  const f = (at: number): number => view.getFloat32(at, true), v = (at: number): Vec3 => [f(at), f(at + 4), f(at + 8)];
  return { header: new TextDecoder().decode(bytes.slice(0, 80)).replace(/\0+$/, ''),
    tris: Array.from({ length: count }, (_, t) => ({ n: v(84 + t * 50), p: [v(96 + t * 50), v(108 + t * 50), v(120 + t * 50)] })) };
}
/** Volume enclosed by triangles wound counterclockwise seen from outside: positive for outward-facing solids. */
function volume(tris: { p: [Vec3, Vec3, Vec3] }[]): number {
  return tris.reduce((sum, { p: [a, b, c] }) => sum + (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6, 0);
}

describe('STL export', () => {
  it('writes every visible solid in world space, outward through mirrored placements, in the chosen unit', () => {
    const { doc } = cubes();
    const { bytes, triangles, notes } = exportStl(doc.state, { unit: 'mm', format: 'binary', name: 'Two cubes.pf' });
    const { header, tris } = readBinary(bytes);
    expect(header).toBe('PushForm STL: Two cubes.pf');
    expect(triangles).toBe(24); expect(tris).toHaveLength(24);
    expect(notes).toEqual([]);
    // Each cube is 1000 mm on a side and encloses positive volume, so its facets face outward.
    expect(volume(tris)).toBeCloseTo(2e9, -3);
    expect(Math.min(...tris.flatMap(t => t.p.map(p => p[0])))).toBeCloseTo(-3000, 3);
    expect(Math.max(...tris.flatMap(t => t.p.map(p => p[0])))).toBeCloseTo(3000, 3);
    for (const { n, p: [a, b, c] } of tris) {
      const centroid = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
      const center = [centroid[0]! > 0 ? 2500 : -2500, 500, 500];
      expect(n[0] * (centroid[0]! - center[0]!) + n[1] * (centroid[1]! - center[1]!) + n[2] * (centroid[2]! - center[2]!)).toBeGreaterThan(0);
    }
    const inches = readBinary(exportStl(doc.state, { unit: 'in', format: 'binary' }).bytes);
    expect(volume(inches.tris)).toBeCloseTo(2 / 0.0254 ** 3, 0);
  });

  it('writes ASCII STL with the same facets', () => {
    const { doc } = cubes();
    const text = new TextDecoder().decode(exportStl(doc.state, { unit: 'm', format: 'ascii', name: 'Cubes' }).bytes);
    expect(text.startsWith('solid Cubes\n  facet normal ')).toBe(true);
    expect(text.trimEnd().endsWith('endsolid Cubes')).toBe(true);
    expect(text.match(/endfacet/g)).toHaveLength(24);
    expect(text).toContain('vertex 3.00000000e+0 1.00000000e+0 1.00000000e+0');
  });

  it('leaves out hidden placements and those on hidden tags, and exports only the selection when asked', () => {
    const { doc, placed, mirrored, body } = cubes();
    expect(readBinary(exportStl(doc.state, { unit: 'mm', format: 'binary', selection: [{ kind: 'instance', path: [], id: placed }] }).bytes).tris).toHaveLength(12);
    const oneFace = exportStl(doc.state, { unit: 'mm', format: 'binary', selection: [{ kind: 'face', path: [mirrored], id: body, faceId: 0 as never, region: null }] });
    expect(oneFace.triangles).toBe(2);
    doc.transact('hide', d => {
      const tagId = d.meta.nextId++ as TagId;
      d.tags.set(tagId, { id: tagId, name: 'Off', visible: false, color: [0, 0, 0], dashes: null, folderId: null });
      d.definitions.get(d.rootDefinitionId)!.entities.instances.get(placed)!.tagId = tagId;
    });
    expect(exportStl(doc.state, { unit: 'mm', format: 'binary' }).triangles).toBe(12);
    doc.transact('hide', d => { d.definitions.get(d.rootDefinitionId)!.entities.instances.get(mirrored)!.hidden = true; });
    expect(() => exportStl(doc.state, { unit: 'mm', format: 'binary' })).toThrow('The model has no visible faces to export.');
    expect(() => exportStl(doc.state, { unit: 'mm', format: 'binary', selection: [{ kind: 'instance', path: [], id: mirrored }] }))
      .toThrow('The selection has no visible faces to export.');
  });

  it('includes sheet faces facing their front, with a note that they are not solids', () => {
    const doc = createDocument();
    doc.transact('sheet', d => { const g = SketchGraph.for(d); g.addEdge([0, 0, 0], [1, 0, 0]); g.addEdge([1, 0, 0], [0, 1, 0]); g.addEdge([0, 1, 0], [0, 0, 0]); });
    const face = [...doc.rootDefinition.entities.sketch.faces.values()][0]!;
    const { bytes, notes } = exportStl(doc.state, { unit: 'mm', format: 'binary' });
    const [tri] = readBinary(bytes).tris;
    expect(readBinary(bytes).tris).toHaveLength(1);
    expect(tri!.n.map(v => Math.round(v) + 0)).toEqual(face.basis.n.map(v => Math.round(v) + 0));
    expect(notes).toEqual(['1 face is not part of a solid; 3D printers usually need closed solids.']);
  });

  it('names the file after the model', () => {
    expect(stlFileName('Bench.pf')).toBe('Bench.stl');
    expect(stlFileName('Untitled')).toBe('Untitled.stl');
  });
});
