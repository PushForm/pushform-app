// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { basisToLocal } from '@pushform/core';
import type { Id, MaterialId, PlaneBasis, Vec3 } from '@pushform/core';
import { reverseLoop, uvAt, uvToAffine } from '@pushform/model';
import type { EntityRef, UvMapping } from '@pushform/model';
import { CommandRegistry } from '../registry/CommandRegistry';
import { editCommands } from '../registry/editCommands';
import { DocumentHost } from '../host/DocumentHost';
import { SERVICE_DOCUMENT, activeMaterialOf } from '../host/services';
import { contextCommands } from './context';
import { contextMenu } from './contextMenu';
import { placeholderTool } from '../tools/impl/Placeholder';
import { groupCommands } from './groups';
import { materialCommands } from './materials';
import type { PaintResult } from './materials';
import { modelCommands } from './model';
import { sketchCommands } from './sketch';
import { PaintTool, paintModeOf, hitSide } from '../tools/impl/Paint';
import { PositionTextureTool, reflectionAcross, rotationAbout, similarityAbout } from '../tools/impl/PositionTexture';
import { ToolManager } from '../tools/ToolManager';
import type { CameraHost } from '../camera/CameraHost';
import { uvApply } from '@pushform/model';
import { entityOverlay } from '../tools/toolUtil';
import { worldToScreen } from '../tools/impl/transformShared';

function setup() {
  const host = new DocumentHost();
  const registry = new CommandRegistry({ tx: host, services: new Map([[SERVICE_DOCUMENT, host]]) });
  registry.registerAll(editCommands);
  registry.registerAll(sketchCommands);
  registry.registerAll(modelCommands);
  registry.registerAll(groupCommands);
  registry.registerAll(contextCommands);
  registry.registerAll(materialCommands);
  const bodyId = registry.execute('model.addBox', { min: [0, 0, 0], max: [1, 1, 1] }) as Id;
  const body = () => host.doc.rootDefinition.entities.bodies.get(bodyId)!;
  const faceIds = () => [...body().faces.keys()];
  const faceRef = (faceId: number): EntityRef => ({ kind: 'face', path: [], id: bodyId, faceId: faceId as never, region: null });
  const red = registry.execute('material.create', { name: 'Red', color: [1, 0, 0] }) as number;
  const blue = registry.execute('material.create', { name: 'Blue', color: [0, 0, 1], activate: false }) as number;
  const paint = (p: Record<string, unknown>) => registry.execute('paint.apply', p) as PaintResult;
  return { host, registry, bodyId, body, faceIds, faceRef, red, blue, paint };
}

