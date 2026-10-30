// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { M4_IDENTITY, meshBox, planeBasis } from '@pushform/core';
import { Color } from 'three';
import type { MeshLambertMaterial } from 'three';
import type { RenderFaceMaterial, RenderMaterial, RenderSketch } from '../types';
import { BodyRenderable, createBodyMaterials } from './BodyRenderable';
import { buildFaceArrays, faceMaterialNeedsGroup } from './buildGeometry';
import { buildSketchGeometry, SketchRenderable, createSketchMaterials } from './SketchRenderable';
import { TextureCache, TexturedMaterialCache, needsOwnMaterial } from '../materials/TextureCache';
import { SceneSync } from '../SceneSync';

const RED: RenderMaterial = { id: 10, color: '#ff0000', alpha: 1 };
const GLASS: RenderMaterial = { id: 11, color: '#0000ff', alpha: 0.5 };
const WOOD: RenderMaterial = { id: 12, color: '#804000', alpha: 1, textureUrl: 'data:image/png;base64,iVBORw0KGgo=', widthM: 0.5, heightM: 0.25 };

/** Face materials for a box: face 0 red (front) / glass (back), face 1 textured, others default. */
function boxFaceMaterials(mesh: ReturnType<typeof meshBox>): Map<number, RenderFaceMaterial> {
  const basisOf = (faceId: number) => {
    // basis at the first vertex of the first triangle of the face, normal from the triangle
    const t = Array.from(mesh.faceId).indexOf(faceId);
    const ia = mesh.tris[t * 3]!, ib = mesh.tris[t * 3 + 1]!, ic = mesh.tris[t * 3 + 2]!;
    const p = (i: number): [number, number, number] => [mesh.verts[i * 3]!, mesh.verts[i * 3 + 1]!, mesh.verts[i * 3 + 2]!];
    const a = p(ia), b = p(ib), c = p(ic);
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n: [number, number, number] = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    return planeBasis(a, n);
  };
  const out = new Map<number, RenderFaceMaterial>();
  out.set(0, { front: RED, back: GLASS, uv: { kind: 'auto' }, basis: basisOf(0) });
  out.set(1, { front: WOOD, back: null, uv: { kind: 'affine', matrix: [2, 0, 0.5, 0, 2, 0] }, basis: basisOf(1) });
  return out;
}

describe('buildFaceArrays with per-face materials', () => {
  it('emits per-vertex front/back colors, uvs and contiguous material groups (default triangles first)', () => {
    const mesh = meshBox([0, 0, 0], [1, 1, 1]);
    const fm = boxFaceMaterials(mesh);
    const a = buildFaceArrays(mesh, M4_IDENTITY, [0, 0, 0], { faceMaterials: fm, defaultColor: '#00ff00' });
    const triCount = mesh.tris.length / 3;
    expect(a.frontColors.length).toBe(triCount * 9);
    expect(a.uvs.length).toBe(triCount * 6);
    // groups: default first, then the (red|glass) pair and the (wood|-) pair
    expect(a.frontGroups.length).toBe(3);
    expect(a.frontGroups[0]!.material).toBeNull();
    expect(a.frontGroups[0]!.start).toBe(0);
    // red is opaque and untextured → it draws with the shared material; the glass back makes the group
    const glass = a.backGroups.find((g) => g.material === GLASS)!;
    const red = a.frontGroups.find((g) => g.start === glass.start)!;
    const wood = a.frontGroups.find((g) => g.material === WOOD)!;
    expect(red.material).toBeNull();
    expect(red.count).toBe(6); // 2 triangles × 3 vertices
    expect(wood.count).toBe(6);
    expect(a.backGroups.find((g) => g.start === wood.start)!.material).toBeNull();
    const sum = a.frontGroups.reduce((s, g) => s + g.count, 0);
    expect(sum).toBe(triCount * 3);
    // colors inside the red group are red on the front, blue on the back; default triangles are green
    const v = red.start;
    expect([a.frontColors[v * 3], a.frontColors[v * 3 + 1], a.frontColors[v * 3 + 2]]).toEqual([1, 0, 0]);
    expect([a.backColors[v * 3], a.backColors[v * 3 + 1], a.backColors[v * 3 + 2]]).toEqual([0, 0, 1]);
    expect(a.frontColors[1]).toBe(1); // green default (vertex 0 of the default group)
    expect(a.frontColors[0]).toBe(0);
    // the sorted faceId attribute still names the faces: every vertex of the wood group is face 1
    for (let i = wood.start; i < wood.start + wood.count; i++) expect(a.faceIds[i]).toBe(1);
    // uvs of the textured face follow the affine matrix (offset 0.5 on s), default faces are zero
    const uvS = a.uvs[wood.start * 2]!;
    expect(uvS - 0.5).toBeCloseTo(Math.round((uvS - 0.5) * 2) / 2);
    expect(a.uvs[0]).toBe(0);
    expect(faceMaterialNeedsGroup(RED)).toBe(false);
    expect(faceMaterialNeedsGroup(GLASS)).toBe(true);
    expect(faceMaterialNeedsGroup(WOOD)).toBe(true);
  });

  it('without groups (color-only materials) keeps the triangle order and no groups', () => {
    const mesh = meshBox([0, 0, 0], [1, 1, 1]);
    const fm = new Map<number, RenderFaceMaterial>([[0, { front: RED, back: null, uv: { kind: 'auto' }, basis: planeBasis([0, 0, 0], [0, 0, 1]) }]]);
    const a = buildFaceArrays(mesh, M4_IDENTITY, [0, 0, 0], { faceMaterials: fm });
    expect(a.frontGroups).toEqual([]);
    expect(Array.from(a.faceIds.slice(0, 3))).toEqual([mesh.faceId[0], mesh.faceId[0], mesh.faceId[0]]);
    const plain = buildFaceArrays(mesh, M4_IDENTITY, [0, 0, 0]);
    expect(plain.frontColors[0]).toBe(1); // style white
    expect(plain.backColors[0]).toBeCloseTo(new Color(0x9fb4cb).r, 5); // three linearizes sRGB colors
  });
});

