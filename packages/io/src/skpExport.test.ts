// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createDocument, bodyFromMesh, SketchGraph } from '@pushform/model';
import { meshBox } from '@pushform/core';
import type { SkpBuilder } from 'openskp';
import { exportSkp } from './skpExport';
import { readSketchUp } from './sketchup';
import { applySketchUpImport } from './sketchupDocument';

it('writes a meter cube and loose edge as a readable SKP without changing the source', async () => {
  const doc = createDocument();
  doc.transact('fixture', draft => {
    bodyFromMesh(draft, meshBox([0, 0, 0], [1, 1, 1]), { container: draft.definitions.get(draft.rootDefinitionId)!.entities });
    SketchGraph.for(draft).addEdge([2, 0, 0], [3, 0, 0]);
  });
  const before = doc.state;
  const file = exportSkp(doc.state, { name: 'Cube.pf' });
  expect(file.fileName).toBe('Cube.skp');
  expect(file.triangles).toBe(12);
  expect(doc.state).toBe(before);
  const scene = await readSketchUp(file.bytes);
  const restored = createDocument();
  const result = restored.transact('import', draft => applySketchUpImport(draft, scene)).value;
  expect(result.bodies).toBe(1);
  expect(result.looseEdges).toBe(1);
  expect([...restored.rootDefinition.entities.bodies.values()][0]!.props.volume).toBeCloseTo(1, 8);
});

it('rejects empty models and empty selections', () => {
  const doc = createDocument();
  expect(() => exportSkp(doc.state)).toThrow('no visible faces or edges');
  doc.transact('cube', draft => { bodyFromMesh(draft, meshBox([0, 0, 0], [1, 1, 1]), { container: draft.definitions.get(draft.rootDefinitionId)!.entities }); });
  expect(() => exportSkp(doc.state, { selection: [] })).toThrow('selection has no visible');
});

it('preserves shared component placements, rotation, scale and color', async () => {
  const { create } = await import('openskp');
  const builder = create(), red = builder.addMaterial('Red', [255, 0, 0], 0.5);
  const part = builder.addComponentDefinition('Panel', d => {
    d.addFace([[0, 0, 0], [10, 0, 0], [0, 20, 0]], { material: red });
  });
  builder.addInstance(part, { name: 'Turned', translation: [100, 20, 30], matrix3x3: [0, -2, 0, 3, 0, 0, 0, 0, 1] });
  builder.addInstance(part, { name: 'Mirror', matrix3x3: [-1, 0, 0, 0, 1, 0, 0, 0, 1] });
  const source = await readSketchUp(builder.toBytes()), doc = createDocument();
  doc.transact('import', draft => applySketchUpImport(draft, source));
  const scene = await readSketchUp(exportSkp(doc.state).bytes);
  expect(scene.root.instances.map(i => i.name)).toEqual(['Turned', 'Mirror']);
  expect(scene.root.instances[0]!.definition).toBe(scene.root.instances[1]!.definition);
  scene.root.instances.forEach((instance, index) => {
    instance.transform.forEach((value, k) => expect(value).toBeCloseTo(source.root.instances[index]!.transform[k]!, 8));
  });
  expect([...scene.materials.values()][0]).toMatchObject({ name: 'Red', alpha: 0.5 });
});

it('embeds a PNG and keeps explicit UV pins through a round trip', async () => {
  const { create, parseSkp } = await import('openskp');
  const { encodePng } = await import('./png');
  const image = encodePng(2, 2, new Uint8Array(12).fill(160), 3);
  const builder = create();
  const material = builder.addTextureMaterial('Wood', image, 'wood.png');
  const points: [number, number, number][] = [[0, 0, 0], [10, 0, 0], [0, 20, 0]];
  builder.addFace(points, { material, frontUv: points.map((p, i) => [p, [[0, 0], [2, 0], [0, 3]][i]! as [number, number]]) });
  const source = await readSketchUp(builder.toBytes()), doc = createDocument();
  const { ImageStore } = await import('@pushform/model');
  const images = new ImageStore();
  doc.transact('import', draft => applySketchUpImport(draft, source, { images }));
  const output = exportSkp(doc.state, { image: id => {
    const blob = images.get(id);
    return blob ? { bytes: blob.bytes, mime: blob.mime, name: 'wood.png' } : undefined;
  } });
  const parsed = parseSkp(output.bytes.buffer.slice(output.bytes.byteOffset, output.bytes.byteOffset + output.bytes.byteLength) as ArrayBuffer);
  expect(parsed.materials[0]!.texture?.data).toEqual(image);
  const scene = await readSketchUp(output.bytes);
  expect(scene.root.sheets).toHaveLength(1);
  expect([...scene.materials.values()][0]!.name).toBe('Wood');
});

/** A SketchUp file built with openskp, opened as Open does. */
async function openBuilt(build: (builder: SkpBuilder) => void) {
  const { create } = await import('openskp');
  const builder = create();
  build(builder);
  return openBytes(builder.toBytes());
}
async function openBytes(bytes: Uint8Array) {
  const { ImageStore } = await import('@pushform/model');
  const scene = await readSketchUp(bytes), doc = createDocument(), images = new ImageStore();
  doc.transact('import', draft => applySketchUpImport(draft, scene, { images }));
  const image = (id: number) => { const blob = images.get(id as never); return blob ? { bytes: blob.bytes, mime: blob.mime, name: `image${id}.png` } : undefined; };
  return { doc, images, image };
}

