// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { CameraState } from '@pushform/commands';
import type { MVec3, Vec3 } from '@pushform/core';
import { v3add, v3addScaled, v3dot, v3normalize, v3scale } from '@pushform/core';
import { cameraBasis, cameraDistance, cameraOrbit, DEG } from '@pushform/render';

/**
 * Navigation cube geometry and camera moves. The cube is an orthographic picture of the unit cube
 * [-1, 1]³ drawn from the camera's direction: each visible face is split into nine click regions
 * (center = the face, side strips = its edges, corner squares = its corners), 26 regions in all.
 * Its design follows FreeCAD's navigation cube; the code is PushForm's own.
 */

/** Widget size in CSS px. */
export const NAV_CUBE_SIZE = 132;
/** Pixels per cube unit inside the widget. */
export const NAV_CUBE_SCALE = 30;
/** Half-extent of a face's center region; the rest is edge and corner strips. */
const INNER = 0.6;
/** Pointer travel (px) that turns a press into an orbit drag. */
export const NAV_CUBE_DRAG_PX = 3;
/** Arrow step. */
const TURN = 45 * DEG;

export type NavCubeFaceId = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';

export interface NavCubeFace {
  readonly id: NavCubeFaceId;
  readonly label: string;
  /** Outward normal. */
  readonly normal: Vec3;
  /** In-plane directions the label reads along (u) and up (v) when the face is viewed straight on. */
  readonly u: Vec3;
  readonly v: Vec3;
}

