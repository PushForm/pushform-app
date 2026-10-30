// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { formatLength, MERGE_TOL, planeFromPointNormal, planeProject, v3cross, v3dist, v3dot, v3len, v3normalize, v3sub } from '@pushform/core';
import type { MVec3, Plane, Vec2, Vec3 } from '@pushform/core';
import type { Axis, InferenceResult } from '@pushform/inference';
import type { Sketch, UndoEntry } from '@pushform/model';
import type { VcbValue } from '../../vcb/parse';
import type { OverlayPrimitive } from '../overlay';
import type { ToolContext, ToolKeyEvent, ToolPointerEvent } from '../Tool';
import { DRAG_PX, hostOfTool, PREVIEW_COLOR, screenDist, worldPerPixelAt } from '../toolUtil';
import { currentContainer, currentFrame } from '../../commands/context';
import type { DocumentHost } from '../../host/DocumentHost';

/** Shared helpers for the curve / shape drawing tools (Circle, Polygon, Arcs, Freehand, Rotated Rectangle). */

export const AXIS_NORMAL: Record<Axis, Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/** Arrow keys pick the drawing plane normal: ↑ blue, → red, ← green, ↓ clears. `undefined` = not a plane key. */
export function planeLockFromKey(key: string): Axis | null | undefined {
  switch (key) {
    case 'ArrowUp':
      return 'z';
    case 'ArrowRight':
      return 'x';
    case 'ArrowLeft':
      return 'y';
    case 'ArrowDown':
      return null;
    default:
      return undefined;
  }
}

/** Toggle semantics of the arrow plane lock (pressing the same arrow again releases it). */
export function toggleLock(current: Axis | null, next: Axis | null): Axis | null {
  return next !== null && current === next ? null : next;
}

/** Plane the cursor is "on": the hovered face's plane, else the inference plane. Re-anchored at `at`. */
export function hoverPlane(inf: InferenceResult, at: Vec3 = inf.point): Plane {
  const hit = inf.hit;
  if (hit && hit.normal && (hit.ref.kind === 'face' || hit.ref.kind === 'sketchFace')) return planeFromPointNormal(at, hit.normal);
  return planeFromPointNormal(at, (inf.primary.plane ?? inf.plane).n);
}

/**
 * Drawing plane for a shape started at `at`: an arrow-key lock wins, then a plane held with Shift,
 * then the hovered face / inference plane.
 */
export function drawingPlaneAt(inf: InferenceResult, at: Vec3, lock: Axis | null, held: Plane | null): Plane {
  if (lock) return planeFromPointNormal(at, AXIS_NORMAL[lock]);
  if (held) return planeFromPointNormal(at, held.n);
  return hoverPlane(inf, at);
}

/** Sides typed before the first click: `24s`, or a bare integer (`24`) that carries no unit. */
export function sidesFromVcb(v: VcbValue): number | null {
  if (v.kind === 'segments') return v.count;
  if (v.kind === 'length' && v.unit === null && Number.isInteger(v.raw) && v.raw >= 1) return v.raw;
  return null;
}

/** Degrees typed in an angle stage: `45deg`, a `rise:run` slope, or a bare number (`45`). */
export function degreesFromVcb(v: VcbValue): number | null {
  if (v.kind === 'angle' || v.kind === 'slope') return v.degrees;
  if (v.kind === 'length' && v.unit === null) return v.raw;
  return null;
}

/** World tolerance for a `px` screen tolerance at point `p` (0 when the camera is unknown). */
export function pixelTolerance(ctx: ToolContext | null, e: Pick<ToolPointerEvent, 'camera'> | null, p: Vec3, px: number): number {
  if (!ctx || !e) return 0;
  return px * worldPerPixelAt(e.camera, ctx.camera.viewportSize().height, p);
}

export function formatLen(ctx: ToolContext | null, meters: number): string | undefined {
  if (!ctx) return undefined;
  return formatLength(meters, hostOfTool(ctx).doc.state.meta.units);
}

export function formatDeg(deg: number): string {
  return `${(Math.round(deg * 10) / 10).toFixed(1)}°`;
}

/** Wrap an angle to (-π, π]. */
export function wrapPi(a: number): number {
  let r = a % (Math.PI * 2);
  if (r <= -Math.PI) r += Math.PI * 2;
  else if (r > Math.PI) r -= Math.PI * 2;
  return r;
}

