// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { meshBox, type Id, type MeshData, type Ray, type Vec2, type Vec3 } from '@pushform/core';
import { bodyFromMesh, createDocument, SketchGraph, type Document, type EntityRef } from '@pushform/model';
import { InferenceEngineImpl, createInferenceEngine } from './InferenceEngineImpl';
import { PickService } from './PickService';
import { SpatialIndex } from './SpatialIndex';
import { GROUND_PLANE, type InferenceInput, type Snap } from './types';

/** 1 px = 1 cm at every depth (orthographic-like). */
const PX = 0.01;

/** Looking straight down from z = 10. */
function down(x: number, y: number): Ray {
  return { origin: [x, y, 10], dir: [0, 0, -1] };
}
function input(ray: Ray, extra: Partial<InferenceInput> = {}): InferenceInput {
  return { ray, screen: [0, 0], pixelSizeAt: () => PX, project: (p: Vec3): Vec2 => [p[0], p[1]], ...extra };
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
}

/**
 * A 2×1×1 box at the origin (top face z = 1) and a 2×2 sketch rectangle on the ground at x 4..6.
 * Optionally a sketch edge hidden under the box.
 */
function fixture(opts: { hiddenEdge?: boolean } = {}): Fixture {
  const doc = createDocument();
  const bodyId = doc.transact('fixture', (d) => {
    const root = d.definitions.get(d.rootDefinitionId)!;
    const id = bodyFromMesh(d, meshBox([0, 0, 0], [2, 1, 1]), { container: root.entities }).id;
    const g = SketchGraph.for(d);
    g.addEdge([4, 0, 0], [6, 0, 0]);
    g.addEdge([6, 0, 0], [6, 2, 0]);
    g.addEdge([6, 2, 0], [4, 2, 0]);
    g.addEdge([4, 2, 0], [4, 0, 0]);
    if (opts.hiddenEdge) g.addEdge([0.5, 0.5, -1], [2.5, 0.5, -1]);
    return id;
  }).value;
  expect(doc.rootDefinition.entities.sketch.faces.size).toBe(1);
  const clock = { now: 0 };
  const engine = new InferenceEngineImpl({ clock: () => clock.now });
  engine.setState(doc.state);
  return { doc, bodyId, engine, clock };
}

