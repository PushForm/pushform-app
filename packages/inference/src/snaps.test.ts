// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { meshBox, type CurveId, type Id, type Ray, type Vec2, type Vec3 } from '@pushform/core';
import { tessellateArc } from '@pushform/geom';
import { allocId, bodyFromMesh, createDocument, SketchGraph, type Document, type EntityRef, type Guide } from '@pushform/model';
import { InferenceEngineImpl, arcTangent, perpendicularTo } from './InferenceEngineImpl';
import { planeLockSnap, type InferenceInput } from './types';

/** 1 px = 1 cm at every depth (orthographic-like). */
const PX = 0.01;

/** Looking straight down from z = 10. */
function down(x: number, y: number): Ray {
  return { origin: [x, y, 10], dir: [0, 0, -1] };
}
function input(ray: Ray): InferenceInput {
  return { ray, screen: [0, 0], pixelSizeAt: () => PX, project: (p: Vec3): Vec2 => [p[0], p[1]] };
}
const near = (a: Vec3, b: Vec3, tol = 1e-9): void => {
  expect(a[0]).toBeCloseTo(b[0], -Math.log10(tol));
  expect(a[1]).toBeCloseTo(b[1], -Math.log10(tol));
  expect(a[2]).toBeCloseTo(b[2], -Math.log10(tol));
};

interface Fixture {
  doc: Document;
  bodyId: Id;
  engine: InferenceEngineImpl;
  clock: { now: number };
  /** The sketch rectangle's bottom edge [4,0,0] → [6,0,0]. */
  bottomEdge: EntityRef;
  /** Start vertex of the arc and the arc's CCW tangent there. */
  arcStart: Vec3;
}

/**
 * The inference fixture plus: a sketch edge floating at z = 1 across the box top (x = 0.5), a
 * quarter arc (sketch, with a Curve record) at (10, 10), guide lines and a guide point.
 */
function fixture(): Fixture {
  const doc = createDocument();
  const ARC_START = Math.PI / 6;
  let bottomEdge: EntityRef = { kind: 'sketchEdge', path: [], id: 0 as Id };
  const bodyId = doc.transact('fixture', (d) => {
    const root = d.definitions.get(d.rootDefinitionId)!;
    const id = bodyFromMesh(d, meshBox([0, 0, 0], [2, 1, 1]), { container: root.entities }).id;
    const g = SketchGraph.for(d);
    const e0 = g.addEdge([4, 0, 0], [6, 0, 0]);
    bottomEdge = { kind: 'sketchEdge', path: [], id: e0[0]! };
    g.addEdge([6, 0, 0], [6, 2, 0]);
    g.addEdge([6, 2, 0], [4, 2, 0]);
    g.addEdge([4, 2, 0], [4, 0, 0]);
    g.addEdge([0.5, -1, 1], [0.5, 3, 1]);
    // quarter arc from 30° to 120° about z at (10, 10, 0), radius 2
    const arc = tessellateArc([10, 10, 0], [0, 0, 1], 2, ARC_START, ARC_START + Math.PI / 2, 4);
    const curveId = allocId<CurveId>(d);
    const before = new Set(g.sketch.edges.keys());
    for (let i = 0; i + 1 < arc.points.length; i++) g.addEdge(arc.points[i]!, arc.points[i + 1]!, { curveId });
    const edgeRefs = [...g.sketch.edges.keys()].filter((k) => !before.has(k));
    g.sketch.curves.set(curveId, { id: curveId, ...arc.curve, edgeRefs });
    const m = (v: Vec3): [number, number, number] => [v[0], v[1], v[2]];
    const guide = (gd: { kind: 'line'; origin: Vec3; dir: Vec3 } | { kind: 'point'; origin: Vec3 }): void => {
      const gid = allocId(d);
      const base = { id: gid, tagId: d.defaultTagId, hidden: false, locked: false, castShadows: false, receiveShadows: false, attributes: {} };
      const g: Guide = gd.kind === 'line' ? { ...base, kind: 'line', origin: m(gd.origin), dir: m(gd.dir) } : { ...base, kind: 'point', origin: m(gd.origin) };
      root.entities.guides.set(gid, g as never);
    };
    guide({ kind: 'line', origin: [1.5, -1, 1], dir: [0, 1, 0] });
    guide({ kind: 'line', origin: [20, 20, 0], dir: [1, 0, 0] });
    guide({ kind: 'line', origin: [22, 18, 0], dir: [0, 1, 0] });
    guide({ kind: 'point', origin: [30, 30, 0] });
    return id;
  }).value;
  const clock = { now: 0 };
  const engine = new InferenceEngineImpl({ clock: () => clock.now });
  engine.setState(doc.state);
  const arcStart: Vec3 = [10 + 2 * Math.cos(ARC_START), 10 + 2 * Math.sin(ARC_START), 0];
  return { doc, bodyId, engine, clock, bottomEdge, arcStart };
}

