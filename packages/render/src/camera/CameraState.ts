// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import {
  box3Center,
  box3Size,
  m4rotationAxis,
  m4transformDir,
  v3add,
  v3addScaled,
  v3cross,
  v3dot,
  v3len,
  v3normalize,
  v3scale,
  v3sub,
  V3_X,
  V3_Y,
  V3_Z,
} from '@pushform/core';
import type { Box3, MVec3, Ray, Vec3 } from '@pushform/core';
import type { CameraState, Projection, StandardView } from '@pushform/commands';

export type { CameraState, Projection, StandardView };

/** Default: 35° vertical FOV, iso-ish view from +X/−Y/+Z, Z up. */
export const DEFAULT_CAMERA: CameraState = {
  eye: [9, -12, 7],
  target: [0, 0, 0.5],
  up: [0, 0, 1],
  fov: 35,
  projection: 'perspective',
  orthoHeight: 10,
};

/** Elevation limit (radians from horizontal) for gravity-constrained orbit. */
const ELEVATION_LIMIT = (89.5 * Math.PI) / 180;

export const DEG = Math.PI / 180;

export interface CameraBasis {
  /** Unit view direction. */
  readonly forward: MVec3;
  /** Unit screen-right. */
  readonly right: MVec3;
  /** Unit screen-up (orthogonalized). */
  readonly up: MVec3;
}

export const cameraDistance = (s: CameraState): number => v3len(v3sub(s.target, s.eye));
export const cameraForward = (s: CameraState): MVec3 => v3normalize(v3sub(s.target, s.eye));

export function cameraBasis(s: CameraState): CameraBasis {
  const forward = cameraForward(s);
  let right = v3cross(forward, s.up);
  if (v3len(right) < 1e-9) right = v3cross(forward, Math.abs(forward[1]) < 0.9 ? V3_Y : V3_X);
  right = v3normalize(right);
  const up = v3normalize(v3cross(right, forward));
  return { forward, right, up };
}

/** World units per CSS pixel at the target depth. */
export function worldPerPixel(s: CameraState, viewportHeight: number): number {
  if (s.projection === 'parallel') return s.orthoHeight / viewportHeight;
  return (2 * cameraDistance(s) * Math.tan((s.fov * DEG) / 2)) / viewportHeight;
}

/** World units per pixel at a given depth along the forward axis. */
export function worldPerPixelAtDepth(s: CameraState, depth: number, viewportHeight: number): number {
  if (s.projection === 'parallel') return s.orthoHeight / viewportHeight;
  return (2 * Math.max(depth, 1e-6) * Math.tan((s.fov * DEG) / 2)) / viewportHeight;
}

function rotateAbout(p: Vec3, pivot: Vec3, m: number[]): MVec3 {
  return v3add(pivot, m4transformDir(m, v3sub(p, pivot)));
}

/**
 * Orbit by `yaw`/`pitch` radians around `pivot`.
 * Gravity mode (default): yaw about world Z, pitch about screen-right, elevation clamped, no roll.
 * Free mode: yaw about screen-up, pitch about screen-right, the up vector rotates too.
 */
export function cameraOrbit(
  s: CameraState,
  pivot: Vec3,
  yaw: number,
  pitch: number,
  opts: { free?: boolean } = {},
): CameraState {
  if (opts.free) {
    const b = cameraBasis(s);
    const r1 = m4rotationAxis(b.up, yaw);
    const r2 = m4rotationAxis(b.right, pitch);
    const eye = rotateAbout(rotateAbout(s.eye, pivot, r2), pivot, r1);
    const target = rotateAbout(rotateAbout(s.target, pivot, r2), pivot, r1);
    const up = v3normalize(m4transformDir(r1, m4transformDir(r2, s.up)));
    return { ...s, eye, target, up };
  }
  const f = cameraForward(s);
  const sinE = Math.max(-1, Math.min(1, v3dot(f, V3_Z)));
  const e = Math.asin(sinE);
  // Horizontal heading: from forward, or from the up vector when looking straight up/down.
  let h: MVec3 = [f[0], f[1], 0];
  if (v3len(h) < 1e-6) h = [s.up[0], s.up[1], 0];
  if (v3len(h) < 1e-6) h = [1, 0, 0];
  h = v3normalize(h);
  const newE = Math.max(-ELEVATION_LIMIT, Math.min(ELEVATION_LIMIT, e + pitch));
  const dPitch = newE - e;
  const right = v3cross(h, V3_Z); // screen-right for a gravity-aligned camera
  const rPitch = m4rotationAxis(right, dPitch);
  const rYaw = m4rotationAxis(V3_Z, yaw);
  const eye = rotateAbout(rotateAbout(s.eye, pivot, rPitch), pivot, rYaw);
  const target = rotateAbout(rotateAbout(s.target, pivot, rPitch), pivot, rYaw);
  return { ...s, eye, target, up: [0, 0, 1] };
}

