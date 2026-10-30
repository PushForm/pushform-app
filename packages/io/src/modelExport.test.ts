// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { m4determinant, m4mul, m4scaling, m4translation, meshBox, type DefId, type Id, type ImageId, type Mat4, type MaterialId, type MMat4 } from '@pushform/core';
import {
  bodyFromMesh, createDocument, createEntityContainer, ImageStore, SketchGraph, walkInstances,
  type ComponentInstance, type Document, type DocumentDraft, type DocumentState,
} from '@pushform/model';
import { exportCollada } from './colladaExport';
import { exportGlb } from './gltfExport';
import { readModelImport } from './modelImport';
import { exportObj } from './objExport';
import { applySketchUpImport } from './sketchupDocument';

const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));

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
function addMaterial(d: DocumentDraft, name: string, color: [number, number, number], textured = false): MaterialId {
  const id = d.meta.nextId++ as MaterialId;
  d.materials.set(id, { id, name, color, alpha: 1, texture: textured ? { imageId: 7 as ImageId, widthM: 0.5, heightM: 0.5, colorize: false } : null });
  return id;
}

/**
 * A 1 m cube component placed at x = 2 m and, mirrored, at x = -2 m, one of its faces red; a 1 × 2 × 3 m box in the
 * model with a textured face; a sheet triangle green in front and blue behind; and a loose line.
 */
function fixture(): Document {
  const doc = createDocument();
  doc.transact('fixture', d => {
    const red = addMaterial(d, 'Red', [1, 0, 0]), wood = addMaterial(d, 'Wood grain', [0.6, 0.4, 0.2], true);
    const green = addMaterial(d, 'Green', [0, 1, 0]), blue = addMaterial(d, 'Blue', [0, 0, 1]);
    const def = addDefinition(d, 'Cube');
    const cube = bodyFromMesh(d, meshBox([0, 0, 0], [1, 1, 1]), { container: d.definitions.get(def)!.entities });
    [...cube.faces.values()][0]!.frontMaterialId = red;
    addInstance(d, def, m4translation([2, 0, 0]), { name: 'Right' });
    addInstance(d, def, m4mul(m4translation([-2, 0, 0]), m4scaling([-1, 1, 1])), { name: 'Left' });
    const box = bodyFromMesh(d, meshBox([0, 0, 5], [1, 2, 8]), { container: d.definitions.get(d.rootDefinitionId)!.entities });
    [...box.faces.values()][1]!.frontMaterialId = wood;
    const g = SketchGraph.for(d);
    g.addEdge([0, 5, 0], [1, 5, 0]); g.addEdge([1, 5, 0], [0, 6, 0]); g.addEdge([0, 6, 0], [0, 5, 0]);
    const sheet = [...d.definitions.get(d.rootDefinitionId)!.entities.sketch.faces.values()][0]!;
    sheet.frontMaterialId = green; sheet.backMaterialId = blue;
    g.addEdge([5, 5, 0], [6, 5, 1]);
  });
  return doc;
}
const image = (id: ImageId) => (id === 7 ? { bytes: PNG, mime: 'image/png', name: 'grain.png' } : undefined);

