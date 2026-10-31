// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { CameraState, Projection, StandardView } from '@pushform/commands';
import type { Box3, Vec3 } from '@pushform/core';

const DEG = Math.PI / 180;
/** Orbiting stops this far short of looking straight down or up, as the Orbit tool does. */
const ELEVATION_LIMIT = 89.5 * DEG;

/** View directions and screen-up of the standard views, as the Camera menu shows them. */
const STANDARD: Record<StandardView, { dir: Vec3; up: Vec3 }> = {
  top: { dir: [0, 0, -1], up: [0, 1, 0] },
  bottom: { dir: [0, 0, 1], up: [0, 1, 0] },
  front: { dir: [0, 1, 0], up: [0, 0, 1] },
  back: { dir: [0, -1, 0], up: [0, 0, 1] },
  left: { dir: [1, 0, 0], up: [0, 0, 1] },
  right: { dir: [-1, 0, 0], up: [0, 0, 1] },
  iso: { dir: normalize([-1, 1, -1]), up: [0, 0, 1] },
};

export interface FrameRequest {
  /** A standard view, or null to keep the current direction. */
  view: StandardView | null;
  horizontalDeg: number;
  verticalDeg: number;
  /** World box to fit, or null to keep the current target and distance. */
  box: Box3 | null;
  /** Extra space around the subject as a fraction of its size. */
  margin: number;
  /** Viewport width / height. */
  aspect: number;
  projection?: Projection | undefined;
  fovDeg?: number | undefined;
}

/**
 * The camera that looks along the requested direction and fits `box`, framed as Zoom Extents frames the model: the
 * box's bounding sphere fills the narrower field of view (perspective) or the view height (parallel).
 */
export function frameCamera(current: CameraState, request: FrameRequest): CameraState {
  const standard = request.view ? STANDARD[request.view] : null;
  let dir = standard ? standard.dir : normalize(sub(current.target, current.eye));
  let up = standard ? standard.up : current.up;
  if (request.horizontalDeg) {
    dir = turnZ(dir, request.horizontalDeg * DEG);
    up = turnZ(up, request.horizontalDeg * DEG);
  }
  if (request.verticalDeg) {
    let heading: Vec3 = [dir[0], dir[1], 0];
    // Looking straight down or up: the heading is screen-up.
    if (Math.hypot(heading[0], heading[1]) < 1e-6) heading = [up[0] * -Math.sign(dir[2]), up[1] * -Math.sign(dir[2]), 0];
    heading = normalize(heading);
    // Raising the eye lowers the line of sight.
    const elevation = Math.max(-ELEVATION_LIMIT, Math.min(ELEVATION_LIMIT, Math.asin(clamp(dir[2])) - request.verticalDeg * DEG));
    dir = [heading[0] * Math.cos(elevation), heading[1] * Math.cos(elevation), Math.sin(elevation)];
  }
  if (Math.abs(dir[2]) < 0.999) up = [0, 0, 1];
  const projection = request.projection ?? current.projection;
  const fov = request.fovDeg ?? current.fov;
  const distance = Math.hypot(...sub(current.eye, current.target));
  if (!request.box) {
    const orthoHeight = projection === 'parallel' && current.projection !== 'parallel' ? 2 * distance * Math.tan((fov * DEG) / 2) : current.orthoHeight;
    return { eye: add(current.target, scale(dir, -distance)), target: current.target, up, fov, projection, orthoHeight };
  }
  const box = request.box;
  const center: Vec3 = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
  const radius = Math.max(1e-3, (Math.hypot(...sub(box.max, box.min)) / 2) * (1 + request.margin));
  const aspect = Math.max(request.aspect, 1e-6);
  if (projection === 'parallel') {
    const orthoHeight = 2 * radius * Math.max(1, 1 / aspect);
    const dist = Math.max(distance, 2 * radius);
    return { eye: add(center, scale(dir, -dist)), target: center, up, fov, projection, orthoHeight };
  }
  const vfov = fov * DEG, hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
  const dist = radius / Math.sin(Math.min(vfov, hfov) / 2);
  return { eye: add(center, scale(dir, -dist)), target: center, up, fov, projection, orthoHeight: current.orthoHeight };
}

const clamp = (x: number): number => Math.max(-1, Math.min(1, x));
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}
function turnZ(v: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]];
}
