// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { basisToLocal, MERGE_TOL, planeBasis, planeFromPointNormal, v3add, v3dist, v3normalize, v3scale, v3sub } from '@pushform/core';
import type { Plane, PlaneBasis, Vec2, Vec3 } from '@pushform/core';
import { tessellateArc } from '@pushform/geom';
import type { Axis, InferenceOptions, InferenceResult, Snap } from '@pushform/inference';
import { SNAP_COLORS } from '@pushform/inference';
import type { VcbKind, VcbValue } from '../../vcb/parse';
import type { AddCurveInput, AddCurveResult } from '../../commands/curves';
import type { OverlayPrimitive } from '../overlay';
import type { EntryField, Tool, ToolContext, ToolKeyEvent, ToolPointerEvent, ToolStatus } from '../Tool';
import { angleDimension, DIMENSION_COLOR, field, pxAt } from '../entry';
import { hostOfTool, inferenceOverlay, PREVIEW_COLOR } from '../toolUtil';
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
  shapePreview,
  toggleLock,
  undoLast,
  wrapPi,
  type LastCommit,
} from './drawingUtil';

export interface ArcParams {
  readonly center: Vec3;
  readonly normal: Vec3;
  readonly radius: number;
  readonly startAngle: number;
  /** Signed sweep (radians), CCW about `normal` when positive. */
  readonly sweep: number;
  readonly segments: number;
}

/** Arc tool default segment count. */
export const ARC_SEGMENTS = 12;

/**
 * Arc tool (centre arc): Idle → Center → Radius point → End angle → commit. VCB: the circle's
 * diameter (or `24r` a radius) in the radius stage, angle (degrees, `45` or `45deg`) in the angle
 * stage, `Ns` segments any time; typing
 * after the commit re-edits the last arc. The plane comes from the hovered face / arrow lock /
 * Shift. Pie (`pie: true`) closes the arc back through the centre with two edges so a face forms.
 */
export class ArcTool implements Tool {
  readonly id: string;
  readonly title: string;
  readonly cursor = 'crosshair';
  readonly vcbSchema: readonly VcbKind[] = ['length', 'radius', 'angle', 'segments'];

  /** Segments of the next arc (session setting). */
  segments = ARC_SEGMENTS;

  protected ctx: ToolContext | null = null;
  protected center: Vec3 | null = null;
  protected plane: Plane | null = null;
  protected basis: PlaneBasis | null = null;
  protected radius: number | null = null;
  protected startAngle = 0;
  protected sweep = 0;
  protected lockNormal: Axis | null = null;
  protected heldPlane: Plane | null = null;
  protected lockSnap: Snap | null = null;
  protected cursorInference: InferenceResult | null = null;
  protected cursorScreen: Vec2 | null = null;
  protected last: LastCommit<ArcParams> | null = null;
  protected readonly gesture = new ClickGesture();

  constructor(protected readonly pie = false) {
    this.id = pie ? 'pie' : 'arc';
    this.title = pie ? 'Pie' : 'Arc';
  }

  get stage(): 'center' | 'radius' | 'angle' {
    return !this.center ? 'center' : this.radius === null ? 'radius' : 'angle';
  }
  get lastParams(): ArcParams | null {
    return this.last?.params ?? null;
  }

  hasPendingWork(): boolean {
    return this.center !== null;
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
    if (this.stage === 'radius' && e.inference) {
      this.track(e);
      this.pickRadius();
    }
  }

  onClick(e: ToolPointerEvent): void {
    if (!this.gesture.click(e) || !e.inference) return;
    this.track(e);
    switch (this.stage) {
      case 'center':
        this.start(e.inference);
        break;
      case 'radius':
        this.pickRadius();
        break;
      case 'angle':
        this.commitCurrent();
        break;
    }
  }

