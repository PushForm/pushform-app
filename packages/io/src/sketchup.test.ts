// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync } from 'fflate';
import { create, parseSkp, type SkpModel } from 'openskp';
import { createDocument, UndoStack } from '@pushform/model';
import { DEFAULT_UNITS, formatLength, m4transformPoint, meshSignedVolume, v3dist, v3dot, type Mat4, type Vec3 } from '@pushform/core';
import { meshTopologyProblems } from '@pushform/kernel';
import { polygonArea, tessellateCurve } from '@pushform/geom';
import { applySketchUpImport } from './sketchupDocument';
import { isSketchUpModelFile, prepareSketchUp, readSketchUp, sketchUpDisplay, sketchUpTransform, sketchUpUnits } from './sketchup';
import { decodeModelDocument, encodeModelDocument, modelJson } from './modelFile';
import { encodePng } from './png';

const cube: [number, number, number][][] = [
  [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]],
  [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
  [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]],
  [[1, 1, 0], [0, 1, 0], [0, 1, 1], [1, 1, 1]],
  [[0, 1, 0], [0, 0, 0], [0, 0, 1], [0, 1, 1]],
  [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
];

export function modelFixture(): Uint8Array {
  const b = create(), red = b.addMaterial('Red', [255, 0, 0], 0.5), blue = b.addMaterial('Blue', [0, 0, 255]);
  const tag = b.addLayer('Furniture', { hidden: true });
  const box = b.addComponentDefinition('Box', d => {
    for (const points of cube) d.addFace(points, { material: red, backMaterial: blue, softEdges: true, smoothEdges: true });
  });
  b.addInstance(box, { name: 'Rotated', translation: [100, 20, 30],
    rotation: { axis: [0, 0, 1], angleRadians: Math.PI / 2 }, layer: tag });
  b.addInstance(box, { name: 'Mirrored', matrix3x3: [-2, 0, 0, 0, 3, 0, 0, 0, 1], hidden: true });
  b.addFace([[10, 0, 0], [14, 0, 0], [14, 4, 0], [10, 4, 0]], {
    material: red, holes: [[[11, 1, 0], [11, 2, 0], [12, 2, 0], [12, 1, 0]]],
  });
  b.addPolyline([[20, 0, 0], [21, 0, 0]], { hiddenEdges: true });
  return b.toBytes();
}

