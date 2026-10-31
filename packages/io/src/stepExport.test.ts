// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { m4mul, m4scaling, m4translation, meshBox, type DefId, type Id, type Mat4, type MaterialId, type MMat4 } from '@pushform/core';
import { bodyFromMesh, createDocument, createEntityContainer, SketchGraph, type ComponentInstance, type Document, type DocumentDraft } from '@pushform/model';
import { collectStepScene, exportStep } from './stepExport';
import { isStepBytes, readStep } from './step';
import { applySketchUpImport } from './sketchupDocument';

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

/** A 1 m cube component placed at x = 2 m and, mirrored, at x = -2 m (one face red), a 1 × 2 × 3 m box and a sheet triangle in the model. */
function fixture(): Document {
  const doc = createDocument();
  doc.transact('fixture', d => {
    const red = d.meta.nextId++ as MaterialId;
    d.materials.set(red, { id: red, name: 'Red', color: [1, 0, 0], alpha: 1, texture: null });
    const def = addDefinition(d, 'Cube');
    const cube = bodyFromMesh(d, meshBox([0, 0, 0], [1, 1, 1]), { container: d.definitions.get(def)!.entities });
    [...cube.faces.values()][0]!.frontMaterialId = red;
    addInstance(d, def, m4translation([2, 0, 0]), { name: 'Right' });
    addInstance(d, def, m4mul(m4translation([-2, 0, 0]), m4scaling([-1, 1, 1])), { name: 'Left' });
    bodyFromMesh(d, meshBox([0, 0, 5], [1, 2, 8]), { container: d.definitions.get(d.rootDefinitionId)!.entities });
    const g = SketchGraph.for(d);
    g.addEdge([0, 5, 0], [1, 5, 0]); g.addEdge([1, 5, 0], [0, 6, 0]); g.addEdge([0, 6, 0], [0, 5, 0]);
  });
  return doc;
}

describe('STEP export', () => {
  it('collects the model as products of polygon faces, writing a mirrored placement already moved', () => {
    const scene = collectStepScene(fixture().state, { name: 'Shelf.pf' });
    expect(scene.name).toBe('Shelf');
    const top = scene.products[scene.root]!;
    // The cube is one product placed once; the mirrored placement became a part of the top product.
    expect(scene.products.map(p => p.name).sort()).toEqual(['Cube', 'Shelf']);
    expect(top.children.map(c => c.name)).toEqual(['Right']);
    expect(top.parts.map(p => p.name)).toEqual(expect.arrayContaining(['Faces']));
    expect(top.parts.filter(p => p.name.startsWith('Body')).length).toBe(2);
    const cube = scene.products.find(p => p.name === 'Cube')!;
    expect(cube.parts[0]!.faces).toHaveLength(6);
    expect(cube.parts[0]!.faces.filter(f => f.color)).toHaveLength(1);
  });

  it('writes a STEP file that reads back with the same structure', async () => {
    const result = await exportStep(fixture().state, { name: 'Shelf.pf', now: new Date('2026-10-31T12:00:00Z') });
    expect(result.fileName).toBe('Shelf.step');
    expect(isStepBytes(result.bytes)).toBe(true);
    const text = new TextDecoder().decode(result.bytes);
    expect(text).toContain("FILE_NAME('Shelf.step','2026-10-31T12:00:00'");
    const back = await readStep(result.bytes);
    // Only the sheet triangle is open; the solids close.
    expect(back.warnings.filter(w => /open body/.test(w))).toEqual(["STEP: solid 'Faces': imported as an open body (the shell is not closed)"]);
    const parts = [back.root, ...back.definitions.values()].flatMap(d => d.meshParts ?? []);
    // The cube once, two bodies and the sheet in the model, and the mirrored cube.
    expect(parts.length).toBeGreaterThanOrEqual(4);
  });

  it('writes the mesh parts of an imported STEP file as faceted solids and says so', async () => {
    const first = await exportStep(fixture().state, { name: 'Shelf.pf' });
    const doc = createDocument();
    const scene = await readStep(first.bytes);
    doc.transact('Open', d => applySketchUpImport(d, scene));
    const again = await exportStep(doc.state, { name: 'Again.pf' });
    expect(again.notes.join(' ')).toMatch(/Mesh parts are exported as faceted solids: .*triangles\)/);
    const back = await readStep(again.bytes);
    expect([back.root, ...back.definitions.values()].flatMap(d => d.meshParts ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it('says what it left out or approximated', () => {
    expect(() => collectStepScene(createDocument().state)).toThrow('no visible faces');
  });
});
