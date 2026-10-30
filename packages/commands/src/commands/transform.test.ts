// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FaceLocalId, Mat4, Vec3 } from '@pushform/core';
import { m4rotationAxis, m4transformPoint, m4translation, meshBounds, planeDistance, PushFormError, v3dist, v3eq } from '@pushform/core';
import { meshTopologyProblems } from '@pushform/kernel';
import { loopPoints, SketchGraph, type Body, type EntityRef, type FaceRecord } from '@pushform/model';
import { arrayMatrices, m4rotationAbout, m4scaleAbout, rigidMatrixRoot } from './transform';
import { disposeKernels, installBrokenPolyMeshStub, installPolyMeshStub, restorePolyMesh, setupCommands, usingRealPolyMesh } from './transform.fixtures';

beforeAll(installPolyMeshStub);
afterEach(disposeKernels);

const bodyRef = (id: number): EntityRef => ({ kind: 'body', path: [], id: id as never });
const faceWithNormal = (body: Body, n: Vec3): FaceRecord => {
  const f = [...body.faces.values()].find((r) => v3eq(r.plane.n, n));
  if (!f) throw new Error(`no face with normal ${n.join(',')}`);
  return f;
};
const near = (a: Vec3, b: Vec3, tol = 1e-6): boolean => v3dist(a, b) <= tol;

function expectConsistent(body: Body): void {
  expect(meshTopologyProblems(body.mesh)).toEqual([]);
  const mb = meshBounds(body.mesh);
  for (const f of body.faces.values()) {
    for (const loop of f.loops) {
      for (const p of loop) {
        expect(Math.abs(planeDistance(f.plane, p))).toBeLessThan(1e-6);
        for (let a = 0; a < 3; a++) {
          expect(p[a]).toBeGreaterThanOrEqual(mb.min[a]! - 1e-6);
          expect(p[a]).toBeLessThanOrEqual(mb.max[a]! + 1e-6);
        }
      }
    }
  }
  for (const e of body.edges.values()) {
    const fa = body.faces.get(e.faceA)!, fb = body.faces.get(e.faceB)!;
    for (const p of e.polyline) {
      expect(Math.abs(planeDistance(fa.plane, p))).toBeLessThan(1e-6);
      expect(Math.abs(planeDistance(fb.plane, p))).toBeLessThan(1e-6);
    }
  }
}

// ---------------------------------------------------------------------------------------------

