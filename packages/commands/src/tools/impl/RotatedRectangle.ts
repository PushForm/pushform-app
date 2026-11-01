// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { basisToWorld, MERGE_TOL, planeBasis, planeFromPointNormal, v3addScaled, v3cross, v3dist, v3dot, v3len, v3normalize, v3sub } from '@pushform/core';
import type { MVec3, Plane, Vec2, Vec3 } from '@pushform/core';
import type { Axis, InferenceOptions, InferenceResult, Snap } from '@pushform/inference';
import { SNAP_COLORS } from '@pushform/inference';
import type { VcbKind, VcbValue } from '../../vcb/parse';
import type { OverlayPrimitive } from '../overlay';
import type { EntryField, Tool, ToolContext, ToolKeyEvent, ToolPointerEvent, ToolStatus } from '../Tool';
import { DIMENSION_OFFSET_PX, field, leftOf, lengthDimension, pxAt } from '../entry';
import { hostOfTool, inferenceOverlay, PREVIEW_COLOR, rubberBandColor } from '../toolUtil';
import {
  AXIS_NORMAL,
  ClickGesture,
  degreesFromVcb,
  drawingPlaneAt,
  formatDeg,
  formatLen,
  hoverPlane,
  isShiftPress,
  onPlane,
  planeLockFromKey,
  toggleLock,
  undoLast,
  type LastCommit,
} from './drawingUtil';

export interface RotatedRectangleParams {
  /** First corner. */
  readonly a: Vec3;
  /** End of the first edge. */
  readonly b: Vec3;
  /** Normal of the base plane the first edge was drawn in. */
  readonly normal: Vec3;
  readonly width: number;
  /** Rotation of the second edge about the first edge, in degrees from the base plane (0 = flat). */
  readonly angleDeg: number;
}

/** Protractor snap: angles within this many degrees of a 15° tick snap to it. */
const ANGLE_SNAP_DEG = 1.5;

/**
 * Rotated Rectangle: Idle → Corner A → first edge (direction + length, VCB length) → protractor
 * at B (perpendicular to the first edge) for the width and the tilt angle about the first edge →
 * commit via `sketch.rectangle`. Shift during the first edge keeps its direction; arrows pick the
 * base plane before the first click; VCB `width,angle` in the last stage (either omitted) and
 * after the commit (re-edit).
 */
export class RotatedRectangleTool implements Tool {
  readonly id = 'rotrect';
  readonly title = 'Rotated Rectangle';
  readonly cursor = 'crosshair';
  readonly vcbSchema: readonly VcbKind[] = ['length', 'list', 'angle'];

  private ctx: ToolContext | null = null;
  private a: Vec3 | null = null;
  private b: Vec3 | null = null;
  private plane: Plane | null = null;
  private lockNormal: Axis | null = null;
  private heldPlane: Plane | null = null;
  private lockSnap: Snap | null = null;
  private cursorInference: InferenceResult | null = null;
  private cursorScreen: Vec2 | null = null;
  private last: LastCommit<RotatedRectangleParams> | null = null;
  private readonly gesture = new ClickGesture();

  get stage(): 'corner' | 'edge' | 'width' {
    return !this.a ? 'corner' : !this.b ? 'edge' : 'width';
  }
  get lastParams(): RotatedRectangleParams | null {
    return this.last?.params ?? null;
  }
  get planeLock(): Axis | null {
    return this.lockNormal;
  }