describe('material.* commands', () => {
  it('creates materials with unique names, updates, duplicates and deletes them (faces fall back to default)', () => {
    const { host, registry, red, faceRef, faceIds, body } = setup();
    const state = () => host.doc.state;
    expect(state().materials.get(red as MaterialId)).toMatchObject({ name: 'Red', color: [1, 0, 0], alpha: 1, texture: null });
    expect(registry.execute('material.getActive')).toBe(red);
    const red2 = registry.execute('material.create', { name: 'Red', color: [0.5, 0, 0] }) as number;
    expect(state().materials.get(red2 as MaterialId)?.name).toBe('Red#1');
    registry.execute('material.update', { id: red, name: 'Crimson', alpha: 0.5, color: [0.9, 0.1, 0.1] });
    expect(state().materials.get(red as MaterialId)).toMatchObject({ name: 'Crimson', alpha: 0.5 });
    const dup = registry.execute('material.duplicate', { id: red }) as number;
    expect(state().materials.get(dup as MaterialId)?.name).toBe('Crimson#1');
    registry.execute('paint.apply', { refs: [faceRef(faceIds()[0]!)], materialId: red, side: 'both' });
    expect(body().faces.get(faceIds()[0]!)?.frontMaterialId).toBe(red);
    expect(registry.execute('material.delete', { id: red })).toBe(2);
    expect(state().materials.has(red as MaterialId)).toBe(false);
    expect(body().faces.get(faceIds()[0]!)?.frontMaterialId).toBeNull();
    expect(registry.execute('material.getActive')).toBe(dup); // duplicate became active; deleting red keeps it
    registry.execute('material.setActive', { id: dup });
    registry.execute('material.delete', { id: dup });
    expect(registry.execute('material.getActive')).toBeNull();
    expect(() => registry.execute('material.delete', { id: state().defaultMaterialId })).toThrow(/default/);
    host.undo(); // delete dup
    host.undo(); // delete red
    expect(state().materials.has(red as MaterialId)).toBe(true);
    expect(body().faces.get(faceIds()[0]!)?.frontMaterialId).toBe(red);
  });

  it('purgeUnused removes materials no face/body/instance references', () => {
    const { registry, host, red, blue, faceRef, faceIds } = setup();
    registry.execute('paint.apply', { refs: [faceRef(faceIds()[1]!)], materialId: blue });
    expect(registry.execute('material.purgeUnused')).toBe(1);
    expect(host.doc.state.materials.has(red as MaterialId)).toBe(false);
    expect(host.doc.state.materials.has(blue as MaterialId)).toBe(true);
  });

  it('importImage stores bytes in host.images, dedupes by hash and creates a textured material', async () => {
    const { registry, host } = setup();
    const png = new Uint8Array(40);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 200, 0, 0, 0, 100]);
    const r1 = (await registry.execute('material.importImage', { bytes: png, name: 'brick.png', mime: 'image/png' })) as { imageId: number; materialId: number; width: number; height: number };
    expect(r1.width).toBe(200);
    expect(r1.height).toBe(100);
    const asset = host.doc.state.images.get(r1.imageId as never)!;
    expect(asset.sha256).toMatch(/^[0-9a-f]+$/);
    expect(host.images.has(r1.imageId as never)).toBe(true);
    const mat = host.doc.state.materials.get(r1.materialId as MaterialId)!;
    expect(mat.name).toBe('brick');
    expect(mat.texture).toMatchObject({ imageId: r1.imageId, widthM: 1, heightM: 0.5, colorize: false });
    expect(registry.execute('material.getActive')).toBe(r1.materialId);
    const r2 = (await registry.execute('material.importImage', { bytes: png, name: 'again.png', mime: 'image/png' })) as { imageId: number };
    expect(r2.imageId).toBe(r1.imageId);
    expect(host.doc.state.images.size).toBe(1);
    // runtime-only image → copied into the document by material.create
    const rt = await host.images.put(new Uint8Array([1, 2, 3, 4, 5]), 'image/png', 'rt.png', { width: 4, height: 4 });
    const m2 = registry.execute('material.create', { name: 'Rt', color: [1, 1, 1], texture: { imageId: rt.id, widthM: 2, heightM: 2 } }) as number;
    const t = host.doc.state.materials.get(m2 as MaterialId)!.texture!;
    expect(t.imageId).not.toBe(rt.id);
    expect(host.doc.state.images.get(t.imageId)?.sha256).toBe(rt.sha256);
  });

  it('fromLibrary adds a named color (no canvas in node → no texture) once and lists the library', async () => {
    const { registry, host } = setup();
    const list = registry.execute('material.library') as { key: string; textured: boolean }[];
    expect(list.some((m) => m.key === 'Wood_Cherry' && m.textured)).toBe(true);
    const id = (await registry.execute('material.fromLibrary', { key: 'Color_B01' })) as number;
    expect(host.doc.state.materials.get(id as MaterialId)).toMatchObject({ name: 'Color_B01', color: [1, 0, 0] });
    expect(await registry.execute('material.fromLibrary', { key: 'Color_B01' })).toBe(id);
    const wood = (await registry.execute('material.fromLibrary', { key: 'Wood_Cherry' })) as number;
    expect(host.doc.state.materials.get(wood as MaterialId)?.texture).toBeNull();
    await expect(registry.execute('material.fromLibrary', { key: 'Nope' })).rejects.toThrow(/Unknown library/);
  });
});