/** Pan by screen pixels (drag right → scene moves right). */
export function cameraPan(s: CameraState, dx: number, dy: number, viewportHeight: number): CameraState {
  const b = cameraBasis(s);
  const wpp = worldPerPixel(s, viewportHeight);
  const shift = v3add(v3scale(b.right, -dx * wpp), v3scale(b.up, dy * wpp));
  return { ...s, eye: v3add(s.eye, shift), target: v3add(s.target, shift) };
}

/**
 * Zoom by `factor` (< 1 zooms in) keeping `anchor` (a world point) fixed on screen.
 * Pass `null` to zoom toward the view center.
 */
export function cameraZoom(s: CameraState, factor: number, anchor: Vec3 | null): CameraState {
  const f = Math.max(1e-4, factor);
  if (s.projection === 'parallel') {
    const b = cameraBasis(s);
    let eye = s.eye,
      target = s.target;
    if (anchor) {
      const d = v3sub(anchor, s.eye);
      const ox = v3dot(d, b.right),
        oy = v3dot(d, b.up);
      const shift = v3add(v3scale(b.right, ox * (1 - f)), v3scale(b.up, oy * (1 - f)));
      eye = v3add(eye, shift);
      target = v3add(target, shift);
    }
    return { ...s, eye, target, orthoHeight: s.orthoHeight * f };
  }
  const dist = cameraDistance(s);
  const forward = cameraForward(s);
  const p = anchor ?? s.target;
  const toP = v3sub(p, s.eye);
  // Do not fly past the anchor: keep at least a small distance in front of the eye.
  const along = v3dot(toP, forward);
  const minDist = 1e-3;
  let eye = v3addScaled(s.eye, toP, 1 - f);
  if (along > 0 && along * f < minDist) eye = v3addScaled(s.eye, toP, 1 - minDist / along);
  const target = v3addScaled(eye, forward, Math.max(minDist, dist * f));
  return { ...s, eye, target };
}

/** Frame `box` in the view (zoom extents). Keeps the view direction. */
export function cameraFrameBox(s: CameraState, box: Box3, aspect: number, padding = 1.05): CameraState {
  const center = box3Center(box);
  const size = box3Size(box);
  const radius = Math.max(1e-3, (v3len(size) / 2) * padding);
  const forward = cameraForward(s);
  if (s.projection === 'parallel') {
    const orthoHeight = 2 * radius * Math.max(1, 1 / Math.max(aspect, 1e-6));
    const dist = Math.max(cameraDistance(s), 2 * radius);
    return { ...s, target: center, eye: v3addScaled(center, forward, -dist), orthoHeight };
  }
  const vfov = s.fov * DEG;
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
  const dist = radius / Math.sin(Math.min(vfov, hfov) / 2);
  return { ...s, target: center, eye: v3addScaled(center, forward, -dist) };
}

/** Standard views keep the target and distance; Top/Bottom use +Y as screen-up. */
export function cameraStandardView(s: CameraState, view: StandardView): CameraState {
  const dist = cameraDistance(s);
  let dir: Vec3, up: Vec3;
  switch (view) {
    case 'top':
      dir = [0, 0, -1];
      up = [0, 1, 0];
      break;
    case 'bottom':
      dir = [0, 0, 1];
      up = [0, 1, 0];
      break;
    case 'front':
      dir = [0, 1, 0];
      up = [0, 0, 1];
      break;
    case 'back':
      dir = [0, -1, 0];
      up = [0, 0, 1];
      break;
    case 'left':
      dir = [1, 0, 0];
      up = [0, 0, 1];
      break;
    case 'right':
      dir = [-1, 0, 0];
      up = [0, 0, 1];
      break;
    case 'iso':
    default:
      dir = v3normalize([-1, 1, -1]);
      up = [0, 0, 1];
      break;
  }
  return { ...s, eye: v3addScaled(s.target, dir, -dist), up };
}

