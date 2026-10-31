// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { M4_IDENTITY, formatLength, m4translation, meshBox } from '@pushform/core';
import type { DefId, Id, MaterialId, TagId, Vec3 } from '@pushform/core';
import { SketchGraph, allocId, bodyFromMesh, createDocument, createEntityContainer, pathKey } from '@pushform/model';
import type { Body, EntityRef, Guide } from '@pushform/model';
import { renderKey } from '@pushform/render';
import {
  axesToRender,
  bodiesToRender,
  dimensionsToRender,
  displayToRender,
  editContextToRender,
  guidesToRender,
  highlightFor,
  highlightsFor,
  instanceWorldBounds,
  sketchToRender,
  sketchesToRender,
  tagVisible,
  textsToRender,
} from './renderAdapter';

function docWithRectangle() {
  const doc = createDocument();
  doc.transact('rect', (draft) => {
    const g = SketchGraph.for(draft);
    g.addEdge([0, 0, 0], [2, 0, 0]);
    g.addEdge([2, 0, 0], [2, 1, 0]);
    g.addEdge([2, 1, 0], [0, 1, 0]);
    g.addEdge([0, 1, 0], [0, 0, 0]);
  });
  return doc;
}

function docWithBox(): { doc: ReturnType<typeof createDocument>; body: Body } {
  const doc = createDocument();
  let id = 0 as Id;
  doc.transact('box', (draft) => {
    const root = draft.definitions.get(draft.rootDefinitionId)!;
    id = bodyFromMesh(draft, meshBox([0, 0, 0], [1, 2, 3]), { container: root.entities }).id;
  });
  const body = doc.rootDefinition.entities.bodies.get(id)!;
  return { doc, body };
}

describe('sketchToRender', () => {
  it('yields one face with 4 loop points and 4 edges for a sketch rectangle', () => {
    const doc = docWithRectangle();
    const rs = sketchToRender(doc.state)!;
    expect(rs.faces).toHaveLength(1);
    expect(rs.faces[0]!.loops).toHaveLength(1);
    expect(rs.faces[0]!.loops[0]).toHaveLength(4);
    expect(rs.faces[0]!.frontColor).toBeUndefined();
    expect(rs.faces[0]!.hidden).toBe(false);
    expect(rs.edges).toHaveLength(4);
    expect(rs.edges.every((e) => !e.soft && !e.hidden)).toBe(true);
    // version token is the immutable sketch: stable across calls, new after a transaction
    expect(sketchToRender(doc.state)!.version).toBe(rs.version);
    doc.transact('more', (draft) => {
      SketchGraph.for(draft).addEdge([5, 5, 0], [6, 5, 0]);
    });
    expect(sketchToRender(doc.state)!.version).not.toBe(rs.version);
    expect(sketchToRender(doc.state)!.edges).toHaveLength(5);
  });
});

describe('highlightsFor', () => {
  it('maps body, face and edge refs of a box to loops / polylines / tints', () => {
    const { doc, body } = docWithBox();
    const faceId = body.faces.keys().next().value!;
    const edgeKey = body.edges.keys().next().value!;
    const faceRef: EntityRef = { kind: 'face', path: [], id: body.id, faceId, region: null };
    const edgeRef: EntityRef = { kind: 'edge', path: [], id: body.id, edgeKey };
    const bodyRef: EntityRef = { kind: 'body', path: [], id: body.id };
    const h = highlightsFor(doc.state, faceRef, [edgeRef, bodyRef]);
    expect(h.hover).toEqual({ kind: 'face', key: renderKey([], body.id), faceId, loops: body.faces.get(faceId)!.loops });
    expect(h.hover?.kind === 'face' && h.hover.loops[0]!.length).toBe(4);
    expect(h.selected).toHaveLength(2);
    expect(h.selected[0]).toEqual({ kind: 'edge', points: body.edges.get(edgeKey)!.polyline });
    const whole = h.selected[1]!;
    expect(whole).toMatchObject({ kind: 'body', key: renderKey([], body.id) });
    // a selected solid outlines every one of its edges
    expect(whole.kind === 'body' && whole.edges).toEqual([...body.edges.values()].map((e) => e.polyline));
    // stale refs disappear instead of throwing
    expect(highlightFor(doc.state, { kind: 'body', path: [], id: 9999 as Id })).toBeNull();
  });

  it('maps sketch refs through the sketch maps', () => {
    const doc = docWithRectangle();
    const sketch = doc.rootDefinition.entities.sketch;
    const face = sketch.faces.values().next().value!;
    const edge = sketch.edges.values().next().value!;
    const h = highlightsFor(doc.state, null, [
      { kind: 'sketchFace', path: [], id: face.id },
      { kind: 'sketchEdge', path: [], id: edge.id },
      { kind: 'sketchVertex', path: [], id: edge.a },
    ]);
    expect(h.hover).toBeNull();
    expect(h.selected.map((s) => s.kind)).toEqual(['sketchFace', 'sketchEdge', 'sketchVertex']);
    const sf = h.selected[0]!;
    expect(sf.kind === 'sketchFace' && sf.loops[0]!.length).toBe(4);
    const se = h.selected[1]!;
    expect(se.kind === 'sketchEdge' && se.a).toEqual(sketch.vertices.get(edge.a)!.p);
  });
});