describe('paint.apply modes on a box', () => {
  it('single paints the clicked side only; sample reads it back and sets the active material', () => {
    const { registry, body, faceIds, faceRef, red, blue, paint } = setup();
    const [f0, f1] = faceIds() as unknown as [number, number];
    const r = paint({ refs: [faceRef(f0)], materialId: red, mode: 'single', side: 'front' });
    expect(r).toMatchObject({ painted: 1, materialId: red, sampled: null });
    expect(body().faces.get(f0 as never)).toMatchObject({ frontMaterialId: red, backMaterialId: null });
    paint({ refs: [faceRef(f0)], materialId: blue, mode: 'single', side: 'back' });
    expect(body().faces.get(f0 as never)).toMatchObject({ frontMaterialId: red, backMaterialId: blue });
    expect(body().faces.get(f1 as never)?.frontMaterialId).toBeNull();
    expect(registry.execute('paint.sample', { ref: faceRef(f0) })).toBe(red);
    expect(registry.execute('paint.sample', { ref: faceRef(f0), side: 'back' })).toBe(blue);
    expect(registry.execute('paint.sample', { ref: faceRef(f1) })).toBeNull();
    expect(registry.execute('material.getActive')).toBeNull();
    const s = paint({ refs: [faceRef(f0)], materialId: blue, mode: 'sample' });
    expect(s).toMatchObject({ painted: 0, sampled: red, materialId: red });
    expect(registry.execute('material.getActive')).toBe(red);
  });

  it('adjacent floods edge-connected faces with the same material', () => {
    const { body, faceIds, faceRef, red, blue, paint } = setup();
    const ids = faceIds();
    // all six faces are default and connected → the whole box
    expect(paint({ refs: [faceRef(ids[0]!)], materialId: red, mode: 'adjacent' }).painted).toBe(6);
    for (const id of ids) expect(body().faces.get(id as never)?.frontMaterialId).toBe(red);
    // repaint one face blue; adjacent from it only touches that face (neighbours are red)
    paint({ refs: [faceRef(ids[2]!)], materialId: blue });
    expect(paint({ refs: [faceRef(ids[2]!)], materialId: null, mode: 'adjacent' }).painted).toBe(1);
    expect(body().faces.get(ids[2]! as never)?.frontMaterialId).toBeNull();
    expect(body().faces.get(ids[0]! as never)?.frontMaterialId).toBe(red);
  });

  it('replaceAll swaps every face side with the sampled material in the context; replaceOnObject stays on one body', () => {
    const { registry, host, body, faceIds, faceRef, red, blue, paint, bodyId } = setup();
    const ids = faceIds();
    const other = registry.execute('model.addBox', { min: [3, 0, 0], max: [4, 1, 1] }) as Id;
    const otherBody = () => host.doc.rootDefinition.entities.bodies.get(other)!;
    const otherFace = [...otherBody().faces.keys()][0]!;
    paint({ refs: [faceRef(ids[0]!), faceRef(ids[1]!)], materialId: red, side: 'both' });
    paint({ refs: [{ kind: 'face', path: [], id: other, faceId: otherFace as never, region: null }], materialId: red });
    // replaceAll from a red face: red → blue on both boxes, front and back
    const r = paint({ refs: [faceRef(ids[0]!)], materialId: blue, mode: 'replaceAll', side: 'both' });
    expect(r.sampled).toBe(red);
    expect(r.painted).toBe(3);
    expect(body().faces.get(ids[0]! as never)).toMatchObject({ frontMaterialId: blue, backMaterialId: blue });
    expect(body().faces.get(ids[1]! as never)).toMatchObject({ frontMaterialId: blue, backMaterialId: blue });
    expect(otherBody().faces.get(otherFace as never)?.frontMaterialId).toBe(blue);
    // replaceOnObject: blue → red on the first box only
    const r2 = paint({ refs: [faceRef(ids[1]!)], materialId: red, mode: 'replaceOnObject' });
    expect(r2.painted).toBe(2);
    expect(body().faces.get(ids[0]! as never)?.frontMaterialId).toBe(red);
    expect(body().faces.get(ids[0]! as never)?.backMaterialId).toBe(blue); // front side only
    expect(otherBody().faces.get(otherFace as never)?.frontMaterialId).toBe(blue);
    // default (null) material counts as a material too: replace all default fronts
    const r3 = paint({ refs: [faceRef(ids[3]!)], materialId: blue, mode: 'replaceAll' });
    expect(r3.sampled).toBeNull();
    expect(r3.painted).toBe(4 + 5);
    expect(bodyId).toBeDefined();
  });

  it('paints a body on every face (loose geometry), instances as a default material keeping explicit faces; selectFaces picks faces', () => {
    const { registry, host, body, faceIds, faceRef, red, blue, paint, bodyId } = setup();
    paint({ refs: [faceRef(faceIds()[0]!)], materialId: blue });
    paint({ refs: [{ kind: 'body', path: [], id: bodyId }], materialId: red });
    expect(body().materialId).toBe(red);
    // a previously painted face is repainted too: a body is a loose "shape", not a group
    expect(body().faces.get(faceIds()[0]! as never)?.frontMaterialId).toBe(red);
    expect([...body().faces.values()].every((f) => f.frontMaterialId === red && f.backMaterialId === null)).toBe(true);
    expect(registry.execute('paint.sample', { ref: faceRef(faceIds()[1]!) })).toBe(red);
    paint({ refs: [faceRef(faceIds()[0]!)], materialId: blue });
    const { instanceId } = registry.execute('group.make', { refs: [{ kind: 'body', path: [], id: bodyId }] }) as { instanceId: number };
    const instRef: EntityRef = { kind: 'instance', path: [], id: instanceId as Id };
    expect(paint({ refs: [instRef], materialId: blue }).painted).toBe(1);
    expect(host.doc.rootDefinition.entities.instances.get(instanceId as Id)?.materialId).toBe(blue);
    expect(registry.execute('paint.sample', { ref: instRef })).toBe(blue);
    // faces inside the group are not in the root context
    const inside = [...host.doc.state.definitions.values()].find((d) => d.isGroup)!;
    const innerBody = [...inside.entities.bodies.values()][0]!;
    expect(() => paint({ refs: [{ kind: 'face', path: [instanceId as Id], id: innerBody.id, faceId: [...innerBody.faces.keys()][0]!, region: null }], materialId: red })).toThrow(/context/);
    registry.execute('context.enter', { instanceId });
    expect(registry.execute('material.selectFaces', { id: red })).toBe(5);
    expect(registry.execute('material.selectFaces', { id: blue })).toBe(1);
    expect(host.selection.refs[0]).toMatchObject({ kind: 'face', path: [instanceId] });
  });

  it('paints sketch faces and floods adjacent sketch faces', () => {
    const { registry, host, red, blue, paint } = setup();
    registry.execute('sketch.rectangle', { a: [5, 0, 0], b: [6, 0, 0], c: [6, 1, 0], d: [5, 1, 0] });
    registry.execute('sketch.rectangle', { a: [6, 0, 0], b: [7, 0, 0], c: [7, 1, 0], d: [6, 1, 0] });
    const sketch = () => host.doc.rootDefinition.entities.sketch;
    const [fa, fb] = [...sketch().faces.keys()] as [Id, Id];
    paint({ refs: [{ kind: 'sketchFace', path: [], id: fa }], materialId: red, side: 'both' });
    expect(sketch().faces.get(fa)).toMatchObject({ frontMaterialId: red, backMaterialId: red });
    expect(sketch().faces.get(fb)?.frontMaterialId).toBeNull();
    expect(paint({ refs: [{ kind: 'sketchFace', path: [], id: fb }], materialId: blue, mode: 'adjacent' }).painted).toBe(1);
    paint({ refs: [{ kind: 'sketchFace', path: [], id: fa }], materialId: blue });
    expect(paint({ refs: [{ kind: 'sketchFace', path: [], id: fa }], materialId: null, mode: 'adjacent' }).painted).toBe(2);
    expect(sketch().faces.get(fb)?.frontMaterialId).toBeNull();
  });
});

