// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import type { Id, ImageId, Mat4, MaterialId, MMat4, PlaneBasis, Vec3 } from '@pushform/core';
import { basisToLocal, m4mul, m4rotationAxis, m4transformPoint, m4translation, meshBounds, v3eq } from '@pushform/core';
import { allocId, containerAt, contextMatrix, sketchFaceLoops, uvApply, uvToAffine, type Body, type EntityContainer, type EntityRef, type FaceRecord, type UvMapping } from '@pushform/model';
import { disposeKernels, setupCommands } from './transform.fixtures';
import { contextCommands } from './context';
import { groupCommands, instanceInfo, type ExplodeResult, type MakeResult, type MakeUniqueResult } from './groups';
import type { PushPullApplyResult } from './pushpull';
import type { TransformApplyResult } from './transform';

afterEach(disposeKernels);

function setup() {
  const s = setupCommands();
  s.registry.registerAll(groupCommands);
  s.registry.registerAll(contextCommands);
  const instanceRef = (id: number, path: readonly number[] = []): EntityRef => ({ kind: 'instance', path: path as Id[], id: id as Id });
  const bodyRef = (id: number, path: readonly number[] = []): EntityRef => ({ kind: 'body', path: path as Id[], id: id as Id });
  const makeGroup = (refs?: EntityRef[]): MakeResult => s.registry.execute('group.make', refs ? { refs } : {}) as MakeResult;
  const setInstanceTransform = (path: readonly number[], id: number, m: readonly number[]): void => {
    s.host.doc.transact('set transform', (draft) => {
      const c = containerAt(draft as never, path as Id[]);
      c.instances.get(id as Id)!.transform = [...m] as unknown as Mat4;
    });
  };
  return { ...s, instanceRef, bodyRef, makeGroup, setInstanceTransform };
}

const topFace = (body: Body): FaceRecord => {
  const f = [...body.faces.values()].find((r) => v3eq(r.plane.n, [0, 0, 1]));
  if (!f) throw new Error('no +z face');
  return f;
};

const vertsOf = (b: Body): number[] => Array.from(b.mesh.verts);

const sortedPoints = (verts: ArrayLike<number>): number[][] => {
  const pts: number[][] = [];
  for (let i = 0; i < verts.length; i += 3) pts.push([verts[i]!, verts[i + 1]!, verts[i + 2]!]);
  return pts.sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!);
};