function docWithGuides() {
  const doc = createDocument();
  const ids: Id[] = [];
  doc.transact('guides', (draft) => {
    const root = draft.definitions.get(draft.rootDefinitionId)!;
    const common = { tagId: draft.defaultTagId, hidden: false, locked: false, castShadows: false, receiveShadows: false, attributes: {} };
    type GuideShape = { kind: 'line'; origin: Vec3; dir: Vec3 } | { kind: 'point'; origin: Vec3 } | { kind: 'segment'; origin: Vec3; end: Vec3 };
    const add = (g: GuideShape, hidden = false) => {
      const id = allocId(draft);
      ids.push(id);
      const guide: Guide = { ...common, hidden, id, ...g };
      root.entities.guides.set(id, guide as never); // immer's WritableDraft rejects readonly Vec3 tuples
    };
    add({ kind: 'line', origin: [1, 2, 3], dir: [0, 0, 1] });
    add({ kind: 'point', origin: [4, 5, 6] });
    add({ kind: 'segment', origin: [0, 0, 0], end: [1, 0, 0] });
    add({ kind: 'line', origin: [9, 9, 9], dir: [1, 0, 0] }, true);
  });
  return { doc, ids };
}

describe('bodiesToRender', () => {
  it('passes hidden solid face identities to the renderer and invalidates after hide/undo', () => {
    const { doc, body } = docWithBox();
    const original = bodiesToRender(doc.state)[0]!.hiddenFaces;
    const faceId = body.faces.keys().next().value!;
    const tx = doc.transact('Hide face', draft => {
      draft.definitions.get(draft.rootDefinitionId)!.entities.bodies.get(body.id)!.faces.get(faceId)!.hidden = true;
    });
    const hidden = bodiesToRender(doc.state)[0]!;
    expect(hidden.hiddenFaces).toEqual(new Set([faceId]));
    expect(hidden.hiddenFaces).not.toBe(original);
    expect(bodiesToRender(doc.state)[0]!.hiddenFaces).toBe(hidden.hiddenFaces);
    doc.applyPatches(tx.inversePatches, tx.patches, 'undo', 'Hide face');
    expect(bodiesToRender(doc.state)[0]!.hiddenFaces?.size).toBe(0);
  });
  it('hands the renderer edge records (flags + face pair) and surfaces with stable identity', () => {
    const { doc, body } = docWithBox();
    const rb = bodiesToRender(doc.state);
    expect(rb).toHaveLength(1);
    expect(rb[0]!.id).toBe(renderKey([], body.id));
    expect(rb[0]!.path).toEqual([]);
    expect(rb[0]!.entityId).toBe(body.id);
    expect(rb[0]!.transform).toBe(M4_IDENTITY);
    expect(rb[0]!.defaultColor).toBeUndefined();
    expect(rb[0]!.edges).toHaveLength(12);
    const first = body.edges.values().next().value!;
    expect(rb[0]!.edges![0]).toEqual({ points: first.polyline, soft: false, smooth: false, hidden: false, faceA: first.faceA, faceB: first.faceB });
    expect(rb[0]!.surfaces).toEqual([]);
    // unchanged body → same arrays (the renderer diffs them by identity)
    const again = bodiesToRender(doc.state);
    expect(again[0]!.edges).toBe(rb[0]!.edges);
    expect(again[0]!.surfaces).toBe(rb[0]!.surfaces);
    // softening an edge yields a new edges array without touching the version
    doc.transact('soften', (draft) => {
      const b = draft.definitions.get(draft.rootDefinitionId)!.entities.bodies.get(body.id)!;
      const e = b.edges.get(first.key)!;
      e.soft = true;
      e.smooth = true;
      b.surfaces.set(1 as never, { id: 1 as never, faceIds: [first.faceA, first.faceB], curveId: null });
    });
    const after = bodiesToRender(doc.state);
    expect(after[0]!.version).toBe(rb[0]!.version);
    expect(after[0]!.edges).not.toBe(rb[0]!.edges);
    expect(after[0]!.edges![0]!.soft).toBe(true);
    expect(after[0]!.surfaces).toEqual([{ faceIds: [first.faceA, first.faceB] }]);
  });
});

