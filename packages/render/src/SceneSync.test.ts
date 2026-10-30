// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { M4_IDENTITY, m4translation, meshBox, planeBasis } from '@pushform/core';
import type { Mat4 } from '@pushform/core';
import { Color, Matrix4, Mesh, OrthographicCamera, Vector3 } from 'three';
import type { BufferAttribute, WebGLRenderer } from 'three';
import { BACK_COLOR, FADE_OPACITY, hiddenLineShade, shadowDisplay } from './renderables/BodyRenderable';
import type { SketchRenderable } from './renderables/SketchRenderable';
import { SceneSync, XRAY_OPACITY } from './SceneSync';
import { EMPTY_SECTIONS, ROOT_EDIT_CONTEXT, renderKey } from './types';
import type { RenderBody, RenderSketch } from './types';

const sketch = (version: unknown): RenderSketch => ({
  id: '',
  path: [],
  version,
  faces: [{ id: 5, loops: [[[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]]], basis: planeBasis([0, 0, 0], [0, 0, 1]), hidden: false }],
  edges: [
    { id: 1, a: [0, 0, 0], b: [1, 0, 0], soft: false, smooth: false, hidden: false },
    { id: 2, a: [1, 0, 0], b: [1, 1, 0], soft: false, smooth: false, hidden: false },
    { id: 3, a: [1, 1, 0], b: [0, 1, 0], soft: false, smooth: false, hidden: false },
    { id: 4, a: [0, 1, 0], b: [0, 0, 0], soft: true, smooth: true, hidden: false },
    { id: 9, a: [0, 0, 0], b: [0, 0, 4], soft: false, smooth: false, hidden: false },
  ],
});

