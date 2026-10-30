// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { basisToLocal, basisToWorld, LENGTH_TOL } from '@pushform/core';
import type { MaterialId, PlaneBasis, Vec2, Vec3 } from '@pushform/core';
import type { Material, UvMapping } from './entities/attrs';

/**
 * Texture coordinate math. A face's `UvMapping` maps face-basis coordinates (u, v) in meters to
 * texture coordinates (s, t) in tiles: `auto` = (u / widthM, v / heightM); `affine` = the 2×3
 * matrix `[a, b, c, d, e, f]` with `s = a·u + b·v + c`, `t = d·u + e·v + f` (texture pins);
 * `projective` = a 3×3 matrix whose rows give (s', t', q) with s = s'/q, t = t'/q (distorted pins);
 * `sized` = a 2×3 matrix to texture-frame meters, divided by the texture size like `auto`.
 */

export type UvAffine = readonly [number, number, number, number, number, number];

export const UV_IDENTITY: UvAffine = [1, 0, 0, 0, 1, 0];

/** The affine form of the automatic mapping for a texture of `widthM × heightM`. */
export function uvAutoAffine(widthM: number, heightM: number): UvAffine {
  const w = widthM > 0 ? widthM : 1, h = heightM > 0 ? heightM : 1;
  return [1 / w, 0, 0, 0, 1 / h, 0];
}

/**
 * Any mapping as an affine matrix (auto and sized resolved with the texture size). A projective mapping gives the
 * affine map that agrees with it at the face basis origin and one meter along each axis.
 */
export function uvToAffine(uv: UvMapping, widthM: number, heightM: number): UvAffine {
  switch (uv.kind) {
    case 'affine':
      return uv.matrix;
    case 'sized':
      return uvCompose(uvAutoAffine(widthM, heightM), uv.matrix);
    case 'projective': {
      const at = (u: number, v: number): Vec2 => uvApplyProjective(uv.matrix, u, v);
      return uvAffineFromPoints([[0, 0], [1, 0], [0, 1]], [at(0, 0), at(1, 0), at(0, 1)]) ?? uvAutoAffine(widthM, heightM);
    }
    default:
      return uvAutoAffine(widthM, heightM);
  }
}

/** A 3×3 projective map, row-major: (s', t', q) = rows · (u, v, 1); the point is (s'/q, t'/q). */
export type UvProjective = readonly [number, number, number, number, number, number, number, number, number];

/** Any mapping as a projective matrix in tiles (auto and sized resolved with the texture size). */
export function uvToProjective(uv: UvMapping, widthM: number, heightM: number): UvProjective {
  if (uv.kind === 'projective') return uv.matrix;
  const m = uvToAffine(uv, widthM, heightM);
  return [m[0], m[1], m[2], m[3], m[4], m[5], 0, 0, 1];
}

export function uvApplyProjective(m: UvProjective, u: number, v: number): Vec2 {
  const q = m[6] * u + m[7] * v + m[8];
  return [(m[0] * u + m[1] * v + m[2]) / q, (m[3] * u + m[4] * v + m[5]) / q];
}

/** Texture coordinates in tiles of face-basis point (u, v) under any mapping, for a side showing a `widthM × heightM` texture. */
export function uvAt(uv: UvMapping, widthM: number, heightM: number, u: number, v: number): Vec2 {
  return uv.kind === 'projective' ? uvApplyProjective(uv.matrix, u, v) : uvApply(uvToAffine(uv, widthM, heightM), u, v);
}

/** `p ∘ a`: the affine map `a` first, then the projective `p`. */
export function uvProjectiveCompose(p: UvProjective, a: UvAffine): UvProjective {
  const row = (r: number): [number, number, number] => [
    p[r]! * a[0] + p[r + 1]! * a[3],
    p[r]! * a[1] + p[r + 1]! * a[4],
    p[r]! * a[2] + p[r + 1]! * a[5] + p[r + 2]!,
  ];
  return [...row(0), ...row(3), ...row(6)];
}

/** Inverse of a projective map, or null when singular. */
export function uvProjectiveInvert(m: UvProjective): UvProjective | null {
  const inv = invert3([...m]);
  return inv && inv.every(Number.isFinite) ? (inv as unknown as UvProjective) : null;
}

/** A projective matrix as a mapping: affine when it divides by a constant, else projective. */
export function uvProjectiveMapping(m: UvProjective): UvMapping {
  if (Math.abs(m[6]) <= 1e-12 && Math.abs(m[7]) <= 1e-12 && m[8] !== 0) {
    const k = m[8];
    return { kind: 'affine', matrix: [m[0] / k, m[1] / k, m[2] / k, m[3] / k, m[4] / k, m[5] / k] };
  }
  return { kind: 'projective', matrix: [...m] as unknown as UvProjective };
}

