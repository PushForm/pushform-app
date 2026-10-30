// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { m4transformPoint } from '@pushform/core';
import { createDocument } from '@pushform/model';
import { isGlbBytes, isGltfJson, readGltf } from './gltf';
import { modelImportFormat, probeMeshImport, readModelImport } from './modelImport';
import { applySketchUpImport } from './sketchupDocument';

const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));

/** Binary data for buffer views, each padded to four bytes, and the views that address it. */
function pack(parts: Uint8Array[]): { bin: Uint8Array; views: { buffer: number; byteOffset: number; byteLength: number }[] } {
  const views: { buffer: number; byteOffset: number; byteLength: number }[] = [];
  let length = 0;
  for (const part of parts) { views.push({ buffer: 0, byteOffset: length, byteLength: part.byteLength }); length += Math.ceil(part.byteLength / 4) * 4; }
  const bin = new Uint8Array(length);
  parts.forEach((part, i) => bin.set(part, views[i]!.byteOffset));
  return { bin, views };
}
const f32 = (values: number[]): Uint8Array => new Uint8Array(Float32Array.from(values).buffer);
const u16 = (values: number[]): Uint8Array => new Uint8Array(Uint16Array.from(values).buffer);

/** A binary glTF file of a JSON object and a binary chunk. */
function glb(json: object, bin: Uint8Array): Uint8Array {
  const text = strToU8(JSON.stringify(json)), jsonLength = Math.ceil(text.byteLength / 4) * 4, binLength = Math.ceil(bin.byteLength / 4) * 4;
  const out = new Uint8Array(12 + 8 + jsonLength + 8 + binLength), view = new DataView(out.buffer);
  out.set(strToU8('glTF'), 0); view.setUint32(4, 2, true); view.setUint32(8, out.byteLength, true);
  view.setUint32(12, jsonLength, true); view.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20); out.fill(0x20, 20 + text.byteLength, 20 + jsonLength);
  view.setUint32(20 + jsonLength, binLength, true); view.setUint32(24 + jsonLength, 0x004e4942, true);
  out.set(bin, 28 + jsonLength);
  return out;
}

// A unit cube from (0, 0, 0) to (1, 1, 1) in glTF's Y-up axes, wound counterclockwise seen from outside, with texture
// coordinates per face.
const CUBE_POSITIONS: number[] = [], CUBE_UVS: number[] = [], CUBE_INDICES: number[] = [];
for (const [axis, side] of [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0], [2, 1]] as const) {
  const u = (axis + 1) % 3, v = (axis + 2) % 3, base = CUBE_POSITIONS.length / 3;
  for (const [a, b] of [[0, 0], [1, 0], [1, 1], [0, 1]] as const) {
    const p = [0, 0, 0];
    p[axis] = side; p[u] = a; p[v] = b;
    CUBE_POSITIONS.push(...p); CUBE_UVS.push(a, b);
  }
  // Outward: counterclockwise about +axis on the far side, clockwise on the near side.
  CUBE_INDICES.push(...(side ? [base, base + 1, base + 2, base, base + 2, base + 3] : [base, base + 2, base + 1, base, base + 3, base + 2]));
}

function cubeFile(extra: Partial<Record<string, unknown>> = {}): Uint8Array {
  const { bin, views } = pack([f32(CUBE_POSITIONS), f32(CUBE_UVS), u16(CUBE_INDICES), PNG]);
  return glb({
    asset: { version: '2.0', generator: 'PushForm test' },
    scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Box', mesh: 0, translation: [0, 0, 2] }],
    meshes: [{ name: 'Cube', primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 24, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 24, type: 'VEC2' },
      { bufferView: 2, componentType: 5123, count: 36, type: 'SCALAR' },
    ],
    bufferViews: views, buffers: [{ byteLength: bin.byteLength }],
    // 0.2140 linear is 0.5 sRGB.
    materials: [{ name: 'Wood', alphaMode: 'BLEND', pbrMetallicRoughness: { baseColorFactor: [0.214, 0.214, 1, 0.5], baseColorTexture: { index: 0 } } }],
    textures: [{ source: 0 }], images: [{ name: 'grain', bufferView: 3, mimeType: 'image/png' }],
    ...extra,
  }, bin);
}

