// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { basisToLocal, MERGE_TOL, planeBasis, planeFromPointNormal, v3dist } from '@pushform/core';
import type { Plane, PlaneBasis, Vec2, Vec3 } from '@pushform/core';
import { tessellateCircle } from '@pushform/geom';
import type { Tessellation } from '@pushform/geom';
import type { Axis, InferenceOptions, InferenceResult, Snap } from '@pushform/inference';
import { SNAP_COLORS } from '@pushform/inference';
import type { VcbKind, VcbValue } from '../../vcb/parse';
import type { AddCurveInput, AddCurveResult } from '../../commands/curves';
import type { OverlayPrimitive } from '../overlay';
import type { Tool, ToolContext, ToolKeyEvent, ToolPointerEvent, ToolStatus } from '../Tool';
import { hostOfTool, inferenceOverlay, PREVIEW_COLOR } from '../toolUtil';
import {
  AXIS_NORMAL,
  ClickGesture,
  drawingPlaneAt,
  formatLen,
  hoverPlane,
  isShiftPress,
  onPlane,
  planeLockFromKey,
  shapePreview,
  sidesFromVcb,
  toggleLock,
  undoLast,
  type LastCommit,
} from './drawingUtil';

export interface CircleParams {
  readonly center: Vec3;
  readonly normal: Vec3;
  /** Distance from the centre to the picked point (vertex radius for circles / inscribed polygons). */
  readonly radius: number;
  readonly segments: number;
  /** Angle of the first vertex in the plane basis (the vertex follows the cursor). */
  readonly startAngle: number;
}

/**
 * Circle tool (C). Idle → Center → Radius → commit. Before the first click the VCB sets
 * the number of sides (`24` / `24s`); after it the radius (`Ns` still changes the sides). The
 * drawing plane comes from the hovered face, an arrow-key lock, or Shift (holds the plane under
 * the cursor). `segments` persists for the session; typing after the commit re-edits the last
 * circle. Commits through `sketch.addCurve`, so the edges carry a Curve record.
 */
export class CircleTool implements Tool {
  readonly id: string = 'circle';
  readonly title: string = 'Circle';
  readonly cursor = 'crosshair';
  readonly vcbSchema: readonly VcbKind[] = ['segments', 'length', 'radius'];

  /** Sides of the next circle (session setting, default 24). */
  segments = 24;

  protected ctx: ToolContext | null = null;
  protected center: Vec3 | null = null;
  protected plane: Plane | null = null;
  protected basis: PlaneBasis | null = null;
  protected lockNormal: Axis | null = null;
  protected heldPlane: Plane | null = null;
  protected lockSnap: Snap | null = null;
  protected cursorInference: InferenceResult | null = null;
  protected cursorScreen: Vec2 | null = null;
  protected last: LastCommit<CircleParams> | null = null;
  protected readonly gesture = new ClickGesture();

  get centerPoint(): Vec3 | null {
    return this.center;
  }
  get planeLock(): Axis | null {
    return this.lockNormal;
  }
  get lastParams(): CircleParams | null {
    return this.last?.params ?? null;
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
    return { anchor: this.center ?? undefined, plane: plane ?? undefined, lockAxis: null, lockSnap: this.lockSnap };
  }

  onPointerMove(e: ToolPointerEvent): void {
    this.track(e);
    this.ctx?.requestRender();
    this.ctx?.statusChanged();
  }

  onPointerDown(e: ToolPointerEvent): void {
    if (!this.gesture.down(e)) return;
    if (!this.center && e.inference) {
      this.track(e);
      this.start(e.inference);
      this.gesture.handledOnDown();
    }
  }

  onPointerUp(e: ToolPointerEvent): void {
    if (!this.gesture.up(e)) return;
    if (this.center && e.inference) {
      this.track(e);
      this.commitCurrent();
    }
  }

  onClick(e: ToolPointerEvent): void {
    if (!this.gesture.click(e) || !e.inference) return;
    this.track(e);
    if (!this.center) this.start(e.inference);
    else this.commitCurrent();
  }

  onKeyDown(e: ToolKeyEvent): boolean {
    const lock = planeLockFromKey(e.key);
    if (lock !== undefined) {
      this.setLock(lock);
      return true;
    }
    if (isShiftPress(e)) {
      // Shift holds the plane under the cursor (and the current inference) until released.
      const inf = this.cursorInference;
      this.lockSnap = inf?.primary ?? null;
      if (inf && !this.center) this.heldPlane = hoverPlane(inf);
      return true;
    }
    return this.onExtraKey(e);
  }

  onKeyUp(e: ToolKeyEvent): boolean {
    if (e.key !== 'Shift') return false;
    this.lockSnap = null;
    this.heldPlane = null;
    return true;
  }

  onVcb(v: VcbValue): void {
    if (!this.center) {
      // Before the first click: sides. After a commit: re-edit the last shape.
      if (this.last && this.ctx && (v.kind === 'length' || v.kind === 'radius' || v.kind === 'circumscribed' || v.kind === 'segments')) {
        if (this.reapplyLast(v)) return;
      }
      const sides = sidesFromVcb(v);
      if (sides !== null) this.setSegments(sides);
      return;
    }
    if (v.kind === 'segments') {
      this.setSegments(v.count);
      this.ctx?.requestRender();
      return;
    }
    const r = this.radiusFromVcb(v);
    if (r !== null && r > MERGE_TOL) this.commit(r, this.segments, this.currentStartAngle());
  }