describe('point snaps', () => {
  it('endpoint: a ray within 5 px of a box corner snaps to the corner (green, "Endpoint")', () => {
    const { engine, bodyId } = fixture();
    const r = engine.resolve(input(down(2.03, 1.0)));
    expect(r.primary.kind).toBe('endpoint');
    expect(r.primary.label).toBe('Endpoint');
    expect(r.tooltip).toBe('Endpoint');
    near(r.point, [2, 1, 1]);
    expect(r.primary.ref).toMatchObject({ kind: 'edge', id: bodyId });
    // the raw hit is the corner reported through an incident edge, snapped to the corner
    expect(r.hit?.ref.kind).toBe('edge');
    near(r.hit!.point, [2, 1, 1]);
  });

  it('endpoint: sketch vertices are reported as sketchVertex refs', () => {
    const { engine } = fixture();
    const r = engine.resolve(input(down(6.02, 2.03)));
    expect(r.primary.kind).toBe('endpoint');
    near(r.point, [6, 2, 0]);
    expect(r.primary.ref?.kind).toBe('sketchVertex');
  });

  it('midpoint: near the middle of a top edge (cyan, "Midpoint")', () => {
    const { engine } = fixture();
    const r = engine.resolve(input(down(1.02, 1.03)));
    expect(r.primary.kind).toBe('midpoint');
    expect(r.primary.label).toBe('Midpoint');
    near(r.point, [1, 1, 1]);
  });

  it('on edge: near a top edge away from its midpoint (red, "On Edge")', () => {
    const { engine } = fixture();
    const r = engine.resolve(input(down(0.5, 1.03)));
    expect(r.primary.kind).toBe('onEdge');
    expect(r.primary.label).toBe('On Edge');
    near(r.point, [0.5, 1, 1]);
    expect(r.primary.dir).toBeDefined();
    expect(r.hit?.ref.kind).toBe('edge');
  });

  it('on face: a face hit returns {kind:"face"} with the face normal and plane', () => {
    const { engine, bodyId } = fixture();
    const r = engine.resolve(input(down(1, 0.5)));
    expect(r.primary.kind).toBe('onFace');
    expect(r.primary.label).toBe('On Face');
    near(r.point, [1, 0.5, 1]);
    expect(r.hit).not.toBeNull();
    expect(r.hit!.ref).toEqual({ kind: 'face', path: [], id: bodyId, faceId: 1, region: null });
    expect(r.hit!.normal).toEqual([0, 0, 1]);
    expect(r.plane).toEqual({ n: [0, 0, 1], d: -1 });
  });

  it('on face: sketch faces are hit too', () => {
    const { engine } = fixture();
    const r = engine.resolve(input(down(5, 1)));
    expect(r.primary.kind).toBe('onFace');
    expect(r.hit?.ref.kind).toBe('sketchFace');
    near(r.point, [5, 1, 0]);
  });

  it('free point: nothing hit → projected onto the ground plane; parallel ray → 10 units along the ray', () => {
    const { engine } = fixture();
    const r = engine.resolve(input(down(10, 10)));
    expect(r.primary.kind).toBe('free');
    expect(r.hit).toBeNull();
    expect(r.tooltip).toBe('');
    near(r.point, [10, 10, 0]);
    expect(r.plane).toEqual(GROUND_PLANE);

    const parallel = engine.resolve(input({ origin: [10, 10, 5], dir: [1, 0, 0] }));
    near(parallel.point, [20, 10, 5]);
    expect(parallel.primary.kind).toBe('free');

    const custom = engine.resolve(input(down(10, 10)), { plane: { n: [0, 0, 1], d: -3 } });
    near(custom.point, [10, 10, 3]);
    expect(custom.plane).toEqual({ n: [0, 0, 1], d: -3 });
  });

  it('origin: near the model origin with nothing else around', () => {
    const doc = createDocument();
    const engine = createInferenceEngine();
    engine.setState(doc.state);
    const r = engine.resolve(input(down(0.03, -0.02)));
    expect(r.primary.kind).toBe('origin');
    expect(r.tooltip).toBe('Origin');
    near(r.point, [0, 0, 0]);
  });

  it('pickOnly returns the raw hit without snapping', () => {
    const { engine } = fixture();
    const r = engine.resolve(input(down(2.03, 1.0)), { pickOnly: true });
    expect(r.primary.kind).toBe('free');
    expect(r.hit?.ref.kind).toBe('edge');
  });
});

describe('dimension picking', () => {
  it('Select picks a dimension drawn over a face; drawing tools reach the face beneath', () => {
    const { doc, engine } = fixture();
    const dimensionId = doc.transact('dimension', (d) => {
      const root = d.definitions.get(d.rootDefinitionId)!;
      const id = d.meta.nextId++ as Id;
      root.entities.dimensions.set(id, { id, kind: 'linear', start: [0.2, 0.2, 1], end: [1.8, 0.2, 1], offset: [0, 0.5, 0], normal: [0, 0, 1], text: null, fontSizePt: 10,
        tagId: d.defaultTagId, hidden: false, locked: false, castShadows: false, receiveShadows: false, attributes: {} } as never);
      return id;
    }).value;
    engine.setState(doc.state);
    // On the dimension line at y = 0.7, over the top face.
    expect(engine.resolve(input(down(1, 0.72)), { pickOnly: true }).hit?.ref).toEqual({ kind: 'dimension', path: [], id: dimensionId });
    expect(engine.resolve(input(down(1, 0.72)), { pickOnly: true, kinds: ['face', 'sketchFace'] }).hit?.ref.kind).toBe('face');
    expect(engine.resolve(input(down(1, 0.72))).hit?.ref.kind).toBe('face');
    // Away from its lines the face is picked.
    expect(engine.resolve(input(down(1, 0.45)), { pickOnly: true }).hit?.ref.kind).toBe('face');
  });
});