describe('material-pair bucketing', () => {
  /** `n` separate unit quads (two triangles each, faceId = quad index) in a row along x. */
  function quadStrip(n: number): ReturnType<typeof meshBox> {
    const verts = new Float64Array(n * 12), tris = new Uint32Array(n * 6), faceId = new Uint32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const x = i * 2, v = i * 4;
      verts.set([x, 0, 0, x + 1, 0, 0, x + 1, 1, 0, x, 1, 0], i * 12);
      tris.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
      faceId[i * 2] = i;
      faceId[i * 2 + 1] = i;
    }
    return { verts, tris, faceId };
  }
  const textured = (k: number): RenderMaterial => ({ id: 100 + k, color: '#ffffff', alpha: 1, textureUrl: `data:image/png;base64,${k}`, widthM: 1 + k, heightM: 1 });
  const glass = (k: number): RenderMaterial => ({ id: 200 + k, color: '#0000ff', alpha: 0.25 + k / 20 });
  const basis = planeBasis([0, 0, 0], [0, 0, 1]);

  it('mixed shared and textured faces: shared triangles first, pairs in first-appearance order, each in mesh order', () => {
    const mesh = quadStrip(12);
    const T = [textured(0), textured(1)], G = glass(0);
    const fm = new Map<number, RenderFaceMaterial>();
    // faces 1, 4, 7, 10 textured 0; 2, 8 textured 1 with a glass back; 5 opaque red (shared); the rest no material
    for (const f of [1, 4, 7, 10]) fm.set(f, { front: T[0]!, back: null, uv: { kind: 'auto' }, basis });
    for (const f of [2, 8]) fm.set(f, { front: T[1]!, back: G, uv: { kind: 'auto' }, basis });
    fm.set(5, { front: RED, back: null, uv: { kind: 'auto' }, basis });
    const a = buildFaceArrays(mesh, M4_IDENTITY, [0, 0, 0], { faceMaterials: fm, defaultColor: '#00ff00' });
    const facesInOrder = Array.from(a.faceIds).filter((_, i) => i % 6 === 0); // first vertex of each quad's first triangle
    expect(facesInOrder).toEqual([0, 3, 5, 6, 9, 11, 1, 4, 7, 10, 2, 8]);
    expect(a.frontGroups.map((g) => [g.start, g.count, g.material?.id ?? null])).toEqual([
      [0, 36, null],
      [36, 24, 100],
      [60, 12, 101],
    ]);
    expect(a.backGroups.map((g) => g.material?.id ?? null)).toEqual([null, null, 200]);
    // every triangle keeps its own attributes: positions name the quad, colors follow the pair
    for (let v = 0; v < a.faceIds.length; v++) {
      const face = a.faceIds[v]!;
      expect(Math.floor(a.positions[v * 3]! / 2)).toBe(face);
      const front = fm.get(face)?.front; // red or white when set, else the green default
      expect(a.frontColors[v * 3]).toBe(front ? 1 : 0);
      expect(a.frontColors[v * 3 + 1]).toBe(front === RED ? 0 : 1);
      expect(a.backColors[v * 3 + 2]).toBe(fm.get(face)?.back === G ? 1 : 0);
    }
  });

  it('many distinct pairs: matches a brute-force stable sort by pair and preserves all per-vertex attributes', () => {
    const n = 300, mesh = quadStrip(n);
    const T = Array.from({ length: 40 }, (_, k) => textured(k)), G = Array.from({ length: 7 }, (_, k) => glass(k));
    const fm = new Map<number, RenderFaceMaterial>();
    for (let f = 0; f < n; f++) {
      if (f % 3 === 0) continue; // shared
      const back = f % 5 === 0 ? G[f % 7]! : null;
      fm.set(f, { front: T[f % 40]!, back, uv: { kind: 'affine', matrix: [1, 0, f / 100, 0, 1, 0] }, basis });
    }
    // reference: the (front, back) key of each triangle, keys in first-appearance order, '' first
    const key = (f: number): string => {
      const e = fm.get(f);
      return e ? `${e.front!.id}|${e.back ? e.back.id : '-'}` : '';
    };
    const keys = Array.from(mesh.faceId, key);
    const seen = ['', ...keys.filter((k, i) => k !== '' && keys.indexOf(k) === i)];
    const order: number[] = [];
    for (const k of seen) for (let t = 0; t < keys.length; t++) if (keys[t] === k) order.push(t);
    expect(seen.length).toBeGreaterThan(50);
    const a = buildFaceArrays(mesh, M4_IDENTITY, [0, 0, 0], { faceMaterials: fm });
    expect(Array.from(a.faceIds).filter((_, i) => i % 3 === 0)).toEqual(order.map((t) => mesh.faceId[t]!));
    expect(a.frontGroups.length).toBe(seen.length);
    expect(a.frontGroups.map((g) => (g.material ? `${g.material.id}` : '-') + '|' + (a.backGroups[a.frontGroups.indexOf(g)]!.material?.id ?? '-'))).toEqual(
      seen.map((k) => (k === '' ? '-|-' : k)),
    );
    let next = 0;
    for (const g of a.frontGroups) {
      expect(g.start).toBe(next);
      next += g.count;
    }
    expect(next).toBe(n * 6);
    // the same mesh pre-permuted into that order yields identical attribute arrays (permutation only)
    const sorted = {
      verts: mesh.verts,
      tris: Uint32Array.from(order.flatMap((t) => [mesh.tris[t * 3]!, mesh.tris[t * 3 + 1]!, mesh.tris[t * 3 + 2]!])),
      faceId: Uint32Array.from(order, (t) => mesh.faceId[t]!),
    };
    const b = buildFaceArrays(sorted, M4_IDENTITY, [0, 0, 0], { faceMaterials: fm });
    expect(a.positions).toEqual(b.positions);
    expect(a.normals).toEqual(b.normals);
    expect(a.faceIds).toEqual(b.faceIds);
    expect(a.flags).toEqual(b.flags);
    expect(a.frontColors).toEqual(b.frontColors);
    expect(a.backColors).toEqual(b.backColors);
    expect(a.uvs).toEqual(b.uvs);
    expect(a.uvsBack).toEqual(b.uvsBack);
    expect(a.frontGroups).toEqual(b.frontGroups);
  });
});