describe('faces.reverse', () => {
  /** Texture coordinates a face side shows at world point `p`, in tiles. */
  const st = (f: { basis: PlaneBasis; uv: UvMapping; uvBack?: UvMapping | undefined }, side: 'front' | 'back', tile: { widthM: number; heightM: number }, p: Vec3) => {
    const [u, v] = basisToLocal(f.basis, p);
    return uvApply(uvToAffine(side === 'back' ? (f.uvBack ?? f.uv) : f.uv, tile.widthM, tile.heightM), u, v);
  };

  it('turns sketch faces over: the normal and loops flip, and each side keeps the material and texture it showed', async () => {
    const { registry, host, red } = setup();
    registry.execute('sketch.rectangle', { a: [0, 0, 5], b: [2, 0, 5], c: [2, 1, 5], d: [0, 1, 5] });
    const sketch = () => host.doc.rootDefinition.entities.sketch;
    const id = [...sketch().faces.keys()][0]!;
    const ref: EntityRef = { kind: 'sketchFace', path: [], id };
    const img = await host.images.put(new Uint8Array([9, 9, 9, 9]), 'image/png', 't.png', { width: 2, height: 2 });
    const tile = { widthM: 0.5, heightM: 0.25 };
    const tex = registry.execute('material.create', { name: 'Tex', color: [1, 1, 1], texture: { imageId: img.id, ...tile } }) as number;
    registry.execute('paint.apply', { refs: [ref], materialId: tex, side: 'front' });
    registry.execute('paint.apply', { refs: [ref], materialId: red, side: 'back' });
    registry.execute('texture.position', { ref, uv: { kind: 'affine', matrix: [2, 0.5, 0.25, -0.5, 2, 0] } });
    const before = structuredClone(sketch().faces.get(id)!);
    const points: Vec3[] = [[0, 0, 5], [2, 0, 5], [0.5, 0.75, 5]];

    expect(registry.execute('faces.reverse', { refs: [ref] })).toBe(1);
    const after = sketch().faces.get(id)!;
    expect(after.plane.n[2]).toBeCloseTo(-before.plane.n[2]);
    expect(after.basis.n[2]).toBeCloseTo(-before.basis.n[2]);
    expect(after.loops[0]).toEqual(reverseLoop(before.loops[0]!));
    expect([after.frontMaterialId, after.backMaterialId]).toEqual([red, tex]);
    // The textured side, now the back, shows the texture where it did as the front.
    for (const p of points) {
      const [s0, t0] = st(before, 'front', tile, p);
      const [s1, t1] = st(after, 'back', tile, p);
      expect(s1).toBeCloseTo(s0);
      expect(t1).toBeCloseTo(t0);
    }
    // Reversing twice restores the face; one undo step each.
    registry.execute('faces.reverse', { refs: [ref] });
    expect(sketch().faces.get(id)!.frontMaterialId).toBe(tex);
    for (const p of points) {
      const [s0, t0] = st(before, 'front', tile, p);
      const [s2, t2] = st(sketch().faces.get(id)!, 'front', tile, p);
      expect(s2).toBeCloseTo(s0);
      expect(t2).toBeCloseTo(t0);
    }
    host.undo();
    host.undo();
    expect(sketch().faces.get(id)).toEqual(before);
  });

  it('an automatic placement on the textured side becomes the affine placement it showed', async () => {
    const { registry, host } = setup();
    registry.execute('sketch.rectangle', { a: [5, 0, 0], b: [5, 2, 0], c: [5, 2, 1], d: [5, 0, 1] });
    const id = [...host.doc.rootDefinition.entities.sketch.faces.keys()][0]!;
    const ref: EntityRef = { kind: 'sketchFace', path: [], id };
    const img = await host.images.put(new Uint8Array([9, 9, 9, 9]), 'image/png', 't.png', { width: 2, height: 2 });
    const tile = { widthM: 0.3, heightM: 0.7 };
    const tex = registry.execute('material.create', { name: 'Tex', color: [1, 1, 1], texture: { imageId: img.id, ...tile } }) as number;
    registry.execute('paint.apply', { refs: [ref], materialId: tex, side: 'front' });
    const before = structuredClone(host.doc.rootDefinition.entities.sketch.faces.get(id)!);
    registry.execute('faces.reverse', {});
    expect(host.doc.rootDefinition.entities.sketch.faces.get(id)!.frontMaterialId).toBe(tex); // the selection was empty
    host.selection.set([ref]);
    registry.execute('faces.reverse', {});
    const after = host.doc.rootDefinition.entities.sketch.faces.get(id)!;
    expect(after.backMaterialId).toBe(tex);
    for (const p of [[5, 0, 0], [5, 2, 1], [5, 1.3, 0.2]] as Vec3[]) {
      const [s0, t0] = st(before, 'front', tile, p);
      const [s1, t1] = st(after, 'back', tile, p);
      expect(s1).toBeCloseTo(s0);
      expect(t1).toBeCloseTo(t0);
    }
  });

  it('leaves faces of a solid alone and says why; mixed with sketch faces, reverses only those', () => {
    const { registry, host, faceIds, faceRef } = setup();
    expect(() => registry.execute('faces.reverse', { refs: [faceRef(faceIds()[0]!)] })).toThrow(/always face outward/);
    registry.execute('sketch.rectangle', { a: [3, 0, 0], b: [4, 0, 0], c: [4, 1, 0], d: [3, 1, 0] });
    const id = [...host.doc.rootDefinition.entities.sketch.faces.keys()][0]!;
    expect(registry.execute('faces.reverse', { refs: [faceRef(faceIds()[0]!), { kind: 'sketchFace', path: [], id }] })).toBe(1);
  });
});

