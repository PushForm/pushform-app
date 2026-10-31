// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { CameraState } from '@pushform/commands';
import type { MVec3, Vec3 } from '@pushform/core';
import { v3add, v3addScaled, v3cross, v3dot, v3len, v3normalize, v3scale, v3sub } from '@pushform/core';
import { cameraBasis, cameraDistance, cameraOrbit, DEG } from '@pushform/render';

/**
 * Navigation cube geometry and camera moves. The cube is an orthographic picture of the unit cube
 * [-1, 1]³ with its edges and corners cut off, drawn from the camera's direction: the six faces, the
 * twelve edge bevels and the eight hexagonal corners are the 26 click regions. Its design follows FreeCAD's
 * navigation cube; the code is PushForm's own.
 */

/** Widget size in CSS px. */
export const NAV_CUBE_SIZE = 144;
/** Pixels per cube unit inside the widget. */
export const NAV_CUBE_SCALE = 36;
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
  /** Screen polygon in cube units, y down, centered on the widget's center. */
  readonly points: readonly (readonly [number, number])[];
  /** 0..1 lighting of the polygon, from a light above and left of the viewer. */
  readonly light: number;
  /** Depth of the polygon's center along the view direction, for painter's ordering (far first). */
  readonly depth: number;
}

export interface NavCubeLabel {
  readonly face: NavCubeFace;
  readonly text: string;
  /** SVG `matrix(a b c d e f)` mapping label space (x along the text, y down) to cube screen units. */
  readonly matrix: readonly [number, number, number, number, number, number];
}

export interface NavCubeAxis {
  readonly axis: 'x' | 'y' | 'z';
  /** Screen direction of the positive axis in cube units (y down). */
  readonly dx: number;
  readonly dy: number;
}

export interface NavCubePicture {
  readonly cells: readonly NavCubeCell[];
  readonly labels: readonly NavCubeLabel[];
  readonly axes: readonly NavCubeAxis[];
}

/**
 * The solid is the unit cube cut by 26 planes: the faces at distance 1 along their normals, the
 * edge bevels where the two faces' coordinates sum to `EDGE_CUT`, and the corner cuts where all
 * three sum to `CORNER_CUT`. The corner cut reaches into the faces and the edge bevels, so corners
 * are hexagons, faces octagons and edge bevels rectangles, and every region is a comfortable target.
 */
export const NAV_CUBE_EDGE_CUT = 1.72;
export const NAV_CUBE_CORNER_CUT = 2.2;

/** The half-space of a region: `normal · p ≤ cut`, with the region's unnormalized normal. */
function cutOf(r: NavCubeRegion): number {
  return r.kind === 'face' ? 1 : r.kind === 'edge' ? NAV_CUBE_EDGE_CUT : NAV_CUBE_CORNER_CUT;
}

/** Sutherland–Hodgman clip of a convex polygon against `n · p ≤ d`. */
function clip(poly: Vec3[], n: Vec3, d: number): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    const da = v3dot(n, a) - d, db = v3dot(n, b) - d;
    if (da <= 0) out.push(a);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) out.push(v3addScaled(a, v3sub(b, a), da / (da - db)));
  }
  return out;
}

/** The polygon of a region: its plane clipped by every other region's half-space. */
function regionPolygon(r: NavCubeRegion): Vec3[] {
  const nn = v3normalize(r.normal);
  const helper: Vec3 = Math.abs(nn[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = v3normalize(v3cross(nn, helper));
  const v = v3cross(nn, u);
  const c = v3scale(nn, cutOf(r) / v3len(r.normal));
  let poly: Vec3[] = [[3, 3], [-3, 3], [-3, -3], [3, -3]].map(([i, j]) => v3add(c, v3add(v3scale(u, i!), v3scale(v, j!))));
  for (const o of NAV_CUBE_REGIONS) {
    if (o === r) continue;
    poly = clip(poly, o.normal, cutOf(o));
  }
  return poly;
}

/** The visible regions' polygons, the face labels and the axis triad for the camera's direction. */
export function navCubePicture(cam: CameraState): NavCubePicture {
  const b = cameraBasis(cam);
  const project = (p: Vec3): readonly [number, number] => [v3dot(p, b.right), -v3dot(p, b.up)];
  // Key light above and to the left of the viewer, a little in front.
  const light = v3normalize(v3add(v3add(v3scale(b.right, -0.35), v3scale(b.up, 0.55)), v3scale(b.forward, -0.76)));
  const cells: NavCubeCell[] = [];
  for (const r of NAV_CUBE_REGIONS) {
    const normal = v3normalize(r.normal);
    if (-v3dot(normal, b.forward) < 1e-3) continue;
    const poly = regionPolygon(r);
    const center = v3scale(poly.reduce<MVec3>((acc, p) => v3add(acc, p), [0, 0, 0]), 1 / poly.length);
    cells.push({ region: r, points: poly.map(project), light: Math.max(0, Math.min(1, v3dot(normal, light))), depth: v3dot(center, b.forward) });
  }
  cells.sort((p, q) => p.depth - q.depth);
  const labels: NavCubeLabel[] = [];
  for (const f of NAV_CUBE_FACES) {
    if (-v3dot(f.normal, b.forward) < 1e-3) continue;
    const [ux, uy] = project(f.u);
    const [vx, vy] = project(f.v);
    const [cx, cy] = project(f.normal);
    labels.push({ face: f, text: f.label.toUpperCase(), matrix: [ux, uy, -vx, -vy, cx, cy] });
  }
  const axes: NavCubeAxis[] = (['x', 'y', 'z'] as const).map((axis, i) => {
    const dir: Vec3 = [i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0];
    const [dx, dy] = project(dir);
    return { axis, dx, dy };
  });
  return { cells, labels, axes };
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

/** Fill for a region: a light grey-blue lit by `light` (0..1); light blue under the pointer. */
export function navCubeFill(light: number, hovered: boolean): string {
  const k = 0.68 + 0.32 * Math.max(0, Math.min(1, light));
  const base: [number, number, number] = hovered ? [160, 214, 255] : [228, 233, 240];
  return `rgb(${base.map((v) => Math.round(v * k)).join(', ')})`;
}