describe('SketchUp import', () => {
  it('reads a 2017 definition ending in a four-byte guide trailer (Garage V3 regression)', async () => {
    const bytes = readFileSync(new URL('../../testing/assets/sketchup/guide-last-2017.skp', import.meta.url));
    const scene = await readSketchUp(bytes);
    const definition = [...scene.definitions.values()].find(d => d.name === 'Guide last');
    expect(definition?.guides).toHaveLength(1);
    expect(definition?.sheets).toHaveLength(1);
    expect(scene.root.instances).toHaveLength(1);
  });
  it('reads the committed fixture with analytical one-meter volume and holed sheet area', async () => {
    const bytes = readFileSync(new URL('../../testing/assets/sketchup/import-basics.skp', import.meta.url));
    const scene = await readSketchUp(bytes), doc = createDocument();
    const report = doc.transact('Open fixture', draft => applySketchUpImport(draft, scene)).value;
    expect(report).toMatchObject({ bodies: 1, sheetFaces: 1, looseEdges: 1, definitions: 1, instances: 2, materials: 1, tags: 0 });
    const component = [...doc.state.definitions.values()].find(d => d.id !== doc.state.rootDefinitionId)!;
    expect([...component.entities.bodies.values()][0]!.props.volume).toBeCloseTo(1, 10);
    expect([...doc.rootDefinition.entities.sketch.faces.values()][0]!.loops).toHaveLength(2);
    expect(polygonArea(scene.root.sheets[0]!.loops.map(loop => loop.map(p => [p[0], p[1]])))).toBeCloseTo(5, 10);
  });

  it('takes a material\'s opacity from its opacity setting, not the color\'s alpha byte (PF-146)', () => {
    const b = create();
    const plain = b.addMaterial('Plain', [200, 0, 0]), glass = b.addMaterial('Glass', [0, 0, 255], 0.5);
    const wood = b.addTextureMaterial('Wood', encodePng(2, 2, new Uint8Array(12).fill(160), 3), 'wood.png');
    b.addFace([[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]], { material: plain });
    b.addFace([[20, 0, 0], [30, 0, 0], [30, 10, 0], [20, 10, 0]], { material: glass });
    b.addFace([[40, 0, 0], [50, 0, 0], [50, 10, 0], [40, 10, 0]], { material: wood });
    const bytes = b.toBytes(), model = parseSkp(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    // As SketchUp 2018 stores them (forum-78487 FujitsuScanSnapHolder): opaque materials with a 0 alpha byte, and a
    // translucent one whose byte repeats its opacity.
    const byName = (name: string) => [...model.materialsById.values()].find(m => m.name === name)!;
    byName('Plain').color.a = 0; byName('Wood').color.a = 0; byName('Glass').color.a = 128;
    const scene = prepareSketchUp(model);
    const alpha = (name: string) => [...scene.materials.values()].find(m => m.name === name)!.alpha;
    expect(alpha('Plain')).toBe(1);
    expect(alpha('Wood')).toBe(1);
    expect([...scene.materials.values()].find(m => m.name === 'Wood')!.texture).not.toBeNull();
    expect(alpha('Glass')).toBeCloseTo(0.5, 9);
  });

  it('keeps texture colorization, its type and its color (PF-168)', () => {
    const b = create(), png = encodePng(2, 2, new Uint8Array(12).fill(160), 3);
    const names = ['Shifted', 'Tinted', 'Plain'];
    const materials = names.map(name => b.addTextureMaterial(name, png, `${name}.png`));
    materials.forEach((material, i) => b.addFace([[i * 20, 0, 0], [i * 20 + 10, 0, 0], [i * 20 + 10, 10, 0], [i * 20, 10, 0]], { material }));
    const bytes = b.toBytes();
    const model = parseSkp(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    const byName = (name: string) => [...model.materialsById.values()].find(m => m.name === name)!;
    Object.assign(byName('Shifted'), { colorized: true, colorizeType: 0, color: { r: 210, g: 180, b: 140, a: 255 } });
    Object.assign(byName('Tinted'), { colorized: true, colorizeType: 1 });
    const scene = prepareSketchUp(model), doc = createDocument();
    const report = doc.transact('Open', draft => applySketchUpImport(draft, scene)).value;
    const material = (name: string) => [...doc.state.materials.values()].find(m => m.name === name)!;
    expect(material('Shifted').texture).toMatchObject({ colorize: true, colorizeType: 'shift' });
    expect(material('Tinted').texture).toMatchObject({ colorize: true, colorizeType: 'tint' });
    expect(material('Plain').texture!.colorize).toBe(false);
    expect(material('Plain').texture!.colorizeType).toBeUndefined();
    expect(material('Shifted').color.map(v => Math.round(v * 255))).toEqual([210, 180, 140]);
    expect(report.warnings.some(w => /coloriz/i.test(w))).toBe(false);
  });

  it.each([2019, 2020])('reads SketchUp %s files whose tags have dashed line styles', async year => {
    const bytes = readFileSync(new URL(`../../testing/assets/sketchup/line-styles-${year}.skp`, import.meta.url));
    const scene = await readSketchUp(bytes), doc = createDocument();
    expect(scene.version).toBe(`{${year - 2000}.0.1}`);
    expect(scene.tags.map(tag => tag.name)).toEqual(['Layer0', 'Dashed', 'Dotted', 'Plain']);
    const report = doc.transact('Open fixture', draft => applySketchUpImport(draft, scene)).value;
    expect(report).toMatchObject({ bodies: 1, sheetFaces: 1, looseEdges: 1, definitions: 2, instances: 3, tags: 3 });
    const bodies = [...doc.state.definitions.values()].flatMap(d => [...d.entities.bodies.values()]);
    expect(bodies[0]!.props.volume).toBeCloseTo(1, 6);
    const sheet = [...scene.definitions.values()].find(d => d.name === 'Sheet')!;
    expect(polygonArea([sheet.sheets[0]!.loops[0]!.map(p => [p[0], p[1]])])).toBeCloseTo(2, 6);
    expect(scene.root.instances.filter(i => i.definition === sheet.key)).toHaveLength(2);
  });

  it.each([2027, 2020, 2017])('keeps the tags of faces, edges, groups and components and the tag folders of a %i file', async year => {
    const bytes = readFileSync(new URL(`../../testing/assets/sketchup/entity-tags-${year}.skp`, import.meta.url));
    const scene = await readSketchUp(bytes), doc = createDocument();
    doc.transact('Open fixture', draft => applySketchUpImport(draft, scene));
    const state = doc.state, tag = (name: string) => [...state.tags.values()].find(t => t.name === name)!;
    const walls = tag('Walls'), trim = tag('Trim'), old = tag('Old'), untagged = state.defaultTagId;
    expect([walls.visible, trim.visible, old.visible]).toEqual([false, true, true]);
    // Only the 2021+ format has tag folders: there Old sits in the hidden folder Archive.
    const folders = [...state.tagFolders.values()];
    if (year >= 2021) {
      expect(folders).toEqual([expect.objectContaining({ name: 'Archive', visible: false, parentId: null })]);
      expect(old.folderId).toBe(folders[0]!.id);
    } else expect(folders).toEqual([]);
    const root = doc.rootDefinition.entities;
    expect([...root.sketch.faces.values()].map(f => f.tagId)).toEqual([walls.id]);
    const edgeTags = [...root.sketch.edges.values()].map(e => e.tagId);
    expect(edgeTags.filter(t => t === trim.id)).toHaveLength(1);
    expect(edgeTags.filter(t => t === old.id)).toHaveLength(1);
    expect(edgeTags.filter(t => t === untagged)).toHaveLength(4);
    const instances = [...root.instances.values()].map(i => [state.definitions.get(i.definitionId)!.name, i.tagId]);
    expect(instances.sort()).toEqual([['Group0', trim.id], ['Post', walls.id]].sort());
    const box = [...state.definitions.values()].find(d => d.name === 'Group0')!;
    const body = [...box.entities.bodies.values()][0]!;
    const faces = [...body.faces.values()];
    expect(faces.filter(f => f.tagId === walls.id).map(f => f.plane.n[2])).toEqual([1]);
    expect(faces.filter(f => f.tagId === untagged)).toHaveLength(5);
    const tagged = [...body.edges.values()].filter(e => e.tagId === trim.id);
    expect(tagged).toHaveLength(1);
    expect(tagged[0]!.polyline.every(p => Math.abs(p[0] - 3) < 1e-9 && Math.abs(p[1]) < 1e-9)).toBe(true);
    expect([...body.edges.values()].filter(e => e.tagId === untagged)).toHaveLength(11);
  });

  it('keeps the tag of a face in an older file, whatever its edges are on', async () => {
    const b = create();
    const walls = b.addLayer('Walls', { hidden: true });
    b.addFace([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], { layer: walls });
    b.addFace([[3, 0, 0], [4, 0, 0], [4, 1, 0], [3, 1, 0]]);
    const scene = await readSketchUp(b.toBytes()), doc = createDocument();
    expect(scene.root.sheets.map(f => f.tag ?? '').sort()).toEqual(['', 'Walls']);
    doc.transact('Open', draft => applySketchUpImport(draft, scene));
    const tag = [...doc.state.tags.values()].find(t => t.name === 'Walls')!;
    expect(tag.visible).toBe(false);
    const sketch = doc.rootDefinition.entities.sketch;
    const onWalls = [...sketch.faces.values()].filter(f => f.tagId === tag.id);
    expect(onWalls).toHaveLength(1);
    expect(sketch.faces.size).toBe(2);
    expect([...sketch.edges.values()].every(e => e.tagId === doc.state.defaultTagId)).toBe(true);
  });

  it('reads pre-2021 tags whose color material carries attribute dictionaries', async () => {
    // A tag record is its preamble, name, hidden flag and its color as an inline material body. SketchUp writes
    // `Tagged`'s own Extension dictionary in the first preamble; move it into the material's preamble, where an
    // extension (V-Ray) left one in a real 2017 model. The store-map numbering is unchanged.
    const bytes = readFileSync(new URL('../../testing/assets/sketchup/tag-attributes-2017.skp', import.meta.url));
    const find = (needle: number[]) => Buffer.from(bytes).indexOf(Buffer.from(needle));
    const utf16 = (s: string) => [0xff, 0xfe, 0xff, s.length, ...[...Buffer.from(s, 'utf16le')]];
    const name = find(utf16('Tagged')), nameEnd = name + utf16('Tagged').length;
    const start = find(utf16('Extension')) - 14, end = name - 4;
    expect([...bytes.subarray(start, start + 2), bytes[end], bytes[nameEnd], bytes[nameEnd + 1], bytes[nameEnd + 2]])
      .toEqual([0x05, 0x80, 0x07, 1, 0, 0]);
    const moved = new Uint8Array(bytes.length);
    moved.set(bytes.subarray(0, start));
    moved.set(bytes.subarray(end, nameEnd + 1), start + 2);
    moved.set(bytes.subarray(start, end), start + 2 + nameEnd + 1 - end);
    moved.set(bytes.subarray(nameEnd + 3), nameEnd + 3);
    for (const file of [bytes, moved]) {
      const scene = await readSketchUp(file);
      expect(scene.tags.map(tag => [tag.name, tag.visible])).toEqual([['Layer0', true], ['Tagged', false], ['Plain', true]]);
      scene.tags[2]!.color.forEach((v, i) => expect(v).toBeCloseTo([200, 100, 50][i]! / 255, 9));
      const report = createDocument().transact('Open fixture', draft => applySketchUpImport(draft, scene)).value;
      expect(report).toMatchObject({ bodies: 1, looseEdges: 1, tags: 2 });
    }
  });

  it('reads pre-2021 definitions whose thumbnail is a JPEG followed by its quality', async () => {
    // A definition ends with its thumbnail: a camera and an image (CDib: image type, length, image). SketchUp writes a
    // JPEG's 32-bit quality after the image; SketchUp 7 stores definition thumbnails as JPEGs, and reading the quality
    // as the next record lost the rest of the model. OpenSKP writes thumbnails without an image, so give the last
    // definition one as SketchUp 7 writes it. That definition places an instance, so the root's instances refer only
    // to classes and objects written before the inserted records and the store-map numbering they use is unchanged.
    const b = create();
    const leaf = b.addComponentDefinition('Leaf', d => d.addFace(cube[0]!));
    const holder = b.addComponentDefinition('Holder', d => d.addInstance(leaf, { translation: [0, 0, 0] }));
    const placements = 80;
    for (let i = 0; i < placements; i++) b.addInstance(holder, { translation: [2 * i, 0, 0] });
    const bytes = b.toBytes();
    // The last definition's thumbnail ends with a null image reference, just before the root's entity count.
    const utf16 = (s: string) => [0xff, 0xfe, 0xff, s.length, ...Buffer.from(s, 'utf16le')];
    const name = Buffer.from(bytes).indexOf(Buffer.from(utf16('Holder')));
    const at = Buffer.from(bytes).indexOf(Buffer.from([0, 0, placements, 0, 0, 0]), name);
    expect(name).toBeGreaterThan(0);
    expect(at).toBeGreaterThan(name);
    const jpeg = [0xff, 0xd8, 0xff, 0xd9];
    const u32 = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24];
    const dib = [0xff, 0xff, 3, 0, 4, 0, ...Buffer.from('CDib', 'latin1'), ...u32(1), ...u32(jpeg.length), ...jpeg, ...u32(70)];
    const file = new Uint8Array(bytes.length - 2 + dib.length);
    file.set(bytes.subarray(0, at));
    file.set(dib, at);
    file.set(bytes.subarray(at + 2), at + dib.length);
    const scene = await readSketchUp(file);
    expect(scene.root.instances).toHaveLength(placements);
    const report = createDocument().transact('Open fixture', draft => applySketchUpImport(draft, scene)).value;
    expect(report).toMatchObject({ definitions: 2, instances: placements + 1, sheetFaces: 1 });
  });

  it('opens saved scenes with their cameras and hidden tags; Import leaves scenes out', async () => {
    const bytes = readFileSync(new URL('../../testing/assets/sketchup/scenes-2027.skp', import.meta.url));
    const scene = await readSketchUp(bytes), doc = createDocument();
    const report = doc.transact('Open fixture', draft => applySketchUpImport(draft, scene)).value;
    expect(report.scenes).toBe(2);
    const [perspective, top] = doc.state.sceneOrder.map(id => doc.state.scenes.get(id)!);
    expect(perspective!.name).toBe('Perspective');
    expect(perspective!.camera.perspective).toBe(true);
    expect(perspective!.camera.fov).toBeCloseTo(40, 9);
    perspective!.camera.eye.forEach((v, i) => expect(v).toBeCloseTo([4, -3, 2][i]!, 9));
    perspective!.camera.target.forEach(v => expect(v).toBeCloseTo(0.5, 9));
    // `Notes ` keeps its trailing space as a tag but not in the scene's list; both tags are hidden.
    const tagNames = perspective!.hiddenTags.map(id => doc.state.tags.get(id)!.name).sort();
    expect(tagNames).toEqual(['Notes ', 'Walls']);
    // The fixture's scenes saved the model's own style, so they use it.
    expect(perspective!.flags).toMatchObject({ useCamera: true, useTags: true, useStyle: true, useHiddenObjects: false });
    expect(perspective!.styleId).toBe(doc.state.activeStyleId);
    expect(top!.name).toBe('Top');
    expect(top!.camera).toMatchObject({ perspective: false });
    expect(top!.camera.height).toBeCloseTo(3, 9);
    top!.camera.up.forEach((v, i) => expect(v).toBeCloseTo([0, 1, 0][i]!, 9));
    expect(top!.hiddenTags).toEqual([]);
    const into = createDocument();
    expect(into.transact('Import fixture', draft => applySketchUpImport(draft, scene, { groupName: 'Scenes' })).value.scenes).toBe(0);
    expect(into.state.sceneOrder).toEqual([]);
  });

  it('opens with the source model\'s display units; Import keeps the destination\'s', async () => {
    const bytes = readFileSync(new URL('../../testing/assets/sketchup/units-decimal-2027.skp', import.meta.url));
    const scene = await readSketchUp(bytes), doc = createDocument();
    expect(scene.version).toBe('{27.0.264}');
    doc.transact('Open fixture', draft => applySketchUpImport(draft, scene));
    expect(doc.state.meta.units).toEqual({
      format: 'decimal', lengthUnit: 'mm', lengthPrecision: 1, areaUnit: 'm²', areaPrecision: 3,
      volumeUnit: 'l', volumePrecision: 1, lengthSnap: expect.closeTo(0.001, 12) as number, angleSnap: 5,
      anglePrecision: 2, displayUnitSuffix: false, forceZeroInches: false,
    });
    expect(formatLength(1, doc.state.meta.units)).toBe('1000.0');
    // Units survive native save and reopen.
    expect(decodeModelDocument(encodeModelDocument(doc)).meta.units).toEqual(doc.state.meta.units);
    const into = createDocument();
    into.transact('Import fixture', draft => applySketchUpImport(draft, scene, { groupName: 'Units' }));
    expect(into.state.meta.units).toEqual(DEFAULT_UNITS);
  });

  // section-display-*.skp were built in SketchUp 2027 (see the fixtures README); the expected settings are what it reads back.
  const activeStyle = (doc: ReturnType<typeof createDocument>) => doc.state.styles.get(doc.state.activeStyleId)!;
  it.each([[2017, { planes: true, cuts: false }], [2027, { planes: false, cuts: true }]] as const)(
    'opens with the file\'s Display Section Planes and Display Section Cuts; Import keeps the destination\'s (SketchUp %s)',
    async (year, display) => {
      const scene = await readSketchUp(readFileSync(new URL(`../../testing/assets/sketchup/section-display-${year}.skp`, import.meta.url)));
      expect(scene.sectionDisplay).toEqual(display);
      const doc = createDocument();
      expect(doc.transact('Open fixture', draft => applySketchUpImport(draft, scene)).value.sectionPlanes).toBe(1);
      expect(activeStyle(doc).modeling).toMatchObject({ sectionPlanesVisible: display.planes, sectionCutsVisible: display.cuts });
      // The settings survive native save and reopen.
      const reopened = decodeModelDocument(encodeModelDocument(doc));
      expect(reopened.styles.get(reopened.activeStyleId)!.modeling).toMatchObject({ sectionPlanesVisible: display.planes, sectionCutsVisible: display.cuts });
      const into = createDocument(), before = structuredClone(activeStyle(into).modeling);
      into.transact('Import fixture', draft => applySketchUpImport(draft, scene, { groupName: 'Sections' }));
      expect(activeStyle(into).modeling).toEqual(before);
    });

  it('opens a file that records no section display with its section planes hidden and its cuts showing', async () => {
    const scene = await readSketchUp(readFileSync(new URL('../../testing/assets/sketchup/section-display-2027.skp', import.meta.url)));
    const doc = createDocument();
    doc.transact('Open fixture', draft => applySketchUpImport(draft, { ...scene, sectionDisplay: null }));
    expect(activeStyle(doc).modeling).toMatchObject({ sectionPlanesVisible: false, sectionCutsVisible: true });
  });

  it('reads no section display from a 2021+ file whose rendering options lack it', () => {
    // Rename the 0x7375 record inside the 0x733c rendering options record.
    const bytes = readFileSync(new URL('../../testing/assets/sketchup/section-display-2027.skp', import.meta.url));
    const zipAt = bytes.indexOf(Buffer.from([0x50, 0x4b, 3, 4]));
    const files = unzipSync(bytes.subarray(zipAt));
    const name = Object.keys(files).find(n => n.toLowerCase().endsWith('model.dat'))!;
    const dat = files[name]!.slice();
    const at = Buffer.from(dat).indexOf(Buffer.from([0x75, 0x73, 4, 0, 0, 0]));
    expect(at).toBeGreaterThan(0);
    dat[at] = 0x76; dat[at + 1] = 0x7f;
    const zip = zipSync({ ...files, [name]: dat });
    const file = new Uint8Array(zipAt + zip.length);
    file.set(bytes.subarray(0, zipAt));
    file.set(zip, zipAt);
    expect(parseSkp(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)).sectionDisplay).toEqual({ planes: false, cuts: true });
    expect(parseSkp(file.buffer).sectionDisplay).toBeNull();
  });

  it('opens the display units of pre-2021 files, with fraction precision as a power of two', async () => {
    const bytes = readFileSync(new URL('../../testing/assets/sketchup/units-architectural-2017.skp', import.meta.url));
    const scene = await readSketchUp(bytes), doc = createDocument();
    expect(scene.version).toBe('{17.0.1}');
    doc.transact('Open fixture', draft => applySketchUpImport(draft, scene));
    expect(doc.state.meta.units).toEqual({ ...DEFAULT_UNITS, format: 'architectural', lengthUnit: 'in', lengthPrecision: 3,
      areaUnit: 'in²', volumeUnit: 'in³', angleSnap: null, anglePrecision: 0, forceZeroInches: true });
    // Precision 3 rounds to 1/8"; forced zero inches keep the inch part of whole feet.
    expect(formatLength(0.0254 * 12.3, doc.state.meta.units)).toBe('1\' 0 1/4"');
    expect(formatLength(0.3048 * 2, doc.state.meta.units)).toBe('2\' 0"');
  });

  it('reads a 2021+ file whose model.dat ends inside a units record, without the units', () => {
    // Cut model.dat right after the first UnitsOptions key's value-wrapper header, with an empty wrapper.
    const bytes = readFileSync(new URL('../../testing/assets/sketchup/units-decimal-2027.skp', import.meta.url));
    const zipAt = bytes.indexOf(Buffer.from([0x50, 0x4b, 3, 4]));
    const files = unzipSync(bytes.subarray(zipAt));
    const name = Object.keys(files).find(n => n.toLowerCase().endsWith('model.dat'))!;
    const dat = files[name]!, tag = Buffer.from('UnitsOptions');
    const key = Buffer.from(dat).indexOf(tag) + tag.length + 6;
    expect([dat[key], dat[key + 1]]).toEqual([0xad, 0x61]);
    const wrapper = key + 6 + new DataView(dat.buffer, dat.byteOffset).getUint32(key + 2, true);
    const cut = dat.slice(0, wrapper + 6);
    new DataView(cut.buffer).setUint32(wrapper + 2, 0, true);
    const zip = zipSync({ ...files, [name]: cut });
    const file = new Uint8Array(zipAt + zip.length);
    file.set(bytes.subarray(0, zipAt));
    file.set(zip, zipAt);
    expect(parseSkp(file.buffer).unitsOptions).toBeNull();
  });

  it('maps SketchUp unit codes and keeps defaults for missing or unknown values', () => {
    expect(sketchUpUnits(null)).toBeNull();
    expect(sketchUpUnits({ LengthFormat: 0 })).toBeNull();
    expect(sketchUpUnits({ LengthUnit: 9, LengthFormat: 0 })).toBeNull();
    expect(sketchUpUnits({ LengthUnit: 1, LengthFormat: 2, LengthPrecision: 3 }))
      .toEqual({ ...DEFAULT_UNITS, format: 'engineering', lengthUnit: 'ft', lengthPrecision: 3 });
    expect(sketchUpUnits({ LengthUnit: 0, LengthFormat: 3, LengthPrecision: 6 }))
      .toMatchObject({ format: 'fractional', lengthUnit: 'in', lengthPrecision: 6 });
    expect(sketchUpUnits({ LengthUnit: 5, LengthFormat: 0, LengthPrecision: 9, AreaUnit: 5, VolumeUnit: 5 }))
      .toMatchObject({ lengthUnit: 'yd', lengthPrecision: 6, areaUnit: 'yd²', volumeUnit: 'yd³' });
    // US gallons (7) have no PushForm equivalent. SketchUp reads a zero snap length as 1/16".
    expect(sketchUpUnits({ LengthUnit: 4, LengthFormat: 0, AreaUnit: 4, VolumeUnit: 7, LengthSnapEnabled: true, LengthSnapLength: 0,
      AngleSnapEnabled: true, SnapAngle: 7.5, SuppressUnitsDisplay: false }))
      .toMatchObject({ lengthUnit: 'm', volumeUnit: DEFAULT_UNITS.volumeUnit, lengthSnap: 0.0254 / 16, angleSnap: 7.5, displayUnitSuffix: true });
    // Files saved before SketchUp had area and volume units get the ones matching the length unit, at precision 2.
    expect(sketchUpUnits({ LengthUnit: 2, LengthFormat: 0, LengthPrecision: 0 }))
      .toMatchObject({ areaUnit: 'mm²', volumeUnit: 'mm³', areaPrecision: 2, volumePrecision: 2 });
  });

  const curvesFixture = (year: number): Uint8Array =>
    readFileSync(new URL(`../../testing/assets/sketchup/curves-groups-${year}.skp`, import.meta.url));

  it.each([2027, 2020, 2017])('opens SketchUp %s groups as groups and components as components', async year => {
    const scene = await readSketchUp(curvesFixture(year)), doc = createDocument();
    expect(scene.warnings.some(w => /groups are imported as components/.test(w))).toBe(false);
    doc.transact('Open fixture', draft => applySketchUpImport(draft, scene));
    const defs = new Map([...doc.state.definitions.values()].map(d => [d.name, d]));
    expect(['Group0', 'Group0#1', 'Group1', 'Post'].map(name => defs.get(name)!.isGroup)).toEqual([true, true, true, false]);
    // The nested Ring group is shared by both boxes, as in SketchUp; Post is placed twice.
    const placements = (id: number): number => [...doc.state.definitions.values()]
      .reduce((n, d) => n + [...d.entities.instances.values()].filter(i => i.definitionId === id).length, 0);
    expect(placements(defs.get('Group1')!.id)).toBe(2);
    expect(placements(defs.get('Post')!.id)).toBe(2);
    // Import into another model wraps everything in a new group, which stays a group too.
    const into = createDocument();
    into.transact('Import fixture', draft => applySketchUpImport(draft, scene, { groupName: 'Curves' }));
    expect([...into.state.definitions.values()].filter(d => d.isGroup).map(d => d.name).sort())
      .toEqual(['Curves', 'Group0', 'Group0#1', 'Group1']);
  });

  it.each([2027, 2020, 2017])('keeps SketchUp %s arcs, circles, polygons and polylines as curves', async year => {
    const scene = await readSketchUp(curvesFixture(year)), doc = createDocument();
    doc.transact('Open fixture', draft => applySketchUpImport(draft, scene));
    const sketch = doc.rootDefinition.entities.sketch;
    const curves = [...sketch.curves.values()];
    const byRadius = (r: number) => curves.filter(c => Math.abs(c.radius - r) < 1e-9);
    // A quarter arc r 1 m about (0, 6, 0) m from +X to +Y in 6 segments.
    const quarter = byRadius(1)[0]!;
    expect(quarter).toMatchObject({ kind: 'arc', segments: 6 });
    quarter.center.forEach((v, i) => expect(v).toBeCloseTo([0, 6, 0][i]!, 9));
    expect(quarter.startAngle).toBeCloseTo(0, 9);
    expect(quarter.endAngle).toBeCloseTo(Math.PI / 2, 9);
    // A 5-segment arc r 0.75 m from 30° to 150° in the XZ plane, whose normal is -Y.
    const tilted = byRadius(0.75)[0]!;
    expect(tilted).toMatchObject({ kind: 'arc', segments: 5 });
    tilted.normal.forEach((v, i) => expect(v).toBeCloseTo([0, -1, 0][i]!, 12));
    expect(tilted.startAngle).toBeCloseTo(Math.PI / 6, 9);
    expect(tilted.endAngle).toBeCloseTo(5 * Math.PI / 6, 9);
    // A half circle r 0.5 m bounding a sheet, and a tilted hexagon r 0.5 m.
    expect(byRadius(0.5).map(c => `${c.kind}/${c.segments}`).sort()).toEqual(['arc/8', 'polygon/6']);
    // The welded polyline and the stretched circle (an ellipse) keep their edges together as freehand curves.
    expect(curves.filter(c => c.kind === 'freehand').map(c => c.segments).sort((a, b) => a - b)).toEqual([4, 16]);
    expect(curves).toHaveLength(6);
    // Every edge of a curve carries its id, and arcs re-tessellate onto exactly their own vertices.
    for (const c of curves) {
      const points = c.edgeRefs.flatMap(ref => {
        const e = sketch.edges.get(ref as never)!;
        expect(e.curveId).toBe(c.id);
        return [sketch.vertices.get(e.a)!.p, sketch.vertices.get(e.b)!.p];
      });
      expect(c.edgeRefs).toHaveLength(c.segments);
      if (c.kind !== 'freehand') for (const p of tessellateCurve({ ...c, kind: c.kind })) expect(points.some(q => v3dist(p, q) < 1e-9)).toBe(true);
    }
    // The nested Ring group has a loose 12-segment circle; the Post cylinder keeps its two rims on body edges.
    const defs = new Map([...doc.state.definitions.values()].map(d => [d.name, d]));
    expect([...defs.get('Group1')!.entities.sketch.curves.values()].map(c => `${c.kind}/${c.segments}`)).toEqual(['circle/12']);
    const post = [...defs.get('Post')!.entities.bodies.values()][0]!;
    const rims = [...post.curves.values()];
    expect(rims.map(c => `${c.kind}/${c.segments}`)).toEqual(['circle/24', 'circle/24']);
    expect(rims.map(c => c.center[2]).sort((a, b) => a - b)).toEqual([expect.closeTo(0, 9), expect.closeTo(1, 9)]);
    for (const c of rims) {
      expect(c.radius).toBeCloseTo(0.25, 9);
      expect(c.edgeRefs).toHaveLength(24);
      for (const key of c.edgeRefs) expect(post.edges.get(key as never)!.curveId).toBe(c.id);
    }
    expect(modelJson(decodeModelDocument(encodeModelDocument(doc)))).toBe(modelJson(doc.state));
  });

  it('keeps edited arcs as freehand curves and curves that are not one chain in one place as plain edges', () => {
    type Patched = { curve: number | null };
    type Curves = { curves: { id: number; edges: number; polygon: boolean; arc: { xaxis: number[] } | null }[] };
    const model = parseSkp(new Uint8Array(curvesFixture(2020)).buffer);
    const root = model.root, edges = root.edges as unknown as (Patched & (typeof root.edges)[number])[];
    const vertex = new Map(root.vertices.map(v => [v.id, v]));
    const curveOf = (radius: number): number => (root as unknown as Curves).curves
      .find(c => c.arc && Math.abs(Math.hypot(...c.arc.xaxis) * 0.0254 - radius) < 1e-9)!.id;
    // The quarter arc also claims an edge of the ellipse (the 1 m by 0.5 m stretched circle): its edges no
    // longer form one chain, while the ellipse remains an open freehand chain.
    const quarter = curveOf(1), ellipse = (root as unknown as Curves).curves.find(c => c.edges === 16)!.id;
    edges.find(e => e.curve === ellipse)!.curve = quarter;
    // A vertex of the 30–150° arc slides along its circle: still on the circle, but no longer its tessellation.
    const tilted = curveOf(0.75), members = edges.filter(e => e.curve === tilted);
    const inner = vertex.get(members.map(e => e.v2Id).find(id => members.some(e => e.v1Id === id))!)!;
    const cz = 1 / 0.0254, r = 0.75 / 0.0254, a = Math.atan2(inner.z - cz, inner.x) + 0.05;
    inner.x = r * Math.cos(a); inner.z = cz + r * Math.sin(a);
    // A Post rim edge chained to a new loose edge: one chain, split between the cylinder and loose geometry.
    const post = [...model.definitions.values()].find(d => d.name === 'Post')!;
    const rimEdge = (post.edges as unknown as (Patched & (typeof post.edges)[number])[]).find(e => e.curve !== null)!;
    const rim = rimEdge.curve!;
    for (const e of post.edges as unknown as Patched[]) if (e.curve === rim && e !== rimEdge) e.curve = null;
    post.vertices.push({ id: 9e8, x: 100, y: 100, z: 100 });
    post.edges.push({ ...rimEdge, id: 9e8, v1Id: rimEdge.v2Id, v2Id: 9e8, curve: rim } as (typeof post.edges)[number]);
    const scene = prepareSketchUp(model);
    expect(scene.root.curves.some(c => c.source === quarter)).toBe(false);
    expect(scene.root.edges.every(e => e.curve !== quarter)).toBe(true);
    expect(scene.root.curves.find(c => c.source === tilted)!.kind).toBe('freehand');
    const prepared = [...scene.definitions.values()].find(d => d.name === 'Post')!;
    expect(prepared.curves.map(c => c.source)).not.toContain(rim);
    expect(prepared.solids[0]!.faces.flatMap(f => f.edgeFlags.flat()).every(f => f.curve !== rim)).toBe(true);
    for (const name of ['ROOT_MODEL', 'Post'])
      expect(scene.warnings).toContain(`${name}: 1 curve(s) imported as separate edges: their edges do not form one chain, or are split between a solid and other geometry.`);
    const doc = createDocument();
    doc.transact('Open edited fixture', draft => applySketchUpImport(draft, scene));
    expect([...doc.rootDefinition.entities.sketch.curves.values()].map(c => c.kind).sort()).toEqual(['arc', 'freehand', 'freehand', 'freehand', 'polygon']);
  });

  it('imports curves on solids as plain edges when the body merges a curve edge with a collinear edge', () => {
    // A cube whose top front edge is split at its midpoint into two collinear edges, which the body stores as one.
    const split = (): SkpModel => {
      const b = create();
      for (const points of cube) {
        const front = points.every(p => p[1] === 0), top = points.every(p => p[2] === 1);
        b.addFace(front || top ? points.flatMap((p, i) => {
          const q = points[(i + 1) % points.length]!;
          return p[1] === 0 && q[1] === 0 && p[2] === 1 && q[2] === 1 ? [p, [0.5, 0, 1] as [number, number, number]] : [p];
        }) : points);
      }
      return parseSkp(new Uint8Array(b.toBytes()).buffer);
    };
    type Patched = { id: number; v1Id: number; v2Id: number; curve?: number | null };
    const weld = (model: SkpModel, pick: (at: (id: number) => [number, number, number]) => (e: Patched) => boolean): void => {
      const root = model.root as unknown as { edges: Patched[]; vertices: { id: number; x: number; y: number; z: number }[]; curves: unknown[] };
      const vertex = new Map(root.vertices.map(v => [v.id, [v.x, v.y, v.z] as [number, number, number]]));
      const members = root.edges.filter(pick(id => vertex.get(id)!));
      for (const e of members) e.curve = 77;
      root.curves = [{ id: 77, edges: members.length, polygon: false, arc: null }];
    };
    const ends = (e: Patched, at: (id: number) => [number, number, number]) => [at(e.v1Id), at(e.v2Id)];
    // One welded polyline made of both halves, and one made of the right half and the edge below it.
    const both = split(), half = split();
    const topFront = (p: [number, number, number]): boolean => p[1] === 0 && p[2] === 1;
    weld(both, at => e => ends(e, at).every(topFront));
    weld(half, at => e => { const [p, q] = ends(e, at); return p![1] === 0 && q![1] === 0 && p![0] + q![0] >= 1.5 && p![2] + q![2] >= 1; });
    for (const model of [both, half]) {
      const scene = prepareSketchUp(model);
      expect(scene.root.solids).toHaveLength(1);
      expect(scene.root.curves.map(c => c.home)).toEqual([0]);
      const doc = createDocument();
      const report = doc.transact('Open', draft => applySketchUpImport(draft, scene)).value;
      const body = [...doc.rootDefinition.entities.bodies.values()][0]!;
      expect(body.curves.size).toBe(0);
      expect([...body.edges.values()].every(e => e.curveId === null)).toBe(true);
      expect(report.warnings).toContain('1 curve(s) on solids imported as separate edges: some of their edges do not map onto solid edges of their own, as when one continues straight into another edge.');
    }
  });

  it('imports a sketch curve as plain edges when its edges are missing from the sheets and loose edges', async () => {
    const scene = await readSketchUp(curvesFixture(2027));
    const curve = scene.root.curves.find(c => c.home === 'sketch')!;
    curve.edges.push(9e8);
    const doc = createDocument();
    const report = doc.transact('Open', draft => applySketchUpImport(draft, scene)).value;
    expect([...doc.rootDefinition.entities.sketch.curves.values()]).toHaveLength(5);
    expect(report.warnings).toContain('1 curve(s) imported as separate edges: some of their edges are missing from the imported sheets and loose edges.');
    expect(report.warnings.some(w => w.includes('on solids'))).toBe(false);
  });

  // annotations-*.skp were built in SketchUp 2027 (see the fixtures README); expected values are its own.
  const annotations = (year: number) => readSketchUp(readFileSync(new URL(`../../testing/assets/sketchup/annotations-${year}.skp`, import.meta.url)));
  const close = (actual: readonly number[], expected: readonly number[]) => actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 9));

  it.each([2027, 2020, 2017])('keeps section planes and guides in their own definitions, with tags and the active plane (SketchUp %s)', async year => {
    const scene = await annotations(year), doc = createDocument();
    const report = doc.transact('Open fixture', draft => applySketchUpImport(draft, scene)).value;
    expect(report).toMatchObject({ sectionPlanes: 3, guides: 5, dimensions: 4 });
    const root = doc.rootDefinition.entities;
    const group = [...doc.state.definitions.values()].find(d => d.name === 'Group0')!.entities;
    const notes = [...doc.state.tags.values()].find(t => t.name === 'Notes')!.id;
    // SketchUp 2017 files store no section plane names; SketchUp shows these as Section 1-3.
    const named = (name: string, symbol: string, n: number) => year === 2017 ? { name: `Section ${n}`, symbol: String(n) } : { name, symbol };
    const [cut, plan] = [...root.sectionPlanes.values()];
    expect(cut).toMatchObject({ ...named('Cut A', 'A', 1), hidden: false, tagId: doc.state.defaultTagId });
    close(cut!.plane.n, [1, 0, 0]); expect(cut!.plane.d).toBeCloseTo(-0.5, 9);
    expect(plan).toMatchObject({ ...named('Plan', 'P', 2), hidden: true, tagId: notes });
    close(plan!.plane.n, [0, 0, -1]); expect(plan!.plane.d).toBeCloseTo(0.75, 9);
    expect(root.activeSectionPlaneId).toBe(cut!.id);
    for (const plane of [cut!, plan!]) expect(v3dot(plane.plane.n, plane.origin) + plane.plane.d).toBeCloseTo(0, 9);
    const inner = [...group.sectionPlanes.values()];
    expect(inner).toHaveLength(1);
    expect(inner[0]).toMatchObject(named('Inner', 'I', 3));
    close(inner[0]!.plane.n, [0, 1, 0]); expect(inner[0]!.plane.d).toBeCloseTo(-0.25, 9);
    expect(group.activeSectionPlaneId).toBe(inner[0]!.id);
    const [line, segment, point] = [...root.guides.values()];
    expect(line).toMatchObject({ kind: 'line', hidden: false });
    if (line!.kind === 'line') { close(line!.origin, [0, 2, 0]); close(line!.dir, [1, 0, 0]); }
    expect(segment!.kind).toBe('segment');
    if (segment!.kind === 'segment') { close(segment!.origin, [0, 3, 0]); close(segment!.end, [2, 3, 1]); }
    expect(point).toMatchObject({ kind: 'point', tagId: notes });
    close(point!.origin, [1, 2, 1]);
    // The group's guides stay in group coordinates, not the rotated and moved placement's.
    const [hiddenLine, groupPoint] = [...group.guides.values()];
    expect(hiddenLine).toMatchObject({ kind: 'line', hidden: true });
    if (hiddenLine!.kind === 'line') { close(hiddenLine!.origin, [0, 0, 1]); close(hiddenLine!.dir, [0, 1, 0]); }
    close(groupPoint!.origin, [1, 1, 1]);
    for (const id of [cut!.id, line!.id]) expect(root.order).toContain(id);
    // The fixtures save Display Section Planes off and Display Section Cuts on, and open that way.
    expect(doc.state.styles.get(doc.state.activeStyleId)!.modeling).toMatchObject({ sectionPlanesVisible: false, sectionCutsVisible: true });
  });

  // The older formats store each dimension differently but open the same.
  it.each([2027, 2020, 2017])('keeps linear dimensions, free or attached, in their definitions; Import puts them in the new group (SketchUp %s)', async year => {
    const scene = await annotations(year), doc = createDocument();
    doc.transact('Open fixture', draft => applySketchUpImport(draft, scene));
    const [free, onEdge, alongEdge] = [...doc.rootDefinition.entities.dimensions.values()];
    expect(free).toMatchObject({ kind: 'linear', text: null, hidden: false, fontSizePt: 10 });
    close(free!.start, [0, -0.5, 0]); close(free!.end, [1, -0.5, 0]); close(free!.offset, [0, -0.3, 0]);
    close(onEdge!.start, [2, 0, 0]); close(onEdge!.end, [2, 1, 0]); close(onEdge!.offset, [0.3, 0, 0]);
    // A quarter of the way along the loose edge.
    close(alongEdge!.start, [2, 0.25, 0]); close(alongEdge!.end, [3.5, 0.25, 0]); close(alongEdge!.offset, [0, 0.4, 0]);
    const group = [...doc.state.definitions.values()].find(d => d.name === 'Group0')!.entities;
    const [top] = [...group.dimensions.values()];
    expect(top!.text).toBe('Top edge');
    close(top!.start, [0, 0, 1]); close(top!.end, [1, 0, 1]); close(top!.offset, [0, 0, 0.2]);
    const reopened = decodeModelDocument(encodeModelDocument(doc));
    expect(modelJson(reopened)).toBe(modelJson(doc.state));
    const into = createDocument();
    const imported = into.transact('Import fixture', draft => applySketchUpImport(draft, scene, { groupName: 'Annotations' })).value;
    expect(imported).toMatchObject({ sectionPlanes: 3, guides: 5, dimensions: 4 });
    expect(into.rootDefinition.entities.dimensions.size).toBe(0);
    const wrapper = [...into.state.definitions.values()].find(d => d.name === 'Annotations')!.entities;
    expect(wrapper.dimensions.size).toBe(3);
    expect(wrapper.sectionPlanes.get(wrapper.activeSectionPlaneId!)?.name).toBe(year === 2017 ? 'Section 1' : 'Cut A');
    expect(into.state.styles.get(into.state.activeStyleId)!.modeling.sectionPlanesVisible).toBe(true);
  });

  it('measures axis-aligned dimensions along their axis and reports what it cannot place', () => {
    const model = parseSkp(new Uint8Array(readFileSync(new URL('../../testing/assets/sketchup/annotations-2027.skp', import.meta.url))).buffer);
    type Patched = { a: number[] | null; b: number[] | null; alignment?: number | null; text: string };
    const [free, onEdge] = model.root.dimensions as unknown as Patched[];
    // Measured along the plane's X axis between points also 30" apart across it: the end moves onto the axis.
    free!.b = [39.37007874015748, 10.31496062992126, 0]; free!.alignment = 1; free!.text = 'W = <>';
    onEdge!.a = null;
    model.root.constructionLines[0]!.end = [10, 78.74015748031496, 0];
    const scene = prepareSketchUp(model);
    expect(scene.root.dimensions).toHaveLength(2);
    const projected = scene.root.dimensions[0]!;
    close(projected.end, [1, -0.5, 0]); close(projected.offset, [0, -0.3, 0]);
    expect(projected.text).toBe('W = <>');
    expect(scene.root.guides[0]).toMatchObject({ kind: 'line' });
    expect(scene.warnings).toContain('1 dimension(s) skipped: the reader could not locate their measured points.');
    expect(scene.warnings).toContain('1 guide line(s) bounded on one side only are imported as infinite guide lines.');
  });

  it('reads the plane, measuring axis and offset of pre-2021 linear dimensions', () => {
    const model = parseSkp(new Uint8Array(readFileSync(new URL('../../testing/assets/sketchup/annotations-2017.skp', import.meta.url))).buffer);
    type Patched = { a: number[] | null; b: number[] | null; normal: number[] | null; planeX: number[] | null; alignment?: number | null; offset: number };
    const [free] = model.root.dimensions as unknown as Patched[];
    // SketchUp 2027 saved the free dimension down with a downward normal, measuring along its X axis.
    close(free!.a!, [0, -19.68503937007874, 0]); close(free!.b!, [39.37007874015748, -19.68503937007874, 0]);
    close(free!.normal!, [0, 0, -1]); close(free!.planeX!, [-1, 0, 0]);
    expect(free!.alignment).toBe(1); expect(free!.offset).toBeCloseTo(-11.811023622047244, 9);
    // Measured along normal x X instead (as most SketchUp 2016-2020 dimensions are): the same length runs along Y.
    free!.alignment = 2; free!.b = [0, -59.05511811023622, 0];
    const dim = prepareSketchUp(model).root.dimensions[0]!;
    close(dim.start, [0, -0.5, 0]); close(dim.end, [0, -1.5, 0]); close(dim.offset, [-0.3, 0, 0]);
  });

  it('numbers the unnamed section planes of files older than SketchUp 2018, model first', () => {
    const model = parseSkp(new Uint8Array(readFileSync(new URL('../../testing/assets/sketchup/annotations-2017.skp', import.meta.url))).buffer);
    const scene = prepareSketchUp(model);
    expect(scene.root.sectionPlanes.map(p => [p.name, p.symbol])).toEqual([['Section 1', '1'], ['Section 2', '2']]);
    expect([...scene.definitions.values()][0]!.sectionPlanes.map(p => p.name)).toEqual(['Section 3']);
    model.version = '{18.0.1}';
    expect(prepareSketchUp(model).root.sectionPlanes.map(p => p.name)).toEqual(['', '']);
  });

  it.each([2017, 2020, 2027])('opens the scenes of a SketchUp %s file, including ones that save no camera or tags', async year => {
    const bytes = readFileSync(new URL(`../../testing/assets/sketchup/text-scenes-${year}.skp`, import.meta.url));
    const scene = await readSketchUp(bytes), doc = createDocument();
    const report = doc.transact('Open fixture', draft => applySketchUpImport(draft, scene)).value;
    expect(report.scenes).toBe(4);
    expect(scene.warnings.filter(w => /camera|scene\(s\)/.test(w))).toEqual([]);
    const scenes = doc.state.sceneOrder.map(id => doc.state.scenes.get(id)!);
    expect(scenes.map(s => s.name)).toEqual(['Perspective', 'Plan', 'No camera', 'Keeps tags']);
    const [perspective, plan, noCamera, keepsTags] = scenes;
    const hidden = (s: typeof perspective) => s!.hiddenTags.map(id => doc.state.tags.get(id)!.name);
    const close = (a: readonly number[], b: readonly number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 9));
    expect(perspective!.camera).toMatchObject({ perspective: true, fov: 40 });
    close(perspective!.camera.eye, [6, -5, 4]); close(perspective!.camera.target, [1.5, 1, 0.5]);
    expect(hidden(perspective)).toEqual(['Walls']);
    expect(plan!.camera.perspective).toBe(false);
    expect(plan!.camera.height).toBeCloseTo(6, 9);
    close(plan!.camera.eye, [1.5, 1.5, 20]); close(plan!.camera.up, [0, 1, 0]);
    expect(hidden(plan)).toEqual(['Notes']);
    // SketchUp leaves the view where it is for a scene that saves no camera, and the tags alone for one that saves no tag visibility.
    expect(noCamera!.flags).toMatchObject({ useCamera: false, useTags: true });
    expect(keepsTags!.flags).toMatchObject({ useCamera: true, useTags: false });
    expect(keepsTags!.hiddenTags).toEqual([]);
    close(keepsTags!.camera.eye, [-4, -4, 3]);
    expect(keepsTags!.camera.fov).toBeCloseTo(50, 9);
  });

  it.each([2017, 2020, 2027])('reads the hidden tags of a last scene that saves no axes in a SketchUp %s file', async year => {
    const bytes = readFileSync(new URL(`../../testing/assets/sketchup/last-scene-no-axes-${year}.skp`, import.meta.url));
    const scene = await readSketchUp(bytes), doc = createDocument();
    expect(doc.transact('Open fixture', draft => applySketchUpImport(draft, scene)).value.scenes).toBe(2);
    expect(scene.warnings.filter(w => /scene\(s\)/.test(w))).toEqual([]);
    const scenes = doc.state.sceneOrder.map(id => doc.state.scenes.get(id)!);
    expect(scenes.map(s => [s.name, s.hiddenTags.map(id => doc.state.tags.get(id)!.name), s.flags.useTags]))
      .toEqual([['All saved', ['Notes'], true], ['No axes', ['Walls'], true]]);
    scenes[1]!.camera.eye.forEach((v, i) => expect(v).toBeCloseTo([-3, -4, 2][i]!, 9));
  });

  it('reads scenes by the version map when the scene class record names an older schema, as SketchUp 8 writes them', async () => {
    // SketchUp 8 writes the scene class record with schema 11 (SketchUp 6 and 7's, whose scenes end without the two
    // flag bytes and thumbnail) but writes the schema 12 layout that its version map names. The 2017 fixture's
    // record says 15 and its map 12; give the record SketchUp 8's 11.
    const bytes = new Uint8Array(readFileSync(new URL('../../testing/assets/sketchup/last-scene-no-axes-2017.skp', import.meta.url)));
    const record = Buffer.from(bytes).indexOf(Buffer.from([9, 0, ...Buffer.from('CViewPage', 'latin1')]));
    expect([...bytes.subarray(record - 4, record)]).toEqual([0xff, 0xff, 15, 0]);
    bytes[record - 2] = 11;
    const scene = await readSketchUp(bytes), doc = createDocument();
    expect(doc.transact('Open fixture', draft => applySketchUpImport(draft, scene)).value.scenes).toBe(2);
    expect(scene.warnings.filter(w => /scene\(s\)/.test(w))).toEqual([]);
    expect(doc.state.sceneOrder.map(id => doc.state.scenes.get(id)!.name)).toEqual(['All saved', 'No axes']);
  });

  it.each([2017, 2020, 2027])('imports the text of a SketchUp %s file at its anchors, with leaders, tags and visibility', async year => {
    const bytes = readFileSync(new URL(`../../testing/assets/sketchup/text-scenes-${year}.skp`, import.meta.url));
    const scene = await readSketchUp(bytes), doc = createDocument(), undo = new UndoStack(doc);
    const report = undo.transact('Open fixture', draft => applySketchUpImport(draft, scene));
    expect(report.texts).toBe(9);
    expect(scene.warnings.some(w => w.includes('text(s) skipped'))).toBe(false);
    const texts = new Map([...doc.state.definitions.values()].flatMap(d => [...d.entities.texts.values()].map(t => [t.text, { t, d }] as const)));
    const at = (text: string, position: Vec3, offset: Vec3 | null = [0.3, 0.2, 0.4]) => {
      const { t } = texts.get(text)!;
      expect(t.kind).toBe('leader');
      t.position.forEach((v, i) => expect(v).toBeCloseTo(position[i]!, 9));
      if (offset) t.offset!.forEach((v, i) => expect(v).toBeCloseTo(offset[i]!, 9));
      return t;
    };
    // A free point, a vertex two instances deep, points along an edge, and a point on a face inside a group.
    expect(at('Free point', [2, -1, 0]).leader).toBe('pushpin');
    at('Post corner', [3, 2, 1]);
    at('Edge middle', [1, 3, 0]);
    at('Edge quarter', [0.5, 3, 0]);
    at('On face', [0.3, 0.6, 1]);
    // A view-based leader's file vector is not its world offset, so none is kept.
    const viewBased = at('View based', [0, -1, 0], null);
    expect(viewBased.leader).toBe('view');
    expect(viewBased.offset).toBeNull();
    expect(at('No leader', [0, -2, 0]).leader).toBe('none');
    const note = at('Hidden note', [1, -1, 0]);
    expect(note.hidden).toBe(true);
    expect(doc.state.tags.get(note.tagId)!.name).toBe('Notes');
    expect(at('Free point', [2, -1, 0]).tagId).toBe(doc.state.defaultTagId);
    // Text inside a group stays in its definition, in the definition's coordinates.
    const inGroup = texts.get('In group')!;
    expect(inGroup.d.id).not.toBe(doc.state.rootDefinitionId);
    expect(inGroup.d.entities.order).toContain(inGroup.t.id);
    at('In group', [0.5, 0.5, 0], [0, 0, 0.5]);
    expect(modelJson(decodeModelDocument(encodeModelDocument(doc)))).toBe(modelJson(doc.state));
    undo.undo();
    expect([...doc.state.definitions.values()].every(d => d.entities.texts.size === 0)).toBe(true);
  });

  it('keeps screen text at its view position and reports text it cannot place', () => {
    const model = parseSkp(new Uint8Array(modelFixture()).buffer);
    const text = { text: '', hidden: false, point: null, vector: null, screen: null, leaderType: 2, displayLeader: true, anchorType: 3, layer: '',
      font: null, materialId: null, arrowType: null };
    model.root.texts.push({ ...text, text: 'Title', screen: [0.1, 0.2], leaderType: 0, anchorType: 0 },
      { ...text, text: 'On a guide' }, { ...text, text: 'Broken', point: [Number.NaN, 0, 0] });
    model.scenesUnread = 2;
    const scene = prepareSketchUp(model);
    expect(scene.root.texts).toEqual([{ text: 'Title', kind: 'screen', position: [0.1, 0.2, 0], offset: null, leader: 'none', hidden: false, tag: '' }]);
    expect(scene.warnings.filter(w => w.endsWith(': 2 text(s) skipped: their position could not be recovered.'))).toHaveLength(1);
    expect(scene.warnings).toContain('2 saved scene(s) could not be read and are not imported.');
  });

  it('reads a text\'s font and arrow from the file', () => {
    // The writer stores SketchUp's own text font record: Tahoma, 8 pt, regular, with a closed arrow.
    const b = create();
    b.addText('Label', [1, 2, 3], [4, 0, 0]);
    const [text] = parseSkp(b.toBytes().buffer as ArrayBuffer).root.texts;
    expect(text).toMatchObject({ text: 'Label', font: { name: 'Tahoma', size: 8, bold: false, italic: false }, arrowType: 3 });
  });

  it('imports a text\'s font, its material\'s color, its arrow and a view-based leader\'s offset', () => {
    const model = parseSkp(new Uint8Array(modelFixture()).buffer);
    const red = [...model.materialsById].find(([, m]) => m.name === 'Red')![0];
    const text = { hidden: false, point: [0, 0, 0] as [number, number, number], screen: null, displayLeader: true, anchorType: 1, layer: '' };
    model.root.texts.push(
      { ...text, text: 'Pushpin', vector: [10, 0, 0], leaderType: 2, font: { name: 'Verdana', size: 14, bold: true, italic: false, worldSize: false, height: 0 }, materialId: red, arrowType: 4 },
      // A view-based leader's vector is its offset along the view's right and up directions, shown or hidden.
      { ...text, text: 'View', vector: [-20, 10, 0], leaderType: 1, displayLeader: false, font: null, materialId: null, arrowType: 0 });
    const scene = prepareSketchUp(model);
    const inch = 0.0254;
    expect(scene.root.texts[0]).toMatchObject({ font: { family: 'Verdana', sizePt: 14, bold: true, italic: false }, color: [1, 0, 0], arrow: 'open',
      leader: 'pushpin', offset: [10 * inch, 0, 0] });
    expect(scene.root.texts[1]).toMatchObject({ leader: 'none', offset: null, viewOffset: [-20 * inch, 10 * inch], arrow: 'none' });
    expect(scene.root.texts[1]!.font).toBeUndefined();
    const doc = createDocument();
    doc.transact('Open', draft => applySketchUpImport(draft, scene));
    const [pushpin, view] = [...doc.state.definitions.get(doc.state.rootDefinitionId)!.entities.texts.values()];
    expect(pushpin).toMatchObject({ fontFamily: 'Verdana', fontSizePt: 14, bold: true, color: [1, 0, 0], arrow: 'open' });
    // Without a recorded font or material, text keeps Arial 12 pt black.
    expect(view).toMatchObject({ fontFamily: 'Arial', fontSizePt: 12, color: [0, 0, 0], viewOffset: [-20 * inch, 10 * inch], arrow: 'none' });
    expect(view!.bold).toBeUndefined();
  });

  it('keeps text and instances on a tag whose name ends in a space', () => {
    // The reader keeps `Notes ` in its tag list but reports the tag of text and instances trimmed.
    const model = parseSkp(new Uint8Array(modelFixture()).buffer);
    model.layers.find(l => l.name === 'Furniture')!.name = 'Notes ';
    for (const inst of model.root.instances) inst.layer = 'Notes';
    model.root.texts.push({ text: 'Note', hidden: false, point: [0, 0, 0], vector: [1, 0, 0], screen: null,
      leaderType: 2, displayLeader: true, anchorType: 3, layer: 'Notes', font: null, materialId: null, arrowType: null });
    const scene = prepareSketchUp(model), doc = createDocument();
    doc.transact('Open', draft => applySketchUpImport(draft, scene));
    const root = doc.state.definitions.get(doc.state.rootDefinitionId)!.entities;
    const tagName = (id: typeof doc.state.defaultTagId) => doc.state.tags.get(id)!.name;
    expect([...root.texts.values()].map(t => tagName(t.tagId))).toEqual(['Notes ']);
    expect([...root.instances.values()].map(i => tagName(i.tagId))).toEqual(['Notes ', 'Notes ']);
  });

  it('keeps untagged entities off a hidden tag whose name is only spaces', () => {
    // forum-114034: a hidden tag named " " trimmed to "", the name an untagged entity reports, and hid the whole model.
    const model = parseSkp(new Uint8Array(modelFixture()).buffer);
    model.layers.find(l => l.name === 'Furniture')!.name = ' ';
    model.layers.find(l => l.name === ' ')!.hidden = true;
    for (const inst of model.root.instances) inst.layer = '';
    model.root.texts.push({ text: 'Note', hidden: false, point: [0, 0, 0], vector: [1, 0, 0], screen: null,
      leaderType: 2, displayLeader: true, anchorType: 3, layer: '', font: null, materialId: null, arrowType: null });
    const scene = prepareSketchUp(model), doc = createDocument();
    doc.transact('Open', draft => applySketchUpImport(draft, scene));
    const root = doc.state.definitions.get(doc.state.rootDefinitionId)!.entities;
    const spaces = [...doc.state.tags.values()].find(t => t.name === ' ')!;
    expect(spaces.visible).toBe(false);
    expect([...root.instances.values()].every(i => i.tagId === doc.state.defaultTagId)).toBe(true);
    expect([...root.texts.values()].map(t => t.tagId)).toEqual([doc.state.defaultTagId]);
  });

  it('recognizes model and backup names without confusing LayOut files', () => {
    expect(isSketchUpModelFile('Building.SKP')).toBe(true);
    expect(isSketchUpModelFile('Building.skb')).toBe(true);
    expect(isSketchUpModelFile('Sheet.layout')).toBe(false);
  });

  it('imports shared components, transforms, manifold bodies, sheets with holes, colors and edge flags', async () => {
    const scene = await readSketchUp(modelFixture());
    expect(scene.definitions.size).toBe(1);
    expect(scene.root.instances).toHaveLength(2);
    const def = [...scene.definitions.values()][0]!;
    expect(def.solids).toHaveLength(1);
    expect(meshTopologyProblems(def.solids[0]!.mesh)).toEqual([]);
    expect(scene.root.sheets).toHaveLength(1);
    expect(scene.root.sheets[0]!.loops).toHaveLength(2);
    expect(scene.root.edges).toHaveLength(1);
    const doc = createDocument();
    const report = doc.transact('Import', draft => applySketchUpImport(draft, scene)).value;
    expect(report).toMatchObject({ bodies: 1, sheetFaces: 1, looseEdges: 1, definitions: 1, instances: 2, materials: 2, tags: 1 });
    // The writer stores SketchUp's default template units: architectural inches to 1/16".
    expect(doc.state.meta.units).toMatchObject({ format: 'architectural', lengthUnit: 'in', lengthPrecision: 4 });
    const instances = [...doc.rootDefinition.entities.instances.values()];
    expect(instances[0]!.definitionId).toBe(instances[1]!.definitionId);
    const point = m4transformPoint(instances[0]!.transform as Mat4, [0.0254, 0, 0]);
    expect(point[0]).toBeCloseTo(2.54, 9);
    expect(point[1]).toBeCloseTo(0.5334, 9);
    expect(point[2]).toBeCloseTo(0.762, 9);
    expect(instances[1]!.hidden).toBe(true);
    expect(m4transformPoint(instances[1]!.transform, [1, 1, 1])).toEqual([-2, 3, 1]);
    expect(doc.state.tags.get(instances[0]!.tagId)?.visible).toBe(false);
    const body = doc.state.definitions.get(instances[0]!.definitionId)!.entities.bodies.values().next().value!;
    expect(body.props.volume).toBeCloseTo(0.0254 ** 3, 12);
    expect(body.faces.size).toBe(6);
    expect([...body.edges.values()].every(e => e.soft && e.smooth)).toBe(true);
    expect([...body.surfaces.values()].map(s => s.faceIds.length)).toEqual([6]);
    const face = [...body.faces.values()][0]!;
    expect(doc.state.materials.get(face.frontMaterialId!)?.color).toEqual([1, 0, 0]);
    expect(doc.state.materials.get(face.frontMaterialId!)?.alpha).toBeCloseTo(0.5, 2);
    expect(doc.state.materials.get(face.backMaterialId!)?.color).toEqual([0, 0, 1]);
    expect([...doc.rootDefinition.entities.sketch.edges.values()].some(e => e.hidden)).toBe(true);
    expect(modelJson(decodeModelDocument(encodeModelDocument(doc)))).toBe(modelJson(doc.state));
  });

  it('imports into an isolated group in one undo step with fresh ids; redo and repeated import stay independent', async () => {
    const scene = await readSketchUp(modelFixture()), doc = createDocument(), undo = new UndoStack(doc);
    const baseline = doc.state, firstId = baseline.meta.nextId;
    undo.transact('Import model', draft => applySketchUpImport(draft, scene, { groupName: 'Furniture' }));
    const after = doc.state, root = doc.rootDefinition.entities;
    expect(root.instances.size).toBe(1);
    expect(undo.length).toBe(1);
    expect([...doc.state.definitions.keys()].filter(id => id >= firstId)).toHaveLength(2);
    expect(undo.undo()).toBe(true);
    expect(doc.rootDefinition.entities).toEqual(baseline.definitions.get(baseline.rootDefinitionId)!.entities);
    expect(doc.state.materials).toEqual(baseline.materials);
    expect(doc.state.definitions).toEqual(baseline.definitions);
    expect(undo.redo()).toBe(true);
    expect(doc.state.definitions).toEqual(after.definitions);
    undo.transact('Import again', draft => applySketchUpImport(draft, scene, { groupName: 'Furniture' }));
    expect(doc.state.definitions.size).toBe(5);
    expect(new Set([...doc.state.definitions.values()].map(d => d.guid)).size).toBe(5);
  });

  it('keeps disconnected solids separate from open sheets within the same definition', async () => {
    const b = create();
    for (const offset of [0, 10]) for (const loop of cube) b.addFace(loop.map(p => [p[0] + offset, p[1], p[2]]));
    b.addFace([[20, 0, 0], [21, 0, 0], [21, 1, 0], [20, 1, 0]]);
    const scene = await readSketchUp(b.toBytes());
    expect(scene.root.solids).toHaveLength(2);
    expect(scene.root.sheets).toHaveLength(1);
    expect(scene.warnings.some(w => w.includes('editable sheets'))).toBe(true);
  });

  it('reverses an inside-out closed shell into a solid, swapping its sides and keeping its edge flags', async () => {
    const build = (inward: boolean): Uint8Array => {
      const b = create(), red = b.addMaterial('Red', [255, 0, 0]), blue = b.addMaterial('Blue', [0, 0, 255]);
      cube.forEach((loop, i) => b.addFace(inward ? [...loop].reverse() : loop,
        { material: red, backMaterial: blue, softEdges: i === 5, hiddenEdges: i === 0 }));
      return b.toBytes();
    };
    const outward = await readSketchUp(build(false)), inwardBytes = build(true), inward = await readSketchUp(inwardBytes);
    const source = parseSkp(new Uint8Array(inwardBytes).buffer).root;
    const vertex = new Map(source.vertices.map(v => [v.id, [v.x * 0.0254, v.y * 0.0254, v.z * 0.0254] as Vec3]));
    expect(inward.root.sheets).toHaveLength(0);
    expect(inward.root.solids).toHaveLength(1);
    expect(inward.warnings).toContain('1 inside-out solid(s) reversed: closed shells whose faces all faced inward are imported as solids facing outward.');
    expect(outward.warnings.some(w => w.includes('reversed'))).toBe(false);
    const solid = inward.root.solids[0]!;
    expect(meshTopologyProblems(solid.mesh)).toEqual([]);
    // Each face now faces outward, as the outward cube's does, with SketchUp's back material in front.
    const key = (a: Vec3, b: Vec3): string => [a.join(','), b.join(',')].sort().join('|');
    const segments = (face: (typeof solid.faces)[number]) => new Map(face.loops.flatMap((loop, k) =>
      loop.map((p, i) => [key(p, loop[(i + 1) % loop.length]!), face.edgeFlags[k]![i]!] as const)));
    for (const face of solid.faces) {
      const twin = outward.root.solids[0]!.faces.find(f => f.loops[0]!.every(p => face.loops[0]!.some(q => v3dist(p, q) === 0)))!;
      expect(v3dot(face.normal, twin.normal)).toBeCloseTo(1, 12);
      expect([face.front, face.back]).toEqual([twin.back, twin.front]);
      // Every boundary segment keeps its own source edge and flags.
      const mine = segments(face), theirs = segments(twin);
      expect(mine.size).toBe(4);
      for (const [segment, { edge, ...flags }] of mine) {
        const e = source.edges.find(s => s.id === edge)!;
        expect(key(vertex.get(e.v1Id)!, vertex.get(e.v2Id)!)).toBe(segment);
        expect({ ...theirs.get(segment), edge }).toEqual({ ...flags, edge });
      }
    }
    const open = (scene: typeof inward) => {
      const doc = createDocument();
      const report = doc.transact('Import', draft => applySketchUpImport(draft, scene)).value;
      expect(report).toMatchObject({ bodies: 1, sheetFaces: 0 });
      return { doc, body: doc.rootDefinition.entities.bodies.values().next().value! };
    };
    const { doc, body } = open(inward), twin = open(outward).body;
    expect(body.props.volume).toBeCloseTo(0.0254 ** 3, 12);
    const flagged = (b: typeof body) => [...b.edges.values()].map(e => `${e.soft}${e.hidden}`).sort();
    expect(flagged(body)).toEqual(flagged(twin));
    expect([...body.edges.values()].filter(e => e.hidden).length).toBeGreaterThan(0);
    expect(doc.state.materials.get([...body.faces.values()][0]!.frontMaterialId!)?.name).toBe('Blue');
  });

  it('retains sub-merge-tolerance sheet edges without collapsing or rejecting the whole import', async () => {
    const b = create();
    b.addFace([[0, 0, 0], [0.0004, 0, 0], [0.0004, 1, 0], [0, 1, 0]]);
    const scene = await readSketchUp(b.toBytes()), doc = createDocument();
    const report = doc.transact('Import thin sheet', draft => applySketchUpImport(draft, scene)).value;
    expect(report).toMatchObject({ bodies: 0, sheetFaces: 1 });
    const sketch = doc.rootDefinition.entities.sketch;
    expect(sketch.vertices.size).toBe(4);
    expect(sketch.edges.size).toBe(4);
    expect([...sketch.edges.values()].every(e => e.a !== e.b)).toBe(true);
  });

  it('retains nested shared definitions with local transforms instead of baking placements', async () => {
    const b = create();
    const box = b.addComponentDefinition('Box', d => { for (const loop of cube) d.addFace(loop); });
    const assembly = b.addComponentDefinition('Assembly', d => {
      d.addInstance(box, { translation: [10, 0, 0] });
      d.addInstance(box, { translation: [20, 0, 0] });
    });
    b.addInstance(assembly, { translation: [0, 100, 0] });
    const scene = await readSketchUp(b.toBytes()), doc = createDocument();
    const report = doc.transact('Import nested', draft => applySketchUpImport(draft, scene)).value;
    expect(report).toMatchObject({ bodies: 1, definitions: 2, instances: 3 });
    const outer = [...doc.rootDefinition.entities.instances.values()][0]!;
    const inner = [...doc.state.definitions.get(outer.definitionId)!.entities.instances.values()];
    expect(inner).toHaveLength(2);
    expect(inner[0]!.definitionId).toBe(inner[1]!.definitionId);
    expect(m4transformPoint(outer.transform, m4transformPoint(inner[0]!.transform, [0, 0, 0]))).toEqual([0.254, 2.54, 0]);
  });

  it('rejects corrupt headers and empty geometry without changing the destination', async () => {
    await expect(readSketchUp(new Uint8Array([1, 2, 3]))).rejects.toThrow('invalid file header');
    const empty = parseSkp(new Uint8Array(modelFixture()).buffer);
    empty.root.faces = []; empty.root.edges = []; empty.root.instances = [];
    expect(() => prepareSketchUp(empty)).toThrow('No supported geometry');
    // Section planes, guides and dimensions alone are content: such a file opens, and only they import.
    const annotated = parseSkp(new Uint8Array(readFileSync(new URL('../../testing/assets/sketchup/annotations-2027.skp', import.meta.url))).buffer);
    for (const def of [annotated.root, ...annotated.definitions.values()]) { def.faces = []; def.edges = []; }
    annotated.root.instances = [];
    const only = prepareSketchUp(annotated);
    expect([only.root.solids.length, only.root.sheets.length, only.root.edges.length, only.definitions.size]).toEqual([0, 0, 0, 0]);
    expect(only.root.guides.length).toBeGreaterThan(0);
    for (const kind of ['sectionPlanes', 'dimensions', 'constructionLines', 'constructionPoints'] as const) {
      expect(() => prepareSketchUp(annotated)).not.toThrow();
      annotated.root[kind] = [] as never;
    }
    expect(() => prepareSketchUp(annotated)).toThrow('No supported geometry');
    expect(() => sketchUpTransform([1, 2])).toThrow('Unsupported instance transform');
    expect(() => sketchUpTransform(new Array(12).fill(0))).toThrow('Singular');
  });

  it('keeps curved outlines whose triangulation has zero-area slivers', async () => {
    const b = create();
    // A finely divided curve leaves runs of collinear points, whose ears are zero-area triangles.
    const edge = Array.from({ length: 41 },(_, i) => [i / 4, 0, 0] as [number, number, number]);
    b.addFace([[10, 5, 0], [0, 5, 0], ...edge]);
    const scene = await readSketchUp(b.toBytes());
    expect(scene.root.sheets).toHaveLength(1);
    expect(polygonArea([scene.root.sheets[0]!.loops[0]!.map(p => [p[0], p[1]])])).toBeCloseTo(50 * 0.0254 ** 2, 12);
    expect(scene.warnings.some(w => w.includes('skipped'))).toBe(false);
  });

  it('makes a solid of a wall whose window holes line up, without T-junctions in its triangles (PF-267)', async () => {
    const b = create();
    // Two windows whose sills and heads lie on one line: triangulating the wall faces can run a triangle side
    // through the corners of both holes, which then meets no other triangle side unless it is cut there.
    const windows = [[1, 3], [5, 8]] as const;
    b.addFace([[0, 0, 0], [10, 0, 0], [10, 0, 5], [0, 0, 5]], { holes: windows.map(([a, c]) => [[a, 0, 2], [a, 0, 4], [c, 0, 4], [c, 0, 2]]) });
    b.addFace([[0, 1, 0], [0, 1, 5], [10, 1, 5], [10, 1, 0]], { holes: windows.map(([a, c]) => [[a, 1, 2], [c, 1, 2], [c, 1, 4], [a, 1, 4]]) });
    b.addFace([[0, 0, 0], [0, 1, 0], [10, 1, 0], [10, 0, 0]]);
    b.addFace([[0, 0, 5], [10, 0, 5], [10, 1, 5], [0, 1, 5]]);
    b.addFace([[0, 1, 0], [0, 0, 0], [0, 0, 5], [0, 1, 5]]);
    b.addFace([[10, 0, 0], [10, 1, 0], [10, 1, 5], [10, 0, 5]]);
    for (const [a, c] of windows) {
      b.addFace([[a, 0, 2], [c, 0, 2], [c, 1, 2], [a, 1, 2]]);
      b.addFace([[a, 0, 4], [a, 1, 4], [c, 1, 4], [c, 0, 4]]);
      b.addFace([[a, 0, 2], [a, 1, 2], [a, 1, 4], [a, 0, 4]]);
      b.addFace([[c, 1, 2], [c, 0, 2], [c, 0, 4], [c, 1, 4]]);
    }
    const scene = await readSketchUp(b.toBytes());
    expect(scene.root.sheets).toHaveLength(0);
    expect(scene.root.solids).toHaveLength(1);
    const mesh = scene.root.solids[0]!.mesh;
    expect(meshTopologyProblems(mesh)).toEqual([]);
    expect(meshSignedVolume(mesh)).toBeCloseTo((50 - 4 - 6) * 0.0254 ** 3, 12);
  });

  const IN2 = 0.0254 ** 2;
  const inches = (p: Vec3): number[] => p.map(c => +(c / 0.0254).toFixed(9));
  const signedXY = (ring: Vec3[]): number => ring.reduce((sum, a, i) => { const c = ring[(i + 1) % ring.length]!; return sum + a[0] * c[1] - a[1] * c[0]; }, 0) / 2;

  it('imports a bowtie as the sheet SketchUp shades, without the outline around its unshaded lobe', async () => {
    const b = create();
    // Its sides A→B and C→D cross at X (22, 4/3): the loop winds clockwise around X B C (8 in²) and
    // counterclockwise around D A X (2 in²). SketchUp shades the lobe the outline winds around in its
    // overall direction (shoelace area −6 in²), and so does the import.
    b.addFace([[20, 0, 0], [26, 4, 0], [26, 0, 0], [20, 2, 0]]);
    const scene = await readSketchUp(b.toBytes());
    expect(scene.root.solids).toHaveLength(0);
    expect(scene.root.sheets).toHaveLength(1);
    const piece = scene.root.sheets[0]!;
    expect(piece.loops).toHaveLength(1);
    expect(piece.loops[0]!.map(inches).sort()).toEqual([[22, 4 / 3, 0], [26, 0, 0], [26, 4, 0]].map(p => p.map(c => +c.toFixed(9))).sort());
    // Counterclockwise about its normal, like every sheet's outer loop.
    expect(signedXY(piece.loops[0]!) * piece.normal[2]).toBeCloseTo(8 * IN2, 12);
    expect(new Set(piece.edgeFlags[0]!.map(f => f.edge)).size).toBe(3);
    // D→A, A→X and X→D bound no shaded area: SketchUp counts them as the face's edges, not loose ones,
    // and a sketch edge bounding no face would be loose, so they are not imported.
    expect(scene.root.edges).toHaveLength(0);
    expect(scene.warnings.some(w => w.includes('skipped'))).toBe(false);
    expect(scene.warnings).toContain('1 face whose outline crosses or touches itself is imported as 1 simple sheet face covering the region SketchUp shades, cut where its outline crosses.');
    expect(scene.warnings).toContain('3 outline segments of these faces bound no shaded area and no other face, and are not imported: SketchUp keeps them as edges of the face, not as loose edges.');
    const doc = createDocument();
    const report = doc.transact('Import bowtie', draft => applySketchUpImport(draft, scene)).value;
    expect(report).toMatchObject({ bodies: 0, sheetFaces: 1, looseEdges: 0 });
    expect(doc.rootDefinition.entities.sketch.vertices.size).toBe(3);
    expect(doc.rootDefinition.entities.sketch.edges.size).toBe(3);
  });

  it('keeps the imported edges of a curve running around the unshaded lobe of a bowtie, as a freehand curve', () => {
    const b = create();
    b.addFace([[20, 0, 0], [26, 4, 0], [26, 0, 0], [20, 2, 0]]);
    const model = parseSkp(new Uint8Array(b.toBytes()).buffer);
    const byPoints = (p: number[], q: number[]): number => {
      const v = (c: number[]): number => model.root.vertices.find(x => x.x === c[0] && x.y === c[1] && x.z === c[2])!.id;
      const a = v(p), c = v(q);
      return model.root.edges.find(e => (e.v1Id === a && e.v2Id === c) || (e.v1Id === c && e.v2Id === a))!.id;
    };
    // Curve 1 is D→A (around the unshaded lobe only) then A→B (cut at X, its part X→B shaded).
    const da = byPoints([20, 2, 0], [20, 0, 0]), ab = byPoints([20, 0, 0], [26, 4, 0]);
    const curve = new Map([[da, 1], [ab, 1]]);
    for (const e of model.root.edges as (typeof model.root.edges[number] & { curve?: number | null })[]) e.curve = curve.get(e.id) ?? null;
    (model.root as typeof model.root & { curves: unknown[] }).curves = [{ id: 1, edges: 2, polygon: false, arc: null }];
    const scene = prepareSketchUp(model);
    expect(scene.root.edges).toHaveLength(0);
    expect(scene.root.curves).toHaveLength(1);
    expect(scene.root.curves[0]).toMatchObject({ kind: 'freehand', home: 'sketch', edges: [ab] });
    expect(scene.warnings.some(w => w.includes('separate edges'))).toBe(false);
    const doc = createDocument();
    const report = doc.transact('Import', draft => applySketchUpImport(draft, scene)).value;
    expect(report.warnings.some(w => w.includes('separate edges'))).toBe(false);
    const curves = [...doc.rootDefinition.entities.sketch.curves.values()];
    expect(curves).toHaveLength(1);
    // Only X→B was imported.
    expect(curves[0]!.edgeRefs).toHaveLength(1);
    expect(curves[0]!.segments).toBe(1);
  });

  it('subtracts a hole that sticks out of its outer loop only where it overlaps it', async () => {
    const b = create();
    b.addFace([[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]], { holes: [[[8, 4, 0], [12, 4, 0], [12, 6, 0], [8, 6, 0]]] });
    const scene = await readSketchUp(b.toBytes());
    expect(scene.root.sheets).toHaveLength(1);
    const face = scene.root.sheets[0]!;
    expect(face.loops).toHaveLength(1);
    expect(Math.abs(signedXY(face.loops[0]!))).toBeCloseTo(96 * IN2, 12);
    // The outer side x = 10 is cut at the hole's sides; its part inside the hole and the hole's part
    // outside the face bound no shaded area, and are not imported.
    expect(face.loops[0]!.map(inches)).toEqual(expect.arrayContaining([[10, 4, 0], [10, 6, 0]]));
    expect(scene.root.edges).toHaveLength(0);
    expect(scene.warnings).toContain('4 outline segments of these faces bound no shaded area and no other face, and are not imported: SketchUp keeps them as edges of the face, not as loose edges.');
  });

  it('cuts every face along an edge where a crossing outline splits it, and keeps its curve freehand', async () => {
    const b = create();
    b.addFace([[20, 0, 0], [26, 4, 0], [26, 0, 0], [20, 2, 0]]);
    // A wall on the bowtie's crossing side A→B.
    b.addFace([[20, 0, 0], [20, 0, 5], [26, 4, 5], [26, 4, 0]]);
    const model = parseSkp(new Uint8Array(b.toBytes()).buffer);
    // Make A→B and B→C one polyline curve.
    const byPoints = (p: number[], q: number[]): number => {
      const v = (c: number[]): number => model.root.vertices.find(x => x.x === c[0] && x.y === c[1] && x.z === c[2])!.id;
      const a = v(p), c = v(q);
      return model.root.edges.find(e => (e.v1Id === a && e.v2Id === c) || (e.v1Id === c && e.v2Id === a))!.id;
    };
    const ab = byPoints([20, 0, 0], [26, 4, 0]), bc = byPoints([26, 4, 0], [26, 0, 0]);
    for (const e of model.root.edges as (typeof model.root.edges[number] & { curve?: number | null })[]) e.curve = e.id === ab || e.id === bc ? 1 : null;
    (model.root as typeof model.root & { curves: unknown[] }).curves = [{ id: 1, edges: 2, polygon: false, arc: null }];
    const scene = prepareSketchUp(model);
    expect(scene.root.sheets).toHaveLength(2);
    const wall = scene.root.sheets.find(f => Math.abs(f.normal[2]) < 0.5)!;
    expect(wall.loops[0]!.map(inches)).toContainEqual([22, 4 / 3, 0].map(c => +c.toFixed(9)));
    expect(wall.loops[0]).toHaveLength(5);
    expect(scene.root.curves).toHaveLength(1);
    expect(scene.root.curves[0]).toMatchObject({ kind: 'freehand', segments: 3, home: 'sketch' });
    const doc = createDocument();
    doc.transact('Import', draft => applySketchUpImport(draft, scene));
    const sketch = doc.rootDefinition.entities.sketch;
    // No sketch edge runs from A to B past the cut: A→X and X→B are shared by the wall and the bowtie's edges.
    const at = (p: number[]): number => [...sketch.vertices.values()].find(v => v3dist(v.p, [p[0]! * 0.0254, p[1]! * 0.0254, p[2]! * 0.0254]) < 1e-9)!.id;
    const joined = (p: number[], q: number[]): boolean => [...sketch.edges.values()].some(e => (e.a === at(p) && e.b === at(q)) || (e.a === at(q) && e.b === at(p)));
    expect(joined([20, 0, 0], [26, 4, 0])).toBe(false);
    expect(joined([20, 0, 0], [22, 4 / 3, 0]) && joined([22, 4 / 3, 0], [26, 4, 0])).toBe(true);
    expect([...sketch.curves.values()][0]!.edgeRefs).toHaveLength(3);
  });

  it('keeps a crossing face out of the solid it touches, and the solid\'s edges whole', async () => {
    const b = create();
    for (const loop of cube) b.addFace(loop);
    // Shares the cube's bottom edge x = 1, which its side from (2, 0) to (0.5, 0.8) crosses at y = 8/15.
    b.addFace([[1, 0, 0], [1, 1, 0], [2, 0, 0], [0.5, 0.8, 0]]);
    const scene = await readSketchUp(b.toBytes());
    expect(scene.root.solids).toHaveLength(1);
    expect(scene.root.solids[0]!.faces).toHaveLength(6);
    expect(scene.root.solids[0]!.faces.every(f => f.loops[0]!.length === 4)).toBe(true);
    expect(scene.root.sheets.length).toBeGreaterThan(0);
    expect(scene.warnings.some(w => w.includes('skipped'))).toBe(false);
    // The cut parts of the shared edge that bound no shaded piece are the solid's: no loose edge repeats them.
    const onShared = (p: Vec3): boolean => Math.abs(p[0] - 0.0254) < 1e-9 && p[2] === 0;
    expect(scene.root.edges.some(e => onShared(e.a) && onShared(e.b))).toBe(false);
  });

  it('keeps a closed shell a solid when welding collapses a triangle', async () => {
    const b = create();
    // A vertex 0.0004" from the corner (1, 1, 1), within the 0.001" merge tolerance, on the edge the side y = 1 and the
    // top share: both faces get a triangle that collapses when the vertex welds to the corner.
    const near: [number, number, number] = [0.9996, 1, 1];
    b.addFace(cube[0]!); b.addFace(cube[1]!); b.addFace(cube[2]!); b.addFace(cube[4]!);
    b.addFace([[1, 1, 0], [0, 1, 0], [0, 1, 1], near, [1, 1, 1]]);
    b.addFace([[0, 0, 1], [1, 0, 1], [1, 1, 1], near, [0, 1, 1]]);
    const scene = await readSketchUp(b.toBytes());
    expect(scene.warnings.filter(w => w.includes('retained as editable sheets'))).toEqual([]);
    expect(scene.root.sheets).toHaveLength(0);
    expect(scene.root.solids).toHaveLength(1);
    const solid = scene.root.solids[0]!;
    expect(solid.faces).toHaveLength(6);
    expect(meshTopologyProblems(solid.mesh)).toEqual([]);
    expect(meshSignedVolume(solid.mesh)).toBeCloseTo(0.0254 ** 3, 12);
  });

  it('still skips faces that enclose no area', () => {
    const b = create();
    b.addFace([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]]);
    b.addFace([[5, 0, 0], [6, 0, 0], [6, 1, 0], [5, 1, 0]]);
    const model = parseSkp(new Uint8Array(b.toBytes()).buffer);
    // Fold the second square onto a line.
    for (const v of model.root.vertices) if (v.x >= 5) v.y = 0;
    const scene = prepareSketchUp(model);
    expect(scene.root.sheets).toHaveLength(1);
    expect(scene.warnings.filter(w => /face \d+ skipped: (empty|degenerate) triangulation/.test(w))).toHaveLength(1);
    expect(scene.warnings.some(w => w.includes('crosses or touches'))).toBe(false);
  });

  it('keeps faces twisted within the planarity tolerance, measuring them in their plane', async () => {
    const b = create();
    // A 0.04" quad whose corners alternate ±0.0008" off its plane: within tolerance of the plane through
    // its centre, though twice that from a corner, and its two 3D triangles slightly exceed its outline.
    const d = 0.0008, s = 0.04;
    b.addFace([[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0]]);
    b.addFace([[1, 0, 0], [1.1, 0, 0], [1.1, 0.1, 0], [1, 0.1, 0]]);
    // The writer only accepts planar faces, so twist the read model instead; the second face goes 0.01" off.
    const model = parseSkp(new Uint8Array(b.toBytes()).buffer);
    for (const v of model.root.vertices) {
      if (v.x < 1) v.z = (v.x === 0) === (v.y === 0) ? d : -d;
      else if (v.x > 1 && v.y === 0) v.z = 0.01;
    }
    const scene = prepareSketchUp(model);
    expect(scene.root.sheets).toHaveLength(1);
    expect(polygonArea([scene.root.sheets[0]!.loops[0]!.map(p => [p[0], p[1]])])).toBeCloseTo((s * 0.0254) ** 2, 12);
    expect(scene.warnings.filter(w => w.includes('nonplanar boundary'))).toHaveLength(1);
  });

  it('reports missing/cyclic instances, malformed faces, and textures explicitly', () => {
    const bytes = modelFixture(), model = parseSkp(new Uint8Array(bytes).buffer);
    const child = [...model.definitions.values()][0]!;
    child.instances.push({ ...model.root.instances[0]!, refIdx: child.id });
    model.root.instances.push({ ...model.root.instances[0]!, refIdx: 999_999 });
    child.faces.push({ ...child.faces[0]!, id: 999, loops: [[{ edgeId: -1, orientation: 1 }]] });
    model.materials[0]!.texture = { filename: 'missing.png', width: 1, height: 1, data: null };
    const scene = prepareSketchUp(model as SkpModel);
    expect(scene.warnings.some(w => w.includes('cyclic'))).toBe(true);
    expect(scene.warnings.some(w => w.includes('missing component'))).toBe(true);
    expect(scene.warnings.some(w => w.includes('face 999 skipped'))).toBe(true);
    expect(scene.warnings.some(w => w.includes('1 texture image is missing from the file'))).toBe(true);
  });
});

