// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { create, parseSkp } from 'openskp';
import { basisToLocal, type MaterialId, type PlaneBasis, type Vec3 } from '@pushform/core';
import { colorizePixels, createDocument, ImageStore, sketchFaceLoops, uvAt, type DocumentState, type MaterialTexture, type UvMapping } from '@pushform/model';
import { applySketchUpImport } from './sketchupDocument';
import { prepareSketchUp, readSketchUp } from './sketchup';
import { decodePng } from './png';
import { decodeModelFile, encodeModelDocument, modelJson } from './modelFile';

const INCH = 0.0254;
const asset = (name: string): Buffer => readFileSync(new URL(`../../testing/assets/sketchup/${name}`, import.meta.url));
interface TruthSide { material: string; uvs: [number, number][] }
interface TruthFace { definition: string; normal: Vec3; points: Vec3[]; front?: TruthSide; back?: TruthSide }
/** SketchUp 2027's own UVHelper coordinates for every textured face of the fixture. */
const truth = (JSON.parse(asset('textures-uv.json').toString()) as { faces: TruthFace[] }).faces;

interface FaceUv {
  basis: PlaneBasis; uv: UvMapping; uvBack?: UvMapping | undefined; front: MaterialId | null; back: MaterialId | null; points: Vec3[];
}
const pointKey = (points: Vec3[]): string => points.map(p => p.map(x => Math.round(x / 1e-5)).join(',')).sort().join('|');

/** Imported faces by definition name ('#root' for the model) and outer-loop points. */
function facesByPoints(state: DocumentState): Map<string, FaceUv> {
  const out = new Map<string, FaceUv>();
  for (const def of state.definitions.values()) {
    const name = def.id === state.rootDefinitionId ? '#root' : def.name;
    for (const f of def.entities.sketch.faces.values()) {
      const points = sketchFaceLoops(def.entities.sketch, f)[0]!;
      out.set(`${name}/${pointKey(points)}`, { ...f, front: f.frontMaterialId, back: f.backMaterialId, points });
    }
    for (const body of def.entities.bodies.values()) for (const f of body.faces.values())
      out.set(`${name}/${pointKey(f.loops[0]!)}`, { ...f, front: f.frontMaterialId, back: f.backMaterialId, points: f.loops[0]! });
  }
  return out;
}

/** Tile coordinates at a definition-local point, as the renderer computes them, for the side's texture or `texture`. */
function tileAt(state: DocumentState, face: FaceUv, side: 'front' | 'back', p: Vec3, texture?: MaterialTexture): [number, number] {
  const uv = side === 'front' ? face.uv : face.uvBack ?? face.uv;
  const shown = texture ?? state.materials.get((side === 'front' ? face.front : face.back)!)!.texture!;
  const [u, v] = basisToLocal(face.basis, p);
  return uvAt(uv, shown.widthM, shown.heightM, u, v) as [number, number];
}

