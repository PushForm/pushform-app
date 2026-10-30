// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Vec3 } from '@pushform/core';
import { triangulatePlanarFace } from '@pushform/geom';
import { BackSide, BufferAttribute, BufferGeometry, Color, FrontSide, Group, Mesh, MeshLambertMaterial } from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { EDGE_FLAG_BOUNDARY, EDGE_FLAG_HIDDEN, EDGE_FLAG_SMOOTH, EDGE_FLAG_SOFT, cssToRgb, edgeStyleFlags } from '../types';
import type { EdgeSegments, RenderFaceGroup, RenderMaterial, RenderPath, RenderSketch, RenderFaceCamera } from '../types';
import { LENGTH_TOL, basisToLocal } from '@pushform/core';
import type { TexturedMaterialCache } from '../materials/TextureCache';
import { needsOwnMaterial } from '../materials/TextureCache';
import { cornerAngle, faceMaterialNeedsGroup, writeFaceUv } from './buildGeometry';
import { FACE_MATERIAL_COMMON, FADE_OPACITY, fillFlags, patchSelectTint, shadowDisplay } from './BodyRenderable';
import { palette } from './palette';
import type { BodyMaterialOptions, BodyMaterials } from './BodyRenderable';
import { EdgeBatch } from './EdgeBatch';

export interface SketchMaterials {
  readonly front: MeshLambertMaterial;
  readonly back: MeshLambertMaterial;
}

/** Vertex-colored Lambert pair so individual sketch faces can carry their own front/back colors. */
export function createSketchMaterials(opts: BodyMaterialOptions = {}): SketchMaterials {
  const faceOpts = opts.faded ? { transparent: true, opacity: FADE_OPACITY, depthWrite: true } : {};
  const front = new MeshLambertMaterial({ color: 0xffffff, vertexColors: true, side: FrontSide, ...FACE_MATERIAL_COMMON, ...faceOpts });
  const back = new MeshLambertMaterial({ color: 0xffffff, vertexColors: true, side: BackSide, ...FACE_MATERIAL_COMMON, ...faceOpts });
  patchSelectTint(front);
  patchSelectTint(back);
  return { front, back };
}

export interface SketchGeometryOptions {
  /** Include hidden faces and soft/hidden edges (hidden-geometry display mode). */
  readonly showHidden?: boolean | undefined;
}

/** Plain-array output of `buildSketchGeometry` (testable without WebGL). */
export interface SketchGeometryData {
  /** Unwelded triangle positions relative to the floating origin. */
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly faceIds: Float32Array;
  readonly frontColors: Float32Array;
  readonly backColors: Float32Array;
  /** Vertex range [start, count] per face id, for selection flags. */
  readonly faceRanges: ReadonlyMap<number, readonly [number, number]>;
  /** Visible edges (normal + profile widths decided on the GPU). */
  readonly edges: EdgeSegments;
  /** Soft/hidden edges, drawn dashed only in hidden-geometry mode. */
  readonly hiddenEdges: EdgeSegments;
  /** Per-vertex texture coordinates in tiles (0 for faces without a textured material). */
  readonly uvs: Float32Array;
  /** The same for the back side (its own mapping and texture size). */
  readonly uvsBack: Float32Array;
  /** Per-vertex projective divisor minus one, front and back (see `writeFaceUv`). */
  readonly uvqs: Float32Array;
  readonly uvqsBack: Float32Array;
  /** Vertex ranges per front / back material; empty when no face needs its own material. */
  readonly frontGroups: readonly RenderFaceGroup[];
  readonly backGroups: readonly RenderFaceGroup[];
}