  onCancel(): void {
    this.reset();
    this.ctx?.requestRender();
    this.ctx?.statusChanged();
  }

  overlay(): readonly OverlayPrimitive[] {
    const out: OverlayPrimitive[] = [];
    const inf = this.cursorInference;
    if (this.center && this.plane && inf) {
      const r = this.currentRadius();
      if (r > MERGE_TOL) {
        const tess = this.tessellate(this.center, this.plane.n, r, this.segments, this.currentStartAngle());
        out.push(...shapePreview(tess.points, true, PREVIEW_COLOR, SNAP_COLORS.onFace));
        out.push({ kind: 'polyline', points: [this.center, onPlane(this.plane, inf.point)], color: PREVIEW_COLOR, dashed: true });
      }
      out.push({ kind: 'point', position: this.center, color: PREVIEW_COLOR, shape: 'square', size: 6 });
    }
    out.push(...inferenceOverlay(inf, this.cursorScreen ?? undefined));
    return out;
  }

  status(): ToolStatus {
    if (!this.center) return { instructor: 'Select center point.', vcbLabel: 'Sides', vcbValue: String(this.segments) };
    return {
      instructor: `Select point on ${this.shapeName} or enter value.`,
      vcbLabel: 'Radius',
      vcbValue: formatLen(this.ctx, this.currentRadius()),
    };
  }

  // --- hooks for Polygon ----------------------------------------------------------------------

  protected get shapeName(): string {
    return 'circle';
  }
  protected get minSides(): number {
    return 3;
  }
  protected tessellate(center: Vec3, normal: Vec3, radius: number, segments: number, startAngle: number): Tessellation {
    return tessellateCircle(center, normal, radius, segments, startAngle);
  }
  protected radiusFromVcb(v: VcbValue): number | null {
    return v.kind === 'length' || v.kind === 'radius' ? v.meters : null;
  }
  protected onExtraKey(_e: ToolKeyEvent): boolean {
    return false;
  }

  // --- internals ------------------------------------------------------------------------------

  protected track(e: ToolPointerEvent): void {
    this.cursorInference = e.inference;
    this.cursorScreen = e.screen;
  }

  protected setSegments(n: number): void {
    this.segments = Math.max(this.minSides, Math.round(n));
    this.ctx?.statusChanged();
  }

  protected start(inf: InferenceResult): void {
    const p = inf.point;
    this.plane = drawingPlaneAt(inf, p, this.lockNormal, this.heldPlane);
    this.basis = planeBasis(p, this.plane.n);
    this.center = p;
    this.ctx?.statusChanged();
  }

  protected currentRadius(): number {
    if (!this.center || !this.plane || !this.cursorInference) return 0;
    return v3dist(this.center, onPlane(this.plane, this.cursorInference.point));
  }

  protected currentStartAngle(): number {
    if (!this.basis || !this.plane || !this.cursorInference) return 0;
    const l = basisToLocal(this.basis, onPlane(this.plane, this.cursorInference.point));
    return Math.hypot(l[0], l[1]) > MERGE_TOL ? Math.atan2(l[1], l[0]) : 0;
  }

  protected commitCurrent(): void {
    const r = this.currentRadius();
    if (r <= MERGE_TOL) return;
    this.commit(r, this.segments, this.currentStartAngle());
  }

  protected commit(radius: number, segments: number, startAngle: number): void {
    if (!this.ctx || !this.center || !this.plane) return;
    const params: CircleParams = { center: this.center, normal: this.plane.n, radius, segments, startAngle };
    this.execute(params);
    this.reset();
    this.ctx.requestRender();
    this.ctx.statusChanged();
  }

  /** Run `sketch.addCurve` for the params and remember the undo entry for VCB re-edits. */
  protected execute(params: CircleParams): AddCurveResult {
    const ctx = this.ctx!;
    const tess = this.tessellate(params.center, params.normal, params.radius, params.segments, params.startAngle);
    const payload: AddCurveInput = { points: tess.points, closed: true, curve: tess.curve };
    const res = ctx.commands.execute('sketch.addCurve', payload) as AddCurveResult;
    this.last = { params, entry: hostOfTool(ctx).undoStack.peek() };
    return res;
  }

  /** VCB typed right after a commit: undo it and redraw with the new radius / sides. */
  protected reapplyLast(v: VcbValue): boolean {
    if (!this.ctx || !this.last) return false;
    const prev = this.last.params;
    let next: CircleParams;
    if (v.kind === 'segments') {
      this.setSegments(v.count);
      next = { ...prev, segments: this.segments };
    } else {
      const r = this.radiusFromVcb(v);
      if (r === null || r <= MERGE_TOL) return false;
      next = { ...prev, radius: r };
    }
    if (!undoLast(this.ctx, this.last)) return false;
    this.execute(next);
    this.ctx.requestRender();
    this.ctx.statusChanged();
    return true;
  }

  protected setLock(axis: Axis | null): void {
    this.lockNormal = toggleLock(this.lockNormal, axis);
    if (this.center) {
      const n = this.lockNormal ? AXIS_NORMAL[this.lockNormal] : (this.plane?.n ?? [0, 0, 1]);
      this.plane = planeFromPointNormal(this.center, n);
      this.basis = planeBasis(this.center, n);
    }
    this.ctx?.requestRender();
  }

  protected reset(): void {
    this.center = null;
    this.plane = null;
    this.basis = null;
    this.lockNormal = null;
    this.heldPlane = null;
    this.lockSnap = null;
    this.gesture.reset();
  }
}