describe('SceneSync (sketch, highlight, preview)', () => {
  it('diffs the sketch by version identity, picks its faces and includes it in the bounds', () => {
    const s = new SceneSync();
    const v = {};
    expect(s.syncSketch(sketch(v))).toBe(true);
    expect(s.syncSketch(sketch(v))).toBe(false);
    expect(s.syncSketch(sketch({}))).toBe(true);
    expect(s.pickables()).toHaveLength(1);
    expect(s.sceneBounds()?.max[2]).toBe(4);
    expect(s.syncSketch(null)).toBe(true);
    expect(s.pickables()).toHaveLength(0);
    s.dispose();
  });

  it('shows dashed soft edges only in hidden-geometry mode', () => {
    const s = new SceneSync();
    s.syncSketch(sketch({}));
    const r = s.renderables().find((c) => c.name === 'Sketch:') as unknown as { hiddenEdges: { visible: boolean; segmentCount: number }; edges: { segmentCount: number } };
    expect(r.edges.segmentCount).toBe(4);
    expect(r.hiddenEdges.visible).toBe(false);
    expect(s.setShowHiddenGeometry(true)).toBe(true);
    expect(r.hiddenEdges.visible).toBe(true);
    expect(r.hiddenEdges.segmentCount).toBe(1);
    expect(s.setShowHiddenGeometry(true)).toBe(false);
    s.dispose();
  });

  it('tints selected bodies through the flags attribute and clears them again', () => {
    const s = new SceneSync();
    s.sync([{ id: '/7', path: [], entityId: 7, mesh: meshBox([0, 0, 0], [1, 1, 1]), transform: M4_IDENTITY }]);
    const body = s.renderables().find((c) => c.name === 'Body:/7') as unknown as { front: { geometry: { getAttribute(n: string): { array: Uint8Array } } }; isSelected: boolean };
    s.setHighlight({ hover: null, selected: [{ kind: 'body', key: '/7' }] });
    expect(body.isSelected).toBe(true);
    expect(body.front.geometry.getAttribute('flags').array.every((f) => f === 1)).toBe(true);
    s.setHighlight({ hover: { kind: 'sketchVertex', p: [0, 0, 0] }, selected: [] });
    expect(body.isSelected).toBe(false);
    expect(body.front.geometry.getAttribute('flags').array.every((f) => f === 0)).toBe(true);
    s.dispose();
  });

  it('builds translucent preview bodies with edges and clears on null', () => {
    const s = new SceneSync();
    expect(s.setPreview([meshBox([0, 0, 0], [1, 1, 1])])).toBe(true);
    expect(s.preview.group.children).toHaveLength(3);
    expect(s.preview.front.opacity).toBe(0.5);
    expect(s.preview.front.transparent).toBe(true);
    expect(s.setPreview(null)).toBe(true);
    expect(s.preview.group.children).toHaveLength(0);
    expect(s.setPreview(null)).toBe(false);
    s.dispose();
  });

  it('edge style toggles profiles by collapsing the profile width onto the edge width', () => {
    const s = new SceneSync();
    expect(s.materials.edge.profileWidth).toBe(2);
    s.setEdgeStyle({ profiles: false });
    expect(s.materials.edge.profileWidth).toBe(1);
    s.setEdgeStyle({ profiles: true, profileWidth: 3, width: 1.5 });
    expect(s.materials.edge.linewidth).toBe(1.5);
    expect(s.materials.edge.profileWidth).toBe(3);
    s.dispose();
  });

  it('draws body edge records instead of mesh edges, soft/hidden ones dashed only in hidden-geometry mode', () => {
    const s = new SceneSync();
    const mesh = meshBox([0, 0, 0], [1, 1, 1]);
    const edges: NonNullable<RenderBody['edges']> = [
      { points: [[0, 0, 0], [1, 0, 0]], soft: false, smooth: false, hidden: false, faceA: 0, faceB: 1 },
      { points: [[0, 0, 0], [0, 1, 0]], soft: true, smooth: true, hidden: false, faceA: 0, faceB: 2 },
      { points: [[0, 0, 0], [0, 0, 1]], soft: false, smooth: false, hidden: true, faceA: 1, faceB: 2 },
    ];
    const body: RenderBody = { id: '/3', path: [], entityId: 3, version: 1, mesh, transform: M4_IDENTITY, edges };
    s.sync([body]);
    const r = s.renderables().find((c) => c.name === 'Body:/3') as unknown as {
      edges: { segmentCount: number };
      hiddenEdges: { visible: boolean; segmentCount: number };
      backEdges: { geometry: unknown };
      needsUpdate(b: RenderBody): boolean;
    };
    expect(r.edges.segmentCount).toBe(1);
    expect(r.hiddenEdges.visible).toBe(false);
    expect(r.hiddenEdges.segmentCount).toBe(0);
    expect(s.setDisplay({ hiddenGeometry: true })).toBe(true);
    expect(r.hiddenEdges.visible).toBe(true);
    expect(r.hiddenEdges.segmentCount).toBe(2);
    expect(r.edges.segmentCount).toBe(1);
    // the back-edges pass shares the solid batch geometry
    expect(r.backEdges.geometry).toBe((r.edges as unknown as { geometry: unknown }).geometry);
    // same edges array → no rebuild; a new array (e.g. after softening) → rebuild without a version bump
    expect(r.needsUpdate(body)).toBe(false);
    expect(r.needsUpdate({ ...body, edges: [...edges] })).toBe(true);
    s.dispose();
  });

  it('display toggles flip material flags: edges, back edges, x-ray, wireframe, hidden line, monochrome, guides', () => {
    const s = new SceneSync();
    s.syncSketch(sketch({}));
    const { front, back, edge, hiddenEdge, backEdge } = s.materials;
    expect(s.display.faceStyle).toBe('shaded');
    expect(backEdge.visible).toBe(false);
    expect(s.setDisplay({})).toBe(false);
    expect(s.setDisplay({ edges: true })).toBe(false);

    expect(s.setDisplay({ edges: false })).toBe(true);
    expect(edge.visible).toBe(false);
    expect(hiddenEdge.visible).toBe(false);
    s.setDisplay({ edges: true, backEdges: true });
    expect(edge.visible).toBe(true);
    expect(backEdge.visible).toBe(true);

    // X-ray: translucent faces without depth writes, edges on top, back edges suppressed
    s.setDisplay({ xray: true });
    expect(front.transparent).toBe(true);
    expect(front.opacity).toBe(XRAY_OPACITY);
    expect(front.depthWrite).toBe(false);
    expect(s.sketchMaterials.back.opacity).toBe(XRAY_OPACITY);
    expect(edge.depthTest).toBe(false);
    expect(backEdge.visible).toBe(false);
    s.setDisplay({ xray: false });
    expect(front.transparent).toBe(false);
    expect(front.opacity).toBe(1);
    expect(front.depthWrite).toBe(true);
    expect(edge.depthTest).toBe(true);
    expect(backEdge.visible).toBe(true);

    // wireframe hides faces; hidden line paints them flat in the background color
    s.setDisplay({ faceStyle: 'wireframe' });
    expect(front.visible).toBe(false);
    expect(s.sketchMaterials.front.visible).toBe(false);
    s.setBackgroundColor(0x112233);
    s.setDisplay({ faceStyle: 'hiddenLine' });
    expect(front.visible).toBe(true);
    expect(front.color.getHex()).toBe(0x000000);
    expect(front.emissive.getHex()).toBe(0x112233);
    expect(front.depthWrite).toBe(true);
    expect(s.sketchMaterials.front.vertexColors).toBe(false);
    // with shadows on, the sun lights and shades those faces
    // with shadows on faces, faces the sun does not reach darken to the background times 0.2 + Dark
    s.setSunShade(0.8);
    expect(front.color.getHex()).toBe(0x112233);
    expect(back.color.getHex()).toBe(0x112233);
    expect(front.emissive.getHex()).toBe(0x000000);
    expect(hiddenLineShade.value.x).toBe(1);
    expect(new Color().setRGB(hiddenLineShade.value.y, 0, 0).getHexString().slice(0, 2)).toBe('cc');
    s.setSunShade(null);
    expect(front.color.getHex()).toBe(0x000000);
    expect(front.emissive.getHex()).toBe(0x112233);
    expect(hiddenLineShade.value.x).toBe(0);

    // monochrome: default front/back colors, sketch per-face colors ignored
    s.setDisplay({ faceStyle: 'monochrome' });
    expect(front.color.getHex()).toBe(0xffffff);
    expect(back.color.getHex()).toBe(0x9fb4cb);
    expect(front.emissive.getHex()).toBe(0x000000);
    expect(s.sketchMaterials.front.vertexColors).toBe(false);
    s.setDisplay({ faceStyle: 'shaded' });
    expect(s.sketchMaterials.front.vertexColors).toBe(true);

    // profiles/hidden geometry route through the existing setters
    s.setDisplay({ profiles: false, hiddenGeometry: true });
    expect(edge.profileWidth).toBe(1);
    expect(s.showHiddenGeometry).toBe(true);
    expect(s.getEdgeStyle().profiles).toBe(false);

    s.setDisplay({ guides: false });
    expect(s.guides.group.visible).toBe(false);
    s.dispose();
  });

  it('syncs guides by identity and re-applies them on origin changes', () => {
    const s = new SceneSync();
    const g = { lines: [{ id: 1, p: [0, 0, 0] as const, dir: [0, 0, 1] as const }], points: [] };
    expect(s.setGuides(g)).toBe(true);
    expect(s.setGuides(g)).toBe(false);
    expect(s.guides.lines.segmentCount).toBe(1);
    s.setOrigin([5, 0, 0]);
    expect(s.guides.lines.geometry.getAttribute('instanceStart').getX(0)).toBe(-5);
    expect(s.setGuides(null)).toBe(true);
    expect(s.guides.isEmpty).toBe(true);
    s.dispose();
  });

  it('diffs bodies by render key: the same entity id in two instances is two renderables', () => {
    const s = new SceneSync();
    const mesh = meshBox([0, 0, 0], [1, 1, 1]);
    const a: RenderBody = { id: renderKey([1], 7), path: [1], entityId: 7, mesh, transform: M4_IDENTITY };
    const b: RenderBody = { id: renderKey([2], 7), path: [2], entityId: 7, mesh, transform: m4translation([5, 0, 0]) as unknown as Mat4 };
    expect(s.sync([a, b])).toBe(true);
    expect(pickTriangles(s)).toBe(24); // both boxes, drawn and picked through one batch
    expect(s.renderables().filter((c) => c.name.startsWith('Body:')).map((c) => c.name).sort()).toEqual(['Body:1/7', 'Body:2/7']);
    expect(s.sync([a, b])).toBe(false);
    // dropping one key removes exactly that renderable; the other keeps its geometry
    expect(s.sync([b])).toBe(true);
    expect(pickTriangles(s)).toBe(12);
    expect(s.renderables().find((c) => c.name === 'Body:2/7')).toBeDefined();
    expect(s.sceneBounds()?.max[0]).toBe(6);
    s.dispose();
  });

  it('tints bodies by key or by containing instance through setSelectedKeys / instance highlights', () => {
    const s = new SceneSync();
    const mesh = meshBox([0, 0, 0], [1, 1, 1]);
    s.sync([
      { id: renderKey([], 1), path: [], entityId: 1, mesh, transform: M4_IDENTITY },
      { id: renderKey([3], 2), path: [3], entityId: 2, mesh, transform: M4_IDENTITY },
      { id: renderKey([3, 4], 5), path: [3, 4], entityId: 5, mesh, transform: M4_IDENTITY },
      { id: renderKey([30], 6), path: [30], entityId: 6, mesh, transform: M4_IDENTITY },
    ]);
    const sel = (name: string) => (s.renderables().find((c) => c.name === name) as unknown as { isSelected: boolean }).isSelected;
    s.setSelectedKeys(new Set(['3']));
    expect(sel('Body:/1')).toBe(false);
    expect(sel('Body:3/2')).toBe(true);
    expect(sel('Body:3.4/5')).toBe(true);
    expect(sel('Body:30/6')).toBe(false); // "30" is not inside instance "3"
    s.setSelectedKeys(new Set(['/1']));
    expect(sel('Body:/1')).toBe(true);
    expect(sel('Body:3/2')).toBe(false);
    // an instance highlight draws its box and tints its bodies
    s.setHighlight({ hover: { kind: 'instance', key: '3.4', bounds: { min: [0, 0, 0], max: [1, 1, 1] } }, selected: [] });
    expect(sel('Body:3/2')).toBe(false);
    expect(sel('Body:3.4/5')).toBe(true);
    expect(sel('Body:/1')).toBe(false);
    s.dispose();
  });

  it('syncs several sketches by id and includes them all in the bounds', () => {
    const s = new SceneSync();
    const root = sketch({});
    const inner: RenderSketch = {
      id: '9',
      path: [9],
      version: {},
      faces: [],
      edges: [{ id: 50, a: [10, 0, 0], b: [12, 0, 0], soft: false, smooth: false, hidden: false }],
    };
    expect(s.syncSketches([root, inner])).toBe(true);
    expect(s.renderables().filter((c) => c.name.startsWith('Sketch:')).map((c) => c.name).sort()).toEqual(['Sketch:', 'Sketch:9']);
    expect(s.syncSketches([root, inner])).toBe(false);
    expect(s.sceneBounds()?.max[0]).toBe(12);
    expect(s.syncSketches([root])).toBe(true);
    expect(s.renderables().filter((c) => c.name.startsWith('Sketch:'))).toHaveLength(1);
    expect(s.syncSketch(null)).toBe(true);
    expect(s.syncSketch(root)).toBe(true);
    expect(s.pickables()).toHaveLength(1);
    s.dispose();
  });

  it('sheet faces cast and receive shadows per their containers\' settings and On Faces (PF-269)', () => {
    const s = new SceneSync();
    const node = (name: string) => s.renderables().find((c) => c.name === name) as unknown as SketchRenderable;
    const meshes = (name: string) => [node(name).front, node(name).back];
    const root = sketch({}), inner: RenderSketch = { ...sketch({}), id: '9', path: [9], castShadows: false, receiveShadows: false };
    s.syncSketches([root, inner]);
    for (const m of meshes('Sketch:')) expect([m.castShadow, m.receiveShadow]).toEqual([true, true]);
    for (const m of meshes('Sketch:9')) expect([m.castShadow, m.receiveShadow]).toEqual([false, false]);
    // The batches drawing them keep each sheet's flags apart (PF-191).
    s.prepareFrame();
    expect(s.batches.allFaceMeshes().map((m) => [m.name, m.castShadow, m.receiveShadow]).sort()).toEqual(
      [['backfaces', false, false], ['backfaces', true, true], ['faces', false, false], ['faces', true, true]]);
    // A placement's setting can change while its definition's sketch (and version) stays the same.
    expect(s.syncSketches([root, { ...inner, castShadows: true }])).toBe(true);
    for (const m of meshes('Sketch:9')) expect([m.castShadow, m.receiveShadow]).toEqual([true, false]);
    expect(s.syncSketches([root, { ...inner, castShadows: true }])).toBe(false);
    // On Faces off: nothing receives, though the faces still cast (onto the ground).
    shadowDisplay.onFaces = false;
    try {
      s.syncSketches([{ ...root, version: {} }]);
      for (const m of meshes('Sketch:')) expect([m.castShadow, m.receiveShadow]).toEqual([true, false]);
      expect(node('Sketch:').front.userData['receiveShadows']).toBe(true);
    } finally { shadowDisplay.onFaces = true; }
    s.dispose();
  });

  it('turns a face-camera sketch\'s shadow toward the sun with Shadows Face Sun (PF-269)', () => {
    const s = new SceneSync();
    const tree: RenderSketch = { ...sketch({}), id: '7', path: [7],
      faceCamera: { pivot: [0, 0, 0], axis: [0, 0, 1], front: [0, -1, 0], shadowsFaceSun: true } };
    s.syncSketches([tree]);
    s.updateFaceCamera({ eye: [7, 0, 1], forward: [-1, 0, 0], parallel: false }, [0, 1, 0]);
    const r = s.renderables().find((c) => c.name === 'Sketch:7') as unknown as SketchRenderable;
    expect(r.front.castShadow).toBe(true);
    s.root.updateMatrixWorld(true);
    const shadowCamera = new OrthographicCamera();
    shadowCamera.updateMatrixWorld(true);
    r.front.onBeforeShadow(null as unknown as WebGLRenderer, null as never, shadowCamera, shadowCamera, r.front.geometry, r.front.material, null as never);
    // The sun is toward +y: the shadow pass turns the front (−y) to +y, while the drawn faces turn to the camera (+x).
    const front = new Vector3(0, -1, 0).transformDirection(new Matrix4().copy(shadowCamera.matrixWorld).multiply(r.front.modelViewMatrix));
    expect(front.y).toBeCloseTo(1, 9);
    s.dispose();
  });

  it('edit context fades or hides entities outside the path and draws the dashed context box', () => {
    const s = new SceneSync();
    const mesh = meshBox([0, 0, 0], [1, 1, 1]);
    s.sync([
      { id: renderKey([], 1), path: [], entityId: 1, mesh, transform: M4_IDENTITY },
      { id: renderKey([3], 2), path: [3], entityId: 2, mesh, transform: M4_IDENTITY },
      { id: renderKey([3, 4], 5), path: [3, 4], entityId: 5, mesh, transform: M4_IDENTITY },
    ]);
    s.syncSketches([sketch({}), { id: '3', path: [3], version: {}, faces: [], edges: [{ id: 1, a: [0, 0, 0], b: [1, 0, 0], soft: false, smooth: false, hidden: false }] }]);
    const node = (name: string) => s.renderables().find((c) => c.name === name) as unknown as { visible: boolean; isFaded: boolean; front: { material: unknown } };
    expect(s.contextBox.visible).toBe(false);
    expect(s.setEditContext({ path: [3], bounds: { min: [0, 0, 0], max: [2, 2, 2] }, fadeOthers: true, hideOthers: false })).toBe(true);
    expect(node('Body:/1').isFaded).toBe(true);
    expect(node('Body:/1').visible).toBe(true);
    expect(node('Body:/1').front.material).toBe(s.fadedMaterials.front);
    expect(node('Body:3/2').isFaded).toBe(false);
    expect(node('Body:3.4/5').isFaded).toBe(false); // nested in the context: not faded
    expect(node('Sketch:').isFaded).toBe(true);
    expect(node('Sketch:3').isFaded).toBe(false);
    expect(s.contextBox.visible).toBe(true);
    expect(s.contextBox.segmentCount).toBe(12);
    expect(s.contextBoxMaterial.dashed).toBe(true);
    // faded faces are translucent but still write depth
    expect(s.fadedMaterials.front.transparent).toBe(true);
    expect(s.fadedMaterials.front.opacity).toBe(FADE_OPACITY);
    expect(s.fadedMaterials.front.depthWrite).toBe(true);
    // the same context again is a no-op
    expect(s.setEditContext({ path: [3], bounds: { min: [0, 0, 0], max: [2, 2, 2] }, fadeOthers: true, hideOthers: false })).toBe(false);
    // hiding drops outside entities from the scene and from picking
    s.setEditContext({ path: [3], bounds: null, fadeOthers: true, hideOthers: true });
    expect(node('Body:/1').visible).toBe(false);
    expect(node('Body:/1').isFaded).toBe(false);
    expect(node('Body:3/2').visible).toBe(true);
    expect(pickTriangles(s)).toBe(24); // the two context bodies (Sketch:3 has no faces to pick)
    expect(s.contextBox.visible).toBe(false);
    // a body added while a context is open gets the context treatment too
    s.sync([
      { id: renderKey([], 1), path: [], entityId: 1, mesh, transform: M4_IDENTITY },
      { id: renderKey([3], 2), path: [3], entityId: 2, mesh, transform: M4_IDENTITY },
      { id: renderKey([], 8), path: [], entityId: 8, mesh, transform: M4_IDENTITY },
    ]);
    expect(node('Body:/8').visible).toBe(false);
    // back to the root: everything visible and normal again
    s.setEditContext(ROOT_EDIT_CONTEXT);
    expect(node('Body:/1').visible).toBe(true);
    expect(node('Body:/8').isFaded).toBe(false);
    expect(node('Body:/1').front.material).toBe(s.materials.front);
    s.dispose();
  });

  it('carries a body default color in the vertex color attribute and rebuilds when it changes', () => {
    const s = new SceneSync();
    const mesh = meshBox([0, 0, 0], [1, 1, 1]);
    const body: RenderBody = { id: '/1', path: [], entityId: 1, mesh, transform: M4_IDENTITY, defaultColor: '#ff0000' };
    s.sync([body]);
    const r = s.renderables().find((c) => c.name === 'Body:/1') as unknown as {
      front: { geometry: { getAttribute(n: string): { getX(i: number): number; getY(i: number): number } } };
      back: { geometry: { getAttribute(n: string): { getX(i: number): number } } };
      needsUpdate(b: RenderBody): boolean;
    };
    expect(r.front.geometry.getAttribute('color').getX(0)).toBe(1);
    expect(r.front.geometry.getAttribute('color').getY(0)).toBe(0);
    expect(r.back.geometry.getAttribute('color').getX(0)).toBe(1);
    expect(r.needsUpdate(body)).toBe(false);
    expect(r.needsUpdate({ ...body, defaultColor: undefined })).toBe(true);
    s.sync([{ ...body, defaultColor: undefined }]);
    expect(r.front.geometry.getAttribute('color').getY(0)).toBe(1); // white → style default
    expect(r.back.geometry.getAttribute('color').getX(0)).toBeCloseTo(new Color(BACK_COLOR).r, 5);
    expect(s.materials.front.vertexColors).toBe(true);
    s.dispose();
  });

  it("applies the style's edge, face and modeling settings", () => {
    const s = new SceneSync();
    const mesh = meshBox([0, 0, 0], [1, 1, 1]);
    s.sync([{ id: renderKey([], 1), path: [], entityId: 1, mesh, transform: M4_IDENTITY }]);
    const body = s.renderables().find((c) => c.name === 'Body:/1') as unknown as { front: { geometry: { getAttribute: (n: string) => { getX: (i: number) => number; getZ: (i: number) => number } } }; back: { geometry: { getAttribute: (n: string) => { getX: (i: number) => number } } } };
    expect(s.setDisplay({ edgeColor: 0xff0000, edgeAxisColors: true, profileWidth: 5, depthCue: 4, edgeExtension: 3, xrayOpacity: 0.6, xray: true,
      faceFrontColor: 0x00ff00, faceBackColor: 0x0000ff, selectedColor: 0xffaa00, guideColor: 0x123456 })).toBe(true);
    // Edges: color (normal set only), By Axis, profile width, depth cue and extension in the edge shader's uniforms.
    expect(s.materials.edge.color.getHex()).toBe(0xff0000);
    expect(s.fadedMaterials.edge.color.getHex()).not.toBe(0xff0000);
    for (const m of [s.materials.edge, s.materials.hiddenEdge, s.fadedMaterials.backEdge]) {
      expect(m.axisColors).toBe(true);
      expect(m.depthCue).toBe(4);
      expect(m.extension).toBe(3);
    }
    expect(s.materials.edge.profileWidth).toBe(5);
    // Faces: X-ray opacity, and default-material faces rebuilt in the new front and back colors.
    expect(s.materials.front.opacity).toBe(0.6);
    expect(body.front.geometry.getAttribute('color').getX(0)).toBe(0);
    expect(body.back.geometry.getAttribute('color').getX(0)).toBe(0);
    expect(body.front.geometry.getAttribute('color').getZ(0)).toBe(0);
    // Modeling: selection and guide colors.
    expect(s.highlight.selected.faceMaterial.color.getHex()).toBe(0xffaa00);
    expect(s.guides.lineMaterial.color.getHex()).toBe(0x123456);
    // Depth cue spans the scene from the camera: nearest corner 4, farthest 5 along +X from x = -4.
    s.updateEdgeDepth([-4, 0.5, 0.5], [1, 0, 0]);
    expect((s.materials.edge.uniforms['pfDepthRange']!.value as { x: number; y: number })).toMatchObject({ x: 4, y: 5 });
    // Back to the defaults.
    s.setDisplay({ edgeColor: undefined, edgeAxisColors: false, faceFrontColor: 0xffffff, faceBackColor: BACK_COLOR, selectedColor: 0x2d5bd1, guideColor: 0x4d4d4d, depthCue: 0, edgeExtension: 0 });
    expect(body.front.geometry.getAttribute('color').getX(0)).toBe(1);
    s.dispose();
  });
});