describe('glTF import', () => {
  it('reads a binary glTF: nodes as groups in Z-up meters, materials with their texture', async () => {
    const bytes = cubeFile();
    expect(isGlbBytes(bytes)).toBe(true);
    expect(probeMeshImport(bytes)).toBeNull();
    const scene = await readModelImport(bytes);
    expect(scene.format?.kind).toBe('gltf');
    expect(scene.version).toBe('2.0, PushForm test');
    expect(scene.root.instances.map(i => i.name)).toEqual(['Box']);
    // glTF +Z (toward the viewer) becomes -Y.
    expect(m4transformPoint(scene.root.instances[0]!.transform, [0, 0, 0]).map(v => v + 0)).toEqual([0, -2, 0]);
    const box = scene.definitions.get(scene.root.instances[0]!.definition)!;
    expect(box.solids).toHaveLength(1);
    expect(box.solids[0]!.faces).toHaveLength(6);
    // glTF +Y (up) becomes +Z, -Z becomes +Y: the cube spans z 0..1 and y -1..0.
    const points = box.solids[0]!.faces.flatMap(f => f.loops[0]!);
    expect(Math.max(...points.map(p => p[2]))).toBeCloseTo(1, 9);
    expect(Math.min(...points.map(p => p[1]))).toBeCloseTo(-1, 9);
    const wood = [...scene.materials.values()].find(m => m.name === 'Wood')!;
    expect(wood.color[0]).toBeCloseTo(0.5, 2);
    expect(wood.color[2]).toBeCloseTo(1, 9);
    expect(wood).toMatchObject({ alpha: 0.5, texture: { image: 0 } });
    expect(scene.images[0]).toMatchObject({ name: 'grain.png', mime: 'image/png' });
    // One tile per 1 m face.
    expect(wood.texture!.widthM).toBeCloseTo(1, 9);
    expect(box.solids[0]!.faces.every(f => f.frontUv)).toBe(true);
    const report = createDocument().transact('Open', d => applySketchUpImport(d, scene)).value;
    expect(report).toMatchObject({ format: 'glTF', bodies: 1, materials: 1 });
  });

  it('makes a mesh several nodes place one shared component, placed by each node\'s rotation and scale', async () => {
    const { bin, views } = pack([f32(CUBE_POSITIONS), u16(CUBE_INDICES)]);
    const half = Math.SQRT1_2;
    const json = {
      asset: { version: '2.0' },
      nodes: [
        { name: 'Shelf', children: [1, 2] },
        { name: 'Left', mesh: 0 },
        // A quarter turn about glTF's up axis, doubled in size.
        { name: 'Right', mesh: 0, translation: [3, 0, 0], rotation: [0, half, 0, half], scale: [2, 2, 2] },
      ],
      scenes: [{ nodes: [0] }],
      meshes: [{ name: 'Block', primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 24, type: 'VEC3' }, { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' }],
      bufferViews: views,
      buffers: [{ byteLength: bin.byteLength, uri: `data:application/octet-stream;base64,${btoa(String.fromCharCode(...bin))}` }],
    };
    const bytes = strToU8(`  ${JSON.stringify(json)}`);
    expect(isGltfJson(bytes)).toBe(true);
    const scene = await readGltf(bytes);
    // The scene's one node at the origin is the model itself.
    expect(scene.root.instances.map(i => i.name)).toEqual(['Left', 'Right']);
    const [left, right] = scene.root.instances;
    expect(left!.definition).toBe(right!.definition);
    const block = scene.definitions.get(left!.definition)!;
    expect(block).toMatchObject({ name: 'Block', group: false });
    expect(block.solids).toHaveLength(1);
    // glTF's (1, 0, 0) turned a quarter about +Y goes to -Z, i.e. +Y in Z-up, doubled, then moved 3 along +X.
    const p = m4transformPoint(right!.transform, [1, 0, 0]);
    [3, 2, 0].forEach((v, i) => expect(p[i]).toBeCloseTo(v, 9));
    // Shared geometry is counted once.
    expect(createDocument().transact('Open', d => applySketchUpImport(d, scene)).value).toMatchObject({ bodies: 1, definitions: 1, instances: 2 });
  });

  it('reads strips, fans and lines, and notes what it does not import', async () => {
    // A strip and a fan that each make a unit square in glTF's XZ plane (the ground), and a line above them.
    const square = [0, 0, 0, 1, 0, 0, 0, 0, -1, 1, 0, -1];
    const fan = [5, 0, 0, 6, 0, 0, 6, 0, -1, 5, 0, -1];
    const line = [0, 2, 0, 1, 2, 0];
    const { bin, views } = pack([f32(square), f32(fan), f32(line), f32([0, 0, 0])]);
    const scene = await readGltf(glb({
      asset: { version: '2.0' }, scenes: [{ nodes: [0, 1] }], animations: [{}], extensionsUsed: ['KHR_materials_clearcoat'],
      nodes: [{ mesh: 0 }, { camera: 0 }], cameras: [{ type: 'perspective' }],
      meshes: [{ primitives: [
        { attributes: { POSITION: 0 }, mode: 5 }, { attributes: { POSITION: 1 }, mode: 6 }, { attributes: { POSITION: 2 }, mode: 1 },
        { attributes: { POSITION: 3 }, mode: 0 },
      ] }],
      accessors: [0, 1, 2, 3].map(i => ({ bufferView: i, componentType: 5126, count: i === 2 ? 2 : i === 3 ? 1 : 4, type: 'VEC3' })),
      bufferViews: views, buffers: [{ byteLength: bin.byteLength }],
    }, bin));
    expect(scene.root.sheets).toHaveLength(2);
    expect(scene.root.sheets.every(f => Math.abs(Math.abs(f.normal[2]) - 1) < 1e-9)).toBe(true);
    expect(scene.root.edges.length).toBeGreaterThanOrEqual(1);
    expect(scene.warnings).toEqual(expect.arrayContaining([
      '1 point primitive is not imported.',
      'Cameras and lights are not imported.',
      'Animations are not imported; the model is imported in its rest position.',
      'Extensions not imported: KHR_materials_clearcoat.',
    ]));
  });

  it('reads a .gltf with its .bin and images from a .zip, and rejects compressed and older files', async () => {
    const { bin, views } = pack([f32(CUBE_POSITIONS), u16(CUBE_INDICES)]);
    const json = {
      asset: { version: '2.0' }, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 24, type: 'VEC3' }, { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' }],
      bufferViews: views, buffers: [{ byteLength: bin.byteLength, uri: 'data/box%20parts.bin' }],
    };
    const archive = zipSync({ 'model/Box.gltf': strToU8(JSON.stringify(json)), 'model/data/box parts.bin': bin });
    expect(probeMeshImport(archive)).toBeNull();
    const scene = await readModelImport(archive);
    expect(scene.format?.kind).toBe('gltf');
    expect(scene.root.solids).toHaveLength(1);
    // Alone, the .gltf cannot reach its buffer.
    await expect(readModelImport(strToU8(JSON.stringify(json)))).rejects.toThrow('This glTF file keeps its geometry in separate files (data/box parts.bin) that were not imported with it: import a .zip archive that holds the .gltf file with its .bin and image files.');
    await expect(readGltf(strToU8(JSON.stringify({ ...json, extensionsRequired: ['KHR_draco_mesh_compression'] })))).rejects.toThrow(/compressed \(KHR_draco_mesh_compression\)/);
    await expect(readGltf(strToU8(JSON.stringify({ asset: { version: '1.0' } })))).rejects.toThrow(/Only glTF 2\.0/);
    expect(modelImportFormat('Duck.glb').kind).toBe('gltf');
    expect(modelImportFormat('Duck.gltf').name).toBe('glTF');
  });
});