describe('text picking', () => {
  it('Select picks a text by its label or near its leader, over the face beneath; screen text by its box', () => {
    const { doc, engine } = fixture();
    const ids = doc.transact('texts', (d) => {
      const root = d.definitions.get(d.rootDefinitionId)!;
      const base = { fontFamily: 'Arial', fontSizePt: 12, color: [0, 0, 0], tagId: d.defaultTagId, hidden: false, locked: false, castShadows: false, receiveShadows: false, attributes: {} };
      const leader = d.meta.nextId++ as Id, screen = d.meta.nextId++ as Id;
      root.entities.texts.set(leader, { ...base, id: leader, text: 'Note', kind: 'leader', position: [1, 0.5, 1], offset: [0.6, 0, 0], leader: 'pushpin' } as never);
      root.entities.texts.set(screen, { ...base, id: screen, text: 'Title', kind: 'screen', position: [0.1, 0.1, 0], offset: null, leader: 'none' } as never);
      return { leader, screen };
    }).value;
    engine.setState(doc.state);
    // 1 px = 1 cm on screen, with screen y following world y
    const project = (p: Vec3): Vec2 => [p[0] * 100, p[1] * 100];
    const view = { right: [1, 0, 0] as Vec3, up: [0, 1, 0] as Vec3, width: 800, height: 600 };
    const at = (x: number, y: number, screen?: Vec2) => input(down(x, y), { project, view, screen: screen ?? [x * 100, y * 100] });
    const leaderRef = { kind: 'text', path: [], id: ids.leader };
    // on the label, starting at its label point (1.6, 0.5) right of the anchor: about 38 × 16 px for four characters at 12 pt
    expect(engine.resolve(at(1.9, 0.52), { pickOnly: true }).hit?.ref).toEqual(leaderRef);
    // not left of the label point, 8 px off the leader, where a centered box would reach
    expect(engine.resolve(at(1.45, 0.42), { pickOnly: true }).hit?.ref.kind).toBe('face');
    // within 6 px of the leader from (1, 0.5) to the label
    expect(engine.resolve(at(1.2, 0.53), { pickOnly: true }).hit?.ref).toEqual(leaderRef);
    expect(engine.resolve(at(1.5, 0.8), { pickOnly: true }).hit?.ref.kind).toBe('face');
    // drawing tools reach the face
    expect(engine.resolve(at(1.9, 0.52)).hit?.ref.kind).toBe('face');
    // screen text: its box starts at 10% of the view from the top-left
    expect(engine.resolve(at(1.5, 0.8, [90, 68]), { pickOnly: true }).hit?.ref).toEqual({ kind: 'text', path: [], id: ids.screen });
  });
});