describe('SceneSync batching (PF-191)', () => {
  const box = meshBox([0, 0, 0], [1, 1, 1]);
  const bodies = (n: number, extra: Partial<RenderBody> = {}): RenderBody[] =>
    Array.from({ length: n }, (_, k) => ({ id: renderKey([k + 1], 7), path: [k + 1], entityId: 7, mesh: box, transform: m4translation([k * 2, 0, 0]) as unknown as Mat4, ...extra }));
  const batched = (s: SceneSync) => s.root.children.filter((c) => c.name.startsWith('Body:') || c.name.startsWith('Sketch:')).length;
  const drawn = (s: SceneSync): Mesh[] => {
    s.prepareFrame();
    return s.batches.group.children.filter((c): c is Mesh => c instanceof Mesh && (c.name === 'faces' || c.name === 'backfaces'));
  };

  it('draws a hundred bodies of one material through one front and one back mesh and their edges through one batch', () => {
    const s = new SceneSync();
    s.sync(bodies(100));
    expect(batched(s)).toBe(0); // no body draws itself
    const faces = drawn(s);
    expect(faces.map((m) => m.name).sort()).toEqual(['backfaces', 'faces']);
    expect(faces[0]!.geometry.getAttribute('position').count).toBe(100 * 36);
    expect(s.batches.group.children.filter((c) => c.name === 'EdgeBatch')).toHaveLength(1);
    expect(s.batches.group.children.filter((c) => c.name === 'BackEdges')).toHaveLength(1);
    expect(pickTriangles(s)).toBe(1200);
    s.dispose();
  });

  it('tints a selected body in its batch without rebuilding the batch, and clears it again', () => {
    const s = new SceneSync();
    s.sync(bodies(3));
    const [front] = drawn(s);
    const flags = () => Array.from((front!.geometry.getAttribute('flags') as BufferAttribute).array as Uint8Array);
    s.setSelectedKeys(new Set([renderKey([2], 7)]));
    expect(s.prepareFrame()).toBe(false);
    expect(drawn(s)[0]).toBe(front);
    expect(flags().slice(0, 36).every((f) => f === 0)).toBe(true);
    expect(flags().slice(36, 72).every((f) => f === 1)).toBe(true);
    expect(flags().slice(72).every((f) => f === 0)).toBe(true);
    s.setSelectedKeys(new Set());
    expect(flags().every((f) => f === 0)).toBe(true);
    s.dispose();
  });

  it('rebuilds only the batch of a changed body; a body facing the camera, or hidden, draws itself or not at all', () => {
    const s = new SceneSync();
    const list = bodies(2);
    s.sync(list);
    const [front] = drawn(s);
    // A body that turns toward the camera leaves the batch and draws itself.
    s.sync([list[0]!, { ...list[1]!, faceCamera: { pivot: [0, 0, 0], axis: [0, 0, 1], front: [0, -1, 0], shadowsFaceSun: false } }]);
    expect(batched(s)).toBe(1);
    expect(drawn(s)[0]).not.toBe(front);
    expect(drawn(s)[0]!.geometry.getAttribute('position').count).toBe(36);
    // Hiding everything outside the open context takes those bodies out of the batches too.
    s.setEditContext({ path: [2], bounds: null, fadeOthers: true, hideOthers: true });
    expect(drawn(s)).toHaveLength(0);
    s.setEditContext(ROOT_EDIT_CONTEXT);
    expect(drawn(s)[0]!.geometry.getAttribute('position').count).toBe(36);
    s.dispose();
  });

  it('faded bodies batch with the faded materials, apart from the others', () => {
    const s = new SceneSync();
    s.sync(bodies(3));
    s.setEditContext({ path: [2], bounds: null, fadeOthers: true, hideOthers: false });
    const fronts = drawn(s).filter((m) => m.name === 'faces');
    expect(fronts.map((m) => [m.material === s.fadedMaterials.front, m.geometry.getAttribute('position').count]).sort()).toEqual([[false, 36], [true, 72]]);
    s.dispose();
  });

  it('draws every body and sketch by itself while a section cut is active, and batches them again after', () => {
    const s = new SceneSync();
    s.sync(bodies(2));
    s.syncSketch(sketch({}));
    expect(batched(s)).toBe(0);
    s.setSections({ ...EMPTY_SECTIONS, cuts: [{ key: '/9', path: [], normal: [0, 0, -1], d: 1 }] });
    expect(batched(s)).toBe(3);
    expect(drawn(s)).toHaveLength(0);
    s.setSections(EMPTY_SECTIONS);
    expect(batched(s)).toBe(0);
    expect(drawn(s).length).toBeGreaterThan(0);
    s.dispose();
  });
});

/** Triangles the pick meshes cover. */
function pickTriangles(s: SceneSync): number {
  return s.pickables().reduce((n, o) => n + ((o as unknown as { geometry: { getAttribute(name: string): { count: number } } }).geometry.getAttribute('position').count / 3), 0);
}
