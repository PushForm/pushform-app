// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import {
  m4mul,
  m4rotationAxis,
  m4transformPoint,
  m4translation,
  meshBox,
  MERGE_TOL,
  PICK_PX,
  planeBasis,
  type DefId,
  type Id,
  type Mat4,
  type MMat4,
  type Ray,
  type Vec2,
  type Vec3,
} from '@pushform/core';
import { cellKey } from '@pushform/geom';
import {
  allocId,
  bodyFromMesh,
  createDocument,
  createEntityContainer,
  type ComponentInstance,
  type Document,
  type DocumentDraft,
  type EntityRef,
  type LoopRef,
  type Sketch,
} from '@pushform/model';
import { InferenceEngineImpl } from './InferenceEngineImpl';
import { SpatialIndex } from './SpatialIndex';
import type { InferenceInput } from './types';

/**
 * Imported-sheet workloads: a document whose geometry is mostly zero-thickness sketch faces, in
 * the root and in instanced components, like a SketchUp building import. Faces are written into
 * the sketch records directly (the way the importer does) rather than through the SketchGraph,
 * so the fixture builds thousands of faces in milliseconds.
 */

/** Realistic viewport: 1440 × 900 CSS pixels, parallel projection framing the model's width. */
const VIEW_W = 1440, VIEW_H = 900;

function down(x: number, y: number, z = 100): Ray {
  return { origin: [x, y, z], dir: [0, 0, -1] };
}
function input(ray: Ray, px: number): InferenceInput {
  return { ray, screen: [0, 0], pixelSizeAt: () => px, project: (p: Vec3): Vec2 => [p[0], p[1]] };
}

function addDefinition(d: DocumentDraft, name: string): DefId {
  const root = d.definitions.get(d.rootDefinitionId)!;
  const id = allocId<DefId>(d);
  d.definitions.set(id, { ...root, id, name, isGroup: false, entities: createEntityContainer(), bounds: null } as never);
  return id;
}

function addInstance(d: DocumentDraft, parentDef: DefId, definitionId: DefId, transform: MMat4, extra: Partial<ComponentInstance> = {}): Id {
  const id = allocId<Id>(d);
  const inst: ComponentInstance = {
    id,
    definitionId,
    transform: transform as unknown as Mat4,
    name: '',
    materialId: null,
    tagId: d.defaultTagId,
    hidden: false,
    locked: false,
    castShadows: true,
    receiveShadows: true,
    attributes: {},
    ...extra,
  };
  d.definitions.get(parentDef)!.entities.instances.set(id, inst as never);
  return id;
}

/**
 * An nx × ny grid of square sheet faces of side `cell` in the plane z = `z` of the definition's
 * sketch (local coordinates), starting at (x0, y0). Returns the face ids as `ids[iy][ix]`.
 */
function addSheetGrid(d: DocumentDraft, def: DefId, nx: number, ny: number, cell: number, z = 0, x0 = 0, y0 = 0): Id[][] {
  // the draft's writable types reject readonly tuples; write through the record type like the importer does
  const sketch = d.definitions.get(def)!.entities.sketch as unknown as Sketch;
  const common = () => ({ tagId: d.defaultTagId, hidden: false, locked: false, castShadows: true, receiveShadows: true, attributes: {} });
  const vertexAt = new Map<string, Id>();
  const vertex = (p: Vec3): Id => {
    const key = p.join(',');
    let id = vertexAt.get(key);
    if (id !== undefined) return id;
    id = allocId<Id>(d);
    sketch.vertices.set(id, { id, p: [p[0], p[1], p[2]] });
    vertexAt.set(key, id);
    const cellId = cellKey(p, MERGE_TOL), bucket = sketch.vertexHash.get(cellId);
    if (bucket) bucket.push(id);
    else sketch.vertexHash.set(cellId, [id]);
    return id;
  };
  const edgeBetween = new Map<string, { id: Id; a: Id }>();
  const edge = (a: Vec3, b: Vec3): LoopRef => {
    const va = vertex(a), vb = vertex(b);
    const key = va < vb ? `${va}:${vb}` : `${vb}:${va}`;
    let e = edgeBetween.get(key);
    if (!e) {
      const id = allocId<Id>(d);
      sketch.edges.set(id, { ...common(), id, a: va, b: vb, soft: false, smooth: false, curveId: null });
      edgeBetween.set(key, (e = { id, a: va }));
    }
    return { edgeId: e.id, forward: e.a === va };
  };
  const basis = planeBasis([0, 0, z], [0, 0, 1]);
  const ids: Id[][] = [];
  for (let iy = 0; iy < ny; iy++) {
    const row: Id[] = [];
    for (let ix = 0; ix < nx; ix++) {
      const x = x0 + ix * cell, y = y0 + iy * cell;
      const corners: Vec3[] = [[x, y, z], [x + cell, y, z], [x + cell, y + cell, z], [x, y + cell, z]];
      const loop = corners.map((p, i) => edge(p, corners[(i + 1) % 4]!));
      const id = allocId<Id>(d);
      sketch.faces.set(id, { ...common(), id, plane: { n: [0, 0, 1], d: -z }, basis, loops: [loop], frontMaterialId: null, backMaterialId: null, uv: { kind: 'auto' } });
      row.push(id);
    }
    ids.push(row);
  }
  return ids;
}

