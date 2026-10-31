// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { createDocument } from '@pushform/model';
import { applySketchUpImport } from './sketchupDocument';
import { isStlBytes, readStl, stlExtent } from './stl';
import { modelImportFormat, probeMeshImport, readModelImport } from './modelImport';

type P = [number, number, number];

const CUBE: P[] = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]];
// Outward, counterclockwise: bottom, top, front, back, left, right.
const CUBE_FACES = [0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
const cube = (offset: P = [0, 0, 0], skip = 0): P[][] => Array.from({ length: 12 - skip }, (_, f) =>
  CUBE_FACES.slice(f * 3, f * 3 + 3).map(i => CUBE[i]!.map((v, k) => v + offset[k]!) as P));

/** A closed, curved mesh standing in for the Stanford bunny: an icosphere, subdivided twice, wound outward. */
function sphere(radius: number): P[][] {
  const t = (1 + Math.sqrt(5)) / 2;
  const unit = (p: P): P => { const l = Math.hypot(...p); return [p[0] / l, p[1] / l, p[2] / l]; };
  let points: P[] = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(p => unit(p as P));
  let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let level = 0; level < 2; level++) {
    const middles = new Map<string, number>();
    const middle = (a: number, b: number): number => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      let at = middles.get(key);
      if (at === undefined) { at = points.length; points = [...points, unit(points[a]!.map((v, k) => (v + points[b]![k]!) / 2) as P)]; middles.set(key, at); }
      return at;
    };
    faces = faces.flatMap(([a, b, c]) => { const ab = middle(a!, b!), bc = middle(b!, c!), ca = middle(c!, a!); return [[a!, ab, ca], [b!, bc, ab], [c!, ca, bc], [ab, bc, ca]]; });
  }
  return faces.map(face => face.map(i => points[i]!.map(v => v * radius) as P));
}

/** A binary STL whose header begins with `solid`, as many exporters write it. */
function binary(triangles: P[][]): Uint8Array {
  const out = new Uint8Array(84 + triangles.length * 50), view = new DataView(out.buffer);
  out.set([...'solid exported by a CAD tool'].map(c => c.charCodeAt(0)));
  view.setUint32(80, triangles.length, true);
  triangles.forEach((triangle, i) => triangle.forEach((p, k) => p.forEach((v, axis) => view.setFloat32(84 + i * 50 + 12 + k * 12 + axis * 4, v, true))));
  return out;
}
function ascii(solids: { name: string; triangles: P[][] }[]): Uint8Array {
  const text = solids.map(({ name, triangles }) => `solid ${name}\n${triangles.map(t => `  facet normal 0 0 0\n    outer loop\n${
    t.map(p => `      vertex ${p.join(' ')}\n`).join('')}    endloop\n  endfacet\n`).join('')}endsolid ${name}\n`).join('');
  return new TextEncoder().encode(text);
}