describe('group.make / group.explode', () => {
  it('moves a box body and a sketch rectangle into a group definition at the bbox min corner; undo restores', () => {
    const { host, registry, root, bodyRef, makeGroup } = setup();
    const boxId = registry.execute('model.addBox', { min: [2, 3, 0], max: [3, 4, 1] }) as number;
    registry.execute('sketch.rectangle', { a: [4, 3, 0], b: [6, 3, 0], c: [6, 5, 0], d: [4, 5, 0] });
    expect(root().sketch.faces.size).toBe(1);
    const faceId = [...root().sketch.faces.keys()][0]!;
    registry.execute('selection.set', { refs: [bodyRef(boxId), { kind: 'sketchFace', path: [], id: faceId }] });
    const entries = host.undoStack.length;

    const res = makeGroup();
    expect(res.instanceId).not.toBeNull();
    expect(root().instances.size).toBe(1);
    expect(root().bodies.size).toBe(0);
    expect(root().sketch.edges.size).toBe(0);
    expect(root().sketch.faces.size).toBe(0);
    const inst = root().instances.get(res.instanceId as Id)!;
    expect(inst.definitionId).toBe(res.definitionId);
    expect(m4transformPoint(inst.transform, [0, 0, 0])).toEqual([2, 3, 0]);
    const def = host.doc.state.definitions.get(res.definitionId as never)!;
    expect(def.isGroup).toBe(true);
    expect(def.name).toBe('Group');
    expect(def.entities.bodies.size).toBe(1);
    expect(def.entities.sketch.faces.size).toBe(1);
    expect(def.entities.sketch.edges.size).toBe(4);
    const body = [...def.entities.bodies.values()][0]!;
    expect(body.id).toBe(boxId);
    const mb = meshBounds(body.mesh);
    expect(mb.min).toEqual([0, 0, 0]);
    expect(mb.max).toEqual([1, 1, 1]);
    const face = [...def.entities.sketch.faces.values()][0]!;
    const facePts = sortedPoints(face.loops[0]!.flatMap((r) => {
      const e = def.entities.sketch.edges.get(r.edgeId)!;
      return def.entities.sketch.vertices.get(r.forward ? e.a : e.b)!.p;
    }));
    expect(facePts).toEqual([[2, 0, 0], [2, 2, 0], [4, 0, 0], [4, 2, 0]]);
    expect(host.selection.refs).toEqual([{ kind: 'instance', path: [], id: res.instanceId }]);
    expect(host.undoStack.length).toBe(entries + 1);

    host.undo();
    expect(root().instances.size).toBe(0);
    expect(root().bodies.size).toBe(1);
    expect(root().sketch.faces.size).toBe(1);
    expect(host.doc.state.definitions.has(res.definitionId as never)).toBe(false);
    host.redo();
    expect(root().instances.size).toBe(1);
  });

  it('explode puts the entities back at their world positions and deletes the definition', () => {
    const { host, registry, root, bodyRef, makeGroup } = setup();
    const boxId = registry.execute('model.addBox', { min: [2, 3, 0], max: [3, 4, 1] }) as number;
    registry.execute('sketch.rectangle', { a: [4, 3, 0], b: [6, 3, 0], c: [6, 5, 0], d: [4, 5, 0] });
    const before = vertsOf(root().bodies.get(boxId as Id)!);
    const faceId = [...root().sketch.faces.keys()][0]!;
    registry.execute('selection.set', { refs: [bodyRef(boxId), { kind: 'sketchFace', path: [], id: faceId }] });
    const made = makeGroup();

    const res = registry.execute('group.explode', {}) as ExplodeResult;
    expect(res.explodedInstanceIds).toEqual([made.instanceId]);
    expect(res.deletedDefinitionIds).toEqual([made.definitionId]);
    expect(host.doc.state.definitions.has(made.definitionId as never)).toBe(false);
    expect(root().instances.size).toBe(0);
    expect(root().bodies.size).toBe(1);
    const body = root().bodies.get(boxId as Id)!;
    const after = vertsOf(body);
    expect(after.length).toBe(before.length);
    for (let i = 0; i < before.length; i++) expect(Math.abs(after[i]! - before[i]!)).toBeLessThan(1e-9);
    expect(root().sketch.faces.size).toBe(1);
    const face = [...root().sketch.faces.values()][0]!;
    const pts = sortedPoints(face.loops[0]!.flatMap((r) => {
      const e = root().sketch.edges.get(r.edgeId)!;
      return root().sketch.vertices.get(r.forward ? e.a : e.b)!.p;
    }));
    expect(pts).toEqual([[4, 3, 0], [4, 5, 0], [6, 3, 0], [6, 5, 0]]);
    expect(host.selection.refs.map((r) => r.kind).sort()).toEqual(['body', 'sketchEdge', 'sketchEdge', 'sketchEdge', 'sketchEdge', 'sketchFace']);
    host.undo();
    expect(root().instances.size).toBe(1);
    expect(host.doc.state.definitions.has(made.definitionId as never)).toBe(true);
  });

  it('explode of a rotated and scaled instance applies the affine transform to the body', async () => {
    const { host, registry, root, bodyRef, makeGroup, setInstanceTransform } = setup();
    const boxId = registry.execute('model.addBox', { min: [0, 0, 0], max: [1, 1, 1] }) as number;
    registry.execute('selection.set', { refs: [bodyRef(boxId)] });
    const made = makeGroup();
    // rotate 90° about Z, then scale x by 2, then translate: a non-rigid instance
    const m = m4mul(m4translation([10, 0, 0]), m4mul([2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], m4rotationAxis([0, 0, 1], Math.PI / 2)));
    setInstanceTransform([], made.instanceId!, m);
    registry.execute('selection.set', { refs: [{ kind: 'instance', path: [], id: made.instanceId }] });
    registry.execute('group.explode', {});
    const body = [...root().bodies.values()][0]!;
    const mb = meshBounds(body.mesh);
    // local box 0..1 → rotated (x→y, y→-x) → scaled x2 in x → translated by 10: x ∈ [8, 10], y ∈ [0, 1]
    expect(mb.min.map((v) => +v.toFixed(9))).toEqual([8, 0, 0]);
    expect(mb.max.map((v) => +v.toFixed(9))).toEqual([10, 1, 1]);
    expect(body.props.volume).toBeCloseTo(2, 9);
    expect(body.valid).toBe(true);
    expect(body.faces.size).toBe(6);
    await expect(host.doc.state.definitions.has(made.definitionId as never)).toBe(false);
  });
});

