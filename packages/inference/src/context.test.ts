// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { m4mul, m4rotationAxis, m4translation, meshBox, type DefId, type Id, type Mat4, type MMat4, type Ray, type TagFolderId, type TagId, type Vec2, type Vec3 } from '@pushform/core';
import { bodyFromMesh, createDocument, createEntityContainer, SketchGraph, type ComponentInstance, type Document, type DocumentDraft } from '@pushform/model';
import { InferenceEngineImpl } from './InferenceEngineImpl';
import { SNAP_COLORS, type InferenceInput } from './types';

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

/** A new definition (group or component) with an empty container, inside the draft. */
function addDefinition(d: DocumentDraft, name: string, isGroup: boolean): DefId {
  const root = d.definitions.get(d.rootDefinitionId)!;
  const id = d.meta.nextId++ as DefId;
  d.definitions.set(id, { ...root, id, name, isGroup, entities: createEntityContainer(), bounds: null } as never);
  return id;
}

/** Place an instance of `definitionId` in the container at `parentPath` (root for []). */
function addInstance(d: DocumentDraft, parentDef: DefId, definitionId: DefId, transform: MMat4, extra: Partial<ComponentInstance> = {}): Id {
  const id = d.meta.nextId++ as Id;
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

/** Rotation of 90° about Z, then translation by (10, 0, 0): local (x, y, z) → world (10 − y, x, z). */
const MOVED: MMat4 = m4mul(m4translation([10, 0, 0]), m4rotationAxis([0, 0, 1], Math.PI / 2));

interface Fixture {
  doc: Document;
  engine: InferenceEngineImpl;
  /** Instance of a group holding a 2×1×1 box, placed with `MOVED`. */
  inst: Id;
  bodyId: Id;
}

/**
 * A group instance (2×1×1 box at its local origin) moved by `MOVED`: its top face spans world
 * x 9..10, y 0..2 at z = 1; the local corner (2, 1, 1) lands at (9, 2, 1) and the local top edge
 * (0,1,1)→(2,1,1) becomes (9,0,1)→(9,2,1) with midpoint (9, 1, 1).
 */
function fixture(opts: { isGroup?: boolean; hiddenInstance?: boolean; locked?: boolean; hiddenTagBody?: boolean } = {}): Fixture {
  const doc = createDocument();
  let inst = 0 as Id, bodyId = 0 as Id;
  doc.transact('fixture', (d) => {
    const def = addDefinition(d, 'Box', opts.isGroup ?? true);
    let tagId: TagId = d.defaultTagId;
    if (opts.hiddenTagBody) {
      tagId = d.meta.nextId++ as TagId;
      d.tags.set(tagId, { id: tagId, name: 'Hidden', visible: false, color: [0, 0, 0], dashes: null, folderId: null });
    }
    bodyId = bodyFromMesh(d, meshBox([0, 0, 0], [2, 1, 1]), { container: d.definitions.get(def)!.entities, tagId }).id;
    inst = addInstance(d, d.rootDefinitionId, def, MOVED, { hidden: opts.hiddenInstance ?? false, locked: opts.locked ?? false });
  });
  const engine = new InferenceEngineImpl({ clock: () => 0 });
  engine.setState(doc.state);
  return { doc, engine, inst, bodyId };
}

describe('whole-model index: instances in world space', () => {
  it('picks the moved box corner at its world position with the instance path on the ref', () => {
    const { engine, inst, bodyId } = fixture();
    const hit = engine.pick(input(down(9.03, 2.0)))!;
    expect(hit).not.toBeNull();
    expect(hit.ref).toMatchObject({ kind: 'edge', path: [inst], id: bodyId });
    near(hit.point, [9, 2, 1]);
    // nothing is left at the box's local position
    expect(engine.pick(input(down(1, 0.5)))).toBeNull();
  });

  it('a face hit on the moved box is in world space and keeps the world normal', () => {
    const { engine, inst, bodyId } = fixture();
    const hit = engine.pick(input(down(9.5, 1.0)))!;
    expect(hit.ref).toMatchObject({ kind: 'face', path: [inst], id: bodyId });
    near(hit.point, [9.5, 1, 1]);
    near(hit.normal!, [0, 0, 1]);
  });

  it('selectable: the instance from the root context, the entity itself inside the instance context', () => {
    const { engine, inst, bodyId } = fixture();
    const fromRoot = engine.pick(input(down(9.03, 2.0)))!;
    expect(fromRoot.selectable).toEqual({ kind: 'instance', path: [], id: inst });
    expect(fromRoot.inContext).toBe(false);

    const inside = engine.pick(input(down(9.03, 2.0)), { context: [inst] })!;
    expect(inside.selectable).toEqual(inside.ref);
    expect(inside.ref).toMatchObject({ kind: 'edge', path: [inst], id: bodyId });
    expect(inside.inContext).toBe(true);

    // the engine-level context works the same as the per-call option
    engine.setContext([inst]);
    expect(engine.context).toEqual([inst]);
    const viaEngine = engine.pick(input(down(9.5, 1.0)))!;
    expect(viaEngine.inContext).toBe(true);
    expect(viaEngine.selectable!.kind).toBe('face');
  });

  it('snapping to the moved midpoint from the root context: world point, magenta, "Midpoint in Group"', () => {
    const { engine, inst } = fixture();
    const r = engine.resolve(input(down(9.02, 1.0)));
    expect(r.primary.kind).toBe('midpoint');
    near(r.point, [9, 1, 1]);
    expect(r.primary.label).toBe('Midpoint in Group');
    expect(r.primary.color).toBe(SNAP_COLORS.otherContext);
    expect(r.primary.inOtherContext).toBe(true);
    expect(r.tooltip).toBe('Midpoint in Group');
    expect(r.hit?.selectable).toEqual({ kind: 'instance', path: [], id: inst });

    // inside the group the same snap is an ordinary cyan midpoint
    const inside = engine.resolve(input(down(9.02, 1.0)), { context: [inst] });
    expect(inside.primary.label).toBe('Midpoint');
    expect(inside.primary.color).toBe(SNAP_COLORS.midpoint);
    expect(inside.primary.inOtherContext).toBeUndefined();
  });

  it('components are labelled "in Component"; faces get "On Face in Component"', () => {
    const { engine } = fixture({ isGroup: false });
    const r = engine.resolve(input(down(9.5, 1.0)));
    expect(r.primary.kind).toBe('onFace');
    expect(r.primary.label).toBe('On Face in Component');
    expect(r.primary.color).toBe(SNAP_COLORS.otherContext);
  });

  it('root entities seen from inside a group resolve to themselves but are not in context', () => {
    const { doc, engine, inst } = fixture();
    doc.transact('root sketch', (d) => {
      SketchGraph.for(d).addEdge([20, 0, 0], [22, 0, 0]);
    });
    engine.setState(doc.state);
    const hit = engine.pick(input(down(21, 0.02)), { context: [inst] })!;
    expect(hit.ref.kind).toBe('sketchEdge');
    expect(hit.ref.path).toEqual([]);
    expect(hit.selectable).toEqual(hit.ref);
    expect(hit.inContext).toBe(false);
    const snap = engine.resolve(input(down(21, 0.02)), { context: [inst] });
    expect(snap.primary.label).toBe('Midpoint in Group');
  });

  it('hidden instance: nothing is picked', () => {
    const { engine } = fixture({ hiddenInstance: true });
    expect(engine.pick(input(down(9.03, 2.0)))).toBeNull();
    expect(engine.pick(input(down(9.5, 1.0)))).toBeNull();
    expect(engine.index.bodies()).toHaveLength(0);
  });

  it('tag-hidden body: nothing is picked; switching the tag on brings it back', () => {
    const { doc, engine, bodyId } = fixture({ hiddenTagBody: true });
    expect(engine.pick(input(down(9.5, 1.0)))).toBeNull();
    doc.transact('show tag', (d) => {
      const body = [...d.definitions.values()].flatMap((def) => [...def.entities.bodies.values()]).find((b) => b.id === bodyId)!;
      d.tags.get(body.tagId)!.visible = true;
    });
    engine.setState(doc.state);
    expect(engine.pick(input(down(9.5, 1.0)))?.ref.kind).toBe('face');
  });

  it('tag hidden only by its folder: nothing is picked, as nothing is drawn; showing the folder brings it back', () => {
    const { doc, engine, bodyId } = fixture({ hiddenTagBody: true });
    const folderId = 9000 as TagFolderId;
    doc.transact('hide folder', (d) => {
      const body = [...d.definitions.values()].flatMap((def) => [...def.entities.bodies.values()]).find((b) => b.id === bodyId)!;
      d.tagFolders.set(folderId, { id: folderId, name: 'Off', visible: false, parentId: null });
      Object.assign(d.tags.get(body.tagId)!, { visible: true, folderId });
    });
    engine.setState(doc.state);
    expect(engine.pick(input(down(9.5, 1.0)))).toBeNull();
    doc.transact('show folder', (d) => { d.tagFolders.get(folderId)!.visible = true; });
    engine.setState(doc.state);
    expect(engine.pick(input(down(9.5, 1.0)))?.ref.kind).toBe('face');
  });

  it('locked instance: selectable from the root, but its entities never pick as inContext', () => {
    const { engine, inst } = fixture({ locked: true });
    const fromRoot = engine.pick(input(down(9.5, 1.0)))!;
    expect(fromRoot.selectable).toEqual({ kind: 'instance', path: [], id: inst });
    const inside = engine.pick(input(down(9.5, 1.0)), { context: [inst] })!;
    expect(inside.inContext).toBe(false);
    expect(inside.selectable).toEqual(inside.ref);
  });

  it('pickBox from the root selects the instance; inside the group it selects the body', () => {
    const { engine, inst, bodyId } = fixture();
    engine.pick(input(down(0, 0))); // seeds the projector
    const rect = { min: [8.5, -0.5] as Vec2, max: [10.5, 2.5] as Vec2 };
    expect(engine.pickBox({ ...rect, mode: 'window' })).toEqual([{ kind: 'instance', path: [], id: inst }]);
    // window: a rect that cuts the box selects nothing; crossing: it selects the instance
    const half = { min: [8.5, -0.5] as Vec2, max: [9.5, 2.5] as Vec2 };
    expect(engine.pickBox({ ...half, mode: 'window' })).toEqual([]);
    expect(engine.pickBox({ ...half, mode: 'crossing' })).toEqual([{ kind: 'instance', path: [], id: inst }]);
    // inside the group the body itself is selected and the instance is not a candidate
    expect(engine.pickBox({ ...rect, mode: 'window' }, { context: [inst] })).toEqual([{ kind: 'body', path: [inst], id: bodyId }]);
  });

  it('ignore: an instance ref hides everything inside it', () => {
    const { engine, inst } = fixture();
    expect(engine.pick(input(down(9.5, 1.0)), { ignore: [{ kind: 'instance', path: [], id: inst }] })).toBeNull();
  });

  it('toLocal / toWorld wrap the context matrices', () => {
    const { engine, inst } = fixture();
    near(engine.toWorld([2, 1, 1], [inst]), [9, 2, 1]);
    near(engine.toLocal([9, 2, 1], [inst]), [2, 1, 1]);
    near(engine.toLocal([9, 2, 1]), [9, 2, 1]); // root context: identity
    engine.setContext([inst]);
    near(engine.toLocal([9, 2, 1]), [2, 1, 1]);
    expect(engine.contextMatrix([])).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });

  it('keeps the body index of an untouched instance across unrelated edits and rebuilds on a transform change', () => {
    const { doc, engine, inst, bodyId } = fixture();
    const before = engine.index.body(bodyId, [inst])!;
    doc.transact('root sketch', (d) => {
      SketchGraph.for(d).addEdge([20, 0, 0], [22, 0, 0]);
    });
    engine.setState(doc.state);
    expect(engine.index.body(bodyId, [inst])).toBe(before);
    doc.transact('move', (d) => {
      d.definitions.get(d.rootDefinitionId)!.entities.instances.get(inst)!.transform = m4translation([0, 0, 5]) as unknown as Mat4;
    });
    engine.setState(doc.state);
    const after = engine.index.body(bodyId, [inst])!;
    expect(after).not.toBe(before);
    near(engine.pick(input(down(1, 0.5)))!.point, [1, 0.5, 6]);
  });
});

describe('nested instances', () => {
  interface Nested {
    engine: InferenceEngineImpl;
    outer: Id;
    inner: Id;
    bodyId: Id;
  }
  /** outer (group, +10 x) → inner (component, +5 y) → 2×1×1 box: world x 10..12, y 5..6, z 0..1. */
  function nested(): Nested {
    const doc = createDocument();
    let outer = 0 as Id, inner = 0 as Id, bodyId = 0 as Id;
    doc.transact('nested', (d) => {
      const defA = addDefinition(d, 'Outer', true);
      const defB = addDefinition(d, 'Inner', false);
      bodyId = bodyFromMesh(d, meshBox([0, 0, 0], [2, 1, 1]), { container: d.definitions.get(defB)!.entities }).id;
      outer = addInstance(d, d.rootDefinitionId, defA, m4translation([10, 0, 0]));
      inner = addInstance(d, defA, defB, m4translation([0, 5, 0]));
    });
    const engine = new InferenceEngineImpl({ clock: () => 0 });
    engine.setState(doc.state);
    return { engine, outer, inner, bodyId };
  }

  it('path length 2; selectable resolves per context level', () => {
    const { engine, outer, inner, bodyId } = nested();
    const root = engine.pick(input(down(11, 5.5)))!;
    expect(root.ref).toMatchObject({ kind: 'face', path: [outer, inner], id: bodyId });
    near(root.point, [11, 5.5, 1]);
    expect(root.selectable).toEqual({ kind: 'instance', path: [], id: outer });
    expect(root.inContext).toBe(false);

    const fromOuter = engine.pick(input(down(11, 5.5)), { context: [outer] })!;
    expect(fromOuter.selectable).toEqual({ kind: 'instance', path: [outer], id: inner });
    expect(fromOuter.inContext).toBe(false);

    const fromInner = engine.pick(input(down(11, 5.5)), { context: [outer, inner] })!;
    expect(fromInner.selectable).toEqual(fromInner.ref);
    expect(fromInner.inContext).toBe(true);
  });

  it('labels name the owning container: "in Component" for the inner component', () => {
    const { engine, outer } = nested();
    expect(engine.resolve(input(down(11, 5.5))).primary.label).toBe('On Face in Component');
    expect(engine.resolve(input(down(11, 5.5)), { context: [outer] }).primary.label).toBe('On Face in Component');
  });

  it('pickBox: the outer instance from the root, the inner instance from the outer context', () => {
    const { engine, outer, inner } = nested();
    engine.pick(input(down(0, 0)));
    const rect = { min: [9, 4] as Vec2, max: [13, 7] as Vec2, mode: 'window' as const };
    expect(engine.pickBox(rect)).toEqual([{ kind: 'instance', path: [], id: outer }]);
    expect(engine.pickBox(rect, { context: [outer] })).toEqual([{ kind: 'instance', path: [outer], id: inner }]);
    expect(engine.pickBox(rect, { context: [outer, inner] })).toEqual([{ kind: 'body', path: [outer, inner], id: expect.any(Number) }]);
  });

  it('a hidden outer instance hides the whole subtree', () => {
    const doc = createDocument();
    doc.transact('nested hidden', (d) => {
      const defA = addDefinition(d, 'Outer', true);
      const defB = addDefinition(d, 'Inner', true);
      bodyFromMesh(d, meshBox([0, 0, 0], [2, 1, 1]), { container: d.definitions.get(defB)!.entities });
      addInstance(d, d.rootDefinitionId, defA, m4translation([10, 0, 0]), { hidden: true });
      addInstance(d, defA, defB, m4translation([0, 5, 0]));
    });
    const engine = new InferenceEngineImpl({ clock: () => 0 });
    engine.setState(doc.state);
    expect(engine.pick(input(down(11, 5.5)))).toBeNull();
    expect(engine.index.containerEntries()).toHaveLength(1);
  });
});