  onKeyDown(e: ToolKeyEvent): boolean {
    const lock = planeLockFromKey(e.key);
    if (lock !== undefined) {
      this.setLock(lock);
      return true;
    }
    if (isShiftPress(e)) {
      const inf = this.cursorInference;
      this.lockSnap = inf?.primary ?? null;
      if (inf && !this.center) this.heldPlane = hoverPlane(inf);
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
    if (v.kind === 'segments') {
      this.setSegments(v.count);
      if (this.stage === 'center' && this.last) this.reapplyLast({ segments: this.segments });
      this.ctx?.requestRender();
      return;
    }
    switch (this.stage) {
      case 'center': {
        if (!this.last) return;
        if (v.kind === 'length' || v.kind === 'radius') this.reapplyLast({ radius: v.kind === 'length' ? v.meters / 2 : v.meters });
        else {
          const deg = degreesFromVcb(v);
          if (deg !== null) this.reapplyLast({ sweep: (deg * Math.PI) / 180 });
        }
        return;
      }
      case 'radius': {
        if (v.kind !== 'length' && v.kind !== 'radius') return;
        const r = v.kind === 'length' ? v.meters / 2 : v.meters;
        if (r <= MERGE_TOL) return;
        this.radius = r;
        this.startAngle = this.cursorAngle() ?? 0;
        this.sweep = 0;
        this.ctx?.statusChanged();
        return;
      }
      case 'angle': {
        const deg = degreesFromVcb(v);
        if (deg === null || Math.abs(deg) < 1e-9) return;
        this.commit((deg * Math.PI) / 180);
      }
    }
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
      out.push({ kind: 'point', position: this.center, color: PREVIEW_COLOR, shape: 'square', size: 6 });
      const cursor = onPlane(this.plane, inf.point);
      if (this.stage === 'radius') {
        out.push({ kind: 'polyline', points: [this.center, cursor], color: PREVIEW_COLOR, width: 2 });
        const r = this.cursorRadius();
        if (r > MERGE_TOL) out.push({ kind: 'circle', center: this.center, normal: this.plane.n, radius: r, color: DIMENSION_COLOR, dashed: true, width: 1 });
        out.push(...this.radiusDimension().overlay);
      } else if (this.radius !== null) {
        const sweep = this.currentSweep();
        const pts = this.points(this.center, this.plane.n, this.radius, this.startAngle, sweep, this.segments);
        if (this.pie && pts.length >= 2) {
          out.push({ kind: 'polygon', points: [this.center, ...pts], color: SNAP_COLORS.onFace, opacity: 0.12 });
          out.push({ kind: 'polyline', points: [this.center, ...pts], color: PREVIEW_COLOR, closed: true, width: 2 });
        } else {
          out.push(...shapePreview(pts, false));
          out.push({ kind: 'polyline', points: [this.center, pts[0]!], color: PREVIEW_COLOR, dashed: true });
          out.push({ kind: 'polyline', points: [this.center, pts[pts.length - 1]!], color: PREVIEW_COLOR, dashed: true });
        }
        out.push(...this.angleDimension(sweep).overlay);
      }
    }
    out.push(...inferenceOverlay(inf, this.cursorScreen ?? undefined));
    return out;
  }

  status(): ToolStatus {
    switch (this.stage) {
      case 'center':
        return { instructor: 'Select center point.', vcbLabel: 'Sides', vcbValue: String(this.segments) };
      case 'radius':
        return {
          instructor: 'Select point on arc or enter diameter.',
          vcbLabel: 'Diameter',
          vcbValue: formatLen(this.ctx, 2 * this.cursorRadius()),
          fields: this.radiusDimension().fields,
        };
      default: {
        const sweep = this.currentSweep();
        return {
          instructor: 'Select end of arc or enter angle.',
          vcbLabel: 'Angle',
          vcbValue: formatDeg((sweep * 180) / Math.PI),
          fields: this.angleDimension(sweep).fields,
        };
      }
    }
  }

  // --- internals ------------------------------------------------------------------------------

  protected track(e: ToolPointerEvent): void {
    this.cursorInference = e.inference;
    this.cursorScreen = e.screen;
    if (this.stage === 'angle') this.sweep = this.currentSweep();
  }

  protected setSegments(n: number): void {
    this.segments = Math.max(1, Math.round(n));
    this.ctx?.statusChanged();
  }

  protected start(inf: InferenceResult): void {
    const p = inf.point;
    this.plane = drawingPlaneAt(inf, p, this.lockNormal, this.heldPlane);
    this.basis = planeBasis(p, this.plane.n);
    this.center = p;
    this.radius = null;
    this.sweep = 0;
    this.ctx?.statusChanged();
  }

  /** Diameter dimension through the centre toward the pointer, running on to the field beside the circle. */
  private radiusDimension(): { overlay: OverlayPrimitive[]; fields: EntryField[] } {
    const r = this.cursorRadius();
    const value = formatLen(this.ctx, 2 * r);
    if (!this.center || !this.plane || !this.cursorInference || r <= MERGE_TOL) return { overlay: [], fields: [field('diameter', 'Diameter', 'length', value, undefined)] };
    const dir = v3normalize(v3sub(onPlane(this.plane, this.cursorInference.point), this.center));
    const far = v3add(this.center, v3scale(dir, r + pxAt(this.ctx, this.center, 16)));
    return {
      overlay: [{ kind: 'polyline', points: [v3add(this.center, v3scale(dir, -r)), far], color: DIMENSION_COLOR, width: 1 }],
      fields: [field('diameter', 'Diameter', 'length', value, far, false, dir)],
    };
  }

