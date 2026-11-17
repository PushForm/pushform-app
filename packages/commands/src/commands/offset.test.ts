// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import type { Id, Mat4, MaterialId, Vec3 } from '@pushform/core';
import { v3eq } from '@pushform/core';
import { tessellateArc, tessellateCircle } from '@pushform/geom';
import { allocId, computeRegions, containerAt, SketchGraph, type Body, type FaceRecord } from '@pushform/model';
import { disposeKernels, setupCommands } from './transform.fixtures';
import { contextCommands } from './context';
import { curveCommands, type AddCurveInput, type AddCurveResult } from './curves';
import { groupCommands, type MakeResult } from './groups';
import { offsetCommands, edgeChainProblem, type OffsetApplyResult } from './offset';
import { tagCommands } from './tags';

afterEach(disposeKernels);

function setup() {
  const s = setupCommands();
  s.registry.registerAll(offsetCommands);
  s.registry.registerAll(curveCommands);
  s.registry.registerAll(groupCommands);
  s.registry.registerAll(contextCommands);
  s.registry.registerAll(tagCommands);
  const sketch = () => s.root().sketch;
  const offset = (params: unknown): OffsetApplyResult => s.registry.execute('sketch.offset', params) as OffsetApplyResult;
  const addCircle = (center: Vec3, radius: number, segments = 24): AddCurveResult => {
    const t = tessellateCircle(center, [0, 0, 1], radius, segments);
    const input: AddCurveInput = { points: t.points, closed: true, curve: t.curve };
    return s.registry.execute('sketch.addCurve', input) as AddCurveResult;
  };
  return { ...s, sketch, offset, addCircle };
}

const topFace = (body: Body): FaceRecord => {
  const f = [...body.faces.values()].find((r) => v3eq(r.plane.n, [0, 0, 1]));
  if (!f) throw new Error('no +z face');
  return f;
};