describe('back-side texture coordinates', () => {
  const STONE: RenderMaterial = { id: 13, color: '#808080', alpha: 1, textureUrl: 'data:image/png;base64,iVBORw0KGgp=', widthM: 2, heightM: 1 };

  it('gives the back side its own mapping and texture size; without uvBack it follows uv', () => {
    const mesh = meshBox([0, 0, 0], [1, 1, 1]);
    const basis = planeBasis([0, 0, 0], [0, 0, 1]);
    const fm = new Map<number, RenderFaceMaterial>([
      [0, { front: WOOD, back: STONE, uv: { kind: 'auto' }, basis }],
      [1, { front: WOOD, back: STONE, uv: { kind: 'auto' }, uvBack: { kind: 'affine', matrix: [0, 1, 0.5, 1, 0, 0] }, basis }],
    ]);
    const a = buildFaceArrays(mesh, M4_IDENTITY, [0, 0, 0], { faceMaterials: fm });
    expect(a.uvsBack.length).toBe(a.uvs.length);
    for (let i = 0; i < a.faceIds.length; i++) {
      const x = a.positions[i * 3]!, y = a.positions[i * 3 + 1]!;
      const [s, t, sb, tb] = [a.uvs[i * 2]!, a.uvs[i * 2 + 1]!, a.uvsBack[i * 2]!, a.uvsBack[i * 2 + 1]!];
      if (a.faceIds[i] === 0) {
        // auto on both sides, each with its own texture size
        expect([s, t]).toEqual([expect.closeTo(x / 0.5, 6), expect.closeTo(y / 0.25, 6)]);
        expect([sb, tb]).toEqual([expect.closeTo(x / 2, 6), expect.closeTo(y / 1, 6)]);
      } else if (a.faceIds[i] === 1) {
        expect([sb, tb]).toEqual([expect.closeTo(y + 0.5, 6), expect.closeTo(x, 6)]);
      }
    }
    const r = new BodyRenderable('/1', createBodyMaterials(), new TexturedMaterialCache(new TextureCache()));
    r.update({ id: '/1', path: [], entityId: 1, mesh, transform: M4_IDENTITY, faceMaterials: fm }, [0, 0, 0]);
    expect(r.back.geometry.getAttribute('uv').array).toEqual(a.uvsBack);
    expect(r.front.geometry.getAttribute('uv').array).toEqual(a.uvs);
    r.dispose();
  });

  it('computes sketch texture coordinates in the uv basis, back side separately', () => {
    const basis = planeBasis([0, 0, 0], [0, 0, 1]);
    // A basis whose axes are halved: a face drawn twice as large shows the same texture extent.
    const uvBasis = { ...basis, u: [0.5, 0, 0] as const, v: [0, 0.5, 0] as const };
    const sketch: RenderSketch = { id: '', path: [], version: 1, edges: [], faces: [
      { id: 1, loops: [[[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]]], basis, uvBasis, hidden: false,
        frontMaterial: WOOD, backMaterial: STONE, uv: { kind: 'auto' }, uvBack: { kind: 'affine', matrix: [1, 0, 0.25, 0, 1, 0] } },
    ] };
    const data = buildSketchGeometry(sketch, [0, 0, 0]);
    for (let i = 0; i < data.faceIds.length; i++) {
      const x = data.positions[i * 3]!, y = data.positions[i * 3 + 1]!;
      expect(data.uvs[i * 2]).toBeCloseTo(x / 2 / 0.5, 6);
      expect(data.uvs[i * 2 + 1]).toBeCloseTo(y / 2 / 0.25, 6);
      expect(data.uvsBack[i * 2]).toBeCloseTo(x / 2 + 0.25, 6);
      expect(data.uvsBack[i * 2 + 1]).toBeCloseTo(y / 2, 6);
    }
    const r = new SketchRenderable('', createSketchMaterials(), createBodyMaterials(), new TexturedMaterialCache(new TextureCache()));
    r.update(sketch, [0, 0, 0]);
    expect(r.back.geometry.getAttribute('uv').array).toEqual(data.uvsBack);
    r.dispose();
  });
});