  hasPendingWork(): boolean {
    return this.a !== null;
  }

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
  }
  deactivate(): void {
    this.reset();
    this.last = null;
    this.ctx = null;
  }

  inferenceOptions(): InferenceOptions {
    let plane = this.plane ?? this.heldPlane;
    if (!plane && this.lockNormal) plane = planeFromPointNormal([0, 0, 0], AXIS_NORMAL[this.lockNormal]);
    // In the width stage the cursor moves in the protractor plane (perpendicular to the first edge).
    if (this.stage === 'width' && this.a && this.b) plane = planeFromPointNormal(this.b, v3normalize(v3sub(this.b, this.a)));
    return { anchor: this.b ?? this.a ?? undefined, plane: plane ?? undefined, lockAxis: null, lockSnap: this.lockSnap };
  }

  onPointerMove(e: ToolPointerEvent): void {
    this.track(e);
    this.ctx?.requestRender();
    this.ctx?.statusChanged();
  }

  onPointerDown(e: ToolPointerEvent): void {
    if (!this.gesture.down(e)) return;
    if (!this.a && e.inference) {
      this.track(e);
      this.begin(e.inference);
      this.gesture.handledOnDown();
    }
  }

  onPointerUp(e: ToolPointerEvent): void {
    if (!this.gesture.up(e)) return;
    if (this.stage === 'edge' && e.inference) {
      this.track(e);
      this.pickB(this.edgeEnd());
    }
  }

  onClick(e: ToolPointerEvent): void {
    if (!this.gesture.click(e) || !e.inference) return;
    this.track(e);
    switch (this.stage) {
      case 'corner':
        this.begin(e.inference);
        break;
      case 'edge':
        this.pickB(this.edgeEnd());
        break;
      case 'width': {
        const wa = this.widthAngle();
        if (wa) this.commit(wa.width, wa.angleDeg);
      }
    }
  }

  onKeyDown(e: ToolKeyEvent): boolean {
    const lock = planeLockFromKey(e.key);
    if (lock !== undefined) {
      this.lockNormal = toggleLock(this.lockNormal, lock);
      if (this.a && this.stage === 'edge') this.plane = planeFromPointNormal(this.a, this.lockNormal ? AXIS_NORMAL[this.lockNormal] : (this.plane?.n ?? [0, 0, 1]));
      this.ctx?.requestRender();
      return true;
    }
    if (isShiftPress(e)) {
      const inf = this.cursorInference;
      if (this.stage === 'edge' && this.a && inf) {
        // Shift keeps the first edge's current direction.
        const dir = v3sub(onPlane(this.plane, inf.point), this.a);
        this.lockSnap = v3len(dir) > MERGE_TOL ? { ...inf.primary, kind: 'onEdge', dir: v3normalize(dir), label: 'Direction locked' } : inf.primary;
      } else {
        this.lockSnap = inf?.primary ?? null;
        if (inf && !this.a) this.heldPlane = hoverPlane(inf);
      }
      return true;
    }
    return false;
  }

  onKeyUp(e: ToolKeyEvent): boolean {
    if (e.key !== 'Shift') return false;
    this.lockSnap = null;
    this.heldPlane = null;
    return true;
  }

  onVcb(v: VcbValue): void {
    switch (this.stage) {
      case 'corner': {
        if (!this.last) return;
        const wa = widthAngleFromVcb(v);
        if (!wa) return;
        this.reapplyLast(wa.width ?? this.last.params.width, wa.angleDeg ?? this.last.params.angleDeg);
        return;
      }
      case 'edge': {
        if (v.kind !== 'length' || !this.a || v.meters <= MERGE_TOL) return;
        const dir = this.edgeDirection();
        if (dir) this.pickB(v3addScaled(this.a, dir, v.meters));
        return;
      }
      case 'width': {
        const wa = widthAngleFromVcb(v);
        if (!wa) return;
        const cur = this.widthAngle();
        this.commit(wa.width ?? cur?.width ?? 0, wa.angleDeg ?? cur?.angleDeg ?? 0);
      }
    }
  }

  onEntry(values: Readonly<Record<string, VcbValue>>): void {
    if (this.stage !== 'width') {
      const v = values.length ?? values.width;
      if (v) this.onVcb(v);
      return;
    }
    const w = values.width?.kind === 'length' ? values.width : null;
    const a = values.angle && (values.angle.kind === 'length' || values.angle.kind === 'angle' || values.angle.kind === 'slope') ? values.angle : null;
    if (w || a) this.onVcb({ kind: 'list', values: [w, a] });
  }

  onCancel(): void {
    this.reset();
    this.ctx?.requestRender();
    this.ctx?.statusChanged();
  }

  overlay(): readonly OverlayPrimitive[] {
    const out: OverlayPrimitive[] = [];
    const inf = this.cursorInference;
    if (this.a) out.push({ kind: 'point', position: this.a, color: PREVIEW_COLOR, shape: 'square', size: 6 });
    if (this.a && inf && this.stage === 'edge') {
      out.push({ kind: 'polyline', points: [this.a, this.edgeEnd()], color: rubberBandColor(this.lockSnap ?? inf.primary), width: 2 });
      out.push(...this.edgeDimension().overlay);
    } else if (this.a && this.b && this.stage === 'width') {
      out.push({ kind: 'polyline', points: [this.a, this.b], color: PREVIEW_COLOR, width: 2 });
      const wa = this.widthAngle();
      if (wa && wa.width > MERGE_TOL) {
        const { c, d } = this.corners(wa.width, wa.angleDeg);
        out.push({ kind: 'polygon', points: [this.a, this.b, c, d], color: SNAP_COLORS.onFace, opacity: 0.12 });
        out.push({ kind: 'polyline', points: [this.a, this.b, c, d], color: PREVIEW_COLOR, closed: true, width: 2 });
        out.push(...this.protractor(wa.width));
        out.push(...lengthDimension(this.b, c, this.frame()!.u, pxAt(this.ctx, this.b, DIMENSION_OFFSET_PX)).overlay);
      }
    }
    out.push(...inferenceOverlay(inf, this.cursorScreen ?? undefined));
    return out;
  }

  status(): ToolStatus {
    switch (this.stage) {
      case 'corner':
        return { instructor: 'Select first corner.', vcbLabel: 'Length' };
      case 'edge':
        return {
          instructor: 'Select second corner or enter length.',
          vcbLabel: 'Length',
          vcbValue: this.a ? formatLen(this.ctx, v3dist(this.a, this.edgeEnd())) : undefined,
          fields: this.edgeDimension().fields,
        };
      default: {
        const wa = this.widthAngle();
        const w = wa ? formatLen(this.ctx, wa.width) : undefined;
        return {
          instructor: 'Set width and angle, or enter width,angle.',
          vcbLabel: 'Width, Angle',
          vcbValue: wa && w ? `${w}, ${formatDeg(wa.angleDeg)}` : undefined,
          fields: wa && this.b ? this.widthFields(wa.width, wa.angleDeg) : [],
        };
      }
    }
  }

  // --- internals ------------------------------------------------------------------------------

  private track(e: ToolPointerEvent): void {
    this.cursorInference = e.inference;
    this.cursorScreen = e.screen;
  }

  private begin(inf: InferenceResult): void {
    const p = inf.point;
    this.plane = drawingPlaneAt(inf, p, this.lockNormal, this.heldPlane);
    this.a = p;
    this.b = null;
    this.ctx?.statusChanged();
  }

  /** Unit direction of the first edge from the cursor (or the Shift lock). */
  private edgeDirection(): MVec3 | null {
    if (!this.a) return null;
    if (this.lockSnap?.dir) return v3normalize(this.lockSnap.dir);
    if (!this.cursorInference) return null;
    const d = v3sub(onPlane(this.plane, this.cursorInference.point), this.a);
    return v3len(d) > MERGE_TOL ? v3normalize(d) : null;
  }

  /** Current end of the first edge: the cursor, or its distance along the locked direction. */
  private edgeEnd(): Vec3 {
    if (!this.a || !this.cursorInference) return this.a ?? [0, 0, 0];
    const p = onPlane(this.plane, this.cursorInference.point);
    if (this.lockSnap?.dir) {
      const dir = v3normalize(this.lockSnap.dir);
      return v3addScaled(this.a, dir, v3dot(v3sub(p, this.a), dir));
    }
    return p;
  }

  /** Length dimension beside the first edge while it is drawn, with its field. */
  private edgeDimension(): { overlay: OverlayPrimitive[]; fields: EntryField[] } {
    if (!this.a || !this.cursorInference) return { overlay: [], fields: [] };
    const end = this.edgeEnd();
    const value = formatLen(this.ctx, v3dist(this.a, end));
    const side = this.plane ? leftOf(this.a, end, this.plane.n) : null;
    if (!side) return { overlay: [], fields: [field('length', 'Length', 'length', value, undefined)] };
    const dim = lengthDimension(this.a, end, side, pxAt(this.ctx, this.a, DIMENSION_OFFSET_PX));
    return { overlay: dim.overlay, fields: [field('length', 'Length', 'length', value, dim.at, false, dim.away)] };
  }

  /** Width field on the dimension beside the second edge, and the Angle field beside the pointer. */
  private widthFields(width: number, angleDeg: number): EntryField[] {
    const dim = width > MERGE_TOL ? lengthDimension(this.b!, this.corners(width, angleDeg).c, this.frame()!.u, pxAt(this.ctx, this.b!, DIMENSION_OFFSET_PX)) : null;
    return [field('width', 'Width', 'length', formatLen(this.ctx, width), dim?.at, false, dim?.away), field('angle', 'Angle', 'angle', formatDeg(angleDeg), undefined)];
  }

  private pickB(p: Vec3): void {
    if (!this.a || v3dist(this.a, p) <= MERGE_TOL) return;
    this.b = p;
    this.lockSnap = null;
    this.ctx?.statusChanged();
  }

  /** Protractor frame at B: u along the first edge, v in the base plane, n the base normal. */
  private frame(): { u: MVec3; v: MVec3; n: MVec3 } | null {
    if (!this.a || !this.b || !this.plane) return null;
    const u = v3normalize(v3sub(this.b, this.a));
    const n = v3normalize(this.plane.n);
    const v = v3normalize(v3cross(n, u));
    return { u, v, n };
  }

  private widthAngle(): { width: number; angleDeg: number } | null {
    const f = this.frame();
    if (!f || !this.b || !this.cursorInference) return null;
    const r = v3sub(this.cursorInference.point, this.b);
    const y = v3dot(r, f.v), z = v3dot(r, f.n);
    const width = Math.hypot(y, z);
    let angleDeg = width > MERGE_TOL ? (Math.atan2(z, y) * 180) / Math.PI : 0;
    const tick = Math.round(angleDeg / 15) * 15;
    if (Math.abs(angleDeg - tick) <= ANGLE_SNAP_DEG) angleDeg = tick;
    return { width, angleDeg };
  }

  private corners(width: number, angleDeg: number): { c: Vec3; d: Vec3 } {
    const f = this.frame()!;
    const rad = (angleDeg * Math.PI) / 180;
    const dir: Vec3 = [
      f.v[0] * Math.cos(rad) + f.n[0] * Math.sin(rad),
      f.v[1] * Math.cos(rad) + f.n[1] * Math.sin(rad),
      f.v[2] * Math.cos(rad) + f.n[2] * Math.sin(rad),
    ];
    return { c: v3addScaled(this.b!, dir, width), d: v3addScaled(this.a!, dir, width) };
  }

  /** Dashed protractor circle around B in the plane perpendicular to the first edge. */
  private protractor(radius: number): OverlayPrimitive[] {
    const f = this.frame();
    if (!f || !this.b) return [];
    const basis = planeBasis(this.b, f.u);
    const pts: Vec3[] = [];
    for (let i = 0; i < 48; i++) {
      const t = (i / 48) * Math.PI * 2;
      pts.push(basisToWorld(basis, Math.cos(t) * radius, Math.sin(t) * radius));
    }
    return [{ kind: 'polyline', points: pts, color: SNAP_COLORS.onFace, dashed: true, closed: true }];
  }

  private commit(width: number, angleDeg: number): void {
    if (!this.ctx || !this.a || !this.b || !this.plane || width <= MERGE_TOL) return;
    this.execute({ a: this.a, b: this.b, normal: this.plane.n, width, angleDeg });
    this.reset();
    this.ctx.requestRender();
    this.ctx.statusChanged();
  }

  private execute(params: RotatedRectangleParams): void {
    const ctx = this.ctx!;
    const corners = rotatedRectangleCorners(params);
    ctx.commands.execute('sketch.rectangle', corners);
    this.last = { params, entry: hostOfTool(ctx).undoStack.peek() };
  }

  private reapplyLast(width: number, angleDeg: number): void {
    if (!this.ctx || !this.last || width <= MERGE_TOL) return;
    if (!undoLast(this.ctx, this.last)) return;
    this.execute({ ...this.last.params, width, angleDeg });
    this.ctx.requestRender();
    this.ctx.statusChanged();
  }

  private reset(): void {
    this.a = null;
    this.b = null;
    this.plane = null;
    this.lockNormal = null;
    this.heldPlane = null;
    this.lockSnap = null;
    this.gesture.reset();
  }
}

