// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { createDocument } from '@pushform/model';
import { applySketchUpImport } from './sketchupDocument';
import { is3dsBytes, read3ds, threeDsExtent } from './threeDs';
import { probeMeshImport, readModelImport } from './modelImport';

/** A 3DS chunk: id, then length, then its parts. */
function chunk(id: number, ...parts: Uint8Array[]): Uint8Array {
  const length = 6 + parts.reduce((sum, part) => sum + part.length, 0), out = new Uint8Array(length), view = new DataView(out.buffer);
  view.setUint16(0, id, true); view.setUint32(2, length, true);
  let at = 6;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
const u16 = (...values: number[]): Uint8Array => { const out = new Uint8Array(values.length * 2), view = new DataView(out.buffer); values.forEach((v, i) => view.setUint16(i * 2, v, true)); return out; };
const u32 = (...values: number[]): Uint8Array => { const out = new Uint8Array(values.length * 4), view = new DataView(out.buffer); values.forEach((v, i) => view.setUint32(i * 4, v, true)); return out; };
const f32 = (...values: number[]): Uint8Array => { const out = new Uint8Array(values.length * 4), view = new DataView(out.buffer); values.forEach((v, i) => view.setFloat32(i * 4, v, true)); return out; };
const text = (s: string): Uint8Array => Uint8Array.from([...s].map(c => c.charCodeAt(0)).concat(0));
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));

const CUBE_POINTS = [0, 0, 0, 1000, 0, 0, 1000, 1000, 0, 0, 1000, 0, 0, 0, 1000, 1000, 0, 1000, 1000, 1000, 1000, 0, 1000, 1000];
// Outward, counterclockwise: bottom, top, front, back, left, right.
const CUBE_FACES = [0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];

/** A 1000-unit cube named `name`, painted with `material`, with each face in its own smoothing group. */
function cube(name: string, material: string): Uint8Array {
  const faces = Array.from({ length: 12 }, (_, f) => [...CUBE_FACES.slice(f * 3, f * 3 + 3), 7]).flat();
  return chunk(0x4000, text(name), chunk(0x4100,
    chunk(0x4110, u16(8), f32(...CUBE_POINTS)),
    chunk(0x4140, u16(8), f32(0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1)),
    chunk(0x4120, u16(12), u16(...faces),
      chunk(0x4130, text(material), u16(12), u16(...Array.from({ length: 12 }, (_, i) => i))),
      chunk(0x4150, u32(...Array.from({ length: 12 }, (_, i) => 1 << Math.floor(i / 2)))))));
}
function file(...objects: Uint8Array[]): Uint8Array {
  const material = chunk(0xafff, chunk(0xa000, text('Brick')), chunk(0xa020, chunk(0x0011, Uint8Array.from([255, 0, 0]))),
    chunk(0xa050, chunk(0x0030, u16(25))), chunk(0xa200, chunk(0xa300, text('BRICK.PNG')), chunk(0xa354, f32(2)), chunk(0xa356, f32(2))));
  return chunk(0x4d4d, chunk(0x0002, u32(3)), chunk(0x3d3d, chunk(0x3d3e, u32(3)), material, ...objects), chunk(0xb000));
}

describe('3DS import', () => {
  it('recognizes 3DS files and measures their extent in file units', () => {
    const bytes = file(cube('Box', 'Brick'));
    expect(is3dsBytes(bytes)).toBe(true);
    expect(is3dsBytes(bytes.slice(0, 20))).toBe(false);
    expect(threeDsExtent(bytes)).toEqual({ min: [0, 0, 0], max: [1000, 1000, 1000] });
    expect(probeMeshImport(bytes)).toMatchObject({ kind: '3ds' });
  });

  it('reads objects as groups in the chosen unit with materials, smoothing groups and textures', async () => {
    const moved = cube('Box 2', 'Brick');
    // Move the second cube 2000 units along x: 3DS stores points in world coordinates.
    const view = new DataView(moved.buffer);
    const start = [...moved].findIndex((_, i) => view.getUint16(i, true) === 0x4110 && i > 6) + 8;
    for (let i = 0; i < 8; i++) view.setFloat32(start + i * 12, view.getFloat32(start + i * 12, true) + 2000, true);
    const scene = await readModelImport(zipSync({ 'model/Brick.3ds': file(cube('Box', 'Brick'), moved), 'model/brick.png': PNG }), undefined, { unit: 'mm', up: 'y' });
    expect(scene.format?.kind).toBe('3ds');
    expect(scene.root.instances.map(i => i.name)).toEqual(['Box', 'Box 2']);
    const [box, box2] = [...scene.definitions.values()];
    // Millimeters to meters; 3DS is Z up, so the up option does not turn it.
    expect(box!.solids).toHaveLength(1);
    expect(Math.max(...box!.solids[0]!.faces.flatMap(f => f.loops[0]!.map(p => p[2])))).toBeCloseTo(1, 6);
    expect(Math.min(...box2!.solids[0]!.faces.flatMap(f => f.loops[0]!.map(p => p[0])))).toBeCloseTo(2, 6);
    // Two triangles per side share a smoothing group, so each side is one face; sides in different groups stay hard.
    expect(box!.solids[0]!.faces).toHaveLength(6);
    expect(box!.solids[0]!.faces.flatMap(f => f.edgeFlags.flat()).some(f => f.soft)).toBe(false);
    const brick = [...scene.materials.values()].find(m => m.name === 'Brick')!;
    // The image is found by name, ignoring case; tiling 2 puts two tiles on each 1 m side.
    expect(brick).toMatchObject({ color: [1, 0, 0], alpha: 0.75, texture: { image: 0 } });
    expect(brick.texture!.widthM).toBeCloseTo(0.5, 9);
    expect(scene.warnings).toContain('The keyframe data (animation and object pivots) is not imported; meshes are imported where they are stored.');
    expect(createDocument().transact('Open', d => applySketchUpImport(d, scene)).value).toMatchObject({ format: '3DS', bodies: 2, materials: 1 });
  });

  it('smooths edges between faces at an angle that share a smoothing group', async () => {
    const faces = [0, 1, 2, 7, 0, 2, 3, 7];
    const fold = chunk(0x4000, text('Fold'), chunk(0x4100,
      chunk(0x4110, u16(4), f32(0, 0, 0, 1, 0, 0, 1, 1, 1, 0, 1, 0)),
      chunk(0x4120, u16(2), u16(...faces), chunk(0x4130, text('Brick'), u16(2), u16(0, 1)), chunk(0x4150, u32(4, 4)))));
    const scene = await read3ds(file(fold), { unit: 'm', up: 'z' });
    const flags = scene.root.sheets.flatMap(f => f.edgeFlags.flat());
    expect(scene.root.sheets).toHaveLength(2);
    expect(new Set(flags.filter(f => f.soft && f.smooth).map(f => f.edge)).size).toBe(1);
    expect(scene.warnings).toContain('1 textured material uses its color: textures are imported from a .zip archive that holds the model with its images.');
    await expect(read3ds(new Uint8Array([0x4d, 0x4d, 1, 0, 0, 0]), { unit: 'm', up: 'z' })).rejects.toThrow('Not a 3DS model');
  });
});