describe('section planes and cuts', () => {
  const withCut = (fx: Fixture): Id => {
    const id = fx.doc.transact('section', (d) => {
      const root = d.definitions.get(d.rootDefinitionId)!;
      const sid = d.meta.nextId++ as Id;
      // keeps z <= 0.5
      root.entities.sectionPlanes.set(sid, { id: sid, name: 'Section 1', symbol: '1', plane: { n: [0, 0, -1], d: 0.5 }, origin: [0, 0, 0.5],
        tagId: d.defaultTagId, hidden: false, locked: false, castShadows: false, receiveShadows: false, attributes: {} } as never);
      root.entities.activeSectionPlaneId = sid;
      return sid;
    }).value;
    fx.engine.setState(fx.doc.state);
    return id;
  };

  it('a click on cut-away geometry reaches what lies beyond the cut', () => {
    const fx = fixture();
    expect(fx.engine.resolve(input(down(1, 0.5)), { pickOnly: true }).hit?.point[2]).toBeCloseTo(1, 9);
    withCut(fx);
    const hit = fx.engine.resolve(input(down(1, 0.5)), { pickOnly: true }).hit;
    expect(hit?.ref.kind).toBe('face');
    expect(hit?.point[2]).toBeCloseTo(0, 9);
    // the box's top edges are cut away too; the sketch rectangle on the ground is kept
    expect(fx.engine.resolve(input(down(2.003, 0.5)), { pickOnly: true }).hit?.point[2] ?? 0).toBeLessThan(0.5);
    expect(fx.engine.resolve(input(down(5, 1)), { pickOnly: true }).hit?.ref.kind).toBe('sketchFace');
  });

  it('Select picks a section plane by its outline', () => {
    const fx = fixture();
    const id = withCut(fx);
    // the plane frames the content (x 0..6, y 0..2) with a margin of a quarter of its larger side
    expect(fx.engine.resolve(input(down(3, -1.495)), { pickOnly: true }).hit?.ref).toEqual({ kind: 'sectionPlane', path: [], id });
    expect(fx.engine.resolve(input(down(3, -1.495))).hit?.ref.kind).not.toBe('sectionPlane');
  });
});

describe('directional snaps', () => {
  it('axis snap from an anchor lands exactly on the axis line (solid colored line)', () => {
    const { engine } = fixture();
    const r = engine.resolve(input(down(3, 0.02)), { anchor: [0, 0, 0] });
    expect(r.primary.kind).toBe('onAxis');
    expect(r.primary.axis).toBe('x');
    expect(r.tooltip).toBe('On Red Axis');
    expect(r.point).toEqual([3, 0, 0]);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ a: [0, 0, 0], b: [3, 0, 0], dashed: false });
    expect(r.lockedAxis).toBeNull();
  });

  it('axis snap intersects the hovered face plane ("pull to the height of that face")', () => {
    // anchor on the ground outside the box; cursor over the top face while aligned with z through the anchor
    const { engine } = fixture();
    // a slanted ray that crosses the top face at (1.5, 0.5, 1) and then passes exactly through
    // (3, 0.5, 0.5) on the blue line through the anchor
    const from: Vec3 = [-25.5, 0.5, 10];
    const to: Vec3 = [3, 0.5, 0.5];
    const d: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    const len = Math.hypot(d[0], d[1], d[2]);
    const ray: Ray = { origin: from, dir: [d[0] / len, d[1] / len, d[2] / len] };
    const r = engine.resolve(input(ray), { anchor: [3, 0.5, 0] });
    expect(r.hit?.ref.kind).toBe('face');
    expect(r.primary.kind).toBe('onAxis');
    expect(r.primary.axis).toBe('z');
    near(r.point, [3, 0.5, 1]);
    expect(r.secondary.map((s) => s.kind)).toContain('onFace');
    expect(r.tooltip).toBe('On Blue Axis · On Face');
  });

  it('a strong point snap wins over the axis but shows the axis line when aligned', () => {
    const { engine } = fixture();
    const r = engine.resolve(input(down(2.03, 1.0)), { anchor: [0, 1, 1] });
    expect(r.primary.kind).toBe('endpoint');
    near(r.point, [2, 1, 1]);
    expect(r.secondary.map((s) => s.kind)).toEqual(['onAxis']);
    expect(r.lines[0]).toMatchObject({ a: [0, 1, 1], b: [2, 1, 1], dashed: false });
  });
});