// style-*.skp were built in SketchUp 2027 with deliberately unusual rendering options (see the fixtures README); the
// expected values are the options as set, which SketchUp reads back unchanged from every copy.
describe('SketchUp styles', () => {
  const fixture = (name: string) => readFileSync(new URL(`../../testing/assets/sketchup/${name}.skp`, import.meta.url));
  const rgb = (r: number, g: number, b: number): Vec3 => [r / 255, g / 255, b / 255];
  const activeStyle = (doc: ReturnType<typeof createDocument>) => doc.state.styles.get(doc.state.activeStyleId)!;
  const open = async (name: string) => {
    const scene = await readSketchUp(fixture(name)), doc = createDocument();
    doc.transact('Open fixture', draft => applySketchUpImport(draft, scene));
    return { scene, doc, style: activeStyle(doc) };
  };

  it.each(['style-wireframe-2027', 'style-wireframe-2017'])('opens a wireframe file in its style with every edge, face, background and modeling setting (%s)', async name => {
    const { style } = await open(name);
    expect(style.faces).toMatchObject({ mode: 'wireframe', frontColor: rgb(200, 210, 220), backColor: rgb(90, 100, 110) });
    expect(style.edges).toEqual({
      edges: true, profiles: false, profileWidth: 4, depthCue: true, depthCueLevels: 5, extension: true, extensionLength: 9,
      endpoints: true, endpointLength: 6, jitter: true, backEdges: false, color: rgb(10, 20, 30), colorMode: 'allSame',
    });
    expect(style.background).toEqual({
      color: rgb(20, 30, 40), sky: false, skyColor: rgb(1, 2, 3), ground: false, groundColor: rgb(4, 5, 6), groundTransparency: 0.5, showGroundFromBelow: true,
    });
    expect(style.modeling).toMatchObject({
      hiddenGeometry: true, guidesVisible: false, modelAxesVisible: false, colorByTag: true,
      sectionPlanesVisible: true, sectionCutsVisible: true, sectionFillEnabled: false, sectionLineWidth: 7,
      activeSection: rgb(11, 12, 13), inactiveSection: rgb(14, 15, 16), sectionFill: rgb(17, 18, 19), sectionLine: rgb(0, 0, 0),
      selected: rgb(0, 1, 255), locked: rgb(255, 0, 0), guides: rgb(0, 0, 0),
    });
  });

  it.each(['style-hiddenline-2027', 'style-hiddenline-2017'])('opens a hidden-line file with edges off, edges by material and the sky and ground on (%s)', async name => {
    const { style } = await open(name);
    expect(style.faces).toMatchObject({ mode: 'hiddenLine', frontColor: rgb(240, 241, 242), backColor: rgb(130, 140, 150) });
    expect(style.edges).toEqual({
      edges: false, profiles: true, profileWidth: 3, depthCue: false, depthCueLevels: 2, extension: false, extensionLength: 2,
      endpoints: false, endpointLength: 3, jitter: false, backEdges: true, color: rgb(60, 70, 80), colorMode: 'byMaterial',
    });
    expect(style.background).toMatchObject({ color: rgb(250, 240, 230), sky: true, skyColor: rgb(100, 150, 250), ground: true, groundColor: rgb(120, 110, 100) });
    expect(style.modeling).toMatchObject({
      hiddenGeometry: false, guidesVisible: true, modelAxesVisible: true, colorByTag: false,
      sectionPlanesVisible: false, sectionCutsVisible: false, sectionFillEnabled: true, sectionLineWidth: 2,
    });
  });

  it.each(['style-xray-2027', 'style-xray-2017'])('opens an X-ray file as X-ray with its edge and face colors (%s)', async name => {
    const { style } = await open(name);
    expect(style.faces).toMatchObject({ mode: 'xray', frontColor: rgb(0, 255, 0), backColor: rgb(0, 0, 255) });
    expect(style.edges).toMatchObject({ edges: true, profiles: true, profileWidth: 1, backEdges: false, color: rgb(255, 0, 0) });
    expect(style.background).toMatchObject({ color: rgb(0, 0, 0), sky: true, ground: false });
    expect(style.modeling.modelAxesVisible).toBe(true);
  });

  it.each(['style-monochrome-2027', 'style-monochrome-2017'])('opens a monochrome file with back edges and a translucent ground (%s)', async name => {
    const { style } = await open(name);
    expect(style.faces).toMatchObject({ mode: 'monochrome', frontColor: rgb(255, 255, 255), backColor: rgb(160, 170, 190) });
    expect(style.edges).toMatchObject({ edges: true, profiles: false, profileWidth: 2, backEdges: true, color: rgb(0, 0, 0) });
    expect(style.background).toMatchObject({ color: rgb(255, 255, 255), sky: false, ground: true, groundColor: rgb(200, 190, 180), groundTransparency: 0.2 });
    expect(style.modeling.modelAxesVisible).toBe(false);
  });

  it('reads the background and edge colors from the current style when the 2021+ record leaves them unset', async () => {
    // section-display-2027.skp stores (0, 0, 0, 0) for both in its rendering options; SketchUp shows white and black.
    const { scene, style } = await open('section-display-2027');
    expect(scene.display?.background.color).toEqual([1, 1, 1]);
    expect(scene.display?.edges.color).toEqual([0, 0, 0]);
    expect(style.background.color).toEqual([1, 1, 1]);
    expect(style.faces).toMatchObject({ mode: 'shadedWithTextures', frontColor: rgb(225, 225, 200), backColor: rgb(128, 128, 200) });
  });

  it('keeps the style across native save and reopen, and leaves the destination style alone on Import', async () => {
    const { scene, doc } = await open('style-wireframe-2027');
    const reopened = decodeModelDocument(encodeModelDocument(doc));
    expect(reopened.styles.get(reopened.activeStyleId)!).toEqual(activeStyle(doc));
    const into = createDocument(), before = structuredClone(activeStyle(into));
    into.transact('Import fixture', draft => applySketchUpImport(draft, scene, { groupName: 'Styled' }));
    expect(activeStyle(into)).toEqual(before);
  });

  it('leaves the default style when a file records no rendering options', async () => {
    const scene = await readSketchUp(fixture('style-wireframe-2027')), doc = createDocument(), before = structuredClone(activeStyle(doc));
    doc.transact('Open fixture', draft => applySketchUpImport(draft, { ...scene, display: null, sectionDisplay: null }));
    expect(activeStyle(doc)).toEqual(before);
    expect(sketchUpDisplay(null)).toBeNull();
    expect(sketchUpDisplay({})).toBeNull();
  });

  // scene-styles-*.skp: Plan saves its own hidden-line style, Perspective saves the model's current style, NoStyle saves none.
  // The 2020 copy is left out: the reader finds no loose geometry in it (PF-307), while its scene styles read the same.
  it.each(['scene-styles-2027', 'scene-styles-2017'])('gives each scene the style it saved: its own, the model\'s, or none (%s)', async name => {
    const { scene, doc } = await open(name);
    expect(scene.scenes.map(saved => [saved.name, saved.display?.faces.mode ?? null])).toEqual([['Plan', 'hiddenLine'], ['Perspective', 'shadedWithTextures'], ['NoStyle', null]]);
    const scenes = doc.state.sceneOrder.map(id => doc.state.scenes.get(id)!);
    expect(scenes.map(item => [item.name, item.flags.useStyle])).toEqual([['Plan', true], ['Perspective', true], ['NoStyle', false]]);
    expect(scenes[2]!.styleId).toBeNull();
    expect(scenes[1]!.styleId).toBe(doc.state.activeStyleId);
    expect(scenes[0]!.styleId).not.toBe(doc.state.activeStyleId);
    const plan = doc.state.styles.get(scenes[0]!.styleId!)!;
    expect(plan.name).toBe('Plan style');
    expect(plan.faces).toMatchObject({ mode: 'hiddenLine' });
    expect(plan.edges).toMatchObject({ edges: true, profiles: false, color: rgb(30, 31, 32) });
    expect(plan.background).toMatchObject({ color: rgb(200, 201, 202), sky: false, ground: false });
    expect(doc.state.styles.size).toBe(2);
    const active = doc.state.styles.get(doc.state.activeStyleId)!;
    expect(active.faces).toMatchObject({ mode: 'shadedWithTextures' });
    expect(active.edges).toMatchObject({ profiles: true, profileWidth: 3, color: rgb(250, 251, 252) });
    expect(active.background).toMatchObject({ color: rgb(40, 41, 42), sky: true, skyColor: rgb(10, 20, 30) });
    // The scene styles survive native save and reopen; Import into another model adds neither scenes nor styles.
    const reopened = decodeModelDocument(encodeModelDocument(doc));
    expect(reopened.styles.get(reopened.scenes.get(reopened.sceneOrder[0]!)!.styleId!)!.name).toBe('Plan style');
    const into = createDocument();
    into.transact('Import fixture', draft => applySketchUpImport(draft, scene, { groupName: 'Scenes' }));
    expect(into.state.scenes.size).toBe(0); expect(into.state.styles.size).toBe(1);
  });

  it('shares one style between scenes that saved the same settings', async () => {
    const scene = await readSketchUp(fixture('scene-styles-2027'));
    const twin = { ...scene, scenes: [...scene.scenes, { ...scene.scenes[0]!, name: 'Plan copy' }] };
    const doc = createDocument();
    doc.transact('Open fixture', draft => applySketchUpImport(draft, twin));
    const scenes = doc.state.sceneOrder.map(id => doc.state.scenes.get(id)!);
    expect(scenes[3]!.styleId).toBe(scenes[0]!.styleId);
    expect(doc.state.styles.size).toBe(2);
  });

  it('maps SketchUp render modes, X-ray and edge color modes to PushForm face and edge styles', () => {
    const faces = (options: Record<string, number | boolean>) => sketchUpDisplay(options)?.faces.mode;
    expect(faces({ RenderMode: 0, ModelTransparency: true })).toBe('wireframe');
    expect(faces({ RenderMode: 1, ModelTransparency: true })).toBe('hiddenLine');
    expect(faces({ RenderMode: 2, Texture: true })).toBe('shadedWithTextures');
    expect(faces({ RenderMode: 2 })).toBe('shadedWithTextures');
    expect(faces({ RenderMode: 2, Texture: false })).toBe('shaded');
    expect(faces({ RenderMode: 5 })).toBe('monochrome');
    expect(faces({ RenderMode: 5, ModelTransparency: true })).toBe('xray');
    expect(faces({ RenderMode: 6, Texture: true, ModelTransparency: false })).toBe('shadedWithTextures');
    expect(sketchUpDisplay({ EdgeColorMode: 2, EdgeDisplayMode: 0 })?.edges).toEqual({ colorMode: 'byAxis', edges: false });
    expect(sketchUpDisplay({ GroundTransparency: 250, HideConstructionGeometry: false })).toEqual({
      edges: {}, faces: {}, background: { groundTransparency: 1 }, modeling: { guidesVisible: true },
    });
  });
});