/** Switch projection while preserving the apparent view size at the target. */
export function cameraSetProjection(s: CameraState, p: Projection): CameraState {
  if (p === s.projection) return s;
  const t = Math.tan((s.fov * DEG) / 2);
  if (p === 'parallel') {
    return { ...s, projection: p, orthoHeight: 2 * cameraDistance(s) * t };
  }
  const dist = s.orthoHeight / (2 * t);
  const forward = cameraForward(s);
  return { ...s, projection: p, eye: v3addScaled(s.target, forward, -dist) };
}

export function cameraSetFov(s: CameraState, fovDeg: number): CameraState {
  const fov = Math.max(1, Math.min(120, fovDeg));
  if (s.projection === 'parallel') return { ...s, fov };
  return { ...s, fov };
}

/** 35 mm-equivalent focal length (36 mm frame width) → vertical FOV given the aspect. */
export function focalLengthToFov(mm: number, aspect: number): number {
  const hfov = 2 * Math.atan(18 / Math.max(mm, 1));
  const vfov = 2 * Math.atan(Math.tan(hfov / 2) / Math.max(aspect, 1e-6));
  return vfov / DEG;
}

/** Ray through normalized device coordinates (x,y in [-1,1], y up). */
export function cameraRay(s: CameraState, ndcX: number, ndcY: number, aspect: number): Ray {
  const b = cameraBasis(s);
  if (s.projection === 'parallel') {
    const hh = s.orthoHeight / 2;
    const origin = v3add(v3add(s.eye, v3scale(b.right, ndcX * hh * aspect)), v3scale(b.up, ndcY * hh));
    return { origin, dir: b.forward };
  }
  const t = Math.tan((s.fov * DEG) / 2);
  const dir = v3normalize(
    v3add(v3add(b.forward, v3scale(b.right, ndcX * t * aspect)), v3scale(b.up, ndcY * t)),
  );
  return { origin: s.eye, dir };
}

/** Project a world point to NDC (x,y in [-1,1]) plus depth along the forward axis. */
export function cameraProject(s: CameraState, p: Vec3, aspect: number): { x: number; y: number; depth: number } {
  const b = cameraBasis(s);
  const d = v3sub(p, s.eye);
  const x = v3dot(d, b.right),
    y = v3dot(d, b.up),
    depth = v3dot(d, b.forward);
  if (s.projection === 'parallel') {
    const hh = s.orthoHeight / 2;
    return { x: x / (hh * aspect), y: y / hh, depth };
  }
  const t = Math.tan((s.fov * DEG) / 2);
  const z = Math.max(depth, 1e-9);
  return { x: x / (z * t * aspect), y: y / (z * t), depth };
}

/** Point on the cursor ray at the target's depth (used as a zoom/orbit fallback). */
export function pointAtTargetDepth(s: CameraState, ray: Ray): MVec3 {
  const forward = cameraForward(s);
  const depth = v3dot(v3sub(s.target, s.eye), forward);
  const denom = v3dot(ray.dir, forward);
  if (Math.abs(denom) < 1e-9) return [...s.target] as MVec3;
  const t = (depth - v3dot(v3sub(ray.origin, s.eye), forward)) / denom;
  return v3addScaled(ray.origin, ray.dir, t);
}

export function cameraStateEquals(a: CameraState, b: CameraState): boolean {
  const eq = (u: Vec3, v: Vec3) => u[0] === v[0] && u[1] === v[1] && u[2] === v[2];
  return (
    eq(a.eye, b.eye) &&
    eq(a.target, b.target) &&
    eq(a.up, b.up) &&
    a.fov === b.fov &&
    a.projection === b.projection &&
    a.orthoHeight === b.orthoHeight
  );
}