  /** Gray arc inside the arc's radius over the swept angle, with the Angle field on it. */
  private angleDimension(sweep: number): { overlay: OverlayPrimitive[]; fields: EntryField[] } {
    const value = formatDeg((sweep * 180) / Math.PI);
    if (!this.center || !this.basis || this.radius === null || Math.abs(sweep) < 1e-9) return { overlay: [], fields: [field('angle', 'Angle', 'angle', value, undefined)] };
    const r = Math.min(this.radius * 0.6, Math.max(this.radius * 0.3, pxAt(this.ctx, this.center, 60)));
    const dim = angleDimension(this.center, this.basis.u, this.basis.v, r, this.startAngle, sweep);
    return { overlay: dim.overlay, fields: [field('angle', 'Angle', 'angle', value, dim.at, false, dim.away)] };
  }

  private cursorRadius(): number {
    if (!this.center || !this.plane || !this.cursorInference) return 0;
    return v3dist(this.center, onPlane(this.plane, this.cursorInference.point));
  }

  /** Angle of the cursor about the centre in the plane basis, or null at the centre. */
  private cursorAngle(): number | null {
    if (!this.basis || !this.plane || !this.cursorInference) return null;
    const l = basisToLocal(this.basis, onPlane(this.plane, this.cursorInference.point));
    return Math.hypot(l[0], l[1]) > MERGE_TOL ? Math.atan2(l[1], l[0]) : null;
  }

  /** Sweep that follows the cursor continuously (unwrapped relative to the previous sweep). */
  private currentSweep(): number {
    const a = this.cursorAngle();
    if (a === null) return this.sweep;
    const next = this.sweep + wrapPi(a - (this.startAngle + this.sweep));
    return Math.max(-Math.PI * 2, Math.min(Math.PI * 2, next));
  }

  private pickRadius(): void {
    const r = this.cursorRadius();
    if (r <= MERGE_TOL) return;
    this.radius = r;
    this.startAngle = this.cursorAngle() ?? 0;
    this.sweep = 0;
    this.ctx?.statusChanged();
  }

  private commitCurrent(): void {
    const sweep = this.currentSweep();
    if (Math.abs(sweep) < 1e-9) return;
    this.commit(sweep);
  }

  private commit(sweep: number): void {
    if (!this.ctx || !this.center || !this.plane || this.radius === null) return;
    this.execute({ center: this.center, normal: this.plane.n, radius: this.radius, startAngle: this.startAngle, sweep, segments: this.segments });
    this.reset();
    this.ctx.requestRender();
    this.ctx.statusChanged();
  }

  private points(center: Vec3, normal: Vec3, radius: number, start: number, sweep: number, segments: number): Vec3[] {
    return tessellateArc(center, normal, radius, start, start + sweep, segments).points;
  }

  protected execute(params: ArcParams): AddCurveResult {
    const ctx = this.ctx!;
    const tess = tessellateArc(params.center, params.normal, params.radius, params.startAngle, params.startAngle + params.sweep, params.segments);
    const payload: AddCurveInput = this.pie
      ? { points: tess.points, closed: false, curve: tess.curve, closeTo: params.center }
      : { points: tess.points, closed: false, curve: tess.curve };
    const res = ctx.commands.execute('sketch.addCurve', payload) as AddCurveResult;
    this.last = { params, entry: hostOfTool(ctx).undoStack.peek() };
    return res;
  }

  private reapplyLast(patch: Partial<ArcParams>): void {
    if (!this.ctx || !this.last) return;
    const next = { ...this.last.params, ...patch };
    if (next.radius <= MERGE_TOL || Math.abs(next.sweep) < 1e-9) return;
    if (!undoLast(this.ctx, this.last)) return;
    this.execute(next);
    this.ctx.requestRender();
    this.ctx.statusChanged();
  }

  private setLock(axis: Axis | null): void {
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
    this.radius = null;
    this.startAngle = 0;
    this.sweep = 0;
    this.lockNormal = null;
    this.heldPlane = null;
    this.lockSnap = null;
    this.gesture.reset();
  }
}