describe('inference memory', () => {
  it('from-point: a dashed axis-colored line from a remembered point', () => {
    const { engine } = fixture();
    engine.rememberPoint([5, 5, 0]);
    const r = engine.resolve(input(down(5.02, 8)));
    expect(r.primary.kind).toBe('fromPoint');
    expect(r.primary.axis).toBe('y');
    expect(r.tooltip).toBe('From Point');
    near(r.point, [5, 8, 0]);
    expect(r.lines).toEqual([{ a: [5, 5, 0], b: [5, 8, 0], color: r.primary.color, dashed: true }]);
  });

  it('from-point combined with an anchor axis: "From Point · On Red Axis" at the intersection', () => {
    const { engine } = fixture();
    engine.rememberPoint([5, 5, 0]);
    const r = engine.resolve(input(down(5.02, 8.03)), { anchor: [0, 8, 0] });
    expect(r.primary.kind).toBe('onAxis');
    expect(r.primary.axis).toBe('x');
    expect(r.secondary.map((s) => s.kind)).toEqual(['fromPoint']);
    expect(r.tooltip).toBe('From Point · On Red Axis');
    near(r.point, [5, 8, 0]);
    expect(r.lines).toHaveLength(2);
    expect(r.lines[1]).toMatchObject({ a: [5, 5, 0], dashed: true });
  });

  it('hovering a snap for > 400 ms pushes it into a 3-deep LRU', () => {
    const { engine, clock } = fixture();
    const corner = input(down(2.03, 1.0));
    engine.resolve(corner);
    clock.now = 300;
    engine.resolve(corner);
    expect(engine.rememberedPoints).toHaveLength(0);
    clock.now = 450;
    engine.resolve(corner);
    expect(engine.rememberedPoints).toHaveLength(1);
    near(engine.rememberedPoints[0]!, [2, 1, 1]);
    // pushed once per hover
    clock.now = 900;
    engine.resolve(corner);
    expect(engine.rememberedPoints).toHaveLength(1);
    // LRU of 3, most recent first, duplicates move to the front
    engine.rememberPoint([1, 1, 1]);
    engine.rememberPoint([2, 2, 2]);
    engine.rememberPoint([3, 3, 3]);
    engine.rememberPoint([2, 2, 2]);
    expect(engine.rememberedPoints).toEqual([
      [2, 2, 2],
      [3, 3, 3],
      [1, 1, 1],
    ]);
    engine.clearMemory();
    expect(engine.rememberedPoints).toHaveLength(0);
  });
});

describe('locks', () => {
  it('lockAxis overrides a face hit: the point is the axis line ∩ the face plane', () => {
    const { engine } = fixture();
    const r = engine.resolve(input(down(1, 0.5)), { anchor: [3, 0.5, 0], lockAxis: 'z' });
    expect(r.hit?.ref.kind).toBe('face');
    expect(r.lockedAxis).toBe('z');
    expect(r.primary.kind).toBe('onAxis');
    near(r.point, [3, 0.5, 1]);
    expect(r.secondary[0]?.kind).toBe('onFace');
    expect(r.lines[0]).toMatchObject({ a: [3, 0.5, 0], b: [3, 0.5, 1] });
  });

  it('lockAxis projects a hovered endpoint onto the locked line', () => {
    const { engine } = fixture();
    const r = engine.resolve(input(down(2.03, 1.0)), { anchor: [3, 0.5, 0], lockAxis: 'z' });
    near(r.point, [3, 0.5, 1]);
    expect(r.secondary[0]?.kind).toBe('endpoint');
    expect(r.tooltip).toBe('On Blue Axis · Endpoint');
  });

  it('lockAxis without an anchor uses the model origin; nothing hit → nearest point to the ray', () => {
    const { engine } = fixture();
    const r = engine.resolve(input(down(10, 3)), { lockAxis: 'x' });
    near(r.point, [10, 0, 0]);
  });

  it('lockSnap freezes a line constraint (e.g. a face normal for push/pull)', () => {
    const { engine } = fixture();
    const lock: Snap = { kind: 'perpendicular', point: [3, 0.5, 0], dir: [0, 0, 1], color: '#d81bd8', label: 'Perpendicular to Face' };
    const r = engine.resolve(input(down(1, 0.5)), { lockSnap: lock });
    near(r.point, [3, 0.5, 1]);
    expect(r.primary.kind).toBe('perpendicular');
    expect(r.primary.label).toBe('Perpendicular to Face');
  });

  it('lockSnap freezes a plane constraint', () => {
    const { engine } = fixture();
    const lock: Snap = { kind: 'onPlane', point: [0, 0, 2], plane: { n: [0, 0, 1], d: -2 }, color: '#2d5bd1', label: 'On Plane' };
    const r = engine.resolve(input(down(1, 0.5)), { lockSnap: lock });
    near(r.point, [1, 0.5, 2]);
    expect(r.plane).toEqual({ n: [0, 0, 1], d: -1 }); // the surface under the cursor is still reported
  });
});