describe('texture.* commands', () => {
  it('position / reset change the face uv mapping; the context menu offers Texture › Position only for textured faces', () => {
    const { registry, host, body, faceIds, faceRef, red, paint } = setup();
    const f0 = faceIds()[0]!;
    expect(registry.execute('texture.position', { ref: faceRef(f0), uv: { kind: 'affine', matrix: [2, 0, 0.5, 0, 2, 0] } })).toBe(true);
    expect(body().faces.get(f0 as never)?.uv).toEqual({ kind: 'affine', matrix: [2, 0, 0.5, 0, 2, 0] });
    expect(registry.execute('texture.reset', { refs: [faceRef(f0)] })).toBe(1);
    expect(body().faces.get(f0 as never)?.uv).toEqual({ kind: 'auto' });
    host.undo();
    expect(body().faces.get(f0 as never)?.uv.kind).toBe('affine');
    expect(contextMenu.itemsFor(host.doc.state, [faceRef(f0)]).some((i) => i.label === 'Texture')).toBe(false);
    expect(() => registry.execute('material.update', { id: red, texture: { imageId: 999 } })).toThrow(/Image 999/);
    expect(() => registry.execute('texture.projected', {})).toThrow();
    paint({ refs: [faceRef(f0)], materialId: red });
  });

  it('Reset Position resets both sides of a face whose back has its own placement', async () => {
    const { registry, host, body, faceIds, faceRef, paint } = setup();
    const f0 = faceIds()[0]!;
    const img = await host.images.put(new Uint8Array([9, 9, 9, 9]), 'image/png', 't.png', { width: 2, height: 2 });
    const tex = registry.execute('material.create', { name: 'Tex', color: [1, 1, 1], texture: { imageId: img.id, widthM: 0.5, heightM: 0.5 } }) as number;
    const face = () => body().faces.get(f0 as never)!;
    const menu = () => contextMenu.itemsFor(host.doc.state, [faceRef(f0)]).find((i) => i.label === 'Texture');
    // Only the back is textured and positioned, as an imported face can be.
    paint({ refs: [faceRef(f0)], materialId: tex, side: 'back' });
    host.edit('Pin back', (draft) => {
      draft.definitions.get(draft.rootDefinitionId)!.entities.bodies.get(body().id)!.faces.get(f0 as never)!.uvBack = { kind: 'affine', matrix: [1, 0, 0.25, 0, 1, 0] };
    });
    const items = menu()!.children!;
    expect(items.find((c) => c.label === 'Position')?.disabled).toBe(true);
    expect(items.find((c) => c.label === 'Reset Position')?.disabled).toBe(false);
    // Position Texture places the front; the back keeps its own placement.
    registry.execute('texture.position', { ref: faceRef(f0), uv: { kind: 'affine', matrix: [2, 0, 0, 0, 2, 0] } });
    expect(face().uvBack).toEqual({ kind: 'affine', matrix: [1, 0, 0.25, 0, 1, 0] });
    expect(registry.execute('texture.reset', { refs: [faceRef(f0)] })).toBe(1);
    expect(face().uv).toEqual({ kind: 'auto' });
    expect(face().uvBack).toBeUndefined();
    expect(menu()!.children!.find((c) => c.label === 'Reset Position')?.disabled).toBe(true);
  });
});

