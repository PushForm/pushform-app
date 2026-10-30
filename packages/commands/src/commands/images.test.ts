// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import { basisToLocal, m4translation, type Id, type Vec3 } from '@pushform/core';
import { containerAt, imageEntityCorners, sketchFaceLoops, type EntityRef, type ImageEntity } from '@pushform/model';
import { disposeKernels, setupCommands } from './transform.fixtures';
import { contextCommands } from './context';
import { groupCommands, type MakeResult } from './groups';
import { contextMenu } from './contextMenu';
import { imageCommands, pictureUv, type ImageExplodeResult, type ImageImportResult } from './images';
import { SERVICE_ACTIVE_MATERIAL } from '../host/services';

afterEach(disposeKernels);

/** The first 24 bytes of a PNG: signature and IHDR, enough for its pixel size. */
function pngHeader(width: number, height: number, seed = 0): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  b[32] = seed;
  return b;
}

function setup() {
  const s = setupCommands();
  s.registry.registerAll(groupCommands);
  s.registry.registerAll(contextCommands);
  s.registry.registerAll(imageCommands);
  const importImage = (width = 400, height = 200, extra: Record<string, unknown> = {}): Promise<ImageImportResult> =>
    s.registry.execute('image.import', { bytes: pngHeader(width, height, width % 251), name: 'photo.png', mime: 'image/png', ...extra }) as Promise<ImageImportResult>;
  const image = (ref: EntityRef): ImageEntity | undefined => containerAt(s.host.doc.state, ref.path).images.get(ref.id);
  return { ...s, importImage, image };
}