describe('intersection snaps (black ×)', () => {
  it('edge × edge: a sketch edge crossing a body edge snaps to the crossing point', () => {
    const { engine } = fixture();
    const r = engine.resolve(input(down(0.52, 1.03)));
    expect(r.primary.kind).toBe('intersection');
    expect(r.primary.label).toBe('Intersection');
    expect(r.tooltip).toBe('Intersection');
    near(r.point, [0.5, 1, 1]);
    expect(r.primary.color).toBe('#222222');
  });

  it('intersection beats midpoint but loses to an endpoint', () => {
    const { engine } = fixture();
    // midpoint of the top edge y = 1 is (1, 1, 1); the crossing is at (0.5, 1, 1)
    expect(engine.resolve(input(down(1.02, 1.03))).primary.kind).toBe('midpoint');
    expect(engine.resolve(input(down(2.03, 1.0))).primary.kind).toBe('endpoint');
  });

  it('guide × edge and guide × guide', () => {
    const { engine } = fixture();
    const ge = engine.resolve(input(down(1.52, 1.0)));
    expect(ge.primary.kind).toBe('intersection');
    near(ge.point, [1.5, 1, 1]);
    const gg = engine.resolve(input(down(22.02, 20.03)));
    expect(gg.primary.kind).toBe('intersection');
    near(gg.point, [22, 20, 0]);
  });

  it('two edges that only meet at a shared endpoint are an endpoint, not an intersection', () => {
    const { engine } = fixture();
    const r = engine.resolve(input(down(6.02, 0.02)));
    expect(r.primary.kind).toBe('endpoint');
  });
});

describe('guides', () => {
  it('"On Line" on a guide line and "Guide Point" on a guide point', () => {
    const { engine } = fixture();
    const line = engine.resolve(input(down(25, 20.03)));
    expect(line.primary.kind).toBe('guide');
    expect(line.primary.label).toBe('On Line');
    expect(line.primary.dir).toEqual([1, 0, 0]);
    near(line.point, [25, 20, 0]);
    const pt = engine.resolve(input(down(30.03, 30.02)));
    expect(pt.primary.kind).toBe('guide');
    expect(pt.tooltip).toBe('Guide Point');
    near(pt.point, [30, 30, 0]);
    expect(pt.primary.ref?.kind).toBe('guide');
  });
});