/** The four corners (a, b, c, d) of a rotated rectangle. */
export function rotatedRectangleCorners(p: RotatedRectangleParams): { a: Vec3; b: Vec3; c: Vec3; d: Vec3 } {
  const u = v3normalize(v3sub(p.b, p.a));
  const n = v3normalize(p.normal);
  const v = v3normalize(v3cross(n, u));
  const rad = (p.angleDeg * Math.PI) / 180;
  const dir: Vec3 = [
    v[0] * Math.cos(rad) + n[0] * Math.sin(rad),
    v[1] * Math.cos(rad) + n[1] * Math.sin(rad),
    v[2] * Math.cos(rad) + n[2] * Math.sin(rad),
  ];
  return { a: p.a, b: p.b, c: v3addScaled(p.b, dir, p.width), d: v3addScaled(p.a, dir, p.width) };
}

/** `width,angle` (either omitted), a bare width, or an angle. Null when nothing applies. */
function widthAngleFromVcb(v: VcbValue): { width: number | null; angleDeg: number | null } | null {
  if (v.kind === 'list') {
    const [w, a] = v.values;
    const width = w && w.kind === 'length' ? w.meters : null;
    const angleDeg = a ? degreesFromVcb(a) : null;
    return width === null && angleDeg === null ? null : { width, angleDeg };
  }
  if (v.kind === 'length') return { width: v.meters, angleDeg: null };
  if (v.kind === 'angle' || v.kind === 'slope') return { width: null, angleDeg: v.degrees };
  return null;
}