describe('transform.apply on bodies', () => {
  it('moves a body 1 m in x in the model (no kernel): bounds, faces and edges shift, one undo entry', async () => {
    const { host, apply, addBox, body } = setupCommands();
    const id = addBox();
    const entries = host.undoStack.length;
    const before = body(id);
    const res = await apply({ refs: [bodyRef(id)], matrix: m4translation([1, 0, 0]) });
    expect(res.bodyIds).toEqual([id]);
    const after = body(id);
    expect(after.version).toBe(before.version + 1);
    const mb = meshBounds(after.mesh);
    expect(near(mb.min, [1, 0, 0])).toBe(true);
    expect(near(mb.max, [2, 1, 1])).toBe(true);
    expect(after.props.volume).toBeCloseTo(1, 9);
    expect(after.faces.size).toBe(6);
    expect(after.edges.size).toBe(12);
    expectConsistent(after);
    expect(near(faceWithNormal(after, [1, 0, 0]).basis.origin, [2, 0, 0])).toBe(true);
    expect(host.undoStack.length).toBe(entries + 1);
    expect(host.undoStack.peek()?.label).toBe('Move');
    expect(host.undo()).toBe(true);
    expect(near(meshBounds(body(id).mesh).min, [0, 0, 0])).toBe(true);
  });

  it('copy: true duplicates the body with a new id and selects the copy', async () => {
    const { host, apply, addBox, bodies, body } = setupCommands();
    const id = addBox();
    const res = await apply({ refs: [bodyRef(id)], matrix: m4translation([0, 2, 0]), copy: true });
    expect(bodies()).toHaveLength(2);
    const copyId = res.refs[0]!.id;
    expect(copyId).not.toBe(id);
    expect(near(meshBounds(body(copyId).mesh).min, [0, 2, 0])).toBe(true);
    expect(near(meshBounds(body(id).mesh).min, [0, 0, 0])).toBe(true);
    expect(body(copyId).faces.size).toBe(6);
    expect(host.selection.refs).toEqual([{ kind: 'body', path: [], id: copyId }]);
    expectConsistent(body(copyId));
  });

  it('transform.array 3x places 3 copies evenly; /3 divides the step', async () => {
    const { registry, addBox, bodies } = setupCommands();
    const id = addBox();
    await registry.execute('transform.array', { refs: [bodyRef(id)], matrix: m4translation([1.5, 0, 0]), count: 3, mode: 'external' });
    const xs = bodies()
      .map((b) => meshBounds(b.mesh).min[0])
      .sort((a, b) => a - b);
    expect(xs.map((x) => +x.toFixed(6))).toEqual([0, 1.5, 3, 4.5]);

    const s = setupCommands();
    const id2 = s.addBox();
    await s.registry.execute('transform.array', { refs: [bodyRef(id2)], matrix: m4translation([3, 0, 0]), count: 3, mode: 'internal' });
    const xs2 = s
      .bodies()
      .map((b) => meshBounds(b.mesh).min[0])
      .sort((a, b) => a - b);
    expect(xs2.map((x) => +x.toFixed(6))).toEqual([0, 1, 2, 3]);
    expect(s.host.undoStack.peek()?.label).toBe('Move');
  });

  it('rotates a body 90° about Z through its centre: x/y extents swap, volume unchanged', async () => {
    const { apply, addBox, body } = setupCommands();
    const id = addBox([0, 0, 0], [2, 1, 1]);
    await apply({ refs: [bodyRef(id)], matrix: m4rotationAbout([1, 0.5, 0], [0, 0, 1], Math.PI / 2), label: 'Rotate' });
    const b = body(id);
    const mb = meshBounds(b.mesh);
    expect(near(mb.min, [0.5, -0.5, 0])).toBe(true);
    expect(near(mb.max, [1.5, 1.5, 1])).toBe(true);
    expect(b.props.volume).toBeCloseTo(2, 9);
    expectConsistent(b);
    // the former +x face now faces +y and its basis follows the new plane
    const py = faceWithNormal(b, [0, 1, 0]);
    expect(py.loops[0]!.every((p) => Math.abs(p[1] - 1.5) < 1e-9)).toBe(true);
  });

  it('scales through the kernel: ×2 uniform → volume ×8, 2,1,1 → ×2, -1 mirror keeps a positive volume', async () => {
    const { apply, addBox, body, host } = setupCommands();
    const id = addBox();
    await apply({ refs: [bodyRef(id)], matrix: m4scaleAbout([0, 0, 0], [2, 2, 2]), label: 'Scale' });
    expect(body(id).props.volume).toBeCloseTo(8, 6);
    expect(near(meshBounds(body(id).mesh).max, [2, 2, 2])).toBe(true);
    expect(body(id).faces.size).toBe(6);
    expect(host.undoStack.peek()?.label).toBe('Scale');
    expectConsistent(body(id));
    host.undo();
    await apply({ refs: [bodyRef(id)], matrix: m4scaleAbout([0, 0, 0], [2, 1, 1]), label: 'Scale' });
    expect(body(id).props.volume).toBeCloseTo(2, 6);
    host.undo();
    await apply({ refs: [bodyRef(id)], matrix: m4scaleAbout([0.5, 0.5, 0.5], [-1, -1, -1]), label: 'Scale' });
    expect(body(id).props.volume).toBeCloseTo(1, 6);
    expect(near(meshBounds(body(id).mesh).min, [0, 0, 0])).toBe(true);
    expectConsistent(body(id));
  });

  it('edit.flipAlong mirrors about the selection centre: bounds unchanged, solid stays valid', async () => {
    const { registry, addBox, body, host } = setupCommands();
    const id = addBox([1, 0, 0], [3, 1, 1]);
    host.selection.set([bodyRef(id)]);
    await registry.execute('edit.flipAlong', { axis: 'x' });
    const b = body(id);
    expect(near(meshBounds(b.mesh).min, [1, 0, 0])).toBe(true);
    expect(near(meshBounds(b.mesh).max, [3, 1, 1])).toBe(true);
    expect(b.props.volume).toBeCloseTo(2, 6);
    expect(host.undoStack.peek()?.label).toBe('Flip Along');
    expectConsistent(b);
  });
});