describe('Paint tool helpers', () => {
  it('maps modifiers to paint modes and the hit normal to a side', () => {
    const m = (p: Partial<{ shift: boolean; ctrl: boolean; alt: boolean; meta: boolean }>) => ({ shift: false, ctrl: false, alt: false, meta: false, ...p });
    expect(paintModeOf(m({}))).toBe('single');
    expect(paintModeOf(m({ ctrl: true }))).toBe('adjacent');
    expect(paintModeOf(m({ shift: true }))).toBe('replaceAll');
    expect(paintModeOf(m({ ctrl: true, shift: true }))).toBe('replaceOnObject');
    expect(paintModeOf(m({ alt: true }))).toBe('sample');
    expect(paintModeOf(m({ meta: true }))).toBe('sample');
    expect(paintModeOf(m({}), true)).toBe('sample');
    const hit = { ref: { kind: 'body', path: [], id: 1 as Id } as EntityRef, point: [0, 0, 0] as const, t: 1, screenDist: 0, normal: [0, 0, 1] as const };
    expect(hitSide(hit, [0, 0, -1])).toBe('front');
    expect(hitSide(hit, [0, 0, 1])).toBe('back');
    expect(hitSide(null, [0, 0, 1])).toBe('front');
  });

  it('pin transforms: similarity keeps the center, rotation and reflection are exact', () => {
    const S = similarityAbout([1, 1], [2, 1], [1, 3])!; // rotate 90°, scale 2 about (1,1)
    expect(uvApply(S, 1, 1)).toEqual([1, 1]);
    const p = uvApply(S, 2, 1);
    expect(p[0]).toBeCloseTo(1);
    expect(p[1]).toBeCloseTo(3);
    const R = rotationAbout([0, 0], Math.PI / 2);
    const q = uvApply(R, 1, 0);
    expect(q[0]).toBeCloseTo(0);
    expect(q[1]).toBeCloseTo(1);
    const F = reflectionAcross([0, 0], [0, 1])!; // mirror across the v axis
    const r = uvApply(F, 1, 2);
    expect(r[0]).toBeCloseTo(-1);
    expect(r[1]).toBeCloseTo(2);
  });
});

describe('PaintTool with a selection', () => {
  it('a plain click on a selected entity paints the whole selection; an unselected one paints only itself', () => {
    const { registry, host, body, faceIds, faceRef, red, bodyId } = setup();
    const tools = new ToolManager(registry, camera);
    registry.ctx.tools = tools;
    const tool = new PaintTool();
    tools.register(tool);
    tools.register(placeholderTool('select', 'Select'));
    const box2 = registry.execute('model.addBox', { min: [3, 0, 0], max: [4, 1, 1] }) as Id;
    const box2Faces = () => [...host.doc.rootDefinition.entities.bodies.get(box2)!.faces.values()];
    tools.activate('paint');
    const [f0, f1] = faceIds() as unknown as [number, number];
    const click = (ref: EntityRef, modifiers = { shift: false, ctrl: false, alt: false, meta: false }) =>
      tool.onClick({
        button: 0,
        screen: [0, 0],
        ray: { origin: [0, -10, 0], dir: [0, 1, 0] },
        modifiers,
        inference: { hit: { ref, selectable: ref, normal: [0, -1, 0] } },
      } as never);
    // drag-selected "shape" (the whole body) + one face of the other box
    host.selection.set([{ kind: 'body', path: [], id: bodyId }, { kind: 'face', path: [], id: box2, faceId: box2Faces()[0]!.id, region: null }]);
    click(faceRef(f1)); // f1 is not selected itself, but its body is
    expect(tool.lastResult?.painted).toBeGreaterThanOrEqual(2);
    expect(body().materialId).toBe(red);
    expect(box2Faces()[0]!.frontMaterialId).toBe(red);
    expect(box2Faces()[1]!.frontMaterialId).toBeNull();
    // hovering a selected entity highlights the whole selection
    tool.onPointerMove({ screen: [0, 0], modifiers: { shift: false, ctrl: false, alt: false, meta: false }, ray: { origin: [0, -10, 0], dir: [0, 1, 0] }, inference: { hit: { ref: faceRef(f0), selectable: faceRef(f0), normal: [0, -1, 0] } } } as never);
    expect(tool.overlay().length).toBeGreaterThan(entityOverlayCount(host, faceRef(f0)));
    // clicking an unselected face paints only that face and keeps the selection
    const blue = registry.execute('material.create', { name: 'Blue2', color: [0, 0, 1] }) as number;
    const other = box2Faces()[2]!;
    click({ kind: 'face', path: [], id: box2, faceId: other.id, region: null });
    expect(tool.lastResult?.painted).toBe(1);
    expect(box2Faces()[2]!.frontMaterialId).toBe(blue);
    expect(box2Faces()[1]!.frontMaterialId).toBeNull();
    expect(host.selection.size).toBe(2);
  });
});