const Q = 1e6;
const AUTO_UV = { kind: 'auto' } as const;
function segKey(a: Vec3, b: Vec3): string {
  const ka = `${Math.round(a[0] * Q)},${Math.round(a[1] * Q)},${Math.round(a[2] * Q)}`;
  const kb = `${Math.round(b[0] * Q)},${Math.round(b[1] * Q)},${Math.round(b[2] * Q)}`;
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

/** Sketch faces joined through smooth edges, as face id → group root; faces with no smooth neighbor are left out. */
export function sketchSmoothGroups(sketch: RenderSketch): Map<number, number> {
  const smooth = new Set(sketch.edges.filter((e) => e.smooth).map((e) => segKey(e.a, e.b)));
  const parent = new Map<number, number>();
  if (smooth.size === 0) return parent;
  const find = (id: number): number => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (id !== root) { const next = parent.get(id)!; parent.set(id, root); id = next; }
    return root;
  };
  const firstFace = new Map<string, number>();
  for (const face of sketch.faces) {
    for (const loop of face.loops) {
      for (let i = 0; i < loop.length; i++) {
        const k = segKey(loop[i]!, loop[(i + 1) % loop.length]!);
        if (!smooth.has(k)) continue;
        if (!parent.has(face.id)) parent.set(face.id, face.id);
        const other = firstFace.get(k);
        if (other === undefined) firstFace.set(k, face.id);
        else parent.set(find(other), find(face.id));
      }
    }
  }
  const size = new Map<number, number>();
  for (const id of parent.keys()) size.set(find(id), (size.get(find(id)) ?? 0) + 1);
  const groups = new Map<number, number>();
  for (const id of parent.keys()) if (size.get(find(id))! > 1) groups.set(id, find(id));
  return groups;
}

/**
 * Faces joined by smooth edges shade as one surface: at each shared vertex the normal is the
 * corner-angle-weighted average of the group's face normals there, as body smoothing surfaces are. Sheets need not
 * face the same way, so each neighbor's normal is turned to agree with the face being shaded before it is added.
 */
function applySketchSmoothNormals(sketch: RenderSketch, pos: readonly number[], nrm: number[],
  faceRanges: ReadonlyMap<number, readonly [number, number]>): void {
  const groupOf = sketchSmoothGroups(sketch);
  if (groupOf.size === 0) return;
  const normalOf = new Map(sketch.faces.map((face) => [face.id, face.basis.n] as const));
  const inv = 1 / LENGTH_TOL;
  const keyOf = (group: number, v: number): string =>
    `${group}|${Math.round(pos[v * 3]! * inv)},${Math.round(pos[v * 3 + 1]! * inv)},${Math.round(pos[v * 3 + 2]! * inv)}`;
  // Per shared vertex: each face's normal with its summed corner angle there.
  const corners = new Map<string, Map<number, number>>();
  for (const [faceId, group] of groupOf) {
    const range = faceRanges.get(faceId);
    if (!range) continue;
    for (let t = range[0]; t < range[0] + range[1]; t += 3) {
      for (let k = 0; k < 3; k++) {
        const p = (t + k) * 3, q = (t + (k + 1) % 3) * 3, r = (t + (k + 2) % 3) * 3;
        const angle = cornerAngle(pos[p]!, pos[p + 1]!, pos[p + 2]!, pos[q]!, pos[q + 1]!, pos[q + 2]!, pos[r]!, pos[r + 1]!, pos[r + 2]!);
        const key = keyOf(group, t + k);
        const faces = corners.get(key) ?? corners.set(key, new Map()).get(key)!;
        faces.set(faceId, (faces.get(faceId) ?? 0) + angle);
      }
    }
  }
  for (const [faceId, group] of groupOf) {
    const range = faceRanges.get(faceId), own = normalOf.get(faceId);
    if (!range || !own) continue;
    for (let v = range[0]; v < range[0] + range[1]; v++) {
      let x = 0, y = 0, z = 0;
      for (const [other, weight] of corners.get(keyOf(group, v)) ?? []) {
        const n = normalOf.get(other)!;
        const sign = n[0] * own[0] + n[1] * own[1] + n[2] * own[2] < 0 ? -weight : weight;
        x += n[0] * sign; y += n[1] * sign; z += n[2] * sign;
      }
      const length = Math.hypot(x, y, z);
      if (length === 0) continue;
      nrm[v * 3] = x / length; nrm[v * 3 + 1] = y / length; nrm[v * 3 + 2] = z / length;
    }
  }
}

/**
 * Triangulate sketch faces (earcut in the face basis; CCW about `basis.n` = front side) into an
 * unwelded geometry, and gather edge segments with the normals of their adjacent faces so the
 * edge shader can draw face boundaries and silhouettes as profiles.
 */