interface Fixture {
  doc: Document;
  engine: InferenceEngineImpl;
  /** Root grid face ids `[iy][ix]`, cells of side `cell` from the origin. */
  root: Id[][];
  /** One face hovering above the root grid (z = 5, cells 5..7 × 5..7). */
  roof: Id;
  /** Hidden face and tag-hidden face of the root grid. */
  hiddenFace: Id;
  taggedFace: Id;
  /** Panel definition's grid ids `[iy][ix]` and the placed instances with their matrices. */
  panel: Id[][];
  instances: { id: Id; matrix: MMat4; hidden: boolean }[];
  cell: number;
  /** World extent along x (model width), for the viewport scale. */
  extent: number;
}

/**
 * Root grid of `rootN`² faces at z = 0, a roof face above it, and 16 instances of a `panelN`²
 * panel placed in a 4 × 4 arrangement east of the grid at z = 2 (odd columns rotated 90° about
 * z, one instance hidden).
 */
function fixture(rootN: number, panelN: number, cell = 4): Fixture {
  const doc = createDocument();
  let root: Id[][] = [], panel: Id[][] = [], roof = 0 as Id, hiddenFace = 0 as Id, taggedFace = 0 as Id;
  const instances: Fixture['instances'] = [];
  const panelSpan = panelN * cell, spacing = panelSpan + 10, startX = rootN * cell + 20;
  doc.transact('fixture', (d) => {
    root = addSheetGrid(d, d.rootDefinitionId, rootN, rootN, cell);
    hiddenFace = root[1]![1]!;
    d.definitions.get(d.rootDefinitionId)!.entities.sketch.faces.get(hiddenFace)!.hidden = true;
    const tagId = allocId<Id>(d) as unknown as typeof d.defaultTagId;
    d.tags.set(tagId, { id: tagId, name: 'Off', visible: false, color: [0, 0, 0], dashes: null, folderId: null });
    taggedFace = root[2]![2]!;
    d.definitions.get(d.rootDefinitionId)!.entities.sketch.faces.get(taggedFace)!.tagId = tagId;
    roof = addSheetGrid(d, d.rootDefinitionId, 1, 1, 2 * cell, 5, 5 * cell, 5 * cell)[0]![0]!;
    const def = addDefinition(d, 'Panel');
    panel = addSheetGrid(d, def, panelN, panelN, cell);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        const translate = m4translation([startX + i * spacing + (i % 2 ? panelSpan : 0), j * spacing, 2]);
        const matrix = i % 2 ? m4mul(translate, m4rotationAxis([0, 0, 1], Math.PI / 2)) : translate;
        const hidden = i === 3 && j === 3;
        instances.push({ id: addInstance(d, d.rootDefinitionId, def, matrix, { hidden }), matrix, hidden });
      }
    }
  });
  const engine = new InferenceEngineImpl({ clock: () => 0 });
  engine.setState(doc.state);
  return { doc, engine, root, roof, hiddenFace, taggedFace, panel, instances, cell, extent: startX + 4 * spacing };
}