function entityOverlayCount(host: DocumentHost, ref: EntityRef): number {
  return entityOverlay(host.doc.state, ref, '#fff').length;
}

const camera: CameraHost = {
  getState: () => ({ eye: [0, -10, 0], target: [0, 0, 0], up: [0, 0, 1], fov: 35, projection: 'perspective', orthoHeight: 10 }),
  setState: () => undefined,
  viewportSize: () => ({ width: 800, height: 600 }),
  screenToRay: () => ({ origin: [0, 0, 0], dir: [0, 1, 0] }),
  pick: () => null,
  sceneBounds: () => null,
  orbitStart: () => undefined,
  orbitDrag: () => undefined,
  orbitEnd: () => undefined,
  panStart: () => undefined,
  panDrag: () => undefined,
  panEnd: () => undefined,
  zoomAt: () => undefined,
  zoomExtents: () => undefined,
  zoomWindow: () => undefined,
  standardView: () => undefined,
  setProjection: () => undefined,
  setFov: () => undefined,
  setFocalLength: () => undefined,
  previousView: () => false,
  nextView: () => false,
};

describe('PositionTextureTool', () => {
  const camera2: CameraHost = {
    getState: () => ({ eye: [0, -10, 0], target: [0, 0, 0], up: [0, 0, 1], fov: 35, projection: 'perspective', orthoHeight: 10 }),
    setState: () => undefined,
    viewportSize: () => ({ width: 800, height: 600 }),
    screenToRay: () => ({ origin: [0, 0, 0], dir: [0, 1, 0] }),
    pick: () => null,
    sceneBounds: () => null,
    orbitStart: () => undefined,
    orbitDrag: () => undefined,
    orbitEnd: () => undefined,
    panStart: () => undefined,
    panDrag: () => undefined,
    panEnd: () => undefined,
    zoomAt: () => undefined,
    zoomExtents: () => undefined,
    zoomWindow: () => undefined,
    standardView: () => undefined,
    setProjection: () => undefined,
    setFov: () => undefined,
    setFocalLength: () => undefined,
    previousView: () => false,
    nextView: () => false,
  };

  it('begins on a textured face, places four pins on one tile, commits moves/rotations and restores on cancel', async () => {
    const { registry, host, body, faceIds, faceRef, paint } = setup();
    const tools = new ToolManager(registry, camera2);
    registry.ctx.tools = tools;
    const tool = new PositionTextureTool();
    tools.register(tool);
    tools.register(placeholderTool('select', 'Select'));
    const f0 = faceIds()[0]!;
    expect(() => registry.execute('texture.positionTool', { ref: faceRef(f0) })).toThrow(/no texture/);
    const img = await host.images.put(new Uint8Array([9, 9, 9, 9]), 'image/png', 't.png', { width: 2, height: 2 });
    const tex = registry.execute('material.create', { name: 'Tex', color: [1, 1, 1], texture: { imageId: img.id, widthM: 0.5, heightM: 0.25 } }) as number;
    paint({ refs: [faceRef(f0)], materialId: tex });
    registry.execute('texture.positionTool', { ref: faceRef(f0) });
    expect(tools.activeToolId).toBe('texturePosition');
    expect(tool.pinPositions).toHaveLength(4);
    // pins sit on the corners of one 0.5 × 0.25 m tile in face space
    const [p0, p1, p2] = tool.pinPositions as [[number, number], [number, number], [number, number]];
    expect(Math.hypot(p1[0] - p0[0], p1[1] - p0[1])).toBeCloseTo(0.5);
    expect(Math.hypot(p2[0] - p0[0], p2[1] - p0[1])).toBeCloseTo(0.25);
    expect(tool.overlay().filter((o) => o.kind === 'point')).toHaveLength(4);
    const before = host.undoStack.length;
    tool.rotate(90);
    expect(host.undoStack.length).toBe(before + 1);
    const uv = body().faces.get(f0 as never)!.uv;
    expect(uv.kind).toBe('affine');
    // the red pin still maps to the same texture corner after rotating about it
    const m = (uv as { matrix: readonly number[] }).matrix;
    const red = tool.pinPositions[0]!;
    const st = [m[0]! * red[0] + m[1]! * red[1] + m[2]!, m[3]! * red[0] + m[4]! * red[1] + m[5]!];
    expect(st[0]).toBeCloseTo(Math.round(st[0]!));
    expect(st[1]).toBeCloseTo(Math.round(st[1]!));
    tool.flip('leftRight');
    tool.reset();
    expect(body().faces.get(f0 as never)!.uv).toEqual({ kind: 'auto' });
    tool.rotate(180);
    expect(body().faces.get(f0 as never)!.uv.kind).toBe('affine');
    tools.cancel(); // Esc → restore the original (auto) mapping and leave the tool
    expect(body().faces.get(f0 as never)!.uv).toEqual({ kind: 'auto' });
    expect(tools.activeToolId).not.toBe('texturePosition');
    // Texture › Position appears for the textured face; the pin menu while the tool is active
    const items = contextMenu.itemsFor(host.doc.state, [faceRef(f0)]);
    const texMenu = items.find((i) => i.label === 'Texture')!;
    expect(texMenu.children?.map((c) => c.label)).toEqual(['Position', 'Reset Position', 'Projected']);
    expect(contextMenu.itemsFor(host.doc.state, [faceRef(f0)], { activeToolId: 'texturePosition' }).map((i) => i.label)).toEqual(['Done', 'Reset', 'Flip', 'Rotate']);
    registry.execute('texture.positionTool', { ref: faceRef(f0) });
    registry.execute('texture.pin.rotate', { degrees: 90 });
    registry.execute('texture.pin.done');
    expect(tools.activeToolId).not.toBe('texturePosition');
    expect(body().faces.get(f0 as never)!.uv.kind).toBe('affine');
    expect(activeMaterialOf(registry.ctx).get()).toBe(tex);
  });

  it('the yellow pin distorts exactly: the four pins keep their tile corners through a projective placement', async () => {
    const { registry, host, body, faceIds, faceRef, paint } = setup();
    const tools = new ToolManager(registry, camera2);
    registry.ctx.tools = tools;
    const tool = new PositionTextureTool();
    tools.register(tool);
    tools.register(placeholderTool('select', 'Select'));
    // The box face facing the camera (eye at y = −10).
    const f0 = faceIds().find((id) => body().faces.get(id as never)!.plane.n[1] < -0.5)!;
    const img = await host.images.put(new Uint8Array([9, 9, 9, 9]), 'image/png', 't.png', { width: 2, height: 2 });
    const tex = registry.execute('material.create', { name: 'Tex', color: [1, 1, 1], texture: { imageId: img.id, widthM: 0.5, heightM: 0.25 } }) as number;
    paint({ refs: [faceRef(f0)], materialId: tex });
    registry.execute('texture.positionTool', { ref: faceRef(f0) });
    const cam = camera2.getState(), size = camera2.viewportSize();
    const event = (p: Vec3, button: number) => {
      const d = [p[0] - cam.eye[0], p[1] - cam.eye[1], p[2] - cam.eye[2]] as const;
      const l = Math.hypot(...d);
      return { screen: worldToScreen(cam, size, p)!, ray: { origin: cam.eye, dir: [d[0] / l, d[1] / l, d[2] / l] }, button, buttons: button === 0 ? 1 : 0,
        modifiers: { shift: false, ctrl: false, alt: false, meta: false }, inference: null, camera: cam } as never;
    };
    const yellow = tool.pinWorld(3)!;
    const target: Vec3 = [yellow[0] + 0.1, yellow[1], yellow[2] + 0.05];
    const corners = tool.pinPositions.map((p) => [p[0], p[1]] as const);
    tool.onPointerDown(event(yellow, 0));
    tool.onPointerMove(event(target, -1));
    tool.onPointerUp(event(target, 0));
    const face = body().faces.get(f0 as never)!;
    expect(face.uv.kind).toBe('projective');
    // Red, green and blue stay put and show the same tile corners; yellow shows its corner where it was dropped.
    const at = (uvp: readonly number[]) => uvAt(face.uv, 0.5, 0.25, uvp[0]!, uvp[1]!);
    const tile = corners.map((c) => at(c));
    tool.pinPositions.slice(0, 3).forEach((p, i) => {
      expect(at(p)[0]).toBeCloseTo(tile[i]![0], 9);
      expect(at(p)[1]).toBeCloseTo(tile[i]![1], 9);
    });
    const dropped = basisToLocal(face.basis, target);
    expect(at(dropped)[0]).toBeCloseTo(Math.round(at(dropped)[0]), 9);
    expect(at(dropped)[1]).toBeCloseTo(Math.round(at(dropped)[1]), 9);
    expect([Math.round(at(dropped)[0]), Math.round(at(dropped)[1])]).toEqual([Math.round(tile[3]![0]), Math.round(tile[3]![1])]);
  });
});