export function buildSketchGeometry(sketch: RenderSketch, origin: Vec3, opts: SketchGeometryOptions = {}): SketchGeometryData {
  const showHidden = opts.showHidden ?? false;
  const pos: number[] = [];
  const nrm: number[] = [];
  const fid: number[] = [];
  const fcol: number[] = [];
  const bcol: number[] = [];
  const uvs: number[] = [];
  const uvsBack: number[] = [];
  const uvqs: number[] = [];
  const uvqsBack: number[] = [];
  const faceRanges = new Map<number, readonly [number, number]>();
  const adjacency = new Map<string, Vec3[]>();
  const front = palette.front.clone();
  const back = palette.back.clone();
  const tmp = new Color();
  const frontGroups: RenderFaceGroup[] = [];
  const backGroups: RenderFaceGroup[] = [];

  // Adjacency is collected for hidden faces too: their edges still bound them.
  for (const face of sketch.faces) {
    for (const loop of face.loops) {
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i]!, b = loop[(i + 1) % loop.length]!;
        const k = segKey(a, b);
        const list = adjacency.get(k);
        if (list) list.push(face.basis.n);
        else adjacency.set(k, [face.basis.n]);
      }
    }
  }
  // Faces grouped by (front, back) material pair so textured / translucent faces form contiguous
  // draw groups; faces on the shared materials come first.
  const pairKey = (f: RenderSketch['faces'][number]): string => {
    const fo = faceMaterialNeedsGroup(f.frontMaterial), bo = faceMaterialNeedsGroup(f.backMaterial);
    return fo || bo ? `${fo ? f.frontMaterial!.id : '-'}|${bo ? f.backMaterial!.id : '-'}` : '';
  };
  const byPair = new Map<string, RenderSketch['faces'][number][]>();
  for (const face of sketch.faces) {
    if (face.hidden && !showHidden) continue;
    if (face.loops.length === 0 || (face.loops[0]?.length ?? 0) < 3) continue;
    const k = pairKey(face);
    const l = byPair.get(k);
    if (l) l.push(face);
    else byPair.set(k, [face]);
  }
  const pairKeys = ['', ...[...byPair.keys()].filter((k) => k !== '')];
  for (const key of pairKeys) {
    const faces = byPair.get(key);
    if (!faces) continue;
    const groupStart = pos.length / 3;
    let groupFront: RenderMaterial | null = null, groupBack: RenderMaterial | null = null;
    for (const face of faces) {
      const tri = triangulatePlanarFace(face.loops, face.basis);
      const n = face.basis.n;
      const fc = face.frontColor ? tmp.set(face.frontColor).clone() : front;
      const bc = face.backColor ? tmp.set(face.backColor).clone() : back;
      const tex = face.frontMaterial?.textureUrl ? face.frontMaterial : face.backMaterial?.textureUrl ? face.backMaterial : (face.frontMaterial ?? face.backMaterial ?? null);
      // Each side uses its own texture size; an untextured side follows the textured one.
      const frontTex = face.frontMaterial?.textureUrl ? face.frontMaterial : tex, backTex = face.backMaterial?.textureUrl ? face.backMaterial : tex;
      const frontUv = face.uv ?? AUTO_UV, backUv = face.uvBack ?? frontUv, uvBasis = face.uvBasis ?? face.basis;
      const textured = !!tex;
      if (key !== '') {
        if (faceMaterialNeedsGroup(face.frontMaterial)) groupFront = face.frontMaterial!;
        if (faceMaterialNeedsGroup(face.backMaterial)) groupBack = face.backMaterial!;
      }
      const start = pos.length / 3;
      for (let i = 0; i < tri.indices.length; i++) {
        const v = tri.indices[i]! * 3;
        const px = tri.positions[v]!, py = tri.positions[v + 1]!, pz = tri.positions[v + 2]!;
        pos.push(px - origin[0], py - origin[1], pz - origin[2]);
        nrm.push(n[0], n[1], n[2]);
        fid.push(face.id);
        fcol.push(fc.r, fc.g, fc.b);
        bcol.push(bc.r, bc.g, bc.b);
        if (textured) {
          const l = basisToLocal(uvBasis, [px, py, pz]);
          writeFaceUv(uvs, uvs.length, frontUv, frontTex, l[0], l[1], uvqs, uvqs.length);
          writeFaceUv(uvsBack, uvsBack.length, backUv, backTex, l[0], l[1], uvqsBack, uvqsBack.length);
        } else {
          uvs.push(0, 0);
          uvsBack.push(0, 0);
          uvqs.push(0);
          uvqsBack.push(0);
        }
      }
      faceRanges.set(face.id, [start, pos.length / 3 - start]);
    }
    const count = pos.length / 3 - groupStart;
    // A textured or translucent pair needs its group even when every face uses it (one exploded picture).
    if (count > 0 && (byPair.size > 1 || key !== '')) {
      frontGroups.push({ start: groupStart, count, material: groupFront });
      backGroups.push({ start: groupStart, count, material: groupBack });
    }
  }
  if (frontGroups.length && frontGroups.every((g) => g.material === null) && backGroups.every((g) => g.material === null)) {
    frontGroups.length = 0;
    backGroups.length = 0;
  }
  applySketchSmoothNormals(sketch, pos, nrm, faceRanges);

  const vis = { pos: [] as number[], nA: [] as number[], nB: [] as number[], flags: [] as number[], colors: [] as number[] };
  const hid = { pos: [] as number[], nA: [] as number[], nB: [] as number[], flags: [] as number[], colors: [] as number[] };
  for (const e of sketch.edges) {
    const concealed = e.hidden || e.soft;
    if (concealed && !showHidden) continue;
    const out = concealed ? hid : vis;
    const normals = adjacency.get(segKey(e.a, e.b)) ?? [];
    let flags = (e.soft ? EDGE_FLAG_SOFT : 0) | (e.smooth ? EDGE_FLAG_SMOOTH : 0) | (e.hidden ? EDGE_FLAG_HIDDEN : 0) | edgeStyleFlags(e);
    const rgb = cssToRgb(e.color);
    let na: Vec3, nb: Vec3;
    if (normals.length >= 2) {
      na = normals[0]!;
      nb = normals[1]!;
    } else if (normals.length === 1) {
      na = normals[0]!;
      nb = [0, 0, 0];
      flags |= EDGE_FLAG_BOUNDARY;
    } else {
      na = [0, 0, 1];
      nb = [0, 0, 1];
    }
    out.pos.push(e.a[0] - origin[0], e.a[1] - origin[1], e.a[2] - origin[2], e.b[0] - origin[0], e.b[1] - origin[1], e.b[2] - origin[2]);
    out.nA.push(na[0], na[1], na[2]);
    out.nB.push(nb[0], nb[1], nb[2]);
    out.flags.push(flags);
    out.colors.push(rgb[0], rgb[1], rgb[2], rgb[0], rgb[1], rgb[2]);
  }
  const pack = (o: typeof vis): EdgeSegments => ({
    positions: new Float32Array(o.pos),
    normalA: new Float32Array(o.nA),
    normalB: new Float32Array(o.nB),
    flags: new Uint8Array(o.flags),
    colors: new Float32Array(o.colors),
  });
  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(nrm),
    faceIds: new Float32Array(fid),
    frontColors: new Float32Array(fcol),
    backColors: new Float32Array(bcol),
    faceRanges,
    edges: pack(vis),
    hiddenEdges: pack(hid),
    uvs: new Float32Array(uvs),
    uvsBack: new Float32Array(uvsBack),
    uvqs: new Float32Array(uvqs),
    uvqsBack: new Float32Array(uvqsBack),
    frontGroups,
    backGroups,
  };
}