describe('transform.apply on sketch geometry', () => {
  it('moves a vertex: connected edges follow and the face stays planar with an updated plane', async () => {
    const { host, apply, root, addRectangle } = setupCommands();
    addRectangle();
    const sketch = root().sketch;
    expect(sketch.faces.size).toBe(1);
    const v = [...sketch.vertices.values()].find((x) => near(x.p, [1, 1, 0]))!;
    const entries = host.undoStack.length;
    await apply({ refs: [{ kind: 'sketchVertex', path: [], id: v.id }], matrix: m4translation([0.5, 0, 0]) });
    const s = root().sketch;
    expect(near(s.vertices.get(v.id)!.p, [1.5, 1, 0])).toBe(true);
    expect(s.edges.size).toBe(4);
    expect(s.faces.size).toBe(1);
    const face = [...s.faces.values()][0]!;
    for (const p of loopPoints(s, face.loops[0]!)) expect(Math.abs(planeDistance(face.plane, p))).toBeLessThan(1e-9);
    expect(host.undoStack.length).toBe(entries + 1);

    // out of plane: the quad tilts but stays planar (4 points, one lifted edge) → re-planed
    const edge = [...s.edges.values()].find((e) => {
      const a = s.vertices.get(e.a)!.p, b = s.vertices.get(e.b)!.p;
      return a[1] > 0.5 && b[1] > 0.5;
    })!;
    await apply({ refs: [{ kind: 'sketchEdge', path: [], id: edge.id }], matrix: m4translation([0, 0, 1]) });
    const s2 = root().sketch;
    const f2 = [...s2.faces.values()][0]!;
    expect(s2.faces.size).toBe(1);
    expect(f2.plane.n[2]).toBeLessThan(0.999);
    for (const p of loopPoints(s2, f2.loops[0]!)) expect(Math.abs(planeDistance(f2.plane, p))).toBeLessThan(1e-9);
  });

  it('moving a whole face keeps it (edges + vertices move) and merging vertices collapses edges', async () => {
    const { apply, root, addRectangle } = setupCommands();
    addRectangle();
    const face = [...root().sketch.faces.values()][0]!;
    await apply({ refs: [{ kind: 'sketchFace', path: [], id: face.id }], matrix: m4translation([0, 0, 2]) });
    const s = root().sketch;
    expect(s.faces.size).toBe(1);
    expect([...s.vertices.values()].every((v) => Math.abs(v.p[2] - 2) < 1e-9)).toBe(true);
    expect(Math.abs(Math.abs(s.faces.get(face.id)!.plane.d) - 2)).toBeLessThan(1e-9);

    // collapse: move (1,1,2) onto (0,1,2) → the vertex merges, the top edge disappears, the face becomes a triangle
    const v = [...s.vertices.values()].find((x) => near(x.p, [1, 1, 2]))!;
    await apply({ refs: [{ kind: 'sketchVertex', path: [], id: v.id }], matrix: m4translation([-1, 0, 0]) });
    const s2 = root().sketch;
    expect(s2.vertices.size).toBe(3);
    expect(s2.edges.size).toBe(3);
    expect(s2.faces.size).toBe(1);
    expect([...s2.faces.values()][0]!.loops[0]).toHaveLength(3);
  });

  it('a non-planar result fan-splits the face into planar pieces', async () => {
    const { apply, root, host } = setupCommands();
    host.edit('Pentagon', (draft) => {
      const g = SketchGraph.for(draft);
      const pts: Vec3[] = [
        [0, 0, 0],
        [2, 0, 0],
        [2.5, 1, 0],
        [1, 2, 0],
        [-0.5, 1, 0],
      ];
      for (let i = 0; i < 5; i++) g.addEdge(pts[i]!, pts[(i + 1) % 5]!);
    });
    expect(root().sketch.faces.size).toBe(1);
    const v = [...root().sketch.vertices.values()].find((x) => near(x.p, [2.5, 1, 0]))!;
    await apply({ refs: [{ kind: 'sketchVertex', path: [], id: v.id }], matrix: m4translation([0, 0, 1]) });
    const s = root().sketch;
    expect(s.faces.size).toBeGreaterThanOrEqual(2);
    for (const f of s.faces.values()) {
      for (const loop of f.loops) for (const p of loopPoints(s, loop)) expect(Math.abs(planeDistance(f.plane, p))).toBeLessThan(1e-9);
    }
    expect(s.edges.size).toBeGreaterThan(5);
  });

  it('copies sketch geometry with vertex merge and selects the copies', async () => {
    const { apply, root, addRectangle, host } = setupCommands();
    addRectangle();
    const face = [...root().sketch.faces.values()][0]!;
    const res = await apply({ refs: [{ kind: 'sketchFace', path: [], id: face.id }], matrix: m4translation([1, 0, 0]), copy: true });
    const s = root().sketch;
    expect(s.faces.size).toBe(2);
    expect(s.vertices.size).toBe(6); // shared edge merged
    expect(s.edges.size).toBe(7);
    expect(res.refs.some((r) => r.kind === 'sketchFace')).toBe(true);
    expect(host.selection.size).toBe(res.refs.length);
  });
});