describe('picking', () => {
  it('occlusion: an edge behind a face is not picked, but is once the body is ignored', () => {
    const { engine, bodyId } = fixture({ hiddenEdge: true });
    const r = engine.resolve(input(down(1, 0.5)));
    expect(r.primary.kind).toBe('onFace');
    expect(r.hit?.ref.kind).toBe('face');
    const ignore: EntityRef[] = [{ kind: 'body', path: [], id: bodyId }];
    const r2 = engine.resolve(input(down(1, 0.5)), { ignore });
    expect(r2.hit?.ref.kind).toBe('sketchEdge');
    expect(r2.primary.kind).toBe('onEdge');
    near(r2.point, [1, 0.5, -1]);
  });

  it('an edge of the hit face is still pickable (not occluded by its own face)', () => {
    const { engine } = fixture();
    const r = engine.resolve(input(down(1.5, 0.98)));
    expect(r.hit?.ref.kind).toBe('edge');
    expect(r.primary.kind).toBe('onEdge');
    near(r.point, [1.5, 1, 1]);
  });

  it('precedence: vertex > edge > face', () => {
    const { engine } = fixture();
    const pick = new PickService(engine.index);
    const v = pick.pick(input(down(1.97, 0.97)));
    expect(v?.ref.kind).toBe('edge');
    near(v!.point, [2, 1, 1]);
    const e = pick.pick(input(down(1.5, 0.97)));
    expect(e?.ref.kind).toBe('edge');
    near(e!.point, [1.5, 1, 1]);
    const f = pick.pick(input(down(1, 0.5)));
    expect(f?.ref.kind).toBe('face');
    expect(f?.screenDist).toBe(0);
  });

  it('kinds restricts what is picked', () => {
    const { engine } = fixture();
    const r = engine.pick(input(down(1.97, 0.97)), { kinds: ['face'] });
    expect(r?.ref.kind).toBe('face');
    expect(engine.pick(input(down(5, 1)), { kinds: ['sketchEdge'] })).toBeNull();
  });

  it('pickBox: window keeps fully enclosed entities, crossing keeps touched ones', () => {
    const { engine, bodyId } = fixture();
    const pick = new PickService(engine.index);
    const inp = input(down(0, 0));
    const kinds = (refs: EntityRef[]): string[] => refs.map((r) => r.kind).sort();

    const bodyWindow = pick.pickBox({ min: [-1, -1], max: [3, 3] }, inp, 'window');
    expect(bodyWindow).toEqual([{ kind: 'body', path: [], id: bodyId }]);

    expect(pick.pickBox({ min: [-1, -1], max: [1, 3] }, inp, 'window')).toEqual([]);
    expect(kinds(pick.pickBox({ min: [-1, -1], max: [1, 3] }, inp, 'crossing'))).toEqual(['body']);

    const sketchWindow = pick.pickBox({ min: [3, -1], max: [7, 3] }, inp, 'window');
    expect(kinds(sketchWindow)).toEqual(['sketchEdge', 'sketchEdge', 'sketchEdge', 'sketchEdge', 'sketchFace']);

    const sketchCrossing = pick.pickBox({ min: [5, -1], max: [7, 3] }, inp, 'crossing');
    expect(kinds(sketchCrossing)).toEqual(['sketchEdge', 'sketchEdge', 'sketchEdge', 'sketchFace']);
    // only the edge at x = 6 is fully enclosed
    expect(kinds(pick.pickBox({ min: [5, -1], max: [7, 3] }, inp, 'window'))).toEqual(['sketchEdge']);

    // a rect entirely inside the box's top face still crosses the body
    expect(kinds(pick.pickBox({ min: [0.5, 0.25], max: [1.5, 0.75] }, inp, 'crossing'))).toEqual(['body']);
    // reversed corners are normalized
    expect(pick.pickBox({ min: [3, 3], max: [-1, -1] }, inp, 'window')).toEqual(bodyWindow);
  });

  it('pickLasso: window keeps what the outline encloses, crossing what it touches', () => {
    const { engine, bodyId } = fixture();
    const pick = new PickService(engine.index);
    const inp = input(down(0, 0));
    const kinds = (refs: EntityRef[]): string[] => refs.map((r) => r.kind).sort();

    const diamond: Vec2[] = [[1, -2], [4, 0.5], [1, 3], [-2, 0.5]];
    expect(pick.pickLasso(diamond, inp, 'window')).toEqual([{ kind: 'body', path: [], id: bodyId }]);
    // A notch that cuts into the sketch rectangle's bottom edge between its corners: every corner is inside,
    // but the bottom edge and the face leave the outline, so only the other three edges are enclosed.
    const notched: Vec2[] = [[3, -1], [4.5, -1], [4.5, 1], [5.5, 1], [5.5, -1], [7, -1], [7, 3], [3, 3]];
    expect(kinds(pick.pickLasso(notched, inp, 'window'))).toEqual(['sketchEdge', 'sketchEdge', 'sketchEdge']);
    expect(kinds(pick.pickLasso(notched, inp, 'crossing'))).toEqual(['sketchEdge', 'sketchEdge', 'sketchEdge', 'sketchEdge', 'sketchFace']);
    // an outline inside the box's top face crosses the body but encloses nothing
    const inner: Vec2[] = [[0.5, 0.25], [1.5, 0.25], [1, 0.75]];
    expect(kinds(pick.pickLasso(inner, inp, 'crossing'))).toEqual(['body']);
    expect(pick.pickLasso(inner, inp, 'window')).toEqual([]);
    expect(pick.pickLasso([[20, 20], [30, 20], [25, 30]], inp, 'crossing')).toEqual([]);
    expect(pick.pickLasso([[-1, -1], [3, 3]], inp, 'crossing')).toEqual([]);
  });
});

