// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { LENGTH_TOL, basisToLocal, m4transformPoint } from '@pushform/core';
import type { Mat4, MeshData, Vec3 } from '@pushform/core';
import { BufferAttribute, BufferGeometry, Color } from 'three';
import { EDGE_FLAG_BOUNDARY, EDGE_FLAG_HIDDEN, EDGE_FLAG_SMOOTH, EDGE_FLAG_SOFT, cssToRgb, edgeStyleFlags } from '../types';
import { palette } from './palette';
import type { EdgeSegments, RenderBodyEdge, RenderBodySurface, RenderFaceGroup, RenderFaceMaterial, RenderMaterial, RenderUvMapping } from '../types';

export interface FaceGeometryOptions {
  /**
   * Smooth face groups: triangles of these faces get per-vertex normals averaged over the group's
   * triangles sharing a vertex position (welded by position within the group only), so the sides
   * of an extruded circle shade smoothly while edges to faces outside the group stay hard.
   */
  readonly smoothGroups?: ReadonlyArray<RenderBodySurface> | undefined;
  /**
   * Per-face materials: fills the per-vertex front/back colors and `uv`s and sorts triangles so
   * faces needing their own material (texture, opacity) form contiguous draw groups.
   */
  readonly faceMaterials?: ReadonlyMap<number, RenderFaceMaterial> | undefined;
  /** CSS color of faces without a material (body / instance default); undefined = style colors. */
  readonly defaultColor?: string | undefined;
  readonly hiddenFaces?: ReadonlySet<number> | undefined;
}

/** Plain-array output of `buildFaceArrays` (testable without a GPU). */
export interface FaceArrays {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly faceIds: Float32Array;
  readonly flags: Uint8Array;
  /** Per-vertex RGB of the front / back side (material color, else the default / style color). */
  readonly frontColors: Float32Array;
  readonly backColors: Float32Array;
  /** Per-vertex texture coordinates in tiles (0 for faces without a material entry). */
  readonly uvs: Float32Array;
  /** The same for the back side (its own mapping and texture size). */
  readonly uvsBack: Float32Array;
  /** Per-vertex projective divisor minus one (`uvq`, 0 for undistorted placements), front and back. */
  readonly uvqs: Float32Array;
  readonly uvqsBack: Float32Array;
  /** Vertex ranges per front / back material; empty when no face needs its own material. */
  readonly frontGroups: readonly RenderFaceGroup[];
  readonly backGroups: readonly RenderFaceGroup[];
}

/**
 * Texture coordinates in tiles of the face-basis point (u, v) meters: `affine` applies its matrix,
 * `auto` divides by the side's texture size, `sized` maps to the texture frame first. Written to
 * `out[at]`, `out[at + 1]`. A `projective` mapping writes (s', t') there and q − 1 to `q[qAt]`
 * (the `uvq` attribute); the face shader divides by q per fragment, so a distorted placement is
 * exact across the triangle. Other mappings write 0 there.
 */
export function writeFaceUv(out: { [i: number]: number }, at: number, uv: RenderUvMapping, tex: RenderMaterial | null | undefined, u: number, v: number,
  q?: { [i: number]: number }, qAt = 0): void {
  if (q) q[qAt] = 0;
  if (uv.kind === 'affine' || uv.kind === 'projective') {
    const m = uv.matrix;
    out[at] = m[0] * u + m[1] * v + m[2];
    out[at + 1] = m[3] * u + m[4] * v + m[5];
    if (uv.kind === 'projective' && q) q[qAt] = uv.matrix[6] * u + uv.matrix[7] * v + uv.matrix[8] - 1;
    return;
  }
  const x = uv.kind === 'sized' ? uv.matrix[0] * u + uv.matrix[1] * v + uv.matrix[2] : u;
  const y = uv.kind === 'sized' ? uv.matrix[3] * u + uv.matrix[4] * v + uv.matrix[5] : v;
  out[at] = x / (tex?.widthM && tex.widthM > 0 ? tex.widthM : 1);
  out[at + 1] = y / (tex?.heightM && tex.heightM > 0 ? tex.heightM : 1);
}

/** A face side needs its own draw group when it has a texture or is translucent. */
export function faceMaterialNeedsGroup(m: RenderMaterial | null | undefined): boolean {
  return !!m && (!!m.textureUrl || m.alpha < 1);
}