/**
 * One container's sketch: a front and a back mesh over shared position/normal/flags attributes
 * (different `color` attributes), plus a solid edge batch and a dashed batch for soft/hidden
 * edges that is only visible in hidden-geometry mode. Keyed by the container's path key.
 */
export class SketchRenderable extends Group {
  readonly front: Mesh<BufferGeometry, MeshLambertMaterial>;
  readonly back: Mesh<BufferGeometry, MeshLambertMaterial>;
  readonly edges: EdgeBatch;
  readonly hiddenEdges: EdgeBatch;
  /** Back-edges pass sharing the solid batch's geometry (visibility through the shared material). */
  readonly backEdges: LineSegments2;
  /** Always Face Camera turn applied each frame by `SceneSync.updateFaceCamera`; never part of the geometry. */
  faceCamera: RenderFaceCamera | undefined = undefined;
  /** Instance path of the container (from the last `update`). */
  path: RenderPath = [];
  versionRef: unknown = undefined;
  sketchRef: RenderSketch | null = null;
  private faceRanges: ReadonlyMap<number, readonly [number, number]> = new Map();
  private selectedFaces = new Set<number>();
  private showHidden = false;
  private builtShowHidden = false;
  private _faded = false;
  private shared: SketchMaterials;
  private frontGroups: readonly RenderFaceGroup[] = [];
  private backGroups: readonly RenderFaceGroup[] = [];
  private _textured = true;