/**
 * The projective map sending the four `src` points to the four `dst` points (a four-pin placement), or null when
 * either quadrilateral is degenerate.
 */
export function uvProjectiveFromPoints(src: readonly [Vec2, Vec2, Vec2, Vec2], dst: readonly [Vec2, Vec2, Vec2, Vec2]): UvProjective | null {
  const s = squareToQuad(src), d = squareToQuad(dst);
  const si = s && invert3([...s]);
  if (!d || !si) return null;
  const m: number[] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) m.push(d[r * 3]! * si[c]! + d[r * 3 + 1]! * si[3 + c]! + d[r * 3 + 2]! * si[6 + c]!);
  const k = m[8]!;
  if (!m.every(Number.isFinite) || Math.abs(k) < 1e-18) return null;
  return m.map((x) => x / k) as unknown as UvProjective;
}

/** The projective map of the unit square's corners (0,0), (1,0), (1,1), (0,1) onto `p` (Heckbert). */
function squareToQuad(p: readonly [Vec2, Vec2, Vec2, Vec2]): UvProjective | null {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = p;
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  if (Math.abs(sx) < 1e-15 && Math.abs(sy) < 1e-15) return [x1 - x0, x3 - x0, x0, y1 - y0, y3 - y0, y0, 0, 0, 1];
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
  const det = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(det) < 1e-18) return null;
  const g = (sx * dy2 - dx2 * sy) / det, h = (dx1 * sy - sx * dy1) / det;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}

export function uvApply(m: UvAffine, u: number, v: number): Vec2 {
  return [m[0] * u + m[1] * v + m[2], m[3] * u + m[4] * v + m[5]];
}

/** Inverse of an affine 2×3 matrix, or null when singular. */
export function uvInvert(m: UvAffine): UvAffine | null {
  const det = m[0] * m[4] - m[1] * m[3];
  if (Math.abs(det) < 1e-18) return null;
  const ia = m[4] / det, ib = -m[1] / det, id = -m[3] / det, ie = m[0] / det;
  return [ia, ib, -(ia * m[2] + ib * m[5]), id, ie, -(id * m[2] + ie * m[5])];
}

/** `a ∘ b`: apply `b` first, then `a`. */
export function uvCompose(a: UvAffine, b: UvAffine): UvAffine {
  return [
    a[0] * b[0] + a[1] * b[3],
    a[0] * b[1] + a[1] * b[4],
    a[0] * b[2] + a[1] * b[5] + a[2],
    a[3] * b[0] + a[4] * b[3],
    a[3] * b[1] + a[4] * b[4],
    a[3] * b[2] + a[4] * b[5] + a[5],
  ];
}

export function uvTranslation(dx: number, dy: number): UvAffine {
  return [1, 0, dx, 0, 1, dy];
}

/** Affine map sending the three `src` points to the three `dst` points, or null when degenerate. */
export function uvAffineFromPoints(src: readonly [Vec2, Vec2, Vec2], dst: readonly [Vec2, Vec2, Vec2]): UvAffine | null {
  // Solve for the map M with M(src_i) = dst_i: M = D · S⁻¹ in homogeneous 3×3 form.
  const [s0, s1, s2] = src;
  const det = (s1[0] - s0[0]) * (s2[1] - s0[1]) - (s2[0] - s0[0]) * (s1[1] - s0[1]);
  if (Math.abs(det) < 1e-18) return null;
  const [d0, d1, d2] = dst;
  // Linear part L maps (s1-s0, s2-s0) → (d1-d0, d2-d0).
  const ax = s1[0] - s0[0], ay = s1[1] - s0[1], bx = s2[0] - s0[0], by = s2[1] - s0[1];
  const px = d1[0] - d0[0], py = d1[1] - d0[1], qx = d2[0] - d0[0], qy = d2[1] - d0[1];
  // L · [ax bx; ay by] = [px qx; py qy]  →  L = [px qx; py qy] · inv([ax bx; ay by])
  const i00 = by / det, i01 = -bx / det, i10 = -ay / det, i11 = ax / det;
  const a = px * i00 + qx * i10, b = px * i01 + qx * i11;
  const d = py * i00 + qy * i10, e = py * i01 + qy * i11;
  return [a, b, d0[0] - a * s0[0] - b * s0[1], d, e, d0[1] - d * s0[0] - e * s0[1]];
}