describe('sketch.offset', () => {
  it('gives the face inside an inward offset the original face\'s material and tag; new edges and ring faces take the active tag', () => {
    const s = setup();
    s.addRectangle();
    const face = [...s.sketch().faces.values()][0]!;
    const wood = s.registry.execute('tag.create', { name: 'Wood' }) as number;
    const active = s.registry.execute('tag.create', { name: 'Active' }) as number;
    s.host.doc.transact('Paint', (draft) => {
      const id = allocId<MaterialId>(draft);
      draft.materials.set(id, { id, name: 'Oak', color: [0.6, 0.4, 0.2], alpha: 1 } as never);
      const f = draft.definitions.get(draft.rootDefinitionId)!.entities.sketch.faces.get(face.id)!;
      f.frontMaterialId = id;
      f.backMaterialId = id;
      f.tagId = wood as never;
    });
    const material = s.sketch().faces.get(face.id)!.frontMaterialId;
    s.registry.execute('tag.setActive', { id: active });

    const inward = s.offset({ faceRef: { kind: 'sketchFace', path: [], id: face.id }, distance: -0.2 });
    expect(s.sketch().faces.size).toBe(2);
    const inner = [...s.sketch().faces.values()].find((f) => f.id !== face.id)!;
    expect(inner.frontMaterialId).toBe(material);
    expect(inner.backMaterialId).toBe(material);
    expect(inner.tagId).toBe(wood);
    expect(s.sketch().faces.get(face.id)!.tagId).toBe(wood);
    for (const id of inward.edgeIds) expect(s.sketch().edges.get(id as Id)!.tagId).toBe(active);

    // an outward offset adds a ring face on the active tag
    s.offset({ faceRef: { kind: 'sketchFace', path: [], id: face.id }, distance: 0.3 });
    const ring = [...s.sketch().faces.values()].find((f) => f.id !== face.id && f.id !== inner.id)!;
    expect(ring.tagId).toBe(active);
    expect(ring.frontMaterialId).toBeNull();
  });

  it('refuses an offset that leaves nothing, and a distance of zero, without an undo entry', () => {
    const s = setup();
    s.addRectangle();
    const face = [...s.sketch().faces.values()][0]!;
    const entries = s.host.undoStack.length;
    expect(() => s.offset({ faceRef: { kind: 'sketchFace', path: [], id: face.id }, distance: -0.6 })).toThrow(/Nothing is left/);
    expect(() => s.offset({ faceRef: { kind: 'sketchFace', path: [], id: face.id }, distance: 0 })).toThrow(/zero/);
    expect(s.host.undoStack.length).toBe(entries);
    expect(s.sketch().edges.size).toBe(4);
  });

  it('refuses an outward offset of a solid\'s face that would leave the face; a region may grow within it', () => {
    const s = setup();
    const id = s.addBox([0, 0, 0], [1, 1, 1]);
    const top = topFace(s.body(id));
    const ref = (region: number | null) => ({ kind: 'face', path: [], id, faceId: top.id, region });
    const entries = s.host.undoStack.length;
    expect(() => s.offset({ faceRef: ref(null), distance: 0.1 })).toThrow(/past the edges of the face/);
    expect(s.host.undoStack.length).toBe(entries);
    expect(s.body(id).imprints.get(top.id)?.edges.size ?? 0).toBe(0);
    // an inset of 0.3 leaves an inner region 0.4 wide; growing it by 0.1 stays on the face
    s.offset({ faceRef: ref(null), distance: -0.3 });
    const regions = computeRegions(s.body(id), top.id);
    const inner = regions.find((r) => Math.abs(r.area - 0.16) < 1e-9)!;
    s.offset({ faceRef: ref(inner.index), distance: 0.1 });
    expect(computeRegions(s.body(id), top.id)).toHaveLength(3);
    // growing it past the face's edge is refused
    const inner2 = computeRegions(s.body(id), top.id).find((r) => Math.abs(r.area - 0.16) < 1e-9)!;
    expect(() => s.offset({ faceRef: ref(inner2.index), distance: 0.5 })).toThrow(/past the edges/);
  });

  it('keeps a circle on a solid\'s face a circle with the same segment count', async () => {
    const s = setup();
    s.addCircle([0, 0, 0], 1, 24);
    const face = [...s.sketch().faces.values()][0]!;
    await s.registry.execute('pushpull.apply', { target: { kind: 'sketchFace', path: [], id: face.id }, distance: 1, mode: 'merge' });
    const body = s.bodies()[0]!;
    const cap = [...body.faces.values()].find((f) => f.loops[0]!.length === 24 && Math.abs(f.plane.n[2]) > 0.99)!;
    const before = new Set(body.curves.keys());
    const res = s.offset({ faceRef: { kind: 'face', path: [], id: body.id, faceId: cap.id, region: null }, distance: -0.25 });
    expect(res.edgeIds).toHaveLength(24);
    const after = s.bodies()[0]!;
    const added = [...after.curves.values()].filter((c) => !before.has(c.id));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ kind: 'circle', segments: 24 });
    expect(added[0]!.radius).toBeCloseTo(0.75);
    const imprint = after.imprints.get(cap.id)!;
    for (const eid of res.edgeIds) expect(imprint.edges.get(eid)!.curveId).toBe(added[0]!.id);
  });

  it('keeps an arc in an open chain an arc', () => {
    const s = setup();
    const t = tessellateArc([0, 0, 0], [0, 0, 1], 1, 0, Math.PI / 2, 6);
    const arc = s.registry.execute('sketch.addCurve', { points: t.points, closed: false, curve: t.curve }) as AddCurveResult;
    const line = s.registry.execute('sketch.addEdge', { a: [0, 1, 0], b: [-1, 1, 0] }) as number[];
    const res = s.offset({ edgeIds: [...arc.edgeIds, ...line], distance: 0.2 });
    const curves = [...s.sketch().curves.values()].filter((c) => c.id !== arc.curveId);
    expect(curves).toHaveLength(1);
    expect(curves[0]!.segments).toBe(6);
    expect([0.8, 1.2].some((r) => Math.abs(curves[0]!.radius - r) < 1e-9)).toBe(true);
    const onCurve = res.edgeIds.filter((id) => s.sketch().edges.get(id as Id)?.curveId === curves[0]!.id);
    expect(onCurve).toHaveLength(6);
  });

  it('measures the distance in the model inside a scaled group', () => {
    const s = setup();
    s.addRectangle();
    s.registry.execute('selection.set', { refs: [...s.sketch().edges.keys()].map((id) => ({ kind: 'sketchEdge', path: [], id })) });
    const made = s.registry.execute('group.make', {}) as MakeResult;
    s.host.doc.transact('scale', (draft) => {
      containerAt(draft as never, []).instances.get(made.instanceId as Id)!.transform = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1] as unknown as Mat4;
    });
    s.registry.execute('context.enter', { instanceId: made.instanceId });
    const inner = () => containerAt(s.host.doc.state, [made.instanceId as Id]).sketch;
    const face = [...inner().faces.values()][0]!;
    // 0.2 in the model is 0.1 in the group, which is drawn twice as large
    s.offset({ faceRef: { kind: 'sketchFace', path: [made.instanceId], id: face.id }, distance: -0.2 });
    const sk = inner();
    const other = [...sk.faces.values()].find((f) => f.id !== face.id)!;
    const xs = other.loops[0]!.map((r) => sk.vertices.get(sk.edges.get(r.edgeId)!.a)!.p[0]);
    expect(Math.min(...xs)).toBeCloseTo(0.1);
    expect(Math.max(...xs)).toBeCloseTo(0.9);
    // a chain too
    s.registry.execute('sketch.addEdge', { a: [4, 0, 0], b: [6, 0, 0] });
    s.registry.execute('sketch.addEdge', { a: [6, 0, 0], b: [6, 2, 0] });
    const chain = [...inner().edges.values()].filter((e) => inner().vertices.get(e.a)!.p[0] >= 2 - 1e-9 && inner().vertices.get(e.b)!.p[0] >= 2 - 1e-9).map((e) => e.id);
    expect(chain).toHaveLength(2);
    s.offset({ edgeIds: chain, distance: 0.2 });
    const xs2 = [...inner().vertices.values()].map((v) => +v.p[0].toFixed(6));
    expect(xs2).toContain(3.1);
  });

  it('says why a selection of edges is not a chain', () => {
    const s = setup();
    s.host.edit('Edges', (draft) => {
      const g = SketchGraph.for(draft);
      g.addEdge([0, 0, 0], [1, 0, 0]);
      g.addEdge([1, 0, 0], [1, 1, 0]);
      g.addEdge([1, 0, 0], [2, -1, 0]); // a branch at (1, 0)
      g.addEdge([5, 0, 0], [6, 0, 0]);
      g.addEdge([6, 0, 0], [6, 1, 1]); // rises out of the plane...
      g.addEdge([6, 1, 1], [5, 1, 0]); // ...and comes back down off it
    });
    const sk = s.sketch();
    const left = [...sk.edges.values()].filter((e) => sk.vertices.get(e.a)!.p[0] < 3 && sk.vertices.get(e.b)!.p[0] < 3).map((e) => e.id);
    const right = [...sk.edges.values()].filter((e) => sk.vertices.get(e.a)!.p[0] >= 5 && sk.vertices.get(e.b)!.p[0] >= 5).map((e) => e.id);
    expect(edgeChainProblem(sk, left)).toBe('The selected edges branch');
    expect(edgeChainProblem(sk, [left[0]!, right[0]!])).toBe('The selected edges have gaps');
    expect(edgeChainProblem(sk, right)).toBe('The selected edges do not lie in one plane');
    expect(edgeChainProblem(sk, left.slice(0, 2))).toBeNull();
  });

  it('offsets a chain along one line in the level plane through it', () => {
    const s = setup();
    const a = s.registry.execute('sketch.addEdge', { a: [0, 0, 0], b: [1, 0, 0] }) as number[];
    const b = s.registry.execute('sketch.addEdge', { a: [1, 0, 0], b: [2, 0, 0] }) as number[];
    s.offset({ edgeIds: [...a, ...b], distance: 0.5 });
    const added = [...s.sketch().vertices.values()].filter((v) => Math.abs(v.p[1]) > 1e-9);
    expect(added).toHaveLength(3);
    for (const v of added) {
      expect(Math.abs(v.p[1])).toBeCloseTo(0.5);
      expect(v.p[2]).toBeCloseTo(0);
    }
  });
});