describe('SpatialIndex', () => {
  it('rebuilds only changed bodies and the sketch when its identity changes', () => {
    const { doc, engine, bodyId } = fixture();
    const index = engine.index;
    const before = index.body(bodyId)!;
    const sketchBefore = index.sketch()!;
    // sketch-only change
    doc.transact('sketch', (d) => {
      SketchGraph.for(d).addEdge([8, 8, 0], [9, 8, 0]);
    });
    index.setState(doc.state);
    expect(index.body(bodyId)).toBe(before);
    expect(index.sketch()).not.toBe(sketchBefore);
    // body mesh change
    doc.transact('body', (d) => {
      const b = d.definitions.get(d.rootDefinitionId)!.entities.bodies.get(bodyId)!;
      b.mesh = meshBox([0, 0, 0], [2, 1, 2]);
      b.version++;
    });
    index.setState(doc.state);
    const after = index.body(bodyId)!;
    expect(after).not.toBe(before);
    expect(after.version).toBe(1);
    expect(after.triBVH).not.toBe(before.triBVH);
    // non-geometric change keeps the BVHs
    doc.transact('flag', (d) => {
      d.definitions.get(d.rootDefinitionId)!.entities.bodies.get(bodyId)!.locked = true;
    });
    index.setState(doc.state);
    expect(index.body(bodyId)!.triBVH).toBe(after.triBVH);
    expect(index.body(bodyId)!.body.locked).toBe(true);
    // a hidden body leaves the index entirely (neither pickable nor occluding)
    doc.transact('hide', (d) => {
      d.definitions.get(d.rootDefinitionId)!.entities.bodies.get(bodyId)!.hidden = true;
    });
    index.setState(doc.state);
    expect(index.body(bodyId)).toBeUndefined();
  });

  it('builds a 50k-triangle body in under 1500 ms (sanity bound; CI and parallel runs are noisy)', () => {
    const doc = createDocument();
    const mesh = uvSphere(160, 160);
    expect(mesh.tris.length / 3).toBeGreaterThanOrEqual(50_000);
    doc.transact('sphere', (d) => {
      const root = d.definitions.get(d.rootDefinitionId)!;
      bodyFromMesh(d, mesh, { container: root.entities });
    });
    const index = new SpatialIndex();
    index.setState(doc.state);
    const t0 = performance.now();
    index.ensure();
    const ms = performance.now() - t0;
    expect(index.bodies()).toHaveLength(1);
    expect(ms).toBeLessThan(1500);
    // and it picks
    const pick = new PickService(index);
    const hit = pick.pick(input(down(0, 0)));
    expect(hit?.ref.kind).toBe('face');
    expect(hit!.point[2]).toBeCloseTo(1, 3);
  });
});