describe('reference edge: parallel, perpendicular, extension', () => {
  const diag: EntityRef = { kind: 'sketchEdge', path: [], id: 999 as Id };
  const S = Math.SQRT1_2;

  it('exposes a referenceEdge setter and normalizes its direction', () => {
    const { engine } = fixture();
    expect(engine.referenceEdge).toBeNull();
    engine.referenceEdge = { ref: diag, a: [20, 0, 0], b: [22, 2, 0], dir: [2, 2, 0] };
    expect(engine.referenceEdge?.dir[0]).toBeCloseTo(S);
    engine.referenceEdge = null;
    expect(engine.referenceEdge).toBeNull();
  });

  it('Parallel to Edge (magenta) along the reference direction from the anchor', () => {
    const { engine } = fixture();
    engine.referenceEdge = { ref: diag, a: [20, 0, 0], b: [22, 2, 0], dir: [S, S, 0] };
    const r = engine.resolve(input(down(23 + S, 1 + S + 0.02)), { anchor: [23, 1, 0] });
    expect(r.primary.kind).toBe('parallel');
    expect(r.tooltip).toBe('Parallel to Edge');
    expect(r.primary.color).toBe('#d81bd8');
    near(r.point, [23 + S + 0.01, 1 + S + 0.01, 0], 1e-6);
    expect(r.lines[0]).toMatchObject({ a: [23, 1, 0], dashed: false });
  });

  it('Perpendicular to Edge (magenta): the perpendicular dropped from the anchor onto the edge line', () => {
    const { engine } = fixture();
    engine.referenceEdge = { ref: diag, a: [20, 0, 0], b: [22, 2, 0], dir: [S, S, 0] };
    const r = engine.resolve(input(down(23 + S, 1 - S + 0.02)), { anchor: [23, 1, 0] });
    expect(r.primary.kind).toBe('perpendicular');
    expect(r.primary.label).toBe('Perpendicular to Edge');
    expect(r.primary.ref).toEqual(diag);
    expect(r.primary.dir![0]).toBeCloseTo(S);
    expect(r.primary.dir![1]).toBeCloseTo(-S);
  });

  it('perpendicularTo: anchor on the edge line → perpendicular within the drawing plane', () => {
    const d = perpendicularTo({ a: [0, 0, 0], dir: [1, 0, 0] }, [1, 0, 0], { n: [0, 0, 1], d: 0 });
    expect(Math.abs(d[1])).toBeCloseTo(1);
    expect(d[2]).toBeCloseTo(0);
    const off = perpendicularTo({ a: [0, 0, 0], dir: [1, 0, 0] }, [1, 0, 3], { n: [0, 0, 1], d: 0 });
    expect(off).toEqual([0, 0, 1]);
  });

  it('"On Line": dashed extension of the referenced edge beyond its ends', () => {
    const { engine, bottomEdge } = fixture();
    engine.referenceEdge = { ref: bottomEdge, a: [4, 0, 0], b: [6, 0, 0], dir: [1, 0, 0] };
    const r = engine.resolve(input(down(7.5, 0.03)));
    expect(r.primary.kind).toBe('extension');
    expect(r.tooltip).toBe('On Line');
    expect(r.primary.ref).toEqual(bottomEdge);
    near(r.point, [7.5, 0, 0]);
    expect(r.lines).toEqual([{ a: [6, 0, 0], b: [7.5, 0, 0], color: r.primary.color, dashed: true }]);
    // on the edge itself it is "On Edge", and far from the line it is free
    expect(engine.resolve(input(down(4.5, 0.03))).primary.kind).toBe('onEdge');
    expect(engine.resolve(input(down(7.5, 0.5))).primary.kind).toBe('free');
    // before the start as well
    near(engine.resolve(input(down(3, -0.02))).point, [3, 0, 0]);
  });

  it('extension ∩ anchor axis: "On Green Axis · On Line" at the crossing', () => {
    const { engine, bottomEdge } = fixture();
    engine.referenceEdge = { ref: bottomEdge, a: [4, 0, 0], b: [6, 0, 0], dir: [1, 0, 0] };
    const r = engine.resolve(input(down(7.52, 0.03)), { anchor: [7.5, 3, 0] });
    expect(r.primary.kind).toBe('onAxis');
    expect(r.primary.axis).toBe('y');
    expect(r.secondary.map((s) => s.kind)).toEqual(['extension']);
    expect(r.tooltip).toBe('On Green Axis · On Line');
    near(r.point, [7.5, 0, 0]);
    expect(r.lines).toHaveLength(2);
    expect(r.lines[1]).toMatchObject({ a: [6, 0, 0], dashed: true });
  });

  it('resting on an edge for the hover delay makes it the reference edge (full extent)', () => {
    const { engine, clock, bodyId } = fixture();
    const onEdge = input(down(1.2, 0.98)); // top edge y = 1 of the box
    engine.resolve(onEdge);
    clock.now = 500;
    engine.resolve(onEdge);
    const ref = engine.referenceEdge;
    expect(ref?.ref).toMatchObject({ kind: 'edge', id: bodyId });
    expect(new Set([ref!.a[0], ref!.b[0]])).toEqual(new Set([0, 2]));
    const ext = engine.resolve(input(down(3, 1.02)));
    expect(ext.primary.kind).toBe('extension');
    near(ext.point, [3, 1, 1]);
  });
});

describe('tangent at vertex (cyan)', () => {
  it('from the start vertex of an arc the direction continues the arc tangent', () => {
    const { engine, arcStart } = fixture();
    // CCW tangent at 30° is (-sin30, cos30); continuing past the start = the opposite direction
    const dir: Vec3 = [Math.sin(Math.PI / 6), -Math.cos(Math.PI / 6), 0];
    const cursor: Vec3 = [arcStart[0] + 1.5 * dir[0] + 0.02 * dir[1], arcStart[1] + 1.5 * dir[1] - 0.02 * dir[0], 0];
    const r = engine.resolve(input(down(cursor[0], cursor[1])), { anchor: arcStart });
    expect(r.primary.kind).toBe('tangent');
    expect(r.tooltip).toBe('Tangent at Vertex');
    expect(r.primary.color).toBe('#2ec7d1');
    expect(r.primary.ref?.kind).toBe('sketchEdge');
    expect(r.primary.dir![0]).toBeCloseTo(dir[0]);
    expect(r.primary.dir![1]).toBeCloseTo(dir[1]);
    near(r.point, [arcStart[0] + 1.5 * dir[0], arcStart[1] + 1.5 * dir[1], 0], 1e-6);
    // an anchor that is not an arc vertex has no tangent
    const none = engine.resolve(input(down(cursor[0] + 5, cursor[1])), { anchor: [arcStart[0] + 5, arcStart[1], 0] });
    expect(none.primary.kind).toBe('free');
  });

  it('arcTangent orients away from the far end of the edge', () => {
    const curve = { id: 1 as CurveId, kind: 'arc' as const, center: [0, 0, 0] as Vec3, normal: [0, 0, 1] as Vec3, radius: 1, startAngle: 0, endAngle: 1, segments: 2, edgeRefs: [] };
    expect(arcTangent(curve, [1, 0, 0], [0.9, 0.4, 0])).toEqual([0, -1, 0]);
    expect(arcTangent(curve, [1, 0, 0], [0.9, -0.4, 0])).toEqual([0, 1, 0]);
  });
});