  constructor(
    readonly key: string,
    materials: SketchMaterials,
    edgeMaterials: Pick<BodyMaterials, 'edge' | 'hiddenEdge' | 'backEdge'>,
    /** Materials for textured / translucent face groups (none = every face uses the shared materials). */
    private readonly texturedCache: TexturedMaterialCache | null = null,
  ) {
    super();
    this.shared = materials;
    this.name = `Sketch:${key}`;
    this.front = new Mesh(new BufferGeometry(), materials.front);
    this.back = new Mesh(new BufferGeometry(), materials.back);
    this.front.name = 'sketchFaces';
    this.back.name = 'sketchBackfaces';
    this.front.userData['key'] = key;
    this.back.userData['key'] = key;
    this.edges = new EdgeBatch(edgeMaterials.edge);
    this.hiddenEdges = new EdgeBatch(edgeMaterials.hiddenEdge);
    this.hiddenEdges.visible = false;
    this.backEdges = new LineSegments2(this.edges.geometry, edgeMaterials.backEdge);
    this.backEdges.name = 'BackEdges';
    this.backEdges.frustumCulled = false;
    this.backEdges.renderOrder = 1;
    this.add(this.front, this.back, this.edges, this.hiddenEdges, this.backEdges);
  }

  /** Swap the shared material sets (normal ↔ faded). */
  setMaterials(materials: SketchMaterials, edgeMaterials: Pick<BodyMaterials, 'edge' | 'hiddenEdge' | 'backEdge'>, faded: boolean): void {
    this.shared = materials;
    this.edges.material = edgeMaterials.edge;
    this.hiddenEdges.material = edgeMaterials.hiddenEdge;
    this.backEdges.material = edgeMaterials.backEdge;
    this._faded = faded;
    this.applyGroups();
  }

  get isFaded(): boolean {
    return this._faded;
  }

  /** Textured face style on/off (see `BodyRenderable.setTextured`). */
  setTextured(on: boolean): void {
    if (this._textured === on) return;
    this._textured = on;
    this.applyGroups();
  }

  get isTextured(): boolean {
    return this._textured;
  }

  private applyGroups(): void {
    const apply = (mesh: Mesh<BufferGeometry, MeshLambertMaterial>, groups: readonly RenderFaceGroup[], side: 'front' | 'back') => {
      const shared = this.shared[side];
      const g = mesh.geometry;
      g.clearGroups();
      if (groups.length === 0 || !this.texturedCache) {
        mesh.material = shared;
        return;
      }
      const list: MeshLambertMaterial[] = [shared];
      const index = new Map<MeshLambertMaterial, number>([[shared, 0]]);
      for (const grp of groups) {
        let mat = shared;
        if (needsOwnMaterial(grp.material, this._textured)) mat = this.texturedCache.get(grp.material, side, this._faded, this._textured);
        let i = index.get(mat);
        if (i === undefined) {
          i = list.length;
          list.push(mat);
          index.set(mat, i);
        }
        g.addGroup(grp.start, grp.count, i);
      }
      (mesh as Mesh<BufferGeometry, MeshLambertMaterial | MeshLambertMaterial[]>).material = list;
    };
    apply(this.front, this.frontGroups, 'front');
    apply(this.back, this.backGroups, 'back');
  }