/** Closed UV sphere of radius 1 with a single face id (only the triangle BVH matters here). */
function uvSphere(segments: number, rings: number): MeshData {
  const verts: number[] = [];
  const tris: number[] = [];
  for (let r = 0; r <= rings; r++) {
    const phi = (Math.PI * r) / rings;
    for (let s = 0; s < segments; s++) {
      const theta = (2 * Math.PI * s) / segments;
      verts.push(Math.sin(phi) * Math.cos(theta), Math.sin(phi) * Math.sin(theta), Math.cos(phi));
    }
  }
  const at = (r: number, s: number): number => r * segments + (s % segments);
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = at(r, s), b = at(r + 1, s), c = at(r + 1, s + 1), d = at(r, s + 1);
      tris.push(a, b, c, a, c, d);
    }
  }
  return { verts: new Float64Array(verts), tris: new Uint32Array(tris), faceId: new Uint32Array(tris.length / 3) };
}

describe('lock line vs hovered surface', () => {
  it('does not pin the point to the origin when the hovered plane passes through it', async () => {
    const { createDocument, bodyFromMesh } = await import('@pushform/model');
    const { meshBox } = await import('@pushform/core');
    const doc = createDocument();
    doc.transact('box', (draft) => {
      const root = draft.definitions.get(draft.rootDefinitionId)!;
      bodyFromMesh(draft, meshBox([0, 0, 0], [1, 1, 1]), { container: root.entities });
    });
    const engine = createInferenceEngine();
    engine.setState(doc.state);
    // Looking down at an angle so the ray through a point 0.5 above the top face also crosses the top face.
    const target: [number, number, number] = [0.5, 0.5, 1.5];
    const eye: [number, number, number] = [0.5, -2, 3];
    const d = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
    const l = Math.hypot(d[0]!, d[1]!, d[2]!);
    const ray = { origin: eye, dir: [d[0]! / l, d[1]! / l, d[2]! / l] as [number, number, number] };
    const res = engine.resolve(
      { ray, screen: [0, 0], pixelSizeAt: () => 0.002 },
      {
        anchor: [0.5, 0.5, 1],
        lockSnap: { kind: 'perpendicular', point: [0.5, 0.5, 1], dir: [0, 0, 1], color: '#000', label: 'Perpendicular to Face' },
      },
    );
    expect(res.point[2]).toBeCloseTo(1.5, 3);
  });
});