describe('inference modes', () => {
  const diag: EntityRef = { kind: 'sketchEdge', path: [], id: 999 as Id };
  const S = Math.SQRT1_2;

  it('without inferences, a point over a vertex stays where the cursor meets the ground or a face', () => {
    const { engine } = fixture();
    expect(engine.resolve(input(down(4.003, 0.002))).primary.kind).toBe('endpoint');
    const r = engine.resolve(input(down(4.003, 0.002)), { snapping: 'none' });
    expect(r.primary.kind).toBe('free');
    expect(r.tooltip).toBe('');
    near(r.point, [4.003, 0.002, 0], 1e-9);
    // over the box top the point lands on the face, still without an "On Face" inference
    const top = engine.resolve(input(down(1, 0.5)), { snapping: 'none' });
    expect(top.primary.kind).toBe('free');
    near(top.point, [1, 0.5, 1], 1e-9);
  });

  it('offers no axis or Parallel to Edge without inferences, and only Parallel / Perpendicular to Edge in the directional mode', () => {
    const { engine } = fixture();
    engine.referenceEdge = { ref: diag, a: [20, 0, 0], b: [22, 2, 0], dir: [S, S, 0] };
    const anchor: Vec3 = [23, 1, 0];
    expect(engine.resolve(input(down(25, 1.02)), { anchor }).primary.kind).toBe('onAxis');
    expect(engine.resolve(input(down(25, 1.02)), { anchor, snapping: 'none' }).primary.kind).toBe('free');
    expect(engine.resolve(input(down(25, 1.02)), { anchor, snapping: 'directional' }).primary.kind).toBe('free');
    const parallel = engine.resolve(input(down(23 + S, 1 + S + 0.02)), { anchor, snapping: 'directional' });
    expect(parallel.primary.kind).toBe('parallel');
    expect(parallel.lines[0]).toMatchObject({ a: anchor, color: '#d81bd8' });
    expect(engine.resolve(input(down(23 + S, 1 + S + 0.02)), { anchor, snapping: 'none' }).primary.kind).toBe('free');
    expect(engine.resolve(input(down(23 + S, 1 - S + 0.02)), { anchor, snapping: 'directional' }).primary.kind).toBe('perpendicular');
  });

  it('keeps arrow-key locks in every mode', () => {
    const { engine } = fixture();
    const r = engine.resolve(input(down(25, 1.4)), { anchor: [23, 1, 0], lockAxis: 'x', snapping: 'none' });
    expect(r.primary.kind).toBe('onAxis');
    near(r.point, [25, 1, 0], 1e-9);
  });
});

describe('Shift+Alt plane lock', () => {
  it('points live on the locked plane; axis lines through an in-plane anchor still snap', () => {
    const { engine } = fixture();
    const lock = planeLockSnap({ n: [0, 0, 1], d: -2 }, [0, 0, 2]);
    const r = engine.resolve(input(down(3.02, 6)), { lockSnap: lock, anchor: [3, 3, 2] });
    expect(r.primary.kind).toBe('onPlane');
    near(r.point, [3, 6, 2]);
    expect(r.secondary.map((s) => s.kind)).toEqual(['onAxis']);
    expect(r.tooltip).toBe('On Plane · On Green Axis');
    expect(r.lines[0]).toMatchObject({ a: [3, 3, 2], b: [3, 6, 2] });
    // free point on the plane
    near(engine.resolve(input(down(8, 8)), { lockSnap: lock }).point, [8, 8, 2]);
    // a strong snap is projected onto the plane and kept as context
    const corner = engine.resolve(input(down(2.03, 1.0)), { lockSnap: lock });
    near(corner.point, [2, 1, 2]);
    expect(corner.secondary[0]?.kind).toBe('endpoint');
  });
});