/**
 * Unwelded face geometry (3 vertices per triangle) with flat normals and per-vertex `faceId` and
 * `flags` attributes. Positions are world coordinates relative to `origin` (floating origin).
 */
export function buildFaceGeometry(mesh: MeshData, transform: Mat4, origin: Vec3, opts: FaceGeometryOptions = {}): BufferGeometry {
  const a = buildFaceArrays(mesh, transform, origin, opts);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(a.positions, 3));
  g.setAttribute('normal', new BufferAttribute(a.normals, 3));
  g.setAttribute('faceId', new BufferAttribute(a.faceIds, 1));
  g.setAttribute('flags', new BufferAttribute(a.flags, 1));
  g.setAttribute('color', new BufferAttribute(a.frontColors, 3));
  g.setAttribute('uv', new BufferAttribute(a.uvs, 2));
  g.setAttribute('uvq', new BufferAttribute(a.uvqs, 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** The arrays behind `buildFaceGeometry`. */
export function buildFaceArrays(mesh: MeshData, transform: Mat4, origin: Vec3, opts: FaceGeometryOptions = {}): FaceArrays {
  if (opts.hiddenFaces?.size) {
    const triangles: number[] = [], faces: number[] = [];
    for (let i = 0; i < mesh.faceId.length; i++) {
      if (opts.hiddenFaces.has(mesh.faceId[i]!)) continue;
      triangles.push(mesh.tris[i * 3]!, mesh.tris[i * 3 + 1]!, mesh.tris[i * 3 + 2]!);
      faces.push(mesh.faceId[i]!);
    }
    mesh = { verts: mesh.verts, tris: Uint32Array.from(triangles), faceId: Uint32Array.from(faces) };
  }
  const triCount = mesh.tris.length / 3;
  const positions = new Float32Array(triCount * 9);
  const normals = new Float32Array(triCount * 9);
  const faceIds = new Float32Array(triCount * 3);
  const flags = new Uint8Array(triCount * 3);
  const world = transformedVerts(mesh, transform, origin);
  for (let t = 0; t < triCount; t++) {
    const ia = mesh.tris[t * 3]!,
      ib = mesh.tris[t * 3 + 1]!,
      ic = mesh.tris[t * 3 + 2]!;
    const ax = world[ia * 3]!, ay = world[ia * 3 + 1]!, az = world[ia * 3 + 2]!;
    const bx = world[ib * 3]!, by = world[ib * 3 + 1]!, bz = world[ib * 3 + 2]!;
    const cx = world[ic * 3]!, cy = world[ic * 3 + 1]!, cz = world[ic * 3 + 2]!;
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const o = t * 9;
    positions[o] = ax; positions[o + 1] = ay; positions[o + 2] = az;
    positions[o + 3] = bx; positions[o + 4] = by; positions[o + 5] = bz;
    positions[o + 6] = cx; positions[o + 7] = cy; positions[o + 8] = cz;
    for (let k = 0; k < 3; k++) {
      normals[o + k * 3] = nx; normals[o + k * 3 + 1] = ny; normals[o + k * 3 + 2] = nz;
      faceIds[t * 3 + k] = mesh.faceId[t] ?? 0;
    }
  }
  if (opts.smoothGroups && opts.smoothGroups.length) applySmoothNormals(mesh, world, normals, opts.smoothGroups);
  const colored = buildFaceColors(mesh, opts);
  if (!colored.order) return { positions, normals, faceIds, flags, ...colored.arrays, frontGroups: [], backGroups: [] };
  // Permute every per-triangle array into material order so each material's triangles are contiguous.
  const order = colored.order;
  const perm = <T extends Float32Array | Uint8Array>(src: T, stride: number): T => {
    const out = new (src.constructor as new (n: number) => T)(src.length);
    for (let i = 0; i < order.length; i++) {
      const from = order[i]! * stride, to = i * stride;
      for (let k = 0; k < stride; k++) out[to + k] = src[from + k]!;
    }
    return out;
  };
  return {
    positions: perm(positions, 9),
    normals: perm(normals, 9),
    faceIds: perm(faceIds, 3),
    flags: perm(flags, 3),
    frontColors: perm(colored.arrays.frontColors, 9),
    backColors: perm(colored.arrays.backColors, 9),
    uvs: perm(colored.arrays.uvs, 6),
    uvsBack: perm(colored.arrays.uvsBack, 6),
    uvqs: perm(colored.arrays.uvqs, 3),
    uvqsBack: perm(colored.arrays.uvqsBack, 3),
    frontGroups: colored.frontGroups,
    backGroups: colored.backGroups,
  };
}

interface FaceColorArrays {
  readonly frontColors: Float32Array;
  readonly backColors: Float32Array;
  readonly uvs: Float32Array;
  readonly uvsBack: Float32Array;
  readonly uvqs: Float32Array;
  readonly uvqsBack: Float32Array;
}

/**
 * Per-vertex colors and uvs in mesh triangle order, plus (when some face needs its own material)
 * the triangle order that groups faces by their (front, back) material pair and the resulting
 * front/back draw groups. Default-material triangles come first (one shared group).
 */
function buildFaceColors(mesh: MeshData, opts: FaceGeometryOptions): { arrays: FaceColorArrays; order: Uint32Array | null; frontGroups: RenderFaceGroup[]; backGroups: RenderFaceGroup[] } {
  const triCount = mesh.tris.length / 3;
  const frontColors = new Float32Array(triCount * 9);
  const backColors = new Float32Array(triCount * 9);
  const uvs = new Float32Array(triCount * 6);
  const uvsBack = new Float32Array(triCount * 6);
  const uvqs = new Float32Array(triCount * 3);
  const uvqsBack = new Float32Array(triCount * 3);
  const def = opts.defaultColor ? new Color(opts.defaultColor) : null;
  // Faces without a material show the style's front and back colors.
  const front = def ?? palette.front;
  const back = def ?? palette.back;
  const colorCache = new Map<string, Color>();
  const colorOf = (css: string): Color => {
    let c = colorCache.get(css);
    if (!c) colorCache.set(css, (c = new Color(css)));
    return c;
  };
  const fm = opts.faceMaterials;
  // Triangle ids bucketed by material-pair key in one pass ('' = shared default, always first;
  // other pairs in order of first appearance), plus the materials behind each key. Each bucket
  // keeps mesh triangle order, so the concatenation is a stable sort by pair.
  const shared: number[] = [];
  const buckets = new Map<string, { front: RenderMaterial | null; back: RenderMaterial | null; tris: number[] }>();
  let anyGroup = false;
  for (let t = 0; t < triCount; t++) {
    const faceId = mesh.faceId[t] ?? 0;
    const entry = fm?.get(faceId);
    const fc = entry?.front ? colorOf(entry.front.color) : front;
    const bc = entry?.back ? colorOf(entry.back.color) : back;
    const o = t * 9;
    for (let k = 0; k < 3; k++) {
      frontColors[o + k * 3] = fc.r; frontColors[o + k * 3 + 1] = fc.g; frontColors[o + k * 3 + 2] = fc.b;
      backColors[o + k * 3] = bc.r; backColors[o + k * 3 + 1] = bc.g; backColors[o + k * 3 + 2] = bc.b;
    }
    if (entry) {
      // Each side uses its own texture size; an untextured side follows the textured one.
      const tex = entry.front?.textureUrl ? entry.front : entry.back?.textureUrl ? entry.back : entry.front ?? entry.back;
      const frontTex = entry.front?.textureUrl ? entry.front : tex, backTex = entry.back?.textureUrl ? entry.back : tex;
      const backUv = entry.uvBack ?? entry.uv;
      for (let k = 0; k < 3; k++) {
        const vi = mesh.tris[t * 3 + k]!;
        const l = basisToLocal(entry.basis, [mesh.verts[vi * 3]!, mesh.verts[vi * 3 + 1]!, mesh.verts[vi * 3 + 2]!]);
        writeFaceUv(uvs, t * 6 + k * 2, entry.uv, frontTex, l[0], l[1], uvqs, t * 3 + k);
        writeFaceUv(uvsBack, t * 6 + k * 2, backUv, backTex, l[0], l[1], uvqsBack, t * 3 + k);
      }
    }
    const fOwn = faceMaterialNeedsGroup(entry?.front), bOwn = faceMaterialNeedsGroup(entry?.back);
    if (fOwn || bOwn) {
      anyGroup = true;
      const key = `${fOwn ? entry!.front!.id : '-'}|${bOwn ? entry!.back!.id : '-'}`;
      let bucket = buckets.get(key);
      if (!bucket) buckets.set(key, (bucket = { front: fOwn ? entry!.front : null, back: bOwn ? entry!.back : null, tris: [] }));
      bucket.tris.push(t);
    } else shared.push(t);
  }
  const arrays = { frontColors, backColors, uvs, uvsBack, uvqs, uvqsBack };
  if (!anyGroup) return { arrays, order: null, frontGroups: [], backGroups: [] };
  const order = new Uint32Array(triCount);
  let n = 0;
  const frontGroups: RenderFaceGroup[] = [];
  const backGroups: RenderFaceGroup[] = [];
  const emit = (tris: readonly number[], front: RenderMaterial | null, back: RenderMaterial | null) => {
    if (tris.length === 0) return;
    const start = n * 3, count = tris.length * 3;
    for (const t of tris) order[n++] = t;
    frontGroups.push({ start, count, material: front });
    backGroups.push({ start, count, material: back });
  };
  emit(shared, null, null);
  for (const b of buckets.values()) emit(b.tris, b.front, b.back);
  return { arrays, order, frontGroups, backGroups };
}

/**
 * Overwrite the flat normals of triangles belonging to a smooth group with area-weighted normals
 * accumulated over that group's triangles at the same (quantized) vertex position. Vertices on the
 * group boundary only average the group's own triangles, so adjacent hard faces keep flat shading.
 */
function applySmoothNormals(mesh: MeshData, world: Float64Array, normals: Float32Array, groups: ReadonlyArray<RenderBodySurface>): void {
  const groupOf = new Map<number, number>();
  groups.forEach((g, gi) => {
    for (const f of g.faceIds) groupOf.set(f, gi);
  });
  if (groupOf.size === 0) return;
  const triCount = mesh.tris.length / 3;
  const inv = 1 / LENGTH_TOL;
  const keyOf = (gi: number, v: number) =>
    `${gi}|${Math.round(world[v * 3]! * inv)},${Math.round(world[v * 3 + 1]! * inv)},${Math.round(world[v * 3 + 2]! * inv)}`;
  const acc = new Map<string, [number, number, number]>();
  const triGroup = new Int32Array(triCount).fill(-1);
  for (let t = 0; t < triCount; t++) {
    const gi = groupOf.get(mesh.faceId[t] ?? 0);
    if (gi === undefined) continue;
    triGroup[t] = gi;
    const ia = mesh.tris[t * 3]!, ib = mesh.tris[t * 3 + 1]!, ic = mesh.tris[t * 3 + 2]!;
    const ax = world[ia * 3]!, ay = world[ia * 3 + 1]!, az = world[ia * 3 + 2]!;
    const e1x = world[ib * 3]! - ax, e1y = world[ib * 3 + 1]! - ay, e1z = world[ib * 3 + 2]! - az;
    const e2x = world[ic * 3]! - ax, e2y = world[ic * 3 + 1]! - ay, e2z = world[ic * 3 + 2]! - az;
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const l = Math.hypot(nx, ny, nz);
    if (l === 0) continue;
    nx /= l; ny /= l; nz /= l;
    // Angle-weighted normals: each triangle contributes by its corner angle, so the result does
    // not depend on how the faces were triangulated (a quad's diagonal would otherwise bias it).
    const bx = world[ib * 3]!, by = world[ib * 3 + 1]!, bz = world[ib * 3 + 2]!;
    const cx = world[ic * 3]!, cy = world[ic * 3 + 1]!, cz = world[ic * 3 + 2]!;
    const corners: [number, number][] = [
      [ia, cornerAngle(ax, ay, az, bx, by, bz, cx, cy, cz)],
      [ib, cornerAngle(bx, by, bz, cx, cy, cz, ax, ay, az)],
      [ic, cornerAngle(cx, cy, cz, ax, ay, az, bx, by, bz)],
    ];
    for (const [v, w] of corners) {
      const k = keyOf(gi, v);
      const a = acc.get(k);
      if (a) {
        a[0] += nx * w; a[1] += ny * w; a[2] += nz * w;
      } else acc.set(k, [nx * w, ny * w, nz * w]);
    }
  }
  for (let t = 0; t < triCount; t++) {
    const gi = triGroup[t]!;
    if (gi < 0) continue;
    for (let k = 0; k < 3; k++) {
      const v = mesh.tris[t * 3 + k]!;
      const a = acc.get(keyOf(gi, v));
      if (!a) continue;
      const l = Math.hypot(a[0], a[1], a[2]);
      if (l === 0) continue;
      const o = t * 9 + k * 3;
      normals[o] = a[0] / l; normals[o + 1] = a[1] / l; normals[o + 2] = a[2] / l;
    }
  }
}

/** Vertex positions transformed to world space minus `origin` (Float64 for the edge pass). */
export function transformedVerts(mesh: MeshData, transform: Mat4, origin: Vec3): Float64Array {
  const n = mesh.verts.length / 3;
  const out = new Float64Array(n * 3);
  const identity = isIdentity(transform);
  for (let i = 0; i < n; i++) {
    const x = mesh.verts[i * 3]!, y = mesh.verts[i * 3 + 1]!, z = mesh.verts[i * 3 + 2]!;
    if (identity) {
      out[i * 3] = x - origin[0];
      out[i * 3 + 1] = y - origin[1];
      out[i * 3 + 2] = z - origin[2];
    } else {
      const p = m4transformPoint(transform, [x, y, z]);
      out[i * 3] = p[0] - origin[0];
      out[i * 3 + 1] = p[1] - origin[1];
      out[i * 3 + 2] = p[2] - origin[2];
    }
  }
  return out;
}

function isIdentity(m: Mat4): boolean {
  for (let i = 0; i < 16; i++) {
    const expect = i % 5 === 0 ? 1 : 0;
    if (m[i] !== expect) return false;
  }
  return true;
}

/**
 * Extract edge segments to draw: every triangle edge shared by two different faceIds (or on the
 * open boundary), with collinear runs per faceId pair merged into single segments.
 * Returns a flat Float32Array of [x1,y1,z1,x2,y2,z2,...] for LineSegmentsGeometry.
 */
export function extractEdges(mesh: MeshData, world: Float64Array): Float32Array {
  return extractEdgeSegments(mesh, world).positions;
}

/**
 * Like `extractEdges` but also returns the unit normals of the two faces adjacent to each segment
 * (for the profile pass) and a BOUNDARY flag for open-boundary segments.
 */
export function extractEdgeSegments(mesh: MeshData, world: Float64Array): EdgeSegments {
  const triCount = mesh.tris.length / 3;
  const vertCount = mesh.verts.length / 3;
  // edge key → [faceA, faceB|-1]
  const edgeFaces = new Map<number, [number, number]>();
  const key = (a: number, b: number) => (a < b ? a * vertCount + b : b * vertCount + a);
  const faceNormals = meshFaceNormals(mesh, world);
  for (let t = 0; t < triCount; t++) {
    const f = mesh.faceId[t] ?? 0;
    for (let k = 0; k < 3; k++) {
      const a = mesh.tris[t * 3 + k]!, b = mesh.tris[t * 3 + ((k + 1) % 3)]!;
      const e = key(a, b);
      const cur = edgeFaces.get(e);
      if (!cur) edgeFaces.set(e, [f, -1]);
      else if (cur[1] === -1 && cur[0] !== f) cur[1] = f;
      else if (cur[0] === f || cur[1] === f) {
        // same face on both sides (interior triangulation edge) → not drawn
        if (cur[1] === -1) cur[1] = f;
      }
    }
  }
  // Group drawable segments by face pair.
  const groups = new Map<string, { fa: number; fb: number; segs: { a: number; b: number }[] }>();
  for (const [e, [fa, fb]] of edgeFaces) {
    if (fb !== -1 && fa === fb) continue;
    const a = Math.floor(e / vertCount), b = e % vertCount;
    const lo = Math.min(fa, fb), hi = Math.max(fa, fb);
    const gk = `${lo}:${hi}`;
    let g = groups.get(gk);
    if (!g) groups.set(gk, (g = { fa, fb, segs: [] }));
    g.segs.push({ a, b });
  }
  const pos: number[] = [];
  const nA: number[] = [];
  const nB: number[] = [];
  const flags: number[] = [];
  const px = (i: number) => world[i * 3]!, py = (i: number) => world[i * 3 + 1]!, pz = (i: number) => world[i * 3 + 2]!;
  for (const { fa, fb, segs } of groups.values()) {
    mergeCollinear(segs, px, py, pz);
    const na = faceNormals.get(fa) ?? [0, 0, 1];
    const nb = fb === -1 ? null : (faceNormals.get(fb) ?? [0, 0, 1]);
    for (const s of segs) {
      pos.push(px(s.a), py(s.a), pz(s.a), px(s.b), py(s.b), pz(s.b));
      nA.push(na[0], na[1], na[2]);
      if (nb) {
        nB.push(nb[0], nb[1], nb[2]);
        flags.push(0);
      } else {
        nB.push(0, 0, 0);
        flags.push(EDGE_FLAG_BOUNDARY);
      }
    }
  }
  return {
    positions: new Float32Array(pos),
    normalA: new Float32Array(nA),
    normalB: new Float32Array(nB),
    flags: new Uint8Array(flags),
  };
}

/** Angle at p between the directions to q and r. */
export function cornerAngle(px: number, py: number, pz: number, qx: number, qy: number, qz: number, rx: number, ry: number, rz: number): number {
  const ux = qx - px, uy = qy - py, uz = qz - pz;
  const vx = rx - px, vy = ry - py, vz = rz - pz;
  const d = (ux * vx + uy * vy + uz * vz) / ((Math.hypot(ux, uy, uz) || 1) * (Math.hypot(vx, vy, vz) || 1));
  return Math.acos(Math.max(-1, Math.min(1, d)));
}

/** Unit normal per faceId (from the first non-degenerate triangle of each face), in `world` space. */
export function meshFaceNormals(mesh: MeshData, world: Float64Array): Map<number, [number, number, number]> {
  const out = new Map<number, [number, number, number]>();
  const triCount = mesh.tris.length / 3;
  for (let t = 0; t < triCount; t++) {
    const f = mesh.faceId[t] ?? 0;
    if (out.has(f)) continue;
    const n = triangleNormal(mesh, world, t);
    if (n) out.set(f, n);
  }
  return out;
}

export interface BodyEdgeSegments {
  /** Edges drawn solid (normal/profile width decided on the GPU). */
  readonly edges: EdgeSegments;
  /** Soft/hidden edges, drawn dashed only in hidden-geometry mode (empty when not shown). */
  readonly hiddenEdges: EdgeSegments;
}

/**
 * Edge segments from body edge records (polylines with flags and the adjacent face pair), with
 * the same flag semantics as sketch edges: soft and hidden edges are omitted unless `showHidden`,
 * in which case they go to the dashed batch. Profiles use the two face normals (`faceNormals`
 * from `meshFaceNormals`); an edge whose second face is unknown is flagged as a boundary.
 * Points are body-local and are mapped through `transform` minus `origin`.
 */
export function buildBodyEdgeSegments(
  edges: ReadonlyArray<RenderBodyEdge>,
  faceNormals: ReadonlyMap<number, readonly [number, number, number]>,
  transform: Mat4,
  origin: Vec3,
  opts: { readonly showHidden?: boolean | undefined } = {},
): BodyEdgeSegments {
  const showHidden = opts.showHidden ?? false;
  const identity = isIdentity(transform);
  const vis = { pos: [] as number[], nA: [] as number[], nB: [] as number[], flags: [] as number[], colors: [] as number[] };
  const hid = { pos: [] as number[], nA: [] as number[], nB: [] as number[], flags: [] as number[], colors: [] as number[] };
  const map = (p: Vec3): [number, number, number] => {
    const q = identity ? p : m4transformPoint(transform, p);
    return [q[0] - origin[0], q[1] - origin[1], q[2] - origin[2]];
  };
  for (const e of edges) {
    const concealed = e.hidden || e.soft;
    if (concealed && !showHidden) continue;
    if (e.points.length < 2) continue;
    const out = concealed ? hid : vis;
    let flags = (e.soft ? EDGE_FLAG_SOFT : 0) | (e.smooth ? EDGE_FLAG_SMOOTH : 0) | (e.hidden ? EDGE_FLAG_HIDDEN : 0) | edgeStyleFlags(e);
    const rgb = cssToRgb(e.color);
    const na = faceNormals.get(e.faceA) ?? faceNormals.get(e.faceB) ?? [0, 0, 1];
    let nb: readonly [number, number, number] | undefined = faceNormals.get(e.faceB);
    if (!faceNormals.has(e.faceA) || !nb) {
      nb = [0, 0, 0];
      flags |= EDGE_FLAG_BOUNDARY;
    }
    for (let i = 0; i + 1 < e.points.length; i++) {
      const a = map(e.points[i]!), b = map(e.points[i + 1]!);
      out.pos.push(a[0], a[1], a[2], b[0], b[1], b[2]);
      out.nA.push(na[0], na[1], na[2]);
      out.nB.push(nb[0], nb[1], nb[2]);
      out.flags.push(flags);
      out.colors.push(rgb[0], rgb[1], rgb[2], rgb[0], rgb[1], rgb[2]);
    }
  }
  const pack = (o: typeof vis): EdgeSegments => ({
    positions: new Float32Array(o.pos),
    normalA: new Float32Array(o.nA),
    normalB: new Float32Array(o.nB),
    flags: new Uint8Array(o.flags),
    colors: new Float32Array(o.colors),
  });
  return { edges: pack(vis), hiddenEdges: pack(hid) };
}

function triangleNormal(mesh: MeshData, world: Float64Array, t: number): [number, number, number] | null {
  const ia = mesh.tris[t * 3]!, ib = mesh.tris[t * 3 + 1]!, ic = mesh.tris[t * 3 + 2]!;
  const ax = world[ia * 3]!, ay = world[ia * 3 + 1]!, az = world[ia * 3 + 2]!;
  const e1x = world[ib * 3]! - ax, e1y = world[ib * 3 + 1]! - ay, e1z = world[ib * 3 + 2]! - az;
  const e2x = world[ic * 3]! - ax, e2y = world[ic * 3 + 1]! - ay, e2z = world[ic * 3 + 2]! - az;
  const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
  const l = Math.hypot(nx, ny, nz);
  if (l === 0) return null;
  return [nx / l, ny / l, nz / l];
}

function mergeCollinear(
  segs: { a: number; b: number }[],
  px: (i: number) => number,
  py: (i: number) => number,
  pz: (i: number) => number,
): void {
  // vertex → segment indices (within this group)
  const atVertex = new Map<number, number[]>();
  const add = (v: number, i: number) => {
    const l = atVertex.get(v);
    if (l) l.push(i);
    else atVertex.set(v, [i]);
  };
  segs.forEach((s, i) => {
    add(s.a, i);
    add(s.b, i);
  });
  const alive = segs.map(() => true);
  const dir = (s: { a: number; b: number }): [number, number, number] => {
    const d: [number, number, number] = [px(s.b) - px(s.a), py(s.b) - py(s.a), pz(s.b) - pz(s.a)];
    const l = Math.hypot(d[0], d[1], d[2]) || 1;
    return [d[0] / l, d[1] / l, d[2] / l];
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const [v, list] of atVertex) {
      const live = list.filter((i) => alive[i]);
      if (live.length !== 2) continue;
      const i = live[0]!, j = live[1]!;
      const si = segs[i]!, sj = segs[j]!;
      const di = dir(si), dj = dir(sj);
      const cross = Math.hypot(di[1] * dj[2] - di[2] * dj[1], di[2] * dj[0] - di[0] * dj[2], di[0] * dj[1] - di[1] * dj[0]);
      if (cross > 1e-6) continue;
      // Merge j into i: endpoints are the two vertices that are not v.
      const otherI = si.a === v ? si.b : si.a;
      const otherJ = sj.a === v ? sj.b : sj.a;
      if (otherI === otherJ) continue;
      si.a = otherI;
      si.b = otherJ;
      alive[j] = false;
      add(otherJ, i);
      atVertex.set(v, []);
      changed = true;
    }
  }
  for (let i = segs.length - 1; i >= 0; i--) if (!alive[i]) segs.splice(i, 1);
}