describe('BodyRenderable / SketchRenderable material groups', () => {
  it('assigns an array material with geometry groups and swaps textured groups with the face style', () => {
    const textures = new TextureCache();
    const cache = new TexturedMaterialCache(textures);
    const r = new BodyRenderable('/1', createBodyMaterials(), cache);
    const mesh = meshBox([0, 0, 0], [1, 1, 1]);
    const body = { id: '/1', path: [], entityId: 1, mesh, transform: M4_IDENTITY, faceMaterials: boxFaceMaterials(mesh) };
    r.update(body, [0, 0, 0]);
    const front = r.front.material as unknown as MeshLambertMaterial[];
    expect(Array.isArray(front)).toBe(true);
    expect(front.length).toBe(2); // shared + wood (red has no texture/alpha → shared)
    expect(front[1]!.map).toBeTruthy();
    expect(r.front.geometry.groups).toHaveLength(3);
    const back = r.back.material as unknown as MeshLambertMaterial[];
    expect(back.length).toBe(2); // shared + glass (translucent)
    expect(back[1]!.transparent).toBe(true);
    expect(back[1]!.opacity).toBe(0.5);
    expect(textures.size).toBe(1);
    // shaded (no textures): the wood group falls back to the shared vertex-colored material
    r.setTextured(false);
    expect((r.front.material as unknown as MeshLambertMaterial[]).length).toBe(1);
    expect(r.front.geometry.groups).toHaveLength(3);
    r.setTextured(true);
    expect((r.front.material as unknown as MeshLambertMaterial[]).length).toBe(2);
    expect(r.needsUpdate(body)).toBe(false);
    expect(r.needsUpdate({ ...body, faceMaterials: new Map() })).toBe(true);
    // faded set → faded textured variants
    r.setMaterials(createBodyMaterials({ faded: true }), true);
    const fadedWood = (r.front.material as unknown as MeshLambertMaterial[])[1]!;
    expect(fadedWood.transparent).toBe(true);
    expect(cache.size).toBe(4); // wood + glass, normal and faded
    expect(needsOwnMaterial(RED, true)).toBe(false);
    expect(needsOwnMaterial(WOOD, false)).toBe(false);
    expect(needsOwnMaterial(WOOD, true)).toBe(true);
    r.dispose();
    cache.dispose();
    textures.dispose();
  });

  it('sketch faces get uvs and groups per material pair', () => {
    const basis = planeBasis([0, 0, 0], [0, 0, 1]);
    const sketch: RenderSketch = {
      id: '',
      path: [],
      version: 1,
      faces: [
        { id: 1, loops: [[[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]]], basis, hidden: false, frontMaterial: WOOD, backMaterial: null, uv: { kind: 'auto' } },
        { id: 2, loops: [[[2, 0, 0], [3, 0, 0], [3, 1, 0], [2, 1, 0]]], basis, hidden: false, frontColor: '#ff0000' },
      ],
      edges: [],
    };
    const data = buildSketchGeometry(sketch, [0, 0, 0]);
    expect(data.frontGroups).toHaveLength(2);
    expect(data.frontGroups[0]!.material).toBeNull(); // plain face first
    expect(data.frontGroups[1]!.material).toBe(WOOD);
    const woodRange = data.faceRanges.get(1)!;
    expect(woodRange[0]).toBe(data.frontGroups[1]!.start);
    // uv of the textured face: u / 0.5, v / 0.25 → the corner (1, 1) maps to (2, 4)
    const uvs = Array.from(data.uvs.slice(woodRange[0] * 2, (woodRange[0] + woodRange[1]) * 2));
    expect(uvs.some((v, i) => i % 2 === 0 && Math.abs(v - 2) < 1e-9)).toBe(true);
    expect(uvs.some((v, i) => i % 2 === 1 && Math.abs(v - 4) < 1e-9)).toBe(true);
    const textures = new TextureCache();
    const cache = new TexturedMaterialCache(textures);
    const r = new SketchRenderable('', createSketchMaterials(), createBodyMaterials(), cache);
    r.update(sketch, [0, 0, 0]);
    expect((r.front.material as unknown as MeshLambertMaterial[]).length).toBe(2);
    expect(r.front.geometry.groups).toHaveLength(2);
    r.setTextured(false);
    expect((r.front.material as unknown as MeshLambertMaterial[]).length).toBe(1);
    r.dispose();
  });

  it('textures a sketch whose only faces share one textured material (an exploded picture)', () => {
    const basis = planeBasis([0, 0, 0], [0, 0, 1]);
    const sketch: RenderSketch = { id: '', path: [], version: 1, edges: [], faces: [
      { id: 1, loops: [[[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]]], basis, hidden: false, frontMaterial: WOOD, backMaterial: WOOD, uv: { kind: 'auto' } },
    ] };
    const data = buildSketchGeometry(sketch, [0, 0, 0]);
    expect(data.frontGroups.map((g) => g.material)).toEqual([WOOD]);
    const r = new SketchRenderable('', createSketchMaterials(), createBodyMaterials(), new TexturedMaterialCache(new TextureCache()));
    r.update(sketch, [0, 0, 0]);
    const materials = r.front.material as unknown as MeshLambertMaterial[];
    expect(materials.length).toBe(2);
    expect(materials[1]!.map).not.toBeNull();
    r.dispose();
  });

  it('SceneSync toggles textures with the face style and exposes the caches', () => {
    const s = new SceneSync();
    const mesh = meshBox([0, 0, 0], [1, 1, 1]);
    s.setDisplay({ faceStyle: 'shadedTextured' });
    s.sync([{ id: '/1', path: [], entityId: 1, mesh, transform: M4_IDENTITY, faceMaterials: boxFaceMaterials(mesh) }]);
    const r = s.renderables().find((c) => c.name === 'Body:/1') as BodyRenderable;
    expect(r.isTextured).toBe(true);
    expect((r.front.material as unknown as MeshLambertMaterial[]).length).toBe(2);
    s.setDisplay({ faceStyle: 'shaded' });
    expect(r.isTextured).toBe(false);
    expect((r.front.material as unknown as MeshLambertMaterial[]).length).toBe(1);
    s.setDisplay({ faceStyle: 'shadedTextured', xray: true });
    const wood = (r.front.material as unknown as MeshLambertMaterial[])[1]!;
    expect(wood.transparent).toBe(true);
    expect(wood.depthWrite).toBe(false);
    expect(s.textures.size).toBe(1);
    s.dispose();
  });
});
