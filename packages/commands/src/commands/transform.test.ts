// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FaceLocalId, Mat4, Vec3 } from '@pushform/core';
import { m4rotationAxis, m4transformPoint, m4translation, meshBounds, planeDistance, PushFormError, v3dist, v3eq } from '@pushform/core';
import { meshTopologyProblems } from '@pushform/kernel';
import { loopPoints, SketchGraph, type Body, type EntityRef, type FaceRecord } from '@pushform/model';
import { arrayMatrices, m4rotationAbout, m4scaleAbout, rigidMatrixRoot, transformRefusal } from './transform';
import { groupCommands, type MakeResult } from './groups';
import { guideCommands } from './guides';
import { textCommands } from './texts';
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

describe('transform.apply: sketch moves draw as drawing does', () => {
  const edgeAt = (sketch: ReturnType<ReturnType<typeof setupCommands>['root']>['sketch'], a: Vec3, b: Vec3) =>
    [...sketch.edges.values()].find((e) => {
      const p = sketch.vertices.get(e.a)!.p, q = sketch.vertices.get(e.b)!.p;
      return (near(p, a) && near(q, b)) || (near(p, b) && near(q, a));
    });

  it('splits the edges a moved edge crosses, and keeps the moved edge selected as its pieces', async () => {
    const { host, apply, root } = setupCommands();
    host.edit('Lines', (draft) => {
      const g = SketchGraph.for(draft);
      g.addEdge([0, 0, 0], [2, 0, 0]);
      g.addEdge([1, 1, 0], [1, 2, 0]);
    });
    const moving = edgeAt(root().sketch, [1, 1, 0], [1, 2, 0])!;
    const ref: EntityRef = { kind: 'sketchEdge', path: [], id: moving.id };
    host.selection.set([ref]);
    const res = await apply({ refs: [ref], matrix: m4translation([0, -1.5, 0]) });
    const s = root().sketch;
    expect(s.edges.size).toBe(4);
    expect([...s.vertices.values()].some((v) => near(v.p, [1, 0, 0]))).toBe(true);
    expect(edgeAt(s, [0, 0, 0], [1, 0, 0])).toBeDefined();
    expect(edgeAt(s, [1, -0.5, 0], [1, 0, 0])).toBeDefined();
    expect(host.selection.size).toBe(2);
    expect(host.selection.refs.every((r) => r.kind === 'sketchEdge' && s.edges.has(r.id))).toBe(true);
    expect(res.refs.filter((r) => r.kind === 'sketchEdge')).toHaveLength(2);
  });

  it('forms a face where a moved edge closes a loop, and splits a face a moved edge runs across', async () => {
    const { host, apply, root } = setupCommands();
    host.edit('U', (draft) => {
      const g = SketchGraph.for(draft);
      g.addEdge([0, 0, 0], [1, 0, 0]);
      g.addEdge([1, 0, 0], [1, 1, 0]);
      g.addEdge([1, 1, 0], [0, 1, 0]);
      g.addEdge([3, 0, 0], [3, 1, 0]);
      g.addEdge([0.5, 3, 0], [0.5, 4.5, 0]);
    });
    expect(root().sketch.faces.size).toBe(0);
    const closer = edgeAt(root().sketch, [3, 0, 0], [3, 1, 0])!;
    await apply({ refs: [{ kind: 'sketchEdge', path: [], id: closer.id }], matrix: m4translation([-3, 0, 0]) });
    expect(root().sketch.faces.size).toBe(1);
    const across = edgeAt(root().sketch, [0.5, 3, 0], [0.5, 4.5, 0])!;
    await apply({ refs: [{ kind: 'sketchEdge', path: [], id: across.id }], matrix: m4translation([0, -3.25, 0]) });
    const s = root().sketch;
    expect(s.faces.size).toBe(2);
    for (const f of s.faces.values()) expect(f.loops[0]).toHaveLength(4);
  });

  it('replaces a face with holes that can no longer be flat by its edges, and says so', async () => {
    const { host, apply, root } = setupCommands();
    host.edit('Frame', (draft) => {
      const g = SketchGraph.for(draft);
      const square = (a: number, b: number): void => {
        g.addEdge([a, a, 0], [b, a, 0]);
        g.addEdge([b, a, 0], [b, b, 0]);
        g.addEdge([b, b, 0], [a, b, 0]);
        g.addEdge([a, b, 0], [a, a, 0]);
      };
      square(0, 3);
      square(1, 2);
    });
    const framed = [...root().sketch.faces.values()].find((f) => f.loops.length === 2)!;
    expect(framed).toBeDefined();
    const edges = root().sketch.edges.size;
    const corner = [...root().sketch.vertices.values()].find((v) => near(v.p, [3, 3, 0]))!;
    const res = await apply({ refs: [{ kind: 'sketchVertex', path: [], id: corner.id }], matrix: m4translation([0, 0, 1]) });
    expect(root().sketch.faces.has(framed.id)).toBe(false);
    expect(root().sketch.edges.size).toBe(edges);
    expect(res.notice).toBe('A face with holes could no longer be flat and was replaced by its edges.');
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

describe('transform.apply on guides and text', () => {
  const setup = () => {
    const s = setupCommands();
    s.registry.registerAll(guideCommands);
    s.registry.registerAll(textCommands);
    return s;
  };
  const turn = m4rotationAbout([0, 0, 0], [0, 0, 1], Math.PI / 2);

  it('turns guide points, lines and segments with the rest of the selection; undo restores them', async () => {
    const { registry, apply, root, host, addBox } = setup();
    const box = addBox([2, 2, 0], [3, 3, 1]);
    const point = (registry.execute('guides.addPoint', { point: [1, 0, 0] }) as { id: number }).id;
    const line = registry.execute('guides.addLine', { point: [1, 0, 0], dir: [1, 0, 0] }) as number;
    const segment = registry.execute('guides.addSegment', { a: [0, 0, 0], b: [1, 0, 0] }) as number;
    const refs: EntityRef[] = [bodyRef(box), ...[point, line, segment].map((id): EntityRef => ({ kind: 'guide', path: [], id: id as never }))];
    const res = await apply({ refs, matrix: turn, label: 'Rotate' });
    expect(res.refs.filter((r) => r.kind === 'guide')).toHaveLength(3);
    const guide = (id: number) => root().guides.get(id as never)!;
    expect(near(guide(point).origin, [0, 1, 0])).toBe(true);
    const l = guide(line);
    expect(l.kind === 'line' && near(l.origin, [0, 1, 0]) && near(l.dir, [0, 1, 0])).toBe(true);
    const sg = guide(segment);
    expect(sg.kind === 'segment' && near(sg.origin, [0, 0, 0]) && near(sg.end, [0, 1, 0])).toBe(true);
    expect(host.undo()).toBe(true);
    expect(near(guide(point).origin, [1, 0, 0])).toBe(true);
  });

  it('moves leader text by its anchor and label point and leaves screen text where it is on screen', async () => {
    const { registry, apply, root } = setup();
    const leader = registry.execute('text.add', { kind: 'leader', anchor: [1, 0, 0], label: [2, 1, 0], text: 'Shelf' }) as EntityRef;
    const screen = registry.execute('text.add', { kind: 'screen', screen: [0.25, 0.75], text: 'Notes' }) as EntityRef;
    const res = await apply({ refs: [leader, screen], matrix: m4translation([0, 0, 2]) });
    expect(res.refs).toEqual([leader]);
    const text = (r: EntityRef) => root().texts.get(r.id)!;
    expect(near(text(leader).position, [1, 0, 2])).toBe(true);
    expect(near(text(leader).offset!, [1, 1, 0])).toBe(true);
    expect(text(screen).position).toEqual([0.25, 0.75, 0]);
    await apply({ refs: [leader], matrix: turn, label: 'Rotate' });
    expect(near(text(leader).position, [0, 1, 2])).toBe(true);
    expect(near(text(leader).offset!, [-1, 1, 0])).toBe(true);
    // screen text on its own is left alone without an error
    await expect(apply({ refs: [screen], matrix: m4translation([1, 0, 0]) })).resolves.toMatchObject({ refs: [] });
  });

  it('copy makes new guides and texts, selects them and keeps the originals', async () => {
    const { registry, apply, root, host } = setup();
    const line = registry.execute('guides.addLine', { point: [0, 0, 0], dir: [0, 1, 0] }) as number;
    const leader = registry.execute('text.add', { kind: 'leader', anchor: [0, 0, 0], label: [1, 1, 0], text: 'Leg' }) as EntityRef;
    const res = await apply({ refs: [{ kind: 'guide', path: [], id: line as never }, leader], matrix: m4translation([3, 0, 0]), copy: true });
    expect(root().guides.size).toBe(2);
    expect(root().texts.size).toBe(2);
    const guideCopy = res.refs.find((r) => r.kind === 'guide')!, textCopy = res.refs.find((r) => r.kind === 'text')!;
    expect(guideCopy.id).not.toBe(line);
    expect(textCopy.id).not.toBe(leader.id);
    expect(near(root().guides.get(guideCopy.id)!.origin, [3, 0, 0])).toBe(true);
    expect(near(root().guides.get(line as never)!.origin, [0, 0, 0])).toBe(true);
    expect(root().texts.get(textCopy.id)).toMatchObject({ text: 'Leg', position: [3, 0, 0], offset: [1, 1, 0] });
    expect(near(root().texts.get(leader.id)!.position, [0, 0, 0])).toBe(true);
    expect(host.selection.refs).toEqual(res.refs);
  });

  it("leaves edges drawn on a solid's face in place when other entities move, and refuses them alone with a plain message", async () => {
    const { registry, apply, root, addBox, body } = setup();
    const id = addBox();
    registry.execute('sketch.addEdge', { a: [0.2, 0.5, 1], b: [0.8, 0.5, 1] });
    const [faceId, graph] = [...body(id).imprints][0]!;
    const imprint: EntityRef = { kind: 'imprintEdge', path: [], id: id as never, faceId, edgeId: [...graph.edges.keys()][0]! };
    const version = body(id).version;
    const point = (registry.execute('guides.addPoint', { point: [2, 0, 0] }) as { id: number }).id;
    await apply({ refs: [imprint, { kind: 'guide', path: [], id: point as never }], matrix: m4translation([0, 1, 0]) });
    expect(near(root().guides.get(point as never)!.origin, [2, 1, 0])).toBe(true);
    expect(body(id).version).toBe(version);
    const refusal = apply({ refs: [imprint], matrix: m4translation([0, 1, 0]) });
    await expect(refusal).rejects.toMatchObject({ code: 'transform.imprintEdge' });
    const message = await refusal.catch((e: Error) => e.message);
    expect(message).toMatch(/solid's face/);
    expect(message).not.toMatch(/\d/);
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

  it('an internal array of a turn steps the way it turned, past 180° and round a whole turn', () => {
    const center: Vec3 = [1, 0, 0], axis: Vec3 = [0, 0, 1], p: Vec3 = [2, 0, 0];
    // 270° counterclockwise: the matrix alone is 90° clockwise
    const m = m4rotationAbout(center, axis, 1.5 * Math.PI);
    const ccw = arrayMatrices(m, 3, 'internal', { center, axis, angle: 1.5 * Math.PI });
    expect(near(m4transformPoint(ccw[0]!, p), [1, 1, 0])).toBe(true); // 90°
    expect(near(m4transformPoint(ccw[1]!, p), [0, 0, 0])).toBe(true); // 180°
    expect(near(m4transformPoint(ccw[2]!, p), m4transformPoint(m, p))).toBe(true);
    // 200° clockwise
    const cw = arrayMatrices(m4rotationAbout(center, axis, (-200 * Math.PI) / 180), 2, 'internal', { center, axis, angle: (-200 * Math.PI) / 180 });
    expect(near(m4transformPoint(cw[0]!, p), [1 + Math.cos((-100 * Math.PI) / 180), Math.sin((-100 * Math.PI) / 180), 0])).toBe(true);
    // a whole turn: the matrix is the identity, the copies spread evenly round the circle
    const round = arrayMatrices(m4rotationAbout(center, axis, 2 * Math.PI), 4, 'internal', { center, axis, angle: 2 * Math.PI });
    expect(round.map((s) => m4transformPoint(s, p).map((x) => +x.toFixed(9) + 0))).toEqual([
      [1, 1, 0],
      [0, 0, 0],
      [1, -1, 0],
      [2, 0, 0],
    ]);
    // external arrays repeat the matrix
    const ext = arrayMatrices(m, 2, 'external', { center, axis, angle: 1.5 * Math.PI });
    expect(near(m4transformPoint(ext[1]!, p), [0, 0, 0])).toBe(true);
  });

  it('transform.array takes the turn for an internal array of a rotation', async () => {
    const { registry, addBox, bodies } = setupCommands();
    const id = addBox([1, 0, 0], [2, 1, 1]);
    const angle = 1.5 * Math.PI;
    await registry.execute('transform.array', { refs: [bodyRef(id)], matrix: m4rotationAbout([0, 0, 0], [0, 0, 1], angle), count: 3, mode: 'internal', label: 'Rotate', rotation: { center: [0, 0, 0], axis: [0, 0, 1], angle } });
    const mins = bodies().map((b) => meshBounds(b.mesh).min.map((x) => +x.toFixed(6) + 0));
    expect(mins).toHaveLength(4);
    expect(mins).toContainEqual([-1, 1, 0]); // 90°
    expect(mins).toContainEqual([-2, -1, 0]); // 180°
    expect(mins).toContainEqual([0, -2, 0]); // 270°
  });

  it('rejects face ids that do not exist', async () => {
    const { apply, addBox } = setupCommands();
    const id = addBox();
    await expect(apply({ refs: [{ kind: 'face', path: [], id, faceId: 99 as FaceLocalId, region: null }], matrix: m4translation([0, 0, 1]) })).rejects.toMatchObject({
      code: 'transform.target',
    });
  });
});

describe('refusing a transform before it starts', () => {
  const setup = () => {
    const s = setupCommands();
    s.registry.registerAll(groupCommands);
    return s;
  };
  const instanceOf = (registry: ReturnType<typeof setup>['registry'], host: ReturnType<typeof setup>['host'], id: number): EntityRef => {
    host.selection.set([bodyRef(id)]);
    const made = registry.execute('group.make', {}) as MakeResult;
    return { kind: 'instance', path: [], id: made.instanceId as never };
  };

  it('refuses a locked group as the move starts and names the operation; a copy of it is allowed and unlocked', async () => {
    const { registry, host, addBox, apply, root } = setup();
    const ref = instanceOf(registry, host, addBox());
    registry.execute('instance.setLocked', { refs: [ref], locked: true });
    expect(transformRefusal(host, [ref], false, 'Move')).toBe('A locked group or component cannot be moved');
    expect(transformRefusal(host, [ref], false, 'Rotate')).toBe('A locked group or component cannot be rotated');
    expect(transformRefusal(host, [ref], false, 'Scale')).toBe('A locked group or component cannot be scaled');
    await expect(apply({ refs: [ref], matrix: m4translation([1, 0, 0]), label: 'Rotate' })).rejects.toThrow('cannot be rotated');
    expect(transformRefusal(host, [ref], true, 'Move')).toBeNull();
    const res = await apply({ refs: [ref], matrix: m4translation([2, 0, 0]), copy: true });
    const copy = root().instances.get(res.refs[0]!.id)!;
    expect(copy.locked).toBe(false);
    expect(root().instances.get(ref.id)!.locked).toBe(true);
  });

  it('refuses entities of different groups, entities outside the open group, copies of solid faces and lone vertex copies', () => {
    const { registry, host, addBox, body, addRectangle, root } = setup();
    const ref = instanceOf(registry, host, addBox());
    const def = host.doc.state.definitions.get(root().instances.get(ref.id)!.definitionId)!;
    const innerBody: EntityRef = { kind: 'body', path: [ref.id], id: [...def.entities.bodies.keys()][0]! };
    const other = addBox([3, 0, 0], [4, 1, 1]);
    expect(transformRefusal(host, [innerBody, bodyRef(other)], false, 'Rotate')).toBe('Entities of different groups or components cannot be rotated together');
    expect(transformRefusal(host, [innerBody], false, 'Move')).toBe('Only what is in the open group or component can be moved.');
    const top = faceWithNormal(body(other), [0, 0, 1]);
    expect(transformRefusal(host, [{ kind: 'face', path: [], id: other as never, faceId: top.id, region: null }], true, 'Move')).toContain('cannot be copied');
    addRectangle(1, 1, 5);
    const v = [...root().sketch.vertices.values()][0]!;
    expect(transformRefusal(host, [{ kind: 'sketchVertex', path: [], id: v.id }], true, 'Move')).toContain('vertices on their own cannot be copied');
    expect(transformRefusal(host, [{ kind: 'sketchVertex', path: [], id: v.id }], false, 'Move')).toBeNull();
    expect(transformRefusal(host, [bodyRef(other)], true, 'Move')).toBeNull();
  });
});