describe('image commands', () => {
  it('imports a picture as an image one millimeter per pixel at the context origin, selected, and shares an identical image', async () => {
    const { importImage, image, host } = setup();
    const a = await importImage(400, 200);
    expect(a).toMatchObject({ widthM: 0.4, heightM: 0.2 });
    expect(image(a.ref)).toMatchObject({ widthM: 0.4, heightM: 0.2, hidden: false, tagId: host.doc.state.defaultTagId });
    expect(host.selection.refs).toEqual([a.ref]);
    expect(host.doc.state.images.get(a.imageId as never)).toMatchObject({ name: 'photo.png', width: 400, height: 200, mime: 'image/png' });
    expect(host.images.has(a.imageId as never)).toBe(true);
    const b = await importImage(400, 200, { origin: [1, 2, 3] });
    expect(b.imageId).toBe(a.imageId);
    expect(host.doc.state.images.size).toBe(1);
    expect(imageEntityCorners(image(b.ref)!)[0]).toEqual([1, 2, 3]);
    expect(host.doc.rootDefinition.entities.order.slice(-2)).toEqual([a.ref.id, b.ref.id]);
    // One undo step per import.
    host.undo();
    expect(image(b.ref)).toBeUndefined();
    expect(image(a.ref)).toBeDefined();
  });

  it('refuses bytes that are not a picture', async () => {
    const { registry } = setup();
    await expect(registry.execute('image.import', { bytes: new Uint8Array([1, 2, 3]), name: 'x.png' })).rejects.toThrow(/could not be read as a picture/);
  });

  it('imports into the open group in its coordinates', async () => {
    const { registry, importImage, image } = setup();
    const first = await importImage(100, 100);
    const made = registry.execute('group.make', { refs: [first.ref] }) as MakeResult;
    const group: EntityRef = { kind: 'instance', path: [], id: made.instanceId as Id };
    await registry.execute('transform.apply', { refs: [group], matrix: m4translation([5, 0, 0]) });
    registry.execute('context.enter', { path: [group.id] });
    const a = await importImage(100, 100);
    expect(a.ref.path).toEqual([group.id]);
    expect(imageEntityCorners(image(a.ref)!)[0]).toEqual([0, 0, 0]);
  });

  it('erases, moves, copies, groups and explodes images with the others', async () => {
    const { registry, importImage, image, host } = setup();
    const a = await importImage(1000, 500);
    await registry.execute('transform.apply', { refs: [a.ref], matrix: m4translation([2, 0, 0]) });
    expect(imageEntityCorners(image(a.ref)!)[0]).toEqual([2, 0, 0]);
    const copied = await registry.execute('transform.apply', { refs: [a.ref], matrix: m4translation([0, 3, 0]), copy: true }) as { refs: EntityRef[] };
    const copy = copied.refs.find((r) => r.kind === 'image')!;
    expect(copy.id).not.toBe(a.ref.id);
    expect(imageEntityCorners(image(copy)!)[0]).toEqual([2, 3, 0]);
    expect(image(a.ref)!.transform[12]).toBe(2);
    // Make Group takes the picture into the group; Explode brings it back where it was.
    const made = registry.execute('group.make', { refs: [a.ref] }) as MakeResult;
    expect(image(a.ref)).toBeUndefined();
    expect(host.doc.state.definitions.get(made.definitionId as never)!.entities.images.size).toBe(1);
    const exploded = registry.execute('group.explode', { refs: [{ kind: 'instance', path: [], id: made.instanceId as Id }] }) as { refs: EntityRef[] };
    const back = exploded.refs.find((r) => r.kind === 'image')!;
    expect(imageEntityCorners(image(back)!)[0]).toEqual([2, 0, 0]);
    host.selection.set([back, copy]);
    registry.execute('edit.delete', {});
    expect(host.doc.rootDefinition.entities.images.size).toBe(0);
  });

  it('explodes a picture into a face painted with it on both sides, showing it where the image did', async () => {
    const { registry, importImage, host } = setup();
    const a = await importImage(1000, 500);
    await registry.execute('transform.apply', { refs: [a.ref], matrix: m4translation([1, 1, 0]) });
    const result = registry.execute('image.explode', { refs: [a.ref] }) as ImageExplodeResult;
    const root = host.doc.rootDefinition.entities;
    expect(root.images.size).toBe(0);
    expect(result.refs).toHaveLength(1);
    expect(host.selection.refs).toEqual(result.refs);
    const face = root.sketch.faces.get(result.refs[0]!.id)!;
    const material = host.doc.state.materials.get(face.frontMaterialId!)!;
    expect(face.backMaterialId).toBe(face.frontMaterialId);
    expect(material).toMatchObject({ name: 'photo', texture: { imageId: a.imageId, widthM: 1, heightM: 0.5 } });
    // The picture's corners are its texture's corners.
    const tile = (p: Vec3): number[] => {
      const [u, v] = basisToLocal(face.basis, p);
      const m = face.uv.kind === 'affine' ? face.uv.matrix : [0, 0, 0, 0, 0, 0];
      return [m[0]! * u + m[1]! * v + m[2]!, m[3]! * u + m[4]! * v + m[5]!].map((x) => Math.round(x * 1e9) / 1e9 + 0);
    };
    const corners: Vec3[] = [[1, 1, 0], [2, 1, 0], [2, 1.5, 0], [1, 1.5, 0]];
    expect(corners.map(tile)).toEqual([[0, 0], [1, 0], [1, 1], [0, 1]]);
    expect(sketchFaceLoops(root.sketch, face)[0]).toHaveLength(4);
  });

  it('maps a turned and stretched picture onto any face basis', () => {
    const corners: Vec3[] = [[0, 0, 0], [0, 2, 0], [-3, 2, 0], [-3, 0, 0]];
    const uv = pictureUv(corners, { origin: [5, 5, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] });
    const at = (p: Vec3): number[] => {
      const m = uv.kind === 'affine' ? uv.matrix : [0, 0, 0, 0, 0, 0];
      const u = p[0] - 5, v = p[1] - 5;
      return [m[0]! * u + m[1]! * v + m[2]!, m[3]! * u + m[4]! * v + m[5]!].map((x) => Math.round(x * 1e9) / 1e9 + 0);
    };
    expect(corners.map(at)).toEqual([[0, 0], [1, 0], [1, 1], [0, 1]]);
  });

  it('makes a material of a picture at its placed size and picks it up for painting', async () => {
    const { registry, importImage, host } = setup();
    const a = await importImage(800, 400);
    await registry.execute('transform.apply', { refs: [a.ref], matrix: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1] });
    const id = registry.execute('image.useAsMaterial', { refs: [a.ref] }) as number;
    expect(host.doc.state.materials.get(id as never)).toMatchObject({ name: 'photo', texture: { imageId: a.imageId, widthM: 1.6, heightM: 0.8 } });
    expect((registry.ctx.services.get(SERVICE_ACTIVE_MATERIAL) as { get(): number | null }).get()).toBe(id);
    expect(host.doc.rootDefinition.entities.images.size).toBe(1);
    expect(() => registry.execute('image.useAsMaterial', { refs: [] })).toThrow(/Select an image/);
  });

  it('offers Explode and Use as Material in the context menu of pictures', async () => {
    const { importImage, host } = setup();
    const a = await importImage();
    const b = await importImage(300, 300);
    const labels = (refs: EntityRef[]) => contextMenu.itemsFor(host.doc.state, refs).map((i) => i.label);
    expect(labels([a.ref])).toEqual(['Entity Info', 'Erase', 'Explode', 'Use as Material', 'Make Group', 'Make Component…', 'Zoom Selection']);
    expect(labels([a.ref, b.ref])).not.toContain('Use as Material');
    expect(contextMenu.itemsFor(host.doc.state, [a.ref]).find((i) => i.label === 'Explode')).toMatchObject({ command: 'image.explode', params: { refs: [{ kind: 'image', path: [], id: a.ref.id as Id }] } });
  });
});