describe('STL import', () => {
  it('recognizes binary and ASCII STL by content and measures them in file units', () => {
    const solid = binary(cube());
    expect(isStlBytes(solid)).toBe(true);
    expect(isStlBytes(ascii([{ name: 'Box', triangles: cube() }]))).toBe(true);
    // A truncated binary file, and text that is not an STL solid, are not STL.
    expect(isStlBytes(solid.slice(0, solid.length - 1))).toBe(false);
    expect(isStlBytes(new TextEncoder().encode('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'))).toBe(false);
    expect(stlExtent(solid)).toEqual({ min: [0, 0, 0], max: [10, 10, 10] });
    expect(probeMeshImport(solid)).toEqual({ kind: 'stl', extent: { min: [0, 0, 0], max: [10, 10, 10] } });
    expect(modelImportFormat('Part.STL').kind).toBe('stl');
  });

  it('turns a closed binary mesh into one solid in the chosen unit, its coplanar triangles joined', async () => {
    const scene = await readModelImport(binary(cube()), undefined, { unit: 'mm', up: 'z' });
    expect(scene.format?.kind).toBe('stl');
    expect(scene.root.solids).toHaveLength(1);
    expect(scene.root.solids[0]!.faces).toHaveLength(6);
    expect(Math.max(...scene.root.solids[0]!.faces.flatMap(f => f.loops[0]!.map(p => p[2])))).toBeCloseTo(0.01, 9);
  });

  it('imports a closed curved mesh as one valid body, as the roadmap\'s bunny acceptance asks', async () => {
    const scene = await readStl(binary(sphere(50)), { unit: 'mm', up: 'z' });
    expect(scene.root.solids).toHaveLength(1);
    expect(scene.root.sheets).toHaveLength(0);
    expect(createDocument().transact('Open', d => applySketchUpImport(d, scene)).value).toMatchObject({ format: 'STL', bodies: 1, sheetFaces: 0 });
  });

  it('reads ASCII solids as named groups, turns Y up to Z up, and reports open parts and bad triangles', async () => {
    const bad = new TextEncoder().encode('  facet normal 0 0 0\n    outer loop\n      vertex 0 0 x\n      vertex 1 0 0\n      vertex 0 1 0\n    endloop\n  endfacet\n');
    const text = ascii([{ name: 'Lid', triangles: cube() }, { name: 'Tray', triangles: cube([20, 0, 0], 2) }]);
    const body = new Uint8Array([...text.slice(0, text.length - 'endsolid Tray\n'.length), ...bad, ...new TextEncoder().encode('endsolid Tray\n')]);
    const scene = await readStl(body, { unit: 'cm', up: 'y' });
    expect(scene.root.instances.map(i => i.name)).toEqual(['Lid', 'Tray']);
    const [lid, tray] = [...scene.definitions.values()];
    expect(lid!.solids).toHaveLength(1);
    // The tray has no top, so it stays a sheet; Y up turns the file's 10 cm in Y into height.
    expect(tray!.solids).toHaveLength(0);
    expect(tray!.sheets.length).toBeGreaterThan(0);
    expect(Math.max(...lid!.solids[0]!.faces.flatMap(f => f.loops[0]!.map(p => p[2])))).toBeCloseTo(0.1, 9);
    expect(scene.warnings).toContain('1 triangle with invalid data is skipped.');
    expect(scene.warnings.some(w => /^1 connected part does not form a closed solid/.test(w))).toBe(true);
  });

  it('imports a mesh over the mesh-part threshold as one mesh part per solid instead of faces', async () => {
    const scene = await readStl(ascii([{ name: 'Lid', triangles: cube() }, { name: 'Ball', triangles: sphere(50) }]), { unit: 'mm', up: 'z' }, undefined, { meshPartThreshold: 100 });
    expect(scene.root.solids).toHaveLength(0);
    const parts = [...scene.definitions.values()].map(d => ({ name: d.name, part: d.meshParts?.[0] }));
    expect(parts.map(p => p.name)).toEqual(['Lid', 'Ball']);
    expect(parts[0]!.part!.geometry.triangles.length / 3).toBe(12);
    // STL carries no normals, so every triangle is a face of its own and every triangle edge is drawn.
    expect(parts[0]!.part!.geometry.faceCount).toBe(12);
    expect(parts[0]!.part!.geometry.edgeOffsets.length - 1).toBe(18);
    expect(parts[1]!.part!.geometry.triangles.length / 3).toBe(320);
    expect(parts[1]!.part!.source).toEqual({ format: 'STL', system: '' });
    expect(Math.max(...parts[0]!.part!.geometry.positions)).toBeCloseTo(0.01, 9);
    expect(scene.warnings.some(w => /imported as mesh parts/.test(w))).toBe(true);
    const report = createDocument().transact('Open', d => applySketchUpImport(d, scene)).value;
    expect(report).toMatchObject({ bodies: 0, sheetFaces: 0, meshParts: 2, meshPartTriangles: 332 });
    // The same file below the threshold still becomes solids.
    expect((await readStl(ascii([{ name: 'Lid', triangles: cube() }]), { unit: 'mm', up: 'z' })).root.solids).toHaveLength(1);
  });
});