/** Put an active section plane (cutting away local x < 0.5) and a dimension into a definition, as a SketchUp import does. */
function addAnnotations(s: ReturnType<typeof setup>, definitionId: number): { planeId: Id; dimensionId: Id } {
  const ids = { planeId: 0 as Id, dimensionId: 0 as Id };
  s.host.doc.transact('annotations', (draft) => {
    const c = draft.definitions.get(definitionId as never)!.entities;
    const common = { tagId: draft.defaultTagId, hidden: false, locked: false, castShadows: false, receiveShadows: false, attributes: { a: { b: 1 } } };
    ids.planeId = allocId<Id>(draft);
    ids.dimensionId = allocId<Id>(draft);
    c.sectionPlanes.set(ids.planeId, { ...common, id: ids.planeId, name: 'Cut', symbol: 'A', plane: { n: [1, 0, 0], d: -0.5 }, origin: [0.5, 0, 0] } as never);
    c.activeSectionPlaneId = ids.planeId;
    c.dimensions.set(ids.dimensionId, { ...common, id: ids.dimensionId, kind: 'linear', start: [0, 0, 0], end: [1, 0, 0], offset: [0, 0.5, 0], normal: [0, 0, 1], text: null, fontSizePt: 10 } as never);
    c.order.push(ids.planeId, ids.dimensionId);
  });
  return ids;
}