/** Preview polyline (+ translucent fill when closed) for a tessellated shape. */
export function shapePreview(points: readonly Vec3[], closed: boolean, color = PREVIEW_COLOR, fill?: string): OverlayPrimitive[] {
  if (points.length < 2) return [];
  const out: OverlayPrimitive[] = [];
  if (closed && fill && points.length >= 3) out.push({ kind: 'polygon', points, color: fill, opacity: 0.12 });
  out.push({ kind: 'polyline', points, color, closed, width: 2 });
  return out;
}

/**
 * Tangent direction of a curve ending at `p` ("Tangent at Vertex"): the end of a sketch
 * edge that belongs to a curve. Exact for arcs/circles (perpendicular to the radius), the last
 * segment's direction for freehand curves. Points away from the curve. Null when no curve ends there.
 */
/** `curveTangentAt` over the sketch of the host's current context: world point in, world tangent out. */
export function contextCurveTangentAt(host: DocumentHost, p: Vec3): MVec3 | null {
  const frame = currentFrame(host);
  const t = curveTangentAt(currentContainer(host).sketch, frame.toLocal(p));
  return t ? frame.toWorldDir(t) : null;
}

export function curveTangentAt(sketch: Sketch, p: Vec3): MVec3 | null {
  let vid: number | null = null;
  for (const v of sketch.vertices.values()) {
    if (v3dist(v.p, p) <= MERGE_TOL) {
      vid = v.id;
      break;
    }
  }
  if (vid === null) return null;
  for (const e of sketch.edges.values()) {
    if (e.curveId === null || (e.a !== vid && e.b !== vid)) continue;
    const other = sketch.vertices.get(e.a === vid ? e.b : e.a);
    if (!other) continue;
    const away = v3sub(p, other.p);
    const curve = sketch.curves.get(e.curveId);
    let t: MVec3;
    if (curve && curve.kind !== 'freehand' && curve.radius > MERGE_TOL) {
      t = v3cross(curve.normal, v3sub(p, curve.center));
      if (v3len(t) < 1e-12) t = away;
    } else t = away;
    if (v3dot(t, away) < 0) t = [-t[0], -t[1], -t[2]];
    return v3len(t) > 0 ? v3normalize(t) : null;
  }
  return null;
}

/** Project a cursor point onto the drawing plane (when there is one). */
export function onPlane(plane: Plane | null, p: Vec3): Vec3 {
  return plane ? planeProject(plane, p) : p;
}

/**
 * Press / release / click bookkeeping shared by the drawing tools: a press followed by a release
 * farther than DRAG_PX is a drag-release gesture, and the browser click that follows any handled
 * press or drag is swallowed.
 */
export class ClickGesture {
  private downScreen: Vec2 | null = null;
  private suppressNextClick = false;

  /** Call on a left-button press; returns true when the press itself should start the operation. */
  down(e: ToolPointerEvent): boolean {
    if (e.button !== 0) return false;
    this.downScreen = e.screen;
    return true;
  }
  /** Marks the following click as already handled (after the press started something). */
  handledOnDown(): void {
    this.suppressNextClick = true;
  }
  /** Call on release; true when the pointer travelled (drag-release). */
  up(e: ToolPointerEvent): boolean {
    if (e.button !== 0 || !this.downScreen) return false;
    const dragged = screenDist(this.downScreen, e.screen) > DRAG_PX;
    this.downScreen = null;
    if (dragged) this.suppressNextClick = true;
    return dragged;
  }
  /** Call on click; false when the click was consumed by an earlier press/drag. */
  click(e: ToolPointerEvent): boolean {
    if (this.suppressNextClick) {
      this.suppressNextClick = false;
      return false;
    }
    return e.button === 0;
  }
  reset(): void {
    this.downScreen = null;
    this.suppressNextClick = false;
  }
}

/** Last committed shape for the "type a value after finishing" re-edit. */
export interface LastCommit<P> {
  readonly params: P;
  readonly entry: UndoEntry | null;
}

/** Undo the last commit when it is still on top of the stack, so it can be re-run with new params. Returns false otherwise. */
export function undoLast<P>(ctx: ToolContext, last: LastCommit<P> | null): last is LastCommit<P> {
  if (!last) return false;
  const host = hostOfTool(ctx);
  if (!last.entry || host.undoStack.peek() !== last.entry) return false;
  host.undo();
  return true;
}

/** Shift pressed (not a repeat): the key event to hold the current inference. */
export const isShiftPress = (e: ToolKeyEvent): boolean => e.key === 'Shift' && !e.repeat;