describe('guidesToRender / axesToRender / displayToRender', () => {
  it('maps visible guides by kind and caches per guides map', () => {
    const { doc, ids } = docWithGuides();
    const g = guidesToRender(doc.state);
    expect(g.lines).toEqual([{ id: ids[0], p: [1, 2, 3], dir: [0, 0, 1] }]);
    expect(g.points).toEqual([{ id: ids[1], p: [4, 5, 6] }]);
    expect(g.segments).toEqual([{ id: ids[2], a: [0, 0, 0], b: [1, 0, 0] }]);
    expect(guidesToRender(doc.state)).toBe(g);
    doc.transact('erase', (draft) => {
      draft.definitions.get(draft.rootDefinitionId)!.entities.guides.delete(ids[1]!);
    });
    const g2 = guidesToRender(doc.state);
    expect(g2).not.toBe(g);
    expect(g2.points).toEqual([]);
  });

  it('highlights guide refs as lines, points or finite segments', () => {
    const { doc, ids } = docWithGuides();
    expect(highlightFor(doc.state, { kind: 'guide', path: [], id: ids[0]! })).toEqual({ kind: 'guide', id: ids[0], p: [1, 2, 3], dir: [0, 0, 1] });
    expect(highlightFor(doc.state, { kind: 'guide', path: [], id: ids[1]! })).toEqual({ kind: 'guide', id: ids[1], p: [4, 5, 6], dir: null });
    expect(highlightFor(doc.state, { kind: 'guide', path: [], id: ids[2]! })).toEqual({ kind: 'guide', id: ids[2], p: [0, 0, 0], dir: [1, 0, 0], end: [1, 0, 0] });
    expect(highlightFor(doc.state, { kind: 'guide', path: [], id: 9999 as Id })).toBeNull();
  });

  it('reads the root definition axes', () => {
    const doc = createDocument();
    expect(axesToRender(doc.state)).toEqual({ origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] });
    doc.transact('axes', (draft) => {
      draft.definitions.get(draft.rootDefinitionId)!.axes = { origin: [1, 2, 0], x: [0, 1, 0], y: [-1, 0, 0], z: [0, 0, 1] };
    });
    expect(axesToRender(doc.state)).toEqual({ origin: [1, 2, 0], x: [0, 1, 0], y: [-1, 0, 0], z: [0, 0, 1] });
  });

  it('maps the active style to display settings (x-ray is a face mode in the model)', () => {
    const doc = createDocument();
    expect(displayToRender(doc.state)).toEqual({
      hiddenGeometry: false, edges: true, profiles: true, guides: true, axes: true, backEdges: false, xray: false, faceStyle: 'shadedTextured',
      // The default style's colors and edge settings.
      edgeColor: 0x000000, edgeAxisColors: false, profileWidth: 2, depthCue: 0, edgeExtension: 0,
      faceFrontColor: 0xffffff, faceBackColor: 0xa1abbf, xrayOpacity: 0.3, selectedColor: 0x1a66e6, guideColor: 0x4d4d4d,
    });
    doc.transact('style', (draft) => {
      const style = draft.styles.get(draft.activeStyleId)!;
      style.faces.mode = 'xray';
      style.edges.backEdges = true;
      style.modeling.hiddenGeometry = true;
      style.modeling.guidesVisible = false;
    });
    const d = displayToRender(doc.state);
    expect(d.xray).toBe(true);
    expect(d.backEdges).toBe(false);
    expect(d.faceStyle).toBe('shaded');
    expect(d.hiddenGeometry).toBe(true);
    expect(d.guides).toBe(false);
    doc.transact('style', (draft) => {
      draft.styles.get(draft.activeStyleId)!.faces.mode = 'hiddenLine';
    });
    expect(displayToRender(doc.state).faceStyle).toBe('hiddenLine');
  });
});

