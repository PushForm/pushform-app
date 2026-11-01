// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createDocument, bodyFromMesh, SketchGraph } from '@pushform/model';
import { meshBox } from '@pushform/core';
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