describe('transform.apply on body sub-entities', () => {
  it('a face moved along its normal with perpendicular neighbours routes to push/pull', async () => {
    const { apply, addBox, body, host } = setupCommands();
    const id = addBox();
    const top = faceWithNormal(body(id), [0, 0, 1]);
    const entries = host.undoStack.length;
    const res = await apply({ refs: [{ kind: 'face', path: [], id, faceId: top.id, region: null }], matrix: m4translation([0, 0, 0.5]) });
    expect(res.bodyIds).toEqual([id]);
    expect(body(id).props.volume).toBeCloseTo(1.5, 6);
    expect(body(id).faces.size).toBe(6);
    expect(host.undoStack.length).toBe(entries + 1);
    expect(host.undoStack.peek()?.label).toBe('Move');
    expectConsistent(body(id));
  });

  it(`moving a box edge up 0.3 autofolds into a valid solid (${usingRealPolyMesh ? 'real PolyMesh' : 'stub PolyMesh'})`, async () => {
    const { apply, addBox, body, host } = setupCommands();
    const id = addBox();
    const b = body(id);
    const top = faceWithNormal(b, [0, 0, 1]), px = faceWithNormal(b, [1, 0, 0]);
    const edge = [...b.edges.values()].find((e) => (e.faceA === top.id && e.faceB === px.id) || (e.faceA === px.id && e.faceB === top.id))!;
    const entries = host.undoStack.length;
    const res = await apply({ refs: [{ kind: 'edge', path: [], id, edgeKey: edge.key }], matrix: m4translation([0, 0, 0.3]) });
    expect(res.bodyIds).toEqual([id]);
    const after = body(id);
    expect(after.props.volume).toBeCloseTo(1.15, 6);
    expect(meshTopologyProblems(after.mesh)).toEqual([]);
    expect(near(meshBounds(after.mesh).max, [1, 1, 1.3])).toBe(true);
    expect(after.faces.size).toBe(6);
    expect(host.undoStack.length).toBe(entries + 1);
    expectConsistent(after);
  });

  it('rejects an autofold the kernel cannot validate with transform.invalidSolid and leaves the model unchanged', async () => {
    const { apply, addBox, body, host } = setupCommands();
    const id = addBox();
    const b = body(id);
    const top = faceWithNormal(b, [0, 0, 1]), px = faceWithNormal(b, [1, 0, 0]);
    const edge = [...b.edges.values()].find((e) => (e.faceA === top.id && e.faceB === px.id) || (e.faceA === px.id && e.faceB === top.id))!;
    const entries = host.undoStack.length;
    installBrokenPolyMeshStub();
    try {
      await expect(apply({ refs: [{ kind: 'edge', path: [], id, edgeKey: edge.key }], matrix: m4translation([0, 0, 0.3]) })).rejects.toMatchObject({
        code: 'transform.invalidSolid',
      });
    } finally {
      restorePolyMesh();
    }
    expect(body(id).version).toBe(b.version);
    expect(host.undoStack.length).toBe(entries);
  });

  it('refuses to copy faces/edges of a solid', async () => {
    const { apply, addBox, body } = setupCommands();
    const id = addBox();
    const top = faceWithNormal(body(id), [0, 0, 1]);
    await expect(apply({ refs: [{ kind: 'face', path: [], id, faceId: top.id, region: null }], matrix: m4translation([0, 0, 0.5]), copy: true })).rejects.toBeInstanceOf(
      PushFormError,
    );
  });
});

describe('matrix helpers', () => {
  it('rigidMatrixRoot divides translations, rotations about a point and screws', () => {
    const m = m4rotationAbout([2, 1, 0], [0, 0, 1], Math.PI / 2);
    const steps = arrayMatrices(m, 3, 'internal');
    expect(steps).toHaveLength(3);
    const p: Vec3 = [3, 1, 0];
    expect(near(m4transformPoint(steps[2]!, p), m4transformPoint(m, p))).toBe(true);
    expect(near(m4transformPoint(steps[0]!, p), [2 + Math.cos(Math.PI / 6), 1 + Math.sin(Math.PI / 6), 0])).toBe(true);
    const t = rigidMatrixRoot(m4translation([3, 0, 0]), 3);
    expect(near(m4transformPoint(t, [0, 0, 0]), [1, 0, 0])).toBe(true);
    const screw = [...m4rotationAxis([0, 0, 1], Math.PI)] as number[];
    screw[14] = 2;
    const r = rigidMatrixRoot(screw as unknown as Mat4, 2);
    expect(near(m4transformPoint(r, [1, 0, 0]), [0, 1, 1])).toBe(true);
  });

  it('rejects face ids that do not exist', async () => {
    const { apply, addBox } = setupCommands();
    const id = addBox();
    await expect(apply({ refs: [{ kind: 'face', path: [], id, faceId: 99 as FaceLocalId, region: null }], matrix: m4translation([0, 0, 1]) })).rejects.toMatchObject({
      code: 'transform.target',
    });
  });
});