/**
 * root: tag-hidden box at the origin, instance `outer` of A at +10x (painted red), hidden instance of A at +100x.
 * A: unit box, sketch edge [0,0,0]→[2,0,0], instance `inner` of B at +5y.
 * B: unit box, empty sketch.
 */
function docWithInstances() {
  const doc = createDocument();
  const ids = { defA: 0 as DefId, defB: 0 as DefId, outer: 0 as Id, inner: 0 as Id, hiddenInst: 0 as Id, rootBody: 0 as Id, aBody: 0 as Id, bBody: 0 as Id, mat: 0 as MaterialId, tag: 0 as TagId };
  doc.transact('setup', (draft) => {
    const root = draft.definitions.get(draft.rootDefinitionId)!;
    ids.defA = allocId<DefId>(draft);
    ids.defB = allocId<DefId>(draft);
    draft.definitions.set(ids.defA, { ...root, id: ids.defA, name: 'A', entities: createEntityContainer() } as never);
    draft.definitions.set(ids.defB, { ...root, id: ids.defB, name: 'B', entities: createEntityContainer() } as never);
    const A = draft.definitions.get(ids.defA)!, B = draft.definitions.get(ids.defB)!;
    ids.mat = allocId<MaterialId>(draft);
    draft.materials.set(ids.mat, { id: ids.mat, name: 'red', color: [1, 0, 0], alpha: 1, texture: null });
    ids.tag = allocId<TagId>(draft);
    draft.tags.set(ids.tag, { id: ids.tag, name: 'Off', visible: false, color: [0, 0, 0], dashes: null, folderId: null });
    ids.rootBody = bodyFromMesh(draft, meshBox([0, 0, 0], [1, 1, 1]), { container: root.entities, tagId: ids.tag }).id;
    ids.aBody = bodyFromMesh(draft, meshBox([0, 0, 0], [1, 1, 1]), { container: A.entities }).id;
    ids.bBody = bodyFromMesh(draft, meshBox([0, 0, 0], [1, 1, 1]), { container: B.entities }).id;
    SketchGraph.for(draft, ids.defA).addEdge([0, 0, 0], [2, 0, 0]);
    const common = { name: '', tagId: draft.defaultTagId, hidden: false, locked: false, castShadows: true, receiveShadows: true, attributes: {} };
    ids.outer = allocId(draft);
    ids.inner = allocId(draft);
    ids.hiddenInst = allocId(draft);
    root.entities.instances.set(ids.outer, { ...common, id: ids.outer, definitionId: ids.defA, transform: m4translation([10, 0, 0]), materialId: ids.mat } as never);
    A.entities.instances.set(ids.inner, { ...common, id: ids.inner, definitionId: ids.defB, transform: m4translation([0, 5, 0]), materialId: null } as never);
    root.entities.instances.set(ids.hiddenInst, { ...common, id: ids.hiddenInst, definitionId: ids.defA, transform: m4translation([100, 0, 0]), materialId: null, hidden: true } as never);
  });
  return { doc, ids };
}