/** Pixel size of a parallel view that fits the model width in the viewport. */
const pixelSize = (f: Fixture): number => f.extent / VIEW_W;

describe('sheet-face picking through the bounds trees (imported-sheet workload)', () => {
  it('picks root faces, hidden/tag-hidden faces are neither picked nor occluding, back side hits', () => {
    const f = fixture(12, 6);
    const px = 0.05; // zoomed in: 8 px = 0.4 m, well inside a 4 m cell
    const c = f.cell;
    const at = (ix: number, iy: number): Ray => down((ix + 0.5) * c, (iy + 0.5) * c);
    const cands = f.engine.picker.candidates(input(at(0, 0), px));
    expect(cands.surface?.ref).toEqual({ kind: 'sketchFace', path: [], id: f.root[0]![0] });
    expect(cands.surface!.point[2]).toBeCloseTo(0, 9);
    expect(cands.surface!.t).toBeCloseTo(100, 9);
    expect(cands.vertices).toEqual([]);
    expect(cands.edges).toEqual([]);
    // hidden flag and hidden tag
    expect(f.engine.picker.candidates(input(at(1, 1), px)).surface).toBeNull();
    expect(f.engine.picker.candidates(input(at(2, 2), px)).surface).toBeNull();
    // the far corner cell and a ray from below (two-sided sheets)
    expect(f.engine.picker.candidates(input(at(11, 11), px)).surface?.ref).toMatchObject({ id: f.root[11]![11] });
    const up = f.engine.picker.candidates(input({ origin: [3.5 * c, 4.5 * c, -10], dir: [0, 0, 1] }, px));
    expect(up.surface?.ref).toMatchObject({ kind: 'sketchFace', id: f.root[4]![3] });
    expect(up.surface!.t).toBeCloseTo(10, 9);
    // the engine's pick reports the same face, and a ray past the model finds nothing
    expect(f.engine.pick(input(at(7, 2), px))?.ref).toMatchObject({ kind: 'sketchFace', id: f.root[2]![7] });
    expect(f.engine.pick(input(down(-50, -50), px))).toBeNull();
  });

  it('picks instanced panel faces through their transforms (translated and rotated), not hidden instances', () => {
    const f = fixture(12, 6);
    const px = 0.05;
    for (const inst of f.instances) {
      const localCenter: Vec3 = [2.5 * f.cell, 3.5 * f.cell, 0]; // cell ix = 2, iy = 3 of the panel
      const world = m4transformPoint(inst.matrix, localCenter);
      const cands = f.engine.picker.candidates(input(down(world[0], world[1]), px));
      if (inst.hidden) {
        expect(cands.surface).toBeNull();
        continue;
      }
      expect(cands.surface?.ref).toEqual({ kind: 'sketchFace', path: [inst.id], id: f.panel[3]![2] });
      expect(cands.surface!.point).toEqual([expect.closeTo(world[0], 9), expect.closeTo(world[1], 9), expect.closeTo(2, 9)]);
      expect(cands.surface!.t).toBeCloseTo(98, 9);
    }
    // the hit resolves to the instance from the root context, and to the face inside its context
    const inst = f.instances[5]!;
    const world = m4transformPoint(inst.matrix, [0.5 * f.cell, 0.5 * f.cell, 0]);
    const hit = f.engine.pick(input(down(world[0], world[1]), px))!;
    expect(hit.selectable).toEqual({ kind: 'instance', path: [], id: inst.id });
    expect(hit.inContext).toBe(false);
    f.engine.setContext([inst.id]);
    expect(f.engine.pick(input(down(world[0], world[1]), px))!.inContext).toBe(true);
  });

  it('a sheet above hides a vertex below it; ignoring the sheet reveals both the vertex and the face underneath', () => {
    const f = fixture(12, 6);
    const px = 0.05;
    const c = f.cell;
    // grid corner (6c, 6c, 0) lies under the roof (cells 5..7); aim 2 px off it
    const ray = down(6 * c + 0.1, 6 * c + 0.1);
    const roofRef: EntityRef = { kind: 'sketchFace', path: [], id: f.roof };
    const cands = f.engine.picker.candidates(input(ray, px));
    expect(cands.surface?.ref).toEqual(roofRef);
    expect(cands.surface!.point[2]).toBeCloseTo(5, 9);
    expect(cands.vertices).toEqual([]);
    expect(cands.edges).toEqual([]);
    const ignoring = f.engine.picker.candidates(input(ray, px), { ignore: [roofRef] });
    expect(ignoring.surface?.ref).toEqual({ kind: 'sketchFace', path: [], id: f.root[6]![6] });
    expect(ignoring.vertices[0]?.ref.kind).toBe('sketchVertex');
    expect(ignoring.vertices[0]!.point).toEqual([6 * c, 6 * c, 0]);
    expect(ignoring.edges.length).toBe(4);
    // the roof's own corner is not occluded by the roof (it lies on the surface)
    const corner = f.engine.picker.candidates(input(down(5 * c + 0.1, 5 * c + 0.1), px));
    expect(corner.vertices.some((v) => v.point[2] === 5)).toBe(true);
    expect(corner.vertices.some((v) => v.point[2] === 0)).toBe(false);
    // snaps follow: the Select-style pick lands on the roof, full inference reports "On Face"
    const select = f.engine.resolve(input(ray, px), { pickOnly: true });
    expect(select.hit?.ref).toEqual(roofRef);
    const full = f.engine.resolve(input(ray, px));
    expect(full.primary.kind).toBe('onFace');
    expect(full.primary.ref).toEqual(roofRef);
  });

  it('reuses the index across hovers; an unrelated body edit keeps every sketch index and face tree', () => {
    const f = fixture(12, 6);
    const index = f.engine.index;
    const gen = index.generation;
    const sketches = index.sketches();
    const tree = index.sketchFaces();
    expect(sketches.length).toBe(1 + 15); // root + visible instances
    expect(tree.sketches.length).toBe(16);
    const px = pixelSize(f);
    for (let i = 0; i < 40; i++) {
      const x = ((i * 37) % VIEW_W) * px, y = ((i * 53) % VIEW_H) * px;
      f.engine.resolve(input(down(x, y), px), i % 2 ? { pickOnly: true } : {});
    }
    expect(index.generation).toBe(gen);
    expect(index.sketches()).toBe(sketches);
    expect(index.sketchFaces()).toBe(tree);
    // a new body elsewhere: one rebuild, sketch indices (and their face trees) are kept
    f.doc.transact('box', (d) => {
      bodyFromMesh(d, meshBox([-20, -20, 0], [-18, -18, 2]), { container: d.definitions.get(d.rootDefinitionId)!.entities });
    });
    f.engine.setState(f.doc.state);
    expect(index.generation).toBe(gen + 1);
    const after = index.sketches();
    expect(after.length).toBe(sketches.length);
    for (let i = 0; i < after.length; i++) expect(after[i]).toBe(sketches[i]);
    expect(index.sketchFaces().sketches.every((sk, i) => sk === tree.sketches[i])).toBe(true);
    // editing one sketch rebuilds only that container's sketch index
    f.doc.transact('hide', (d) => {
      d.definitions.get(d.rootDefinitionId)!.entities.sketch.faces.get(f.root[0]![0]!)!.hidden = true;
    });
    f.engine.setState(f.doc.state);
    expect(index.generation).toBe(gen + 2);
    const edited = index.sketches();
    expect(edited.filter((sk, i) => sk !== after[i]).map((sk) => sk.path)).toEqual([[]]);
    expect(f.engine.picker.candidates(input(down(2, 2), 0.05)).surface).toBeNull();
  });

  it('builds a large index in short slices, and hovers meanwhile see an empty index instead of waiting (PF-189)', () => {
    const f = fixture(60, 20);
    const full = new SpatialIndex();
    full.setState(f.doc.state);
    full.ensure();

    const sliced = new SpatialIndex();
    sliced.setState(f.doc.state);
    expect(sliced.building).toBe(true);
    // A hover with no time to spare sees nothing rather than half of the model or the previous state.
    expect(sliced.within(0, () => sliced.sketches())).toEqual([]);
    expect(sliced.within(0, () => sliced.generation)).toBe(-1);
    let slices = 0, longest = 0;
    for (;;) {
      const t0 = performance.now();
      const done = sliced.ensureFor(1);
      longest = Math.max(longest, performance.now() - t0);
      slices++;
      if (done) break;
    }
    expect(sliced.building).toBe(false);
    expect(slices).toBeGreaterThan(10);
    expect(longest).toBeLessThan(200);
    const faces = (index: SpatialIndex) => index.sketches().reduce((n, sk) => n + sk.faces.length, 0);
    expect(faces(sliced)).toBe(faces(full));
    expect(sliced.vertices().items.length).toBe(full.vertices().items.length);
    expect(sliced.sketchFaces().sketches.length).toBe(full.sketchFaces().sketches.length);
    const ray = input(down(2.5 * f.cell, 3.5 * f.cell), 0.05);
    expect(new InferenceEngineImpl({ index: sliced }).picker.candidates(ray).surface?.ref)
      .toEqual({ kind: 'sketchFace', path: [], id: f.root[3]![2] });

    // An edit during the build restarts it on the new state; the result shows the edit.
    const edited = new SpatialIndex();
    edited.setState(f.doc.state);
    edited.ensureFor(0);
    expect(edited.building).toBe(true);
    f.doc.transact('box', (d) => {
      bodyFromMesh(d, meshBox([-20, -20, 0], [-18, -18, 2]), { container: d.definitions.get(d.rootDefinitionId)!.entities });
    });
    edited.setState(f.doc.state);
    expect(edited.ensure()).toBe(true);
    expect(edited.bodies()).toHaveLength(1);
    expect(faces(edited)).toBe(faces(full));
  });

  it('cold index build and warm Select hovers stay fast at 1440 × 900 (generous CI bounds)', () => {
    // 60² root faces + 15 visible instances × 20² panel faces ≈ 9,600 sheet faces
    const f = fixture(60, 20);
    const px = pixelSize(f);
    const index = new SpatialIndex();
    index.setState(f.doc.state);
    const t0 = performance.now();
    index.ensure();
    const coldMs = performance.now() - t0;
    const faces = index.sketches().reduce((n, sk) => n + sk.faces.length, 0);
    expect(faces).toBeGreaterThanOrEqual(9_600);
    expect(coldMs).toBeLessThan(4000);

    // warm hovers with the engine's own (already built) index: the index is not rebuilt
    f.engine.index.ensure();
    const gen = f.engine.index.generation;
    // the worst case for occlusion queries: cursor on a grid corner where 4 faces, 4 edges and
    // a vertex are all within the pick radius (PICK_PX.vertex pixels)
    const corners: Vec2[] = [];
    for (let i = 0; i < 20; i++) corners.push([((i * 7) % 50 + 5) * f.cell, ((i * 11) % 50 + 5) * f.cell]);
    const panelCorner = m4transformPoint(f.instances[6]!.matrix, [10 * f.cell, 10 * f.cell, 0]);
    corners.push([panelCorner[0], panelCorner[1]]);
    const hover = (opts: { pickOnly?: boolean }) => {
      let worst = 0;
      for (const [x, y] of corners) {
        const t1 = performance.now();
        const r = f.engine.resolve(input(down(x + 2 * px, y + 2 * px), px), opts);
        worst = Math.max(worst, performance.now() - t1);
        expect(r.hit).not.toBeNull();
        expect(r.hit!.screenDist).toBeLessThanOrEqual(PICK_PX.vertex);
      }
      return worst;
    };
    const selectWorst = hover({ pickOnly: true });
    const fullWorst = hover({});
    expect(f.engine.index.generation).toBe(gen);
    expect(selectWorst).toBeLessThan(250);
    expect(fullWorst).toBeLessThan(250);
  });
});