/** The volume of every solid at every placement, sorted. */
function placedVolumes(state: DocumentState): number[] {
  const out: number[] = [];
  const add = (definitionId: DefId, matrix: MMat4): void => {
    for (const body of state.definitions.get(definitionId)!.entities.bodies.values()) out.push(Math.round(body.props.volume * Math.abs(m4determinant(matrix)) * 1e6) / 1e6);
  };
  add(state.rootDefinitionId, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  for (const visit of walkInstances(state)) add(visit.definition.id, visit.matrix);
  return out.sort((a, b) => a - b);
}
/** The colors (two decimals) that faces show on their front and, for sheets, back sides. */
function faceColors(state: DocumentState): string[] {
  const colors = new Set<string>();
  const color = (id: MaterialId | null): void => {
    const material = id === null ? undefined : state.materials.get(id);
    if (material) colors.add(material.color.map(c => c.toFixed(2)).join(','));
  };
  for (const definition of state.definitions.values()) {
    for (const body of definition.entities.bodies.values()) for (const face of body.faces.values()) color(face.frontMaterialId ?? body.materialId);
    for (const face of definition.entities.sketch.faces.values()) { color(face.frontMaterialId); color(face.backMaterialId); }
  }
  return [...colors].sort();
}
async function reimport(bytes: Uint8Array, options?: { unit: 'm' | 'mm'; up: 'z' | 'y' }): Promise<{ state: DocumentState; images: ImageStore; edges: number; warnings: string[] }> {
  const scene = await readModelImport(bytes, undefined, options);
  const doc = createDocument(), images = new ImageStore();
  const report = doc.transact('Import', d => applySketchUpImport(d, scene, { images })).value;
  return { state: doc.state, images, edges: report.looseEdges, warnings: report.warnings };
}

describe('model export round trips', () => {
  const original = fixture();
  const volumes = placedVolumes(original.state), colors = faceColors(original.state);

  it('keeps the solids, their volumes and face materials through glTF, with the component shared', async () => {
    const { bytes, fileName, triangles, notes } = exportGlb(original.state, { name: 'Shelf.pf', image });
    expect(fileName).toBe('Shelf.glb');
    // The sheet triangle twice: its back is painted differently.
    expect(triangles).toBe(12 + 12 + 12 + 2);
    expect(notes).toEqual([]);
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + new DataView(bytes.buffer).getUint32(12, true)))) as {
      meshes: unknown[]; nodes: { mesh?: number }[]; images: { mimeType: string }[]; materials: { name: string; alphaMode?: string }[];
    };
    // Both cube placements show one mesh.
    expect(json.nodes.filter(n => n.mesh !== undefined).length).toBe(3);
    expect(json.meshes).toHaveLength(2);
    expect(json.images).toEqual([expect.objectContaining({ mimeType: 'image/png' })]);
    const back = await reimport(bytes);
    expect(placedVolumes(back.state)).toEqual(volumes);
    expect(faceColors(back.state)).toEqual(colors);
    expect(back.edges).toBe(1);
    expect([...back.images.entries()]).toHaveLength(1);
    // The shared cube comes back as one component placed twice.
    const cubes = [...walkInstances(back.state)].filter(v => v.definition.name === 'Cube');
    expect(cubes).toHaveLength(2);
    expect(new Set(cubes.map(v => v.definition.id)).size).toBe(1);
  });

  it('keeps them through COLLADA, zipped with its texture image', async () => {
    const { bytes, fileName } = exportCollada(original.state, { name: 'Shelf.pf', image });
    expect(fileName).toBe('Shelf.zip');
    const files = unzipSync(bytes);
    expect(Object.keys(files).sort()).toEqual(['Shelf.dae', 'images/grain.png']);
    expect(strFromU8(files['Shelf.dae']!)).toContain('<instance_node url="#shared0"/>');
    const back = await reimport(bytes);
    expect(placedVolumes(back.state)).toEqual(volumes);
    // A COLLADA diffuse is a color or a texture: the textured material keeps its texture, on white.
    expect(faceColors(back.state)).toEqual(colors.map(c => (c === '0.60,0.40,0.20' ? '1.00,1.00,1.00' : c)).sort());
    expect([...back.state.materials.values()].find(m => m.name === 'Wood grain')?.texture).not.toBeNull();
    expect(back.edges).toBe(1);
    const cubes = [...walkInstances(back.state)].filter(v => v.definition.name === 'Cube');
    expect(new Set(cubes.map(v => v.definition.id)).size).toBe(1);
    // Without textures the file is a plain .dae.
    const plain = exportCollada(original.state, { name: 'Shelf.pf' });
    expect(plain.fileName).toBe('Shelf.dae');
    expect(plain.notes).toEqual(['1 texture image is not available; its material exports its color.']);
  });

  it('keeps them through OBJ in the chosen unit and up axis, flattening placements into objects', async () => {
    const { bytes, fileName } = exportObj(original.state, { name: 'Shelf.pf', image, unit: 'mm', up: 'y' });
    expect(fileName).toBe('Shelf.zip');
    const files = unzipSync(bytes);
    expect(Object.keys(files).sort()).toEqual(['Shelf.mtl', 'Shelf.obj', 'textures/grain.png']);
    const obj = strFromU8(files['Shelf.obj']!);
    expect(obj).toContain('o Right\n');
    expect(obj).toContain('o Left\n');
    expect(strFromU8(files['Shelf.mtl']!)).toContain('newmtl Wood_grain\nKd 0.6 0.4 0.2\nd 1\nmap_Kd textures/grain.png');
    // Millimeters with Y up: the box's top (z = 8 m) is at y = 8000.
    expect(obj).toMatch(/\nv [-\d.]+ 8000 /);
    const back = await reimport(bytes, { unit: 'mm', up: 'y' });
    // Default-material faces are `usemtl (null)`, which the reader takes without a note.
    expect(back.warnings.join(' ')).not.toMatch(/default material/);
    expect(placedVolumes(back.state)).toEqual(volumes);
    expect(faceColors(back.state)).toEqual(colors);
    expect(back.edges).toBe(1);
  });

  it('exports only the selection, and says when there is nothing to export', () => {
    const state = original.state, root = state.definitions.get(state.rootDefinitionId)!;
    const right = [...root.entities.instances.values()].find(i => i.name === 'Right')!;
    expect(exportGlb(state, { selection: [{ kind: 'instance', path: [], id: right.id }] }).triangles).toBe(12);
    const empty = createDocument();
    expect(() => exportObj(empty.state, { unit: 'm', up: 'z' })).toThrow('The model has no visible faces or edges to export.');
  });
});