describe('guidesToRender with instances', () => {
  it('draws the guides of every visible instance in world coordinates, as the inference index offers them', () => {
    const { doc, ids } = docWithInstances();
    const before = guidesToRender(doc.state);
    let line = 0 as Id, point = 0 as Id;
    doc.transact('guides', (draft) => {
      const B = draft.definitions.get(ids.defB)!;
      const common = { tagId: draft.defaultTagId, hidden: false, locked: false, castShadows: false, receiveShadows: false, attributes: {} };
      line = allocId(draft);
      point = allocId(draft);
      B.entities.guides.set(line, { ...common, id: line, kind: 'line', origin: [1, 0, 0], dir: [0, 0, 2] } as never);
      B.entities.guides.set(point, { ...common, id: point, kind: 'point', origin: [0, 0, 1] } as never);
    });
    const g = guidesToRender(doc.state);
    expect(g).not.toBe(before);
    // B is placed at +5y inside A at +10x; the hidden instance of A draws nothing.
    expect(g.lines).toEqual([{ id: line, p: [11, 5, 0], dir: [0, 0, 1] }]);
    expect(g.points).toEqual([{ id: point, p: [10, 5, 1] }]);
    expect(guidesToRender(doc.state)).toBe(g);
    doc.transact('move', (draft) => {
      draft.definitions.get(draft.rootDefinitionId)!.entities.instances.get(ids.outer)!.transform = m4translation([20, 0, 0]) as never;
    });
    expect(guidesToRender(doc.state).points).toEqual([{ id: point, p: [20, 5, 1] }]);
  });
});

describe('textsToRender', () => {
  it('draws visible texts at every placement in world coordinates, flagging selected ones', () => {
    const { doc, ids } = docWithInstances();
    const base = { fontFamily: 'Arial', fontSizePt: 12, color: [1, 0, 0] as [number, number, number], tagId: 0 as TagId, hidden: false, locked: false, castShadows: false, receiveShadows: false, attributes: {} };
    let leader = 0 as Id, screen = 0 as Id;
    doc.transact('texts', (draft) => {
      const root = draft.definitions.get(draft.rootDefinitionId)!.entities, A = draft.definitions.get(ids.defA)!.entities;
      leader = allocId<Id>(draft);
      A.texts.set(leader, { ...base, tagId: draft.defaultTagId, id: leader, text: 'Note', kind: 'leader', position: [1, 0, 0], offset: [0, 0, 1], leader: 'pushpin', arrow: 'dot' });
      screen = allocId<Id>(draft);
      root.texts.set(screen, { ...base, tagId: draft.defaultTagId, id: screen, text: 'Title', kind: 'screen', position: [0.1, 0.2, 0], offset: null, leader: 'none' });
      const hidden = allocId<Id>(draft);
      root.texts.set(hidden, { ...base, tagId: draft.defaultTagId, id: hidden, text: 'Hidden', kind: 'screen', position: [0, 0, 0], offset: null, leader: 'none', hidden: true });
    });
    const selection: EntityRef[] = [{ kind: 'text', path: [ids.outer], id: leader }];
    const items = textsToRender(doc.state, selection).items;
    expect(items.map((t) => t.text).sort()).toEqual(['Note', 'Title']);
    const note = items.find((t) => t.text === 'Note')!;
    // the outer placement is at x = 10; the hidden one draws nothing
    expect(note).toMatchObject({ id: renderKey([ids.outer], leader), position: [11, 0, 0], offset: [0, 0, 1], viewOffset: null, arrow: 'dot', color: '#ff0000', selected: true });
    expect(items.find((t) => t.text === 'Title')).toMatchObject({ kind: 'screen', position: [0.1, 0.2, 0], offset: null, selected: false });
    expect(textsToRender(doc.state, selection)).toBe(textsToRender(doc.state, selection));
  });
});