describe('SketchUp textures', () => {
  it.each(['textures-2027.skp', 'textures-2020.skp'])('imports texture images and every placement SketchUp shows in %s', async name => {
    const scene = await readSketchUp(asset(name));
    const doc = createDocument(), images = new ImageStore();
    const report = doc.transact('Open fixture', draft => applySketchUpImport(draft, scene, { images })).value;
    expect(report.materials).toBe(4);
    const textured = [...doc.state.materials.values()].filter(m => m.texture);
    expect(textured.map(m => m.name).sort()).toEqual(['Image', 'Quadrants', 'Stripes']);
    const quadrants = textured.find(m => m.name === 'Quadrants')!.texture!;
    expect(quadrants.widthM).toBeCloseTo(1, 12);
    expect(quadrants.heightM).toBeCloseTo(0.5, 12);
    expect(quadrants.colorize).toBe(false);
    // One asset per picture, with its pixel size; the bytes are the PNGs SketchUp embedded.
    expect([...doc.state.images.values()].map(a => [a.mime, a.width, a.height]).sort()).toEqual(
      [['image/png', 4, 4], ['image/png', 6, 3], ['image/png', 8, 4]]);
    for (const a of doc.state.images.values()) expect([...images.get(a.id)!.bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(report.warnings.some(w => /distorted/.test(w))).toBe(false);
    expect(report.warnings.some(w => /Texture images|untextured|SketchUp image/.test(w))).toBe(false);
    // The fixture's SketchUp image is an image entity showing the picture its material holds.
    const pictures = [...doc.state.definitions.values()].flatMap(d => [...d.entities.images.values()]);
    expect(pictures).toHaveLength(1);
    expect(report.images).toBe(1);
    expect(pictures[0]!.imageId).toBe(textured.find(m => m.name === 'Image')!.texture!.imageId);
    // SketchUp shows the whole picture across the image's 6" × 3" rectangle, on both sides, from its origin corner.
    expect([pictures[0]!.widthM, pictures[0]!.heightM]).toEqual([6 * INCH, 3 * INCH]);
    expect(truth.filter(t => t.definition === 'Image').flatMap(t => [t.front!.uvs, t.back!.uvs])).toEqual([[[0, 0], [1, 0], [1, 1], [0, 1]], [[0, 0], [1, 0], [1, 1], [0, 1]]]);

    const faces = facesByPoints(doc.state);
    let sides = 0, distortedSides = 0;
    for (const t of truth) {
      if (t.definition === 'Image') continue;
      const points = t.points.map(p => p.map(x => x * INCH) as unknown as Vec3);
      const face = faces.get(`${t.definition}/${pointKey(points)}`);
      expect(face, `${t.definition} face at ${JSON.stringify(t.points[0])}`).toBeDefined();
      for (const side of ['front', 'back'] as const) {
        const expected = t[side];
        if (!expected) continue;
        sides++;
        expect(doc.state.materials.get((side === 'front' ? face!.front : face!.back)!)!.name).toBe(expected.material);
        // Every placement is exact, the four-pin (distorted) one too, which is projective;
        // the recorded points are rounded to a millionth of an inch.
        const distorted = expected.uvs.some(([u, v]) => Math.abs(u - 1.4) < 1e-9 && Math.abs(v - 1.2) < 1e-9);
        if (distorted) expect((side === 'front' ? face!.uv : face!.uvBack ?? face!.uv).kind).toBe('projective');
        points.forEach((p, i) => {
          const [s, tt] = tileAt(doc.state, face!, side, p);
          const [u, v] = expected.uvs[i]!;
          expect(Math.abs(s - u), `${t.definition} ${side} s`).toBeLessThan(1e-6);
          expect(Math.abs(tt - v), `${t.definition} ${side} t`).toBeLessThan(1e-6);
        });
        if (distorted) distortedSides++;
      }
    }
    expect(sides).toBe(15);
    expect(distortedSides).toBe(1);
  });

  it('keeps texture images and placements through native save and reopen', async () => {
    const scene = await readSketchUp(asset('textures-2027.skp'));
    const doc = createDocument(), images = new ImageStore();
    doc.transact('Open fixture', draft => applySketchUpImport(draft, scene, { images }));
    const reopened = decodeModelFile(encodeModelDocument(doc, images));
    expect(modelJson(reopened.state)).toBe(modelJson(doc.state));
    expect(reopened.images.size).toBe(3);
    for (const [id, blob] of reopened.images) {
      expect(blob.mime).toBe('image/png');
      expect(blob.bytes).toEqual(images.get(id)!.bytes);
    }
    // Without the image bytes the archive still opens, keeping the descriptors and falling back to colors.
    const bare = decodeModelFile(encodeModelDocument(doc));
    expect(bare.images.size).toBe(0);
    expect(bare.state.images.size).toBe(3);
  });

  it('shares one asset among materials with the same picture and with an identical image already in the model', async () => {
    const bytes = new Uint8Array(asset('textures-2027.skp')), model = parseSkp(new Uint8Array(bytes).buffer);
    const quadrants = model.materials.find(m => m.name === 'Quadrants')!;
    model.materials.find(m => m.name === 'Stripes')!.texture = { ...quadrants.texture! };
    const scene = prepareSketchUp(model);
    expect(scene.images).toHaveLength(2);
    const doc = createDocument(), images = new ImageStore();
    doc.transact('Open', draft => applySketchUpImport(draft, scene, { images }));
    doc.transact('Import again', draft => applySketchUpImport(draft, scene, { images, groupName: 'Again' }));
    expect(doc.state.images.size).toBe(2);
    expect(images.size).toBe(2);
  });

  it('places a texture inherited by a face facing down as SketchUp does, whatever sizes its placements pass down', () => {
    const model = parseSkp(new Uint8Array(asset('textures-2027.skp')).buffer);
    const quadrants = [...model.materialsById].find(([, m]) => m.name === 'Quadrants')![0];
    const stripes = [...model.materialsById].find(([, m]) => m.name === 'Stripes')![0];
    const [groupKey, group] = [...model.definitions].find(([, d]) => d.name === 'Group0')!;
    // The cube's bottom loses its own Quadrants paint and inherits it from the group instead.
    const bottom = group.faces.find(f => f.normal[2] < -0.5)!;
    bottom.materialId = null;
    const placement = model.root.instances.find(i => i.refIdx === groupKey)!;
    placement.materialId = quadrants;
    const expected = truth.find(t => t.definition === 'Group0' && t.normal[2] < -0.5)!;
    const points = expected.points.map(p => p.map(x => x * INCH) as unknown as Vec3);
    const check = (): void => {
      const scene = prepareSketchUp(model), doc = createDocument();
      doc.transact('Open', draft => applySketchUpImport(draft, scene));
      const face = facesByPoints(doc.state).get(`Group0/${pointKey(points)}`)!;
      // One placement for every texture the face shows: SketchUp's default frame, divided by that texture's size.
      expect(face.uv.kind).toBe('sized');
      const textures = [...doc.state.materials.values()].filter(m => m.texture).map(m => m.texture!);
      const shown = textures.find(t => t.widthM === [...doc.state.materials.values()].find(m => m.name === 'Quadrants')!.texture!.widthM)!;
      for (const texture of textures) {
        points.forEach((p, i) => {
          const [s, t] = tileAt(doc.state, face, 'front', p, texture);
          // SketchUp's coordinates for Quadrants, scaled to this texture's tile.
          const [eu, ev] = expected.front!.uvs[i]!;
          expect(s).toBeCloseTo(eu * shown.widthM / texture.widthM, 6);
          expect(t).toBeCloseTo(ev * shown.heightM / texture.heightM, 6);
        });
      }
      expect(scene.warnings.some(w => /differently sized/.test(w))).toBe(false);
    };
    check();
    // A second placement painted with a texture of another size.
    model.root.instances.push({ ...placement, materialId: stripes });
    check();
  });

  it('shows each side of a reversed inside-out solid where SketchUp shows it', () => {
    // Group0 turned inside out: every face runs the other way, keeping its paint and placement.
    const insideOut = (drop: boolean) => {
      const model = parseSkp(new Uint8Array(asset('textures-2027.skp')).buffer);
      const group = [...model.definitions.values()].find(d => d.name === 'Group0')!;
      for (const face of group.faces) {
        face.loops = face.loops.map(loop => loop.map(ref => ({ ...ref, orientation: -ref.orientation })).reverse());
        face.normal = [-face.normal[0], -face.normal[1], -face.normal[2]];
      }
      // Without its top the shell is open, and its faces stay as SketchUp has them.
      if (drop) group.faces = group.faces.filter(f => f.normal[2] > -0.5);
      const scene = prepareSketchUp(model), doc = createDocument();
      doc.transact('Open', draft => applySketchUpImport(draft, scene));
      return { scene, doc };
    };
    const solid = insideOut(false), open = insideOut(true);
    const group = (scene: typeof solid.scene) => [...scene.definitions.values()].find(d => d.name === 'Group0')!;
    expect(group(solid.scene).solids).toHaveLength(1);
    expect(group(open.scene).sheets).toHaveLength(5);
    expect(solid.scene.warnings).toContain('1 inside-out solid(s) reversed: closed shells whose faces all faced inward are imported as solids facing outward.');
    const body = [...solid.doc.state.definitions.values()].find(d => d.name === 'Group0')!.entities.bodies.values().next().value!;
    expect(body.props.volume).toBeGreaterThan(0);
    const reversed = facesByPoints(solid.doc.state), sheets = facesByPoints(open.doc.state);
    let compared = 0;
    for (const [key, sheet] of sheets) {
      if (!key.startsWith('Group0/')) continue;
      const face = reversed.get(key)!;
      // The painted side faced inward in SketchUp, so it is the reversed face's back.
      expect(face.front).toBeNull();
      expect(solid.doc.state.materials.get(face.back!)!.name).toBe(open.doc.state.materials.get(sheet.front!)!.name);
      for (const p of sheet.points) {
        const [s, t] = tileAt(solid.doc.state, face, 'back', p), [es, et] = tileAt(open.doc.state, sheet, 'front', p);
        expect(s).toBeCloseTo(es, 6);
        expect(t).toBeCloseTo(et, 6);
      }
      compared++;
    }
    expect(compared).toBe(5);
  });

  it('places differently sized inherited textures on a reversed inside-out solid where SketchUp shows them', () => {
    const open = (reversedShell: boolean) => {
      const model = parseSkp(new Uint8Array(asset('textures-2027.skp')).buffer);
      const id = (name: string) => [...model.materialsById].find(([, m]) => m.name === name)![0];
      const [groupKey, group] = [...model.definitions].find(([, d]) => d.name === 'Group0')!;
      for (const face of group.faces) {
        face.loops = face.loops.map(loop => loop.map(ref => ({ ...ref, orientation: -ref.orientation })).reverse());
        face.normal = [-face.normal[0], -face.normal[1], -face.normal[2]];
        face.materialId = null;
        face.backMaterialId = null;
      }
      // Without its top the shell is open, and its faces stay as SketchUp has them.
      if (!reversedShell) group.faces = group.faces.filter(f => f.normal[2] > -0.5);
      // Two placements pass down textures of different sizes.
      const placement = model.root.instances.find(i => i.refIdx === groupKey)!;
      placement.materialId = id('Quadrants');
      model.root.instances.push({ ...placement, materialId: id('Stripes') });
      const scene = prepareSketchUp(model), doc = createDocument();
      doc.transact('Open', draft => applySketchUpImport(draft, scene));
      return { scene, doc };
    };
    const solid = open(true), sheets = open(false);
    expect([...solid.scene.definitions.values()].find(d => d.name === 'Group0')!.solids).toHaveLength(1);
    expect(solid.scene.warnings.some(w => /differently sized/.test(w))).toBe(false);
    const reversed = facesByPoints(solid.doc.state), asDrawn = facesByPoints(sheets.doc.state);
    const textures = [...solid.doc.state.materials.values()].filter(m => m.texture).map(m => m.texture!);
    let compared = 0;
    for (const [key, sheet] of asDrawn) {
      if (!key.startsWith('Group0/')) continue;
      // SketchUp shows the inherited texture on the side that faced inward, the reversed face's back.
      const face = reversed.get(key)!;
      for (const texture of textures) for (const p of sheet.points) {
        const [s, t] = tileAt(solid.doc.state, face, 'back', p, texture), [es, et] = tileAt(sheets.doc.state, sheet, 'front', p, texture);
        expect(s).toBeCloseTo(es, 6);
        expect(t).toBeCloseTo(et, 6);
      }
      compared++;
    }
    expect(compared).toBe(5);
  });

  it('keeps colors for missing or undisplayable texture images and reports them', () => {
    const b = create(), wood = b.addMaterial('Wood', [150, 100, 50]);
    b.addFace([[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]], { material: wood });
    const model = parseSkp(new Uint8Array(b.toBytes()).buffer);
    model.materials[0]!.texture = { filename: 'wood.tif', width: 10, height: 10, data: new Uint8Array([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0]) };
    const scene = prepareSketchUp(model);
    expect(scene.images).toEqual([]);
    expect([...scene.materials.values()][0]!.texture).toBeNull();
    expect(scene.warnings).toContain('1 texture image is missing from the file or not PNG, JPEG, GIF, BMP or a TIFF PushForm can read; its material uses its color.');
  });

  it('imports TIFF textures as PNG images, in either byte order, sharing identical pictures', () => {
    /** A 2 x 1 uncompressed 8-bit RGB TIFF: red, then blue. */
    const tiff = (littleEndian: boolean): Uint8Array => {
      const tags: [number, number, number][] = [[256, 3, 2], [257, 3, 1], [258, 3, 8], [259, 3, 1], [262, 3, 2], [273, 4, 0], [277, 3, 3], [278, 3, 1], [279, 4, 6]];
      const ifd = 8, data = ifd + 2 + tags.length * 12 + 4, bytes = new Uint8Array(data + 6), view = new DataView(bytes.buffer);
      bytes.set(littleEndian ? [0x49, 0x49] : [0x4d, 0x4d]);
      view.setUint16(2, 42, littleEndian);
      view.setUint32(4, ifd, littleEndian);
      view.setUint16(ifd, tags.length, littleEndian);
      tags.forEach(([tag, type, value], i) => {
        const at = ifd + 2 + i * 12;
        view.setUint16(at, tag, littleEndian);
        view.setUint16(at + 2, type, littleEndian);
        view.setUint32(at + 4, 1, littleEndian);
        if (type === 3) view.setUint16(at + 8, tag === 273 ? data : value, littleEndian);
        else view.setUint32(at + 8, tag === 273 ? data : value, littleEndian);
      });
      bytes.set([255, 0, 0, 0, 0, 255], data);
      return bytes;
    };
    const b = create(), wood = b.addMaterial('Wood', [150, 100, 50]), granite = b.addMaterial('Granite', [90, 90, 90]), slate = b.addMaterial('Slate', [40, 40, 40]);
    b.addFace([[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]], { material: wood });
    b.addFace([[20, 0, 0], [30, 0, 0], [30, 10, 0], [20, 10, 0]], { material: granite });
    b.addFace([[40, 0, 0], [50, 0, 0], [50, 10, 0], [40, 10, 0]], { material: slate });
    const model = parseSkp(new Uint8Array(b.toBytes()).buffer);
    model.materials[0]!.texture = { filename: 'C:\\textures\\GRA-28.TIF', width: 10, height: 10, data: tiff(true) };
    model.materials[1]!.texture = { filename: 'plan.tiff', width: 10, height: 10, data: tiff(false) };
    model.materials[2]!.texture = { filename: 'copy.tif', width: 10, height: 10, data: tiff(true) };
    const scene = prepareSketchUp(model);
    // All three hold the same picture, so after conversion they share one image, named after the first.
    expect(scene.images).toMatchObject([{ name: 'GRA-28.png', mime: 'image/png', width: 2, height: 1 }]);
    expect([...scene.materials.values()].map((m) => m.texture?.image)).toEqual([0, 0, 0]);
    expect(decodePng(scene.images[0]!.bytes)).toMatchObject({ width: 2, height: 1, channels: 3, pixels: new Uint8Array([255, 0, 0, 0, 0, 255]) });
    expect(scene.warnings.some((w) => /texture image/.test(w))).toBe(false);
  });

  it('keeps Windows bitmap textures, which SketchUp 5 files store, with their pixel size', () => {
    const b = create(), brick = b.addMaterial('Brick', [150, 60, 40]);
    b.addFace([[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]], { material: brick });
    const model = parseSkp(new Uint8Array(b.toBytes()).buffer);
    // A 4 x 2 pixel, 24-bit BITMAPFILEHEADER + BITMAPINFOHEADER image (rows padded to 12 bytes).
    const bmp = new Uint8Array(54 + 24), view = new DataView(bmp.buffer);
    bmp.set([0x42, 0x4d]);
    view.setUint32(2, bmp.length, true);
    view.setUint32(10, 54, true);
    view.setUint32(14, 40, true);
    view.setInt32(18, 4, true);
    view.setInt32(22, 2, true);
    view.setUint16(26, 1, true);
    view.setUint16(28, 24, true);
    model.materials[0]!.texture = { filename: 'brick.bmp', width: 10, height: 10, data: bmp };
    const scene = prepareSketchUp(model);
    expect(scene.images).toMatchObject([{ name: 'brick.bmp', mime: 'image/bmp', width: 4, height: 2 }]);
    expect([...scene.materials.values()][0]!.texture).toMatchObject({ image: 0, widthM: 10 * INCH, heightM: 10 * INCH });
    expect(scene.warnings.some(w => /texture image/.test(w))).toBe(false);
  });

  /** What SketchUp writes for an image: a definition holding one four-cornered face painted with the picture. */
  function imageDefinition(id: number, name: string, corners: Vec3[], material: number) {
    return { id, guid: `${name}-guid`, name, isImage: true, alwaysFacesCamera: false, shadowsFaceSun: false,
      vertices: corners.map(([x, y, z], i) => ({ id: i + 1, x, y, z })),
      edges: [0, 1, 2, 3].map(i => ({ id: i + 1, v1Id: i + 1, v2Id: ((i + 1) % 4) + 1, soft: false, smooth: false, hidden: false })),
      faces: [{ id: 1, loops: [[1, 2, 3, 4].map(edgeId => ({ edgeId, orientation: 1 }))], normal: [0, 0, 1], materialId: material, backMaterialId: null, uvFront: null, uvBack: null }],
      instances: [], sectionPlanes: [], texts: [], dimensions: [], constructionLines: [], constructionPoints: [] };
  }
  const placement = (refIdx: number, matrix: number[], hidden = false) =>
    ({ name: '', refIdx, guid: `p${refIdx}${matrix.join('')}`, matrix, materialId: null, hidden, layer: '', properties: {} });

  it('imports a SketchUp image as an image entity with its picture, size and placement', () => {
    const model = parseSkp(new Uint8Array(asset('textures-2027.skp')).buffer);
    const quadrants = [...model.materialsById].find(([, m]) => m.name === 'Quadrants')![0];
    model.definitions.set(9001, imageDefinition(9001, 'Photo', [[0, 0, 0], [40, 0, 0], [40, 20, 0], [0, 20, 0]], quadrants) as never);
    // Placed twice: moved 10" along x, and turned a quarter turn about z and hidden.
    model.root.instances.push(placement(9001, [1, 0, 0, 0, 1, 0, 0, 0, 1, 10, 0, 0]) as never, placement(9001, [0, 1, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0], true) as never);
    const scene = prepareSketchUp(model);
    expect(scene.definitions.get(9001)!.picture).toEqual({ material: quadrants, origin: [0, 0, 0], widthM: 40 * INCH, heightM: 20 * INCH });
    expect(scene.warnings.some(w => /image/.test(w))).toBe(false);
    const doc = createDocument(), images = new ImageStore();
    const report = doc.transact('Open', draft => applySketchUpImport(draft, scene, { images })).value;
    const root = doc.state.definitions.get(doc.state.rootDefinitionId)!.entities;
    // The fixture's own image is placed too; these are the two placements added here.
    const placed = [...root.images.values()].filter(p => Math.abs(p.widthM - 40 * INCH) < 1e-12);
    expect(placed).toHaveLength(2);
    expect(report.images).toBe(3);
    const texture = [...doc.state.materials.values()].find(m => m.name === 'Quadrants')!.texture!;
    expect(placed.every(p => p.imageId === texture.imageId && images.has(p.imageId))).toBe(true);
    expect(placed.map(p => [p.widthM, p.heightM, p.hidden])).toEqual([[40 * INCH, 20 * INCH, false], [40 * INCH, 20 * INCH, true]]);
    expect(placed[0]!.transform[12]).toBeCloseTo(10 * INCH);
    // The picture's x axis is the placement's (SketchUp's matrices are row-major: its x axis is the first column).
    expect([placed[1]!.transform[0]!, placed[1]!.transform[1]!].map(v => Math.round(v) + 0)).toEqual([0, -1]);
    // No component definition stands in for the picture.
    expect([...doc.state.definitions.values()].some(d => d.name === 'Photo')).toBe(false);
  });

  it('keeps a SketchUp image that is not one flat rectangle as a component, and says so', () => {
    const model = parseSkp(new Uint8Array(asset('textures-2027.skp')).buffer);
    const quadrants = [...model.materialsById].find(([, m]) => m.name === 'Quadrants')![0];
    model.definitions.set(9002, imageDefinition(9002, 'Tilted', [[0, 0, 0], [40, 0, 0], [40, 20, 5], [0, 20, 5]], quadrants) as never);
    model.root.instances.push(placement(9002, [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]) as never);
    const scene = prepareSketchUp(model);
    expect(scene.definitions.get(9002)!.picture).toBeUndefined();
    expect(scene.warnings).toContain('Tilted: a SketchUp image that is not a single flat rectangle is imported as a component holding its textured geometry.');
  });

  it.each(['colorize-2027.skp', 'colorize-2017.skp'])('draws the textures %s colorizes as SketchUp does (PF-168)', async name => {
    const scene = await readSketchUp(asset(name));
    const doc = createDocument(), images = new ImageStore();
    const report = doc.transact('Open fixture', draft => applySketchUpImport(draft, scene, { images })).value;
    expect(report.warnings.some(w => /coloriz/i.test(w))).toBe(false);
    const material = (n: string) => [...doc.state.materials.values()].find(m => m.name === n)!;
    expect(material('Plain').texture).toMatchObject({ colorize: false });
    expect(material('Shifted').texture).toMatchObject({ colorize: true, colorizeType: 'shift' });
    expect(material('Tinted').texture).toMatchObject({ colorize: true, colorizeType: 'tint' });
    for (const [n, png] of [['Shifted', 'colorize-shifted.png'], ['Tinted', 'colorize-tinted.png']] as const) {
      const m = material(n), source = decodePng(images.get(m.texture!.imageId)!.bytes)!, expected = decodePng(asset(png))!;
      const rgba = new Uint8ClampedArray(source.width * source.height * 4);
      for (let i = 0; i < source.width * source.height; i++)
        for (let k = 0; k < 4; k++) rgba[i * 4 + k] = k < source.channels ? source.pixels[i * source.channels + k]! : 255;
      colorizePixels(rgba, m.color.map(v => Math.round(v * 255)) as [number, number, number], m.texture!.colorizeType!);
      let worst = 0;
      for (let i = 0; i < source.width * source.height; i++)
        for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(rgba[i * 4 + k]! - expected.pixels[i * expected.channels + k]!));
      // Within a few levels of SketchUp's own colorized image, pixel for pixel.
      expect(worst, n).toBeLessThanOrEqual(6);
    }
  });
});
