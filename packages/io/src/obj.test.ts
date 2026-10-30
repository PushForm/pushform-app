// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { m4transformPoint } from '@pushform/core';
import { createDocument } from '@pushform/model';
import { isObjText, objExtent, readObj } from './obj';
import { probeMeshImport, readModelImport } from './modelImport';
import { applySketchUpImport } from './sketchupDocument';

// A 1×1×1 cube of quads, Y up, in its own units: bottom (y = 0) to top (y = 1).
const CUBE = `v 0 0 0\nv 1 0 0\nv 1 0 1\nv 0 0 1\nv 0 1 0\nv 1 1 0\nv 1 1 1\nv 0 1 1
vt 0 0\nvt 2 0\nvt 2 2\nvt 0 2
f 1/1 2/2 3/3 4/4\nf 5/1 8/2 7/3 6/4\nf 1/1 5/2 6/3 2/4\nf 2/1 6/2 7/3 3/4\nf 3/1 7/2 8/3 4/4\nf 4/1 8/2 5/3 1/4\n`;
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));

describe('OBJ import', () => {
  it('recognizes OBJ text and measures its extent in file units', () => {
    expect(isObjText(strToU8('# exported\n\nmtllib a.mtl\nv 0 0 0\n'))).toBe(true);
    expect(isObjText(strToU8('<COLLADA/>'))).toBe(false);
    expect(objExtent(strToU8(CUBE))).toEqual({ min: [0, 0, 0], max: [1, 1, 1] });
  });

  it('reads groups in the chosen unit with Y turned up, and textures from a .zip with the .mtl', async () => {
    const obj = `mtllib Box parts.mtl\no Box\nusemtl Wood\n${CUBE}o Line\nl 1 7\n`;
    const mtl = 'newmtl Wood\nKd 0.5 0.25 0\nd 0.75\nmap_Kd -s 1 1 textures/wood grain.png\n';
    const archive = zipSync({ 'Box.obj': strToU8(obj), 'Box parts.mtl': strToU8(mtl), 'textures/wood grain.png': PNG });
    expect(probeMeshImport(archive)).toEqual({ kind: 'obj', extent: { min: [0, 0, 0], max: [1, 1, 1] } });
    const scene = await readModelImport(archive, undefined, { unit: 'cm', up: 'y' });
    expect(scene.format?.kind).toBe('obj');
    expect(scene.root.instances.map(i => i.name)).toEqual(['Box', 'Line']);
    const box = [...scene.definitions.values()].find(d => d.name === 'Box')!;
    expect(box.solids).toHaveLength(1);
    // Y up becomes Z up, centimeters become meters: the cube's top is at z = 1 cm.
    const points = box.solids[0]!.faces.flatMap(f => f.loops[0]!);
    expect(Math.max(...points.map(p => p[2]))).toBeCloseTo(0.01, 12);
    expect(Math.min(...points.map(p => p[1]))).toBeCloseTo(-0.01, 12);
    const wood = [...scene.materials.values()].find(m => m.name === 'Wood')!;
    expect(wood).toMatchObject({ color: [0.5, 0.25, 0], alpha: 0.75, texture: { image: 0 } });
    expect(scene.images[0]).toMatchObject({ name: 'wood grain.png', mime: 'image/png' });
    // Two tiles across each 1 cm face.
    expect(wood.texture!.widthM).toBeCloseTo(0.005, 12);
    expect(box.solids[0]!.faces.every(f => f.frontUv)).toBe(true);
    const line = [...scene.definitions.values()].find(d => d.name === 'Line')!;
    expect(line.edges).toHaveLength(1);
    const report = createDocument().transact('Open', d => applySketchUpImport(d, scene)).value;
    expect(report).toMatchObject({ format: 'OBJ', bodies: 1, looseEdges: 1, materials: 1 });
    expect(m4transformPoint(scene.root.instances[0]!.transform, [0, 0, 0])).toEqual([0, 0, 0]);
  });

  it('reads relative indices, normals and smoothing groups, and notes materials it cannot find', async () => {
    // Two triangles folded along x = 0 that share smoothing group 1, then a flat-shaded square (smoothing off).
    const obj = `usemtl Missing\nv 0 0 0\nv 0 1 0\nv -1 0 1\nv 1 0 1\ns 1\nf -4 -3 -2\nf -3 -4 -1
v 5 0 0\nv 6 0 0\nv 6 1 0\nv 5 1 0\nvn 0 0 1\ns off\nf 5//1 6//1 7//1 8//1\nf 1 2 99\n`;
    const scene = await readObj(strToU8(obj), { unit: 'm', up: 'z' });
    const crease = scene.root.sheets.flatMap(f => f.edgeFlags.flat()).filter(f => f.soft && f.smooth);
    expect(new Set(crease.map(f => f.edge)).size).toBe(1);
    expect(scene.root.sheets).toHaveLength(3);
    expect(scene.warnings).toEqual(expect.arrayContaining([
      '1 face or line with invalid vertex indices or coordinates is skipped.',
      '1 material named in the file uses the default material: materials and textures are imported from a .zip archive that holds the model with its .mtl files and images.',
      '2 connected parts do not form a closed solid; their 3 faces are imported as editable sheet faces.',
    ]));
  });
});