describe('section planes and dimensions inside definitions', () => {
  it('explode maps them through a mirrored instance, keeps the cut side and makes the plane active', () => {
    const s = setup();
    const { host, registry, root, bodyRef, makeGroup, setInstanceTransform } = s;
    const boxId = registry.execute('model.addBox', { min: [0, 0, 0], max: [1, 1, 1] }) as number;
    registry.execute('selection.set', { refs: [bodyRef(boxId)] });
    const made = makeGroup();
    const { planeId, dimensionId } = addAnnotations(s, made.definitionId);
    setInstanceTransform([], made.instanceId!, m4mul(m4translation([10, 0, 0]), [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
    const res = registry.execute('group.explode', { refs: [{ kind: 'instance', path: [], id: made.instanceId }] }) as ExplodeResult;
    expect(res.refs.map((r) => r.kind)).toEqual(['body', 'sectionPlane', 'dimension']);
    const plane = root().sectionPlanes.get(planeId)!;
    // Local x > 0.5 is kept; after the mirror about x = 0 and the move to +10 that is world x < 9.5.
    expect(plane.origin).toEqual([9.5, 0, 0]);
    expect(plane.plane.n.map((v) => v + 0)).toEqual([-1, 0, 0]);
    expect(plane.plane.d).toBeCloseTo(9.5, 12);
    expect(root().activeSectionPlaneId).toBe(planeId);
    const dim = root().dimensions.get(dimensionId)!;
    expect([dim.start, dim.end, dim.offset, dim.normal].map((v) => v.map((x) => x + 0))).toEqual([[10, 0, 0], [9, 0, 0], [0, 0.5, 0], [0, 0, 1]]);
    expect(root().order).toEqual(expect.arrayContaining([planeId, dimensionId]));
    host.undo();
    expect(root().sectionPlanes.size).toBe(0);
    expect(root().activeSectionPlaneId).toBeNull();
  });

  it('makeUnique copies them under new ids with the active plane', async () => {
    const s = setup();
    const { host, registry, bodyRef, instanceRef, apply } = s;
    const boxId = registry.execute('model.addBox', { min: [0, 0, 0], max: [1, 1, 1] }) as number;
    registry.execute('selection.set', { refs: [bodyRef(boxId)] });
    const made = registry.execute('component.make', { name: 'Box' }) as MakeResult;
    const { planeId, dimensionId } = addAnnotations(s, made.definitionId);
    const copied = (await apply({ refs: [instanceRef(made.instanceId!)], matrix: m4translation([5, 0, 0]), copy: true, label: 'Move' })) as TransformApplyResult;
    const unique = registry.execute('component.makeUnique', { refs: [copied.refs[0]!] }) as MakeUniqueResult;
    const src = host.doc.state.definitions.get(made.definitionId as never)!.entities;
    const dst = host.doc.state.definitions.get(unique.createdDefinitionIds[0]! as never)!.entities;
    const [plane] = [...dst.sectionPlanes.values()], [dim] = [...dst.dimensions.values()];
    expect(plane!.id).not.toBe(planeId);
    expect(dim!.id).not.toBe(dimensionId);
    expect(dst.activeSectionPlaneId).toBe(plane!.id);
    expect(dst.order).toEqual(expect.arrayContaining([plane!.id, dim!.id]));
    const strip = <T extends { id: Id }>(e: T): Omit<T, 'id'> => { const { id: _id, ...rest } = e; return rest; };
    expect(strip(plane!)).toEqual(strip(src.sectionPlanes.get(planeId)!));
    expect(strip(dim!)).toEqual(strip(src.dimensions.get(dimensionId)!));
    expect(plane!.attributes).not.toBe(src.sectionPlanes.get(planeId)!.attributes);
  });
});

describe('texture placements through Make Group and Explode', () => {
  /** Texture coordinates at every boundary point of every face side in `c`, keyed by the point mapped by `m`. */
  const textureCoords = (c: EntityContainer, tile: { widthM: number; heightM: number }, m: Mat4 | MMat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) => {
    const out = new Map<string, number[]>();
    const add = (side: string, basis: PlaneBasis, uv: UvMapping, points: readonly Vec3[]): void => {
      const a = uvToAffine(uv, tile.widthM, tile.heightM);
      for (const p of points) {
        const l = basisToLocal(basis, p);
        out.set(`${side}:${m4transformPoint(m, p).map((x) => x.toFixed(6)).join(',')}`, [...uvApply(a, l[0], l[1])]);
      }
    };
    for (const f of c.sketch.faces.values()) {
      const pts = sketchFaceLoops(c.sketch, f).flat();
      add('front', f.basis, f.uv, pts);
      add('back', f.basis, f.uvBack ?? f.uv, pts);
    }
    for (const b of c.bodies.values()) for (const f of b.faces.values()) {
      add('front', f.basis, f.uv, f.loops.flat());
      add('back', f.basis, f.uvBack ?? f.uv, f.loops.flat());
    }
    return out;
  };

  it('keeps each face side\'s texture coordinates when grouping and when exploding a rotated, scaled instance', () => {
    const { host, registry, root, bodyRef, makeGroup, setInstanceTransform } = setup();
    const tile = { widthM: 0.5, heightM: 0.25 };
    const boxId = registry.execute('model.addBox', { min: [2, 3, 0], max: [3, 4, 1] }) as number;
    registry.execute('sketch.rectangle', { a: [4, 3, 0], b: [6, 3, 0], c: [6, 3, 2], d: [4, 3, 2] });
    host.doc.transact('Texture', (draft) => {
      const id = allocId<MaterialId>(draft);
      draft.materials.set(id, { id, name: 'Tex', color: [1, 1, 1], alpha: 1, texture: { imageId: 1 as ImageId, ...tile, colorize: false } });
      const c = draft.definitions.get(draft.rootDefinitionId)!.entities;
      for (const f of c.sketch.faces.values()) {
        f.frontMaterialId = id;
        f.backMaterialId = id;
        f.uv = { kind: 'affine', matrix: [1, 0.5, 0.3, -0.2, 2, 0.1] };
        f.uvBack = { kind: 'affine', matrix: [-1, 0, 0.7, 0, 3, 0] };
      }
      const body = c.bodies.get(boxId as Id)!;
      body.materialId = id;
      [...body.faces.values()][0]!.uv = { kind: 'affine', matrix: [0, 1, 0.2, 1, 0, 0.4] };
    });
    const world = textureCoords(root(), tile);
    const faceId = [...root().sketch.faces.keys()][0]!;
    registry.execute('selection.set', { refs: [bodyRef(boxId), { kind: 'sketchFace', path: [], id: faceId }] });
    const made = makeGroup();
    const inst = root().instances.get(made.instanceId as Id)!;
    const grouped = textureCoords(host.doc.state.definitions.get(made.definitionId as never)!.entities, tile, inst.transform);
    expect([...grouped.keys()].sort()).toEqual([...world.keys()].sort());
    for (const [k, st] of world) {
      expect(grouped.get(k)![0]).toBeCloseTo(st[0]!, 9);
      expect(grouped.get(k)![1]).toBeCloseTo(st[1]!, 9);
    }

    // Rotated 60° about X and scaled 1.5 × 2 × 1, as a SketchUp component placement can be.
    const m = m4mul(m4translation([1, 2, 3]), m4mul([1.5, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], m4rotationAxis([1, 0, 0], Math.PI / 3)));
    setInstanceTransform([], made.instanceId!, m);
    const placed = textureCoords(host.doc.state.definitions.get(made.definitionId as never)!.entities, tile, m);
    registry.execute('selection.set', { refs: [{ kind: 'instance', path: [], id: made.instanceId }] });
    registry.execute('group.explode', {});
    const exploded = textureCoords(root(), tile);
    expect(exploded.size).toBe(placed.size);
    for (const [k, st] of placed) {
      expect(exploded.get(k), k).toBeDefined();
      expect(exploded.get(k)![0]).toBeCloseTo(st[0]!, 9);
      expect(exploded.get(k)![1]).toBeCloseTo(st[1]!, 9);
    }
  });

  it('leaves untextured and unmoved automatic placements automatic', () => {
    const { host, registry, root, makeGroup } = setup();
    registry.execute('sketch.rectangle', { a: [0, 0, 0], b: [2, 0, 0], c: [2, 2, 0], d: [0, 2, 0] });
    const faceId = [...root().sketch.faces.keys()][0]!;
    registry.execute('selection.set', { refs: [{ kind: 'sketchFace', path: [], id: faceId }] });
    const made = makeGroup();
    const face = [...host.doc.state.definitions.get(made.definitionId as never)!.entities.sketch.faces.values()][0]!;
    expect(face.uv).toEqual({ kind: 'auto' });
    expect(face.uvBack).toBeUndefined();
  });
});

describe('component.make / component.makeUnique', () => {
  it('makes a named component, copies the instance, and makeUnique isolates edits', async () => {
    const { host, registry, root, bodyRef, instanceRef, apply } = setup();
    const boxId = registry.execute('model.addBox', { min: [0, 0, 0], max: [1, 1, 1] }) as number;
    registry.execute('selection.set', { refs: [bodyRef(boxId)] });
    const made = registry.execute('component.make', { name: 'Box', glueTo: 'any', cutOpening: true }) as MakeResult;
    const def = host.doc.state.definitions.get(made.definitionId as never)!;
    expect(def.isGroup).toBe(false);
    expect(def.name).toBe('Box');
    expect(def.behaviors).toMatchObject({ glueTo: 'any', cutsOpening: true, alwaysFaceCamera: false });

    const copied = (await apply({ refs: [instanceRef(made.instanceId!)], matrix: m4translation([5, 0, 0]), copy: true, label: 'Move' })) as TransformApplyResult;
    expect(copied.refs).toHaveLength(1);
    const second = copied.refs[0]!;
    expect(second.kind).toBe('instance');
    expect(root().instances.size).toBe(2);
    expect(instanceInfo(host.doc.state, instanceRef(made.instanceId!)).instanceCount).toBe(2);

    const unique = registry.execute('component.makeUnique', { refs: [second] }) as MakeUniqueResult;
    expect(unique.createdDefinitionIds).toHaveLength(1);
    const uniqueDefId = unique.createdDefinitionIds[0]!;
    expect(host.doc.state.definitions.get(uniqueDefId as never)!.name).toBe('Box#1');
    expect(root().instances.get(second.id)!.definitionId).toBe(uniqueDefId);
    expect(root().instances.get(made.instanceId as Id)!.definitionId).toBe(made.definitionId);
    const uniqueBody = [...host.doc.state.definitions.get(uniqueDefId as never)!.entities.bodies.values()][0]!;
    expect(uniqueBody.id).not.toBe(boxId);

    // edit inside the unique instance: the original definition is untouched
    registry.execute('context.enter', { path: [second.id] });
    expect(host.context.definitionId).toBe(uniqueDefId);
    const face = topFace(uniqueBody);
    const res = (await registry.execute('pushpull.apply', {
      target: { kind: 'face', path: [second.id], id: uniqueBody.id, faceId: face.id, region: null },
      distance: 1,
      mode: 'merge',
    })) as PushPullApplyResult;
    expect(res.bodyIds).toEqual([uniqueBody.id]);
    const after = [...host.doc.state.definitions.get(uniqueDefId as never)!.entities.bodies.values()][0]!;
    expect(after.props.volume).toBeCloseTo(2, 9);
    const original = [...host.doc.state.definitions.get(made.definitionId as never)!.entities.bodies.values()][0]!;
    expect(original.props.volume).toBeCloseTo(1, 9);
    const info = instanceInfo(host.doc.state, instanceRef(second.id));
    expect(info).toMatchObject({ definitionName: 'Box#1', isGroup: false, instanceCount: 1, solid: true });
    expect(info.volume).toBeCloseTo(2, 9);
    expect(info.bounds).toEqual({ min: [5, 0, 0], max: [6, 1, 2] });

    // makeUnique on the only instance of a definition is a no-op (refs must be in the open context)
    expect(() => registry.execute('component.makeUnique', { refs: [second] })).toThrow(/edit context/);
    registry.execute('context.exitAll', {});
    const noop = registry.execute('component.makeUnique', { refs: [second] }) as MakeUniqueResult;
    expect(noop.createdDefinitionIds).toEqual([]);
  });

  it('component.make without replaceSelection keeps the loose geometry and creates no instance', () => {
    const { host, registry, root, bodyRef } = setup();
    const boxId = registry.execute('model.addBox', { min: [0, 0, 0], max: [1, 1, 1] }) as number;
    const res = registry.execute('component.make', { refs: [bodyRef(boxId)], replaceSelection: false }) as MakeResult;
    expect(res.instanceId).toBeNull();
    expect(root().bodies.size).toBe(1);
    expect(root().instances.size).toBe(0);
    const def = host.doc.state.definitions.get(res.definitionId as never)!;
    expect(def.name).toBe('Component#1');
    expect(def.entities.bodies.size).toBe(1);
    const res2 = registry.execute('component.make', { refs: [bodyRef(boxId)], replaceSelection: false }) as MakeResult;
    expect(host.doc.state.definitions.get(res2.definitionId as never)!.name).toBe('Component#2');
  });
});

describe('context.* commands', () => {
  it('enter validates the path, refuses locked instances, exit goes up, and events fire', () => {
    const { host, registry, bodyRef, instanceRef, makeGroup } = setup();
    const boxId = registry.execute('model.addBox', {}) as number;
    registry.execute('selection.set', { refs: [bodyRef(boxId)] });
    const made = makeGroup();
    const events: string[] = [];
    host.events.on('contextChanged', (e) => events.push(e.context.path.join('.')));

    expect(() => registry.execute('context.enter', { path: [999] })).toThrow(/No instance 999/);
    expect(() => registry.execute('context.enter', { path: [boxId] })).toThrow(/No instance/);
    registry.execute('selection.set', { refs: [instanceRef(made.instanceId!)] });
    const info = registry.execute('context.enter', { path: [made.instanceId] }) as { path: number[]; definitionId: number };
    expect(info).toMatchObject({ path: [made.instanceId], definitionId: made.definitionId });
    expect(host.selection.isEmpty).toBe(true);
    expect(events).toEqual([String(made.instanceId)]);
    expect(registry.execute('context.get')).toMatchObject({ path: [made.instanceId], definitionId: made.definitionId });

    registry.execute('context.exit', {});
    expect(host.context.path).toEqual([]);
    registry.execute('context.enter', { instanceId: made.instanceId });
    expect(host.context.path).toEqual([made.instanceId]);
    registry.execute('context.exitAll', {});
    expect(host.context.path).toEqual([]);

    registry.execute('instance.setLocked', { refs: [instanceRef(made.instanceId!)], locked: true });
    expect(() => registry.execute('context.enter', { path: [made.instanceId] })).toThrow(/locked/);
    expect(() => registry.execute('group.explode', { refs: [instanceRef(made.instanceId!)] })).toThrow(/locked/);
    registry.execute('instance.setLocked', { refs: [instanceRef(made.instanceId!)], locked: false });
    registry.execute('context.enter', { path: [made.instanceId] });
    expect(host.context.path).toEqual([made.instanceId]);
    // undo past the group creation drops the context back to the root
    registry.execute('context.exitAll', {});
    registry.execute('context.enter', { path: [made.instanceId] });
    while (host.undoStack.length) host.undo();
    expect(host.context.path).toEqual([]);
  });

  it('rename / hide commands and definition name uniqueness', () => {
    const { host, registry, bodyRef, instanceRef, makeGroup } = setup();
    const boxId = registry.execute('model.addBox', {}) as number;
    const made = makeGroup([bodyRef(boxId)]);
    registry.execute('instance.rename', { ref: instanceRef(made.instanceId!), name: 'Left wall' });
    registry.execute('definition.rename', { definitionId: made.definitionId, name: 'Wall' });
    registry.execute('instance.setHidden', { refs: [instanceRef(made.instanceId!)], hidden: true });
    const info = instanceInfo(host.doc.state, instanceRef(made.instanceId!));
    expect(info).toMatchObject({ instanceName: 'Left wall', definitionName: 'Wall', hidden: true, isGroup: true });
    expect(() => registry.execute('definition.rename', { definitionId: made.definitionId, name: 'Model' })).toThrow(/already exists/);
  });
});

describe('editing inside a context', () => {
  /** A group whose instance is translated by (10,0,0) and rotated 90° about Z; returns its instance id. */
  function rotatedGroup(s: ReturnType<typeof setup>): number {
    const boxId = s.registry.execute('model.addBox', { min: [0, 0, 0], max: [1, 1, 1] }) as number;
    const made = s.makeGroup([s.bodyRef(boxId)]);
    s.setInstanceTransform([], made.instanceId!, m4mul(m4translation([10, 0, 0]), m4rotationAxis([0, 0, 1], Math.PI / 2)));
    s.registry.execute('context.enter', { path: [made.instanceId] });
    return made.instanceId!;
  }

  it('rectangle + push/pull inside a translated and rotated group: world points → local geometry → world bounds', async () => {
    const s = setup();
    const inst = rotatedGroup(s);
    const path = [inst];
    const def = () => s.host.doc.state.definitions.get(s.host.context.definitionId)!;
    // world rectangle x ∈ [9, 10], y ∈ [3, 5] on the ground (clear of the box): local x ∈ [3, 5], y ∈ [0, 1]
    s.registry.execute('sketch.rectangle', { a: [10, 3, 0], b: [10, 5, 0], c: [9, 5, 0], d: [9, 3, 0] });
    expect(s.root().sketch.edges.size).toBe(0);
    expect(def().entities.sketch.faces.size).toBe(1);
    const face = [...def().entities.sketch.faces.values()][0]!;
    const pts = sortedPoints(face.loops[0]!.flatMap((r) => {
      const e = def().entities.sketch.edges.get(r.edgeId)!;
      return def().entities.sketch.vertices.get(r.forward ? e.a : e.b)!.p.map((v) => +v.toFixed(9));
    }));
    expect(pts).toEqual([[3, 0, 0], [3, 1, 0], [5, 0, 0], [5, 1, 0]]);

    // pull 1 m upwards in world (+z, which is +z locally too)
    const worldNormal = m4transformPoint(m4rotationAxis([0, 0, 1], Math.PI / 2), face.plane.n);
    const distance = worldNormal[2] > 0 ? 1 : -1;
    const res = (await s.registry.execute('pushpull.apply', { target: { kind: 'sketchFace', path, id: face.id }, distance, mode: 'merge' })) as PushPullApplyResult;
    expect(res.bodyIds).toHaveLength(1);
    expect(def().entities.sketch.faces.size).toBe(0);
    const body = def().entities.bodies.get(res.bodyIds[0] as Id)!;
    const lb = meshBounds(body.mesh);
    expect(lb.min.map((v) => +v.toFixed(9))).toEqual([3, 0, 0]);
    expect(lb.max.map((v) => +v.toFixed(9))).toEqual([5, 1, 1]);
    expect(body.props.volume).toBeCloseTo(2, 9);
    const m = contextMatrix(s.host.doc.state, path as Id[]);
    const worldPts = sortedPoints(Array.from(body.mesh.verts).reduce<number[]>((acc, _, i, arr) => {
      if (i % 3 === 0) acc.push(...m4transformPoint(m, [arr[i]!, arr[i + 1]!, arr[i + 2]!]).map((v) => +v.toFixed(9)));
      return acc;
    }, []));
    expect(worldPts[0]).toEqual([9, 3, 0]);
    expect(worldPts[worldPts.length - 1]).toEqual([10, 5, 1]);

    // a root-path target is rejected while editing the group
    await expect(s.registry.execute('pushpull.apply', { target: { kind: 'sketchFace', path: [], id: face.id }, distance: 1, mode: 'merge' })).rejects.toThrow(/edit context/);
  });

  it('move of a body inside a rotated group converts the world translation to local', async () => {
    const s = setup();
    const inst = rotatedGroup(s);
    const def = () => s.host.doc.state.definitions.get(s.host.context.definitionId)!;
    const body = [...def().entities.bodies.values()][0]!;
    const before = meshBounds(body.mesh);
    const res = await s.apply({ refs: [s.bodyRef(body.id, [inst])], matrix: m4translation([0, 5, 0]), label: 'Move' });
    expect(res.refs).toEqual([{ kind: 'body', path: [inst], id: body.id }]);
    const after = meshBounds(def().entities.bodies.get(body.id)!.mesh);
    // world +y is local +x under Rz(90°)⁻¹
    expect(after.min.map((v, i) => +(v - before.min[i]!).toFixed(9))).toEqual([5, 0, 0]);
    const m = contextMatrix(s.host.doc.state, [inst] as Id[]);
    expect(m4transformPoint(m, after.min).map((v) => +v.toFixed(9))).toEqual([10, 5, 0]);
    // refs from the root while inside the group are rejected
    await expect(s.apply({ refs: [s.bodyRef(body.id, [])], matrix: m4translation([0, 5, 0]), label: 'Move' })).rejects.toThrow(/edit context/);
  });

  it('select all / delete inside a group act on the group container only', () => {
    const s = setup();
    const inst = rotatedGroup(s);
    const path = [inst];
    const def = () => s.host.doc.state.definitions.get(s.host.context.definitionId)!;
    s.registry.execute('sketch.addEdge', { a: [10, 0, 0], b: [10, 2, 0] });
    expect(def().entities.sketch.edges.size).toBe(1);
    s.registry.execute('edit.selectAll', {});
    expect(s.host.selection.refs.map((r) => r.kind).sort()).toEqual(['body', 'sketchEdge']);
    expect(s.host.selection.refs.every((r) => r.path.length === 1 && r.path[0] === inst)).toBe(true);
    const edgeId = [...def().entities.sketch.edges.keys()][0]!;
    s.registry.execute('selection.set', { refs: [{ kind: 'sketchEdge', path, id: edgeId }, { kind: 'instance', path: [], id: inst }] });
    const r = s.registry.execute('edit.delete', {}) as { removed: number; skipped: number };
    expect(r).toMatchObject({ removed: 1, skipped: 1 });
    expect(def().entities.sketch.edges.size).toBe(0);
    expect(s.root().instances.size).toBe(1);
    expect(def().entities.bodies.size).toBe(1);
  });

  it('nested group: context matrices compose and push/pull adds 1 m × area of world volume', async () => {
    const s = setup();
    const boxId = s.registry.execute('model.addBox', { min: [0, 0, 0], max: [2, 1, 1] }) as number;
    const outer = s.makeGroup([s.bodyRef(boxId)]);
    s.setInstanceTransform([], outer.instanceId!, m4translation([10, 0, 0]));
    s.registry.execute('context.enter', { path: [outer.instanceId] });
    const inner = s.makeGroup([s.bodyRef(boxId, [outer.instanceId!])]);
    s.setInstanceTransform([outer.instanceId!], inner.instanceId!, m4mul(m4translation([0, 5, 0]), m4rotationAxis([0, 0, 1], Math.PI / 2)));
    const path = [outer.instanceId!, inner.instanceId!];
    s.registry.execute('context.enter', { path });
    const ctx = s.registry.execute('context.get') as { matrix: number[] };
    expect(m4transformPoint(ctx.matrix, [1, 0, 0]).map((v) => +v.toFixed(9))).toEqual([10, 6, 0]);
    const def = s.host.doc.state.definitions.get(s.host.context.definitionId)!;
    const body = [...def.entities.bodies.values()][0]!;
    const face = topFace(body);
    const area = 2;
    const res = (await s.registry.execute('pushpull.apply', { target: { kind: 'face', path, id: body.id, faceId: face.id, region: null }, distance: 1, mode: 'merge' })) as PushPullApplyResult;
    expect(res.bodyIds).toEqual([body.id]);
    const after = s.host.doc.state.definitions.get(s.host.context.definitionId)!.entities.bodies.get(body.id)!;
    expect(after.props.volume).toBeCloseTo(body.props.volume + 1 * area, 9);
    const info = instanceInfo(s.host.doc.state, s.instanceRef(inner.instanceId!, [outer.instanceId!]));
    expect(info.volume).toBeCloseTo(4, 9);
    expect(info.bounds!.max.map((v) => +v.toFixed(9))).toEqual([10, 7, 2]);
    expect(info.bounds!.min.map((v) => +v.toFixed(9))).toEqual([9, 5, 0]);
    const outerInfo = instanceInfo(s.host.doc.state, s.instanceRef(outer.instanceId!));
    expect(outerInfo.bounds!.min.map((v) => +v.toFixed(9))).toEqual([9, 5, 0]);
    expect(outerInfo.solid).toBe(false); // the outer definition holds only an instance

    // push/pull along a rotated normal: the +x face of the body points to world +y
    const xFace = [...after.faces.values()].find((f) => v3eq(f.plane.n, [1, 0, 0]))!;
    const r2 = (await s.registry.execute('pushpull.apply', { target: { kind: 'face', path, id: body.id, faceId: xFace.id, region: null }, distance: 0.5, mode: 'merge' })) as PushPullApplyResult;
    expect(r2.bodyIds).toEqual([body.id]);
    const after2 = s.host.doc.state.definitions.get(s.host.context.definitionId)!.entities.bodies.get(body.id)!;
    expect(meshBounds(after2.mesh).max.map((v) => +v.toFixed(9))).toEqual([2.5, 1, 2]);
    const worldMax: Vec3 = instanceInfo(s.host.doc.state, s.instanceRef(inner.instanceId!, [outer.instanceId!])).bounds!.max;
    expect(worldMax.map((v) => +v.toFixed(9))).toEqual([10, 7.5, 2]);
  });
});

describe('bodies.setHidden', () => {
  it('hides and shows loose solids, drops hidden ones from the selection, and undoes', () => {
    const { registry, host, bodyRef, makeGroup } = setup();
    const a = registry.execute('model.addBox', { min: [0, 0, 0], max: [1, 1, 1] }) as number;
    const b = registry.execute('model.addBox', { min: [3, 0, 0], max: [4, 1, 1] }) as number;
    const root = () => containerAt(host.doc.state, []);
    host.selection.set([bodyRef(a), bodyRef(b)]);
    expect(registry.execute('bodies.setHidden', { refs: [bodyRef(a)], hidden: true })).toBe(1);
    expect(root().bodies.get(a as Id)!.hidden).toBe(true);
    expect(host.selection.refs).toEqual([bodyRef(b)]);
    host.undo();
    expect(root().bodies.get(a as Id)!.hidden).toBe(false);

    // A solid inside a group is addressed by the group's path; instance refs are ignored.
    const group = makeGroup([bodyRef(b)]).instanceId!;
    const inner = [...containerAt(host.doc.state, [group as Id]).bodies.keys()][0]!;
    expect(registry.execute('bodies.setHidden', { refs: [bodyRef(inner, [group]), { kind: 'instance', path: [], id: group as Id }], hidden: true })).toBe(1);
    expect(containerAt(host.doc.state, [group as Id]).bodies.get(inner)!.hidden).toBe(true);
    expect(registry.execute('bodies.setHidden', { refs: [bodyRef(inner, [group])], hidden: false })).toBe(1);
    expect(containerAt(host.doc.state, [group as Id]).bodies.get(inner)!.hidden).toBe(false);
  });
});