/** The six faces in naming order; Z is up, Front faces −Y. */
export const NAV_CUBE_FACES: readonly NavCubeFace[] = [
  { id: 'front', label: 'Front', normal: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { id: 'back', label: 'Back', normal: [0, 1, 0], u: [-1, 0, 0], v: [0, 0, 1] },
  { id: 'left', label: 'Left', normal: [-1, 0, 0], u: [0, -1, 0], v: [0, 0, 1] },
  { id: 'right', label: 'Right', normal: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
  { id: 'top', label: 'Top', normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { id: 'bottom', label: 'Bottom', normal: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
];

export interface NavCubeRegion {
  /** Face ids in naming order joined by '+', e.g. `front+right+top`. */
  readonly id: string;
  readonly kind: 'face' | 'edge' | 'corner';
  readonly faces: readonly NavCubeFace[];
  /** Accessible name, e.g. "Front Right Top". */
  readonly label: string;
  /** Sum of the faces' outward normals (not normalized). */
  readonly normal: Vec3;
}

const faceByNormal = (n: Vec3): NavCubeFace => NAV_CUBE_FACES.find((f) => v3dot(f.normal, n) > 0.5)!;

function regionOf(faces: NavCubeFace[]): NavCubeRegion {
  const ordered = NAV_CUBE_FACES.filter((f) => faces.includes(f));
  const normal = ordered.reduce<MVec3>((acc, f) => v3add(acc, f.normal), [0, 0, 0]);
  const kind = ordered.length === 1 ? 'face' : ordered.length === 2 ? 'edge' : 'corner';
  return { id: ordered.map((f) => f.id).join('+'), kind, faces: ordered, label: ordered.map((f) => f.label).join(' '), normal };
}

/** All 26 regions. */
export const NAV_CUBE_REGIONS: readonly NavCubeRegion[] = (() => {
  const byId = new Map<string, NavCubeRegion>();
  for (const f of NAV_CUBE_FACES) {
    for (const i of [-1, 0, 1]) {
      for (const j of [-1, 0, 1]) {
        const faces = [f];
        if (i !== 0) faces.push(faceByNormal(v3scale(f.u, i)));
        if (j !== 0) faces.push(faceByNormal(v3scale(f.v, j)));
        const r = regionOf(faces);
        if (!byId.has(r.id)) byId.set(r.id, r);
      }
    }
  }
  return [...byId.values()];
})();

export const navCubeRegion = (id: string): NavCubeRegion | undefined => NAV_CUBE_REGIONS.find((r) => r.id === id);

export interface NavCubeCell {
  readonly region: NavCubeRegion;
  readonly face: NavCubeFace;
  /** Screen polygon in cube units, y down, centered on the widget's center. */
  readonly points: readonly (readonly [number, number])[];
  /** 0..1: how squarely the face faces the viewer, for shading. */
  readonly facing: number;
}

export interface NavCubeLabel {
  readonly face: NavCubeFace;
  readonly text: string;
  /** SVG `matrix(a b c d e f)` mapping label space (x along the text, y down) to cube screen units. */
  readonly matrix: readonly [number, number, number, number, number, number];
}

export interface NavCubePicture {
  readonly cells: readonly NavCubeCell[];
  readonly labels: readonly NavCubeLabel[];
}

const SPAN: Record<number, readonly [number, number]> = { [-1]: [-1, -INNER], 0: [-INNER, INNER], 1: [INNER, 1] };

/** The visible faces' cells and labels for the camera's direction. */
export function navCubePicture(cam: CameraState): NavCubePicture {
  const b = cameraBasis(cam);
  const project = (p: Vec3): readonly [number, number] => [v3dot(p, b.right), -v3dot(p, b.up)];
  const cells: NavCubeCell[] = [];
  const labels: NavCubeLabel[] = [];
  for (const f of NAV_CUBE_FACES) {
    const facing = -v3dot(f.normal, b.forward);
    if (facing < 0.02) continue;
    const at = (u: number, v: number): Vec3 => v3add(v3add(f.normal, v3scale(f.u, u)), v3scale(f.v, v));
    for (const i of [-1, 0, 1]) {
      for (const j of [-1, 0, 1]) {
        const [u0, u1] = SPAN[i]!;
        const [v0, v1] = SPAN[j]!;
        const faces = [f];
        if (i !== 0) faces.push(faceByNormal(v3scale(f.u, i)));
        if (j !== 0) faces.push(faceByNormal(v3scale(f.v, j)));
        cells.push({
          region: navCubeRegion(regionOf(faces).id)!,
          face: f,
          facing,
          points: [project(at(u0, v0)), project(at(u1, v0)), project(at(u1, v1)), project(at(u0, v1))],
        });
      }
    }
    const [ux, uy] = project(f.u);
    const [vx, vy] = project(f.v);
    const [cx, cy] = project(f.normal);
    labels.push({ face: f, text: f.label.toUpperCase(), matrix: [ux, uy, -vx, -vy, cx, cy] });
  }
  return { cells, labels };
}

/**
 * The camera looking straight at a region: along its inward normal, keeping the target, distance,
 * projection and field of view. Up is +Z, except straight up or down, where screen-up is the
 * horizontal axis closest to the current screen-up.
 */
export function navCubeView(cam: CameraState, region: NavCubeRegion): CameraState {
  const dir = v3normalize(v3scale(region.normal, -1));
  const dist = cameraDistance(cam);
  let up: Vec3 = [0, 0, 1];
  if (Math.abs(dir[2]) > 0.999) {
    // Screen-up on the ground; from a level view that is zero, so the far side (the look direction) goes to the top.
    const b = cameraBasis(cam);
    let flat: Vec3 = [b.up[0], b.up[1], 0];
    if (Math.hypot(flat[0], flat[1]) < 1e-6) flat = [b.forward[0], b.forward[1], 0];
    const candidates: Vec3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];
    up = candidates.reduce((best, c) => (v3dot(c, flat) > v3dot(best, flat) ? c : best));
  }
  return { ...cam, eye: v3addScaled(cam.target, dir, -dist), up };
}

export type NavCubeTurn = 'up' | 'down' | 'left' | 'right';

/** One 45° arrow step about the target, moving the view as a drag toward that arrow would: left/right about Z, up/down about screen-right, no roll. */
export function navCubeTurn(cam: CameraState, turn: NavCubeTurn): CameraState {
  const yaw = turn === 'left' ? TURN : turn === 'right' ? -TURN : 0;
  const pitch = turn === 'up' ? TURN : turn === 'down' ? -TURN : 0;
  return cameraOrbit(cam, cam.target, yaw, pitch);
}

/** Fill for a face: light grey, darker the more it turns away; light blue under the pointer. */
export function navCubeFill(facing: number, hovered: boolean): string {
  if (hovered) return 'rgb(170, 226, 255)';
  const k = 0.72 + 0.28 * Math.max(0, Math.min(1, facing));
  const c = (v: number) => Math.round(v * k);
  return `rgb(${c(226)}, ${c(232)}, ${c(239)})`;
}