it('writes a face with a hole as one face, not triangles', async () => {
  const source = await openBuilt(builder => {
    builder.addFace([[0, 0, 0], [40, 0, 0], [40, 40, 0], [0, 40, 0]], { holes: [[[10, 10, 0], [10, 30, 0], [30, 30, 0], [30, 10, 0]]] });
  });
  const written = exportSkp(source.doc.state);
  const reopened = await openBytes(written.bytes);
  const faces = [...reopened.doc.rootDefinition.entities.sketch.faces.values()];
  expect(faces).toHaveLength(1);
  expect(faces[0]!.loops).toHaveLength(2);
  expect(written.notes.join(' ')).not.toMatch(/triangles/);
});

it('keeps soft and smooth edges and paint on placements, with one definition for both placements', async () => {
  const source = await openBuilt(builder => {
    const red = builder.addMaterial('Red', [255, 0, 0]), blue = builder.addMaterial('Blue', [0, 0, 255]);
    const panel = builder.addComponentDefinition('Panel', d => {
      // Two faces meeting along a soft, smooth edge, written first so the faces use it.
      d.addEdges([[10, 0, 0], [10, 10, 0]], { softEdges: true, smoothEdges: true });
      d.addFace([[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]]);
      d.addFace([[10, 0, 0], [20, 0, 5], [20, 10, 5], [10, 10, 0]]);
    });
    builder.addInstance(panel, { name: 'Left', material: red });
    builder.addInstance(panel, { name: 'Right', translation: [50, 0, 0], material: blue });
  });
  const written = await openBytes(exportSkp(source.doc.state).bytes);
  const state = written.doc.state, root = written.doc.rootDefinition.entities;
  const placements = [...root.instances.values()];
  expect(placements.map(p => p.name)).toEqual(['Left', 'Right']);
  expect(placements[0]!.definitionId).toBe(placements[1]!.definitionId);
  expect(placements.map(p => state.materials.get(p.materialId!)?.name)).toEqual(['Red', 'Blue']);
  const panel = state.definitions.get(placements[0]!.definitionId)!.entities;
  const edges = [...panel.sketch.edges.values(), ...[...panel.bodies.values()].flatMap(body => [...body.edges.values()])];
  expect(edges.filter(edge => edge.soft && edge.smooth)).toHaveLength(1);
});

it('writes a face slightly off its plane as triangles with a hidden edge between them, and says so', async () => {
  const doc = createDocument();
  doc.transact('fixture', draft => { bodyFromMesh(draft, meshBox([0, 0, 0], [1, 1, 1]), { container: draft.definitions.get(draft.rootDefinitionId)!.entities }); });
  doc.transact('bend', draft => {
    // The corner at the origin a millimetre out along the diagonal: the three faces meeting there are no longer flat.
    const body = [...draft.definitions.get(draft.rootDefinitionId)!.entities.bodies.values()][0]!;
    const moved = (p: readonly number[]): [number, number, number] => (p[0] === 0 && p[1] === 0 && p[2] === 0 ? [-1e-3, -1e-3, -1e-3] : [p[0]!, p[1]!, p[2]!]);
    const verts = Float64Array.from(body.mesh.verts);
    for (let i = 0; i < verts.length; i += 3) [verts[i], verts[i + 1], verts[i + 2]] = moved([verts[i]!, verts[i + 1]!, verts[i + 2]!]);
    body.mesh = { ...body.mesh, verts };
    for (const face of body.faces.values()) face.loops = face.loops.map(loop => loop.map(moved));
  });
  const file = exportSkp(doc.state);
  expect(file.notes).toContain('3 faces are not quite flat and were written as triangles with hidden edges between them.');
  const reopened = await openBytes(file.bytes);
  const edges = [...reopened.doc.rootDefinition.entities.bodies.values()].flatMap(body => [...body.edges.values()]);
  const sketchEdges = [...reopened.doc.rootDefinition.entities.sketch.edges.values()];
  expect([...edges, ...sketchEdges].filter(edge => edge.hidden)).toHaveLength(3);
});

it('keeps a texture whose placement maps to a line, without the placement, and says so', async () => {
  const { encodePng } = await import('./png');
  const image = encodePng(2, 2, new Uint8Array(12).fill(160), 3);
  const source = await openBuilt(builder => {
    const wood = builder.addTextureMaterial('Wood', image, 'wood.png');
    builder.addFace([[0, 0, 0], [10, 0, 0], [0, 20, 0]], { material: wood });
  });
  source.doc.transact('flatten', draft => {
    const face = [...draft.definitions.get(draft.rootDefinitionId)!.entities.sketch.faces.values()][0]!;
    face.uv = { kind: 'affine', matrix: [1, 0, 0, 1, 0, 0] };
  });
  const file = exportSkp(source.doc.state, { image: source.image });
  expect(file.notes).toContain("1 textured face could not keep its texture placement and use the texture's default placement.");
  const reopened = await openBytes(file.bytes);
  const face = [...reopened.doc.rootDefinition.entities.sketch.faces.values()][0]!;
  expect(reopened.doc.state.materials.get(face.frontMaterialId!)?.name).toBe('Wood');
});