describe('dimensionsToRender', () => {
  it('draws dimensions at every visible placement, attached to their vertices, skips hidden ones and flags the selection', () => {
    const { doc, ids } = docWithInstances();
    let linear = 0 as Id, hidden = 0 as Id;
    doc.transact('dimensions', (draft) => {
      const A = draft.definitions.get(ids.defA)!;
      const common = { tagId: draft.defaultTagId, hidden: false, locked: false, castShadows: false, receiveShadows: false, attributes: {} };
      const end = [...A.entities.sketch.vertices.values()].find((v) => v.p[0] === 2)!.id;
      linear = allocId(draft);
      hidden = allocId(draft);
      A.entities.dimensions.set(linear, { ...common, id: linear, kind: 'linear', start: [0, 0, 0], end: [9, 9, 9], offset: [0, -1, 0], normal: [0, 0, 1],
        text: null, fontSizePt: 10, anchors: [null, { kind: 'sketchVertex', path: [], id: end }] } as never);
      A.entities.dimensions.set(hidden, { ...common, hidden: true, id: hidden, kind: 'linear', start: [0, 0, 0], end: [1, 0, 0], offset: [0, 1, 0], normal: [0, 0, 1], text: null, fontSizePt: 10 } as never);
    });
    const selection: EntityRef[] = [{ kind: 'dimension', path: [ids.outer], id: linear }];
    const { items } = dimensionsToRender(doc.state, selection);
    // A is placed at +10x; the anchored end is the sketch vertex at (2, 0, 0), not the stored (9, 9, 9).
    expect(items).toHaveLength(1);
    const [d] = items;
    expect(d).toMatchObject({ id: linear, selected: true, fontSizePt: 10, textAt: [11, -1, 0] });
    expect(d!.lines).toEqual([[[10, 0, 0], [10, -1, 0]], [[12, 0, 0], [12, -1, 0]], [[10, -1, 0], [12, -1, 0]]]);
    expect(d!.text).toBe(formatLength(2, doc.state.meta.units));
    expect(dimensionsToRender(doc.state, selection)).toBe(dimensionsToRender(doc.state, selection));
    expect(dimensionsToRender(doc.state).items[0]!.selected).toBe(false);
    expect(d!.arrow).toBeUndefined();
    expect(d!.aligned).toBeUndefined();
  });

  it('passes each dimension\'s endpoints, and its text along the line with the side away from what it measures', () => {
    const { doc, ids } = docWithInstances();
    let id = 0 as Id;
    doc.transact('dimension', (draft) => {
      const A = draft.definitions.get(ids.defA)!;
      id = allocId(draft);
      A.entities.dimensions.set(id, { tagId: draft.defaultTagId, hidden: false, locked: false, castShadows: false, receiveShadows: false, attributes: {},
        id, kind: 'linear', start: [0, 0, 0], end: [2, 0, 0], offset: [0, -0.5, 0], normal: [0, 0, 1], text: null, fontSizePt: 10, arrow: 'slash', align: 'outside' } as never);
      draft.definitions.get(draft.rootDefinitionId)!.entities.dimensions.set(allocId(draft), { tagId: draft.defaultTagId, hidden: false, locked: false,
        castShadows: false, receiveShadows: false, attributes: {}, id: 0, kind: 'linear', start: [0, 0, 0], end: [0, 7, 0], offset: [0.25, 0, 0],
        normal: [0, 0, 1], text: null, fontSizePt: 10, align: 'above' } as never);
    });
    const items = dimensionsToRender(doc.state).items;
    const d = items.find((x) => x.arrow === 'slash');
    expect(d!.aligned).toEqual({ along: [1, 0, 0], out: [0, -1, 0], position: 'outside' });
    // Unit directions, in the model as in placements.
    expect(items.find((x) => x.aligned?.position === 'above')!.aligned).toEqual({ along: [0, 1, 0], out: [1, 0, 0], position: 'above' });
  });
});