/** Least-squares affine map from ≥ 3 point pairs (used to store a 4-pin distort as a best-fit affine). */
export function uvAffineLeastSquares(src: readonly Vec2[], dst: readonly Vec2[]): UvAffine | null {
  const n = Math.min(src.length, dst.length);
  if (n < 3) return null;
  // Normal equations for [u v 1] · [a d; b e; c f] = [s t]
  let suu = 0, suv = 0, su = 0, svv = 0, sv = 0;
  let sus = 0, svs = 0, ss = 0, sut = 0, svt = 0, st = 0;
  for (let i = 0; i < n; i++) {
    const [u, v] = src[i]!, [s, t] = dst[i]!;
    suu += u * u; suv += u * v; su += u; svv += v * v; sv += v;
    sus += u * s; svs += v * s; ss += s; sut += u * t; svt += v * t; st += t;
  }
  const A = [suu, suv, su, suv, svv, sv, su, sv, n];
  const inv = invert3(A);
  if (!inv) return null;
  const mul = (x: number, y: number, z: number): [number, number, number] => [
    inv[0]! * x + inv[1]! * y + inv[2]! * z,
    inv[3]! * x + inv[4]! * y + inv[5]! * z,
    inv[6]! * x + inv[7]! * y + inv[8]! * z,
  ];
  const [a, b, c] = mul(sus, svs, ss);
  const [d, e, f] = mul(sut, svt, st);
  return [a, b, c, d, e, f];
}

function invert3(m: number[]): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-18) return null;
  return [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ];
}

export function uvMappingEquals(a: UvMapping, b: UvMapping): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'auto' || b.kind === 'auto') return true;
  if (a.matrix.length !== b.matrix.length) return false;
  for (let i = 0; i < a.matrix.length; i++) if (a.matrix[i] !== b.matrix[i]) return false;
  return true;
}

/** A copy of a mapping that shares no array with it. */
export function uvClone(uv: UvMapping): UvMapping {
  return uv.kind === 'auto' ? uv : ({ kind: uv.kind, matrix: [...uv.matrix] } as UvMapping);
}

/** Size of one texture tile in meters (a material texture's `widthM × heightM`). */
export interface UvTileSize {
  readonly widthM: number;
  readonly heightM: number;
}

/** Texture tile a material shows (null for none), for re-expressing texture placements. */
export type TextureTileOf = (id: MaterialId | null) => UvTileSize | null;

/** `TextureTileOf` over a document's (or draft's) materials. */
export function textureTiles(state: { readonly materials: ReadonlyMap<MaterialId, Material> }): TextureTileOf {
  return (id) => (id === null ? null : (state.materials.get(id)?.texture ?? null));
}

/**
 * `uv`, a mapping in face basis `from`, re-expressed in basis `to` so every point of the face keeps
 * its texture coordinates after it moves by `point` (identity by default; the moved point is
 * projected onto the plane of `to`). An affine, projective or sized mapping is composed with the
 * change of basis and keeps its kind. An automatic one stays automatic when the bases agree;
 * otherwise it becomes the affine mapping of `tile`, the texture the side shows, or stays automatic
 * when the side shows no texture. A degenerate change of basis leaves `uv` unchanged.
 */
export function uvRebase(uv: UvMapping, from: PlaneBasis, to: PlaneBasis, tile: UvTileSize | null, point: (p: Vec3) => Vec3 = (p) => p): UvMapping {
  const src: [Vec2, Vec2, Vec2] = [[0, 0], [1, 0], [0, 1]];
  const local = (q: Vec2): Vec2 => {
    const l = basisToLocal(to, point(basisToWorld(from, q[0], q[1])));
    return [l[0], l[1]];
  };
  const change = uvAffineFromPoints(src, [local(src[0]), local(src[1]), local(src[2])]);
  if (!change) return uv;
  if (change.every((x, i) => Math.abs(x - UV_IDENTITY[i]!) <= LENGTH_TOL)) return uv;
  if (uv.kind === 'auto' && !tile) return uv;
  const back = uvInvert(change);
  if (!back) return uv;
  if (uv.kind === 'projective') return { kind: 'projective', matrix: uvProjectiveCompose(uv.matrix, back) };
  if (uv.kind === 'sized') {
    const s = uvCompose(uv.matrix, back);
    return { kind: 'sized', matrix: [s[0], s[1], s[2], s[3], s[4], s[5]] };
  }
  const m = uvCompose(uvToAffine(uv, tile?.widthM ?? 1, tile?.heightM ?? 1), back);
  return { kind: 'affine', matrix: [m[0], m[1], m[2], m[3], m[4], m[5]] };
}

/**
 * Both sides of a face rebased with `uvRebase`: `front`/`back` are the textures each side shows
 * (null for none). `uvBack` is returned only where the back no longer follows `uv`.
 */
export function uvRebaseSides(
  face: { readonly uv: UvMapping; readonly uvBack?: UvMapping | undefined },
  from: PlaneBasis,
  to: PlaneBasis,
  front: UvTileSize | null,
  back: UvTileSize | null,
  point?: (p: Vec3) => Vec3,
): { uv: UvMapping; uvBack: UvMapping | undefined } {
  const uv = uvRebase(face.uv, from, to, front, point);
  const uvBack = uvRebase(face.uvBack ?? face.uv, from, to, back, point);
  return { uv, uvBack: face.uvBack || !uvMappingEquals(uv, uvBack) ? uvBack : undefined };
}