  /**
   * Cast and receive shadows, like a solid's faces; receiving also follows the Shadows panel's On Faces
   * (`shadowDisplay`). Returns whether anything changed.
   */
  setShadows(cast: boolean, receive: boolean): boolean {
    const onFaces = shadowDisplay.onFaces && receive;
    if (this.front.castShadow === cast && this.front.userData['receiveShadows'] === receive && this.front.receiveShadow === onFaces) return false;
    for (const mesh of [this.front, this.back]) {
      mesh.castShadow = cast;
      mesh.receiveShadow = onFaces;
      mesh.userData['receiveShadows'] = receive;
    }
    return true;
  }

  update(sketch: RenderSketch, origin: Vec3): void {
    this.path = sketch.path;
    this.front.userData['path'] = sketch.path;
    this.back.userData['path'] = sketch.path;
    const data = buildSketchGeometry(sketch, origin, { showHidden: this.showHidden });
    const position = new BufferAttribute(data.positions, 3);
    const normal = new BufferAttribute(data.normals, 3);
    const faceId = new BufferAttribute(data.faceIds, 1);
    const flags = new BufferAttribute(new Uint8Array(data.positions.length / 3), 1);
    const uv = new BufferAttribute(data.uvs, 2);
    const fg = new BufferGeometry();
    fg.setAttribute('position', position);
    fg.setAttribute('normal', normal);
    fg.setAttribute('faceId', faceId);
    fg.setAttribute('flags', flags);
    fg.setAttribute('uv', uv);
    fg.setAttribute('uvq', new BufferAttribute(data.uvqs, 1));
    fg.setAttribute('color', new BufferAttribute(data.frontColors, 3));
    const bg = new BufferGeometry();
    bg.setAttribute('position', position);
    bg.setAttribute('normal', normal);
    bg.setAttribute('faceId', faceId);
    bg.setAttribute('flags', flags);
    bg.setAttribute('uv', new BufferAttribute(data.uvsBack, 2));
    bg.setAttribute('uvq', new BufferAttribute(data.uvqsBack, 1));
    bg.setAttribute('color', new BufferAttribute(data.backColors, 3));
    this.frontGroups = data.frontGroups;
    this.backGroups = data.backGroups;
    if (data.positions.length) {
      fg.computeBoundingBox();
      fg.computeBoundingSphere();
      bg.boundingBox = fg.boundingBox;
      bg.boundingSphere = fg.boundingSphere;
    }
    this.front.geometry.dispose();
    this.front.geometry = fg;
    this.back.geometry.dispose();
    this.back.geometry = bg;
    this.applyGroups();
    this.front.visible = this.back.visible = data.positions.length > 0;
    this.edges.setSegments(data.edges);
    this.hiddenEdges.setSegments(data.hiddenEdges);
    this.hiddenEdges.visible = this.showHidden && data.hiddenEdges.positions.length > 0;
    this.backEdges.geometry = this.edges.geometry;
    this.backEdges.visible = this.edges.visible;
    this.faceRanges = data.faceRanges;
    this.versionRef = sketch.version;
    this.sketchRef = sketch;
    this.builtShowHidden = this.showHidden;
    this.applySelection();
  }

  /** Rebuild when the `version` token changes (object identity) or the hidden mode flipped. */
  needsUpdate(sketch: RenderSketch): boolean {
    return sketch.version !== this.versionRef || this.showHidden !== this.builtShowHidden;
  }

  /** Hidden-geometry mode; the next `update` rebuilds (hidden faces/edges are added or dropped). */
  setShowHidden(on: boolean): boolean {
    if (this.showHidden === on) return false;
    this.showHidden = on;
    return true;
  }

  /** Tint the given faces via the shared `flags` attribute. */
  setSelectedFaces(ids: ReadonlySet<number>): void {
    this.selectedFaces = new Set(ids);
    this.applySelection();
  }

  private applySelection(): void {
    const g = this.front.geometry;
    fillFlags(g, 0);
    for (const id of this.selectedFaces) {
      const r = this.faceRanges.get(id);
      if (r) fillFlags(g, 1, r[0], r[1]);
    }
  }

  dispose(): void {
    this.front.geometry.dispose();
    this.back.geometry.dispose();
    this.edges.geometry.dispose();
    this.hiddenEdges.geometry.dispose();
  }
}