describe('bodiesToRender / sketchesToRender with instances', () => {
  it('gives the contents of a placement that Always Faces Camera its turn, nested contents included', () => {
    const { doc, ids } = docWithInstances();
    expect(bodiesToRender(doc.state).every((b) => b.faceCamera === undefined)).toBe(true);
    doc.transact('face me', (draft) => {
      draft.definitions.get(ids.defA)!.behaviors = { glueTo: 'none', cutsOpening: false, alwaysFaceCamera: true, shadowsFaceSun: true };
    });
    const turn = { pivot: [10, 0, 0], axis: [0, 0, 1], front: [-0, -1, -0], shadowsFaceSun: true };
    const rb = bodiesToRender(doc.state);
    expect(rb.find((b) => b.entityId === ids.aBody)!.faceCamera).toEqual(turn);
    // the nested placement turns with the outer one, about the outer one's axis
    expect(rb.find((b) => b.entityId === ids.bBody)!.faceCamera).toEqual(turn);
    expect(sketchesToRender(doc.state).find((sk) => sk.path.length === 1 && sk.path[0] === ids.outer)!.faceCamera).toEqual(turn);
    doc.transact('group', (draft) => {
      draft.definitions.get(ids.defA)!.isGroup = true;
    });
    expect(bodiesToRender(doc.state).every((b) => b.faceCamera === undefined)).toBe(true);
  });

  it('flattens nested instances with world transforms, unique keys and inherited colors; skips hidden/tag-hidden', () => {
    const { doc, ids } = docWithInstances();
    const rb = bodiesToRender(doc.state);
    expect(rb.map((b) => b.id).sort()).toEqual([renderKey([ids.outer], ids.aBody), renderKey([ids.outer, ids.inner], ids.bBody)].sort());
    expect(new Set(rb.map((b) => b.id)).size).toBe(rb.length);
    const a = rb.find((b) => b.entityId === ids.aBody)!;
    const b = rb.find((b) => b.entityId === ids.bBody)!;
    expect(a.path).toEqual([ids.outer]);
    expect(Array.from(a.transform)).toEqual(Array.from(m4translation([10, 0, 0])));
    expect(b.path).toEqual([ids.outer, ids.inner]);
    expect(Array.from(b.transform)).toEqual(Array.from(m4translation([10, 5, 0])));
    // body material ?? instance material (inherited down the chain) ?? style default
    expect(a.defaultColor).toBe('#ff0000');
    expect(b.defaultColor).toBe('#ff0000');
    // tag-hidden root body and the hidden instance's contents are gone
    expect(tagVisible(doc.state, ids.tag)).toBe(false);
    expect(rb.some((x) => x.entityId === ids.rootBody)).toBe(false);
    expect(rb.some((x) => x.path[0] === ids.hiddenInst)).toBe(false);
    // transforms keep their identity across unrelated transactions (the renderer diffs by identity)
    doc.transact('noop', (draft) => {
      SketchGraph.for(draft).addEdge([50, 50, 0], [51, 50, 0]);
    });
    const again = bodiesToRender(doc.state);
    expect(again.find((x) => x.entityId === ids.bBody)!.transform).toBe(b.transform);
    expect(again.find((x) => x.entityId === ids.bBody)!.edges).toBe(b.edges);
  });

  it('shows a tag-hidden body again when its tag is switched on', () => {
    const { doc, ids } = docWithInstances();
    doc.transact('tag on', (draft) => {
      draft.tags.get(ids.tag)!.visible = true;
    });
    const rb = bodiesToRender(doc.state);
    expect(rb.some((x) => x.id === renderKey([], ids.rootBody))).toBe(true);
    expect(rb.find((x) => x.entityId === ids.rootBody)!.defaultColor).toBeUndefined();
  });

  it('yields the root sketch plus each visible instance sketch in world coordinates, with stable versions', () => {
    const { doc, ids } = docWithInstances();
    const sk = sketchesToRender(doc.state);
    expect(sk.map((s) => s.id)).toEqual(['', pathKey([ids.outer])]); // B's sketch is empty, hidden instance skipped
    const a = sk[1]!;
    expect(a.path).toEqual([ids.outer]);
    expect(a.edges).toHaveLength(1);
    expect(a.edges[0]!.a).toEqual([10, 0, 0]);
    expect(a.edges[0]!.b).toEqual([12, 0, 0]);
    expect(sketchesToRender(doc.state)[1]!.version).toBe(a.version);
    expect(sketchToRender(doc.state)!.id).toBe('');
    doc.transact('move', (draft) => {
      draft.definitions.get(draft.rootDefinitionId)!.entities.instances.get(ids.outer)!.transform = m4translation([20, 0, 0]) as never;
    });
    const moved = sketchesToRender(doc.state)[1]!;
    expect(moved.version).not.toBe(a.version);
    expect(moved.edges[0]!.a).toEqual([20, 0, 0]);
  });
});

describe('editContextToRender / instanceWorldBounds', () => {
  it('bounds the context definition (bodies + sketch + nested instances) in world space', () => {
    const { doc, ids } = docWithInstances();
    const root = editContextToRender(doc.state, []);
    expect(root).toEqual({ path: [], bounds: null, fadeOthers: true, hideOthers: false });
    const ctx = editContextToRender(doc.state, [ids.outer], { hideOthers: true });
    expect(ctx.path).toEqual([ids.outer]);
    expect(ctx.hideOthers).toBe(true);
    // A's box [10..11]x[0..1]x[0..1], its sketch edge to x=12, nested B at +5y → y up to 6
    expect(ctx.bounds).toEqual({ min: [10, 0, 0], max: [12, 6, 1] });
    expect(instanceWorldBounds(doc.state, [ids.outer, ids.inner])).toEqual({ min: [10, 5, 0], max: [11, 6, 1] });
    // stale path → no bounds instead of throwing
    expect(editContextToRender(doc.state, [9999 as Id]).bounds).toBeNull();
  });
});

describe('highlightsFor with paths', () => {
  it('highlights an instance as its world box + key, and transforms entities inside instances', () => {
    const { doc, ids } = docWithInstances();
    const bBody = doc.state.definitions.get(ids.defB)!.entities.bodies.get(ids.bBody)!;
    const faceId = bBody.faces.keys().next().value!;
    const instRef: EntityRef = { kind: 'instance', path: [ids.outer], id: ids.inner };
    const bodyRef: EntityRef = { kind: 'body', path: [ids.outer, ids.inner], id: ids.bBody };
    const faceRef: EntityRef = { kind: 'face', path: [ids.outer, ids.inner], id: ids.bBody, faceId, region: null };
    const h = highlightsFor(doc.state, instRef, [bodyRef, faceRef, { kind: 'instance', path: [], id: ids.outer }]);
    expect(h.hover).toEqual({ kind: 'instance', key: pathKey([ids.outer, ids.inner]), bounds: { min: [10, 5, 0], max: [11, 6, 1] } });
    expect(h.selected[0]).toMatchObject({ kind: 'body', key: renderKey([ids.outer, ids.inner], ids.bBody) });
    // its edges are outlined in world coordinates
    const whole = h.selected[0]!;
    expect(whole.kind === 'body' && whole.edges?.length).toBe(bBody.edges.size);
    for (const p of whole.kind === 'body' ? whole.edges!.flat() : []) {
      expect(p[0]).toBeGreaterThanOrEqual(10 - 1e-9); expect(p[0]).toBeLessThanOrEqual(11 + 1e-9);
      expect(p[1]).toBeGreaterThanOrEqual(5 - 1e-9); expect(p[1]).toBeLessThanOrEqual(6 + 1e-9);
    }
    const face = h.selected[1]!;
    expect(face.kind).toBe('face');
    if (face.kind === 'face') {
      expect(face.key).toBe(renderKey([ids.outer, ids.inner], ids.bBody));
      const local = bBody.faces.get(faceId)!.loops[0]![0]!;
      expect(face.loops[0]![0]).toEqual([local[0] + 10, local[1] + 5, local[2]]);
    }
    expect(h.selected[2]).toEqual({ kind: 'instance', key: pathKey([ids.outer]), bounds: { min: [10, 0, 0], max: [12, 6, 1] } });
    // sketch edge inside A is transformed too; stale paths / ids yield null
    const edgeId = doc.state.definitions.get(ids.defA)!.entities.sketch.edges.keys().next().value!;
    const se = highlightFor(doc.state, { kind: 'sketchEdge', path: [ids.outer], id: edgeId });
    expect(se).toEqual({ kind: 'sketchEdge', id: edgeId, a: [10, 0, 0], b: [12, 0, 0] });
    expect(highlightFor(doc.state, { kind: 'body', path: [9999 as Id], id: ids.bBody })).toBeNull();
    expect(highlightFor(doc.state, { kind: 'instance', path: [], id: 9999 as Id })).toBeNull();
  });
});
