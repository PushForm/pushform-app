// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { MERGE_TOL, planeFromPointNormal, v3addScaled, v3dist, v3len, v3normalize, v3sub } from '@pushform/core';
import type { Plane, Vec2, Vec3 } from '@pushform/core';
import { arcFrom3Points } from '@pushform/geom';
import type { Tessellation } from '@pushform/geom';
import type { Axis, InferenceOptions, InferenceResult, Snap } from '@pushform/inference';
import type { VcbKind, VcbValue } from '../../vcb/parse';
import type { AddCurveInput, AddCurveResult } from '../../commands/curves';
import type { OverlayPrimitive } from '../overlay';
import type { Tool, ToolContext, ToolKeyEvent, ToolPointerEvent, ToolStatus } from '../Tool';
import { pointerField } from '../entry';
import { hostOfTool, inferenceOverlay, PREVIEW_COLOR } from '../toolUtil';
import { ARC_SEGMENTS } from './Arc';
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
  toggleLock,
  undoLast,
  type LastCommit,
} from './drawingUtil';

export interface Arc3Params {
  readonly start: Vec3;
  readonly pivot: Vec3;
  readonly end: Vec3;
  readonly segments: number;
}

/**
 * 3-Point Arc: Idle → Start → Pivot (second point on the arc) → End → commit, through
 * `arcFrom3Points`. VCB: length of the start→pivot leg in the pivot stage, `Ns` segments any
 * time; `Ns` after the commit re-tessellates the last arc. The drawing plane (hovered face /
 * arrow lock / Shift) only constrains free points; three snapped points define their own plane.
 */
export class ThreePointArcTool implements Tool {
  readonly id = 'arc3';
  readonly title = '3 Point Arc';
  readonly cursor = 'crosshair';
  readonly vcbSchema: readonly VcbKind[] = ['length', 'segments'];

  segments = ARC_SEGMENTS;

  private ctx: ToolContext | null = null;
  private start: Vec3 | null = null;
  private pivot: Vec3 | null = null;
  private plane: Plane | null = null;
  private lockNormal: Axis | null = null;
  private heldPlane: Plane | null = null;
  private lockSnap: Snap | null = null;
  private cursorInference: InferenceResult | null = null;
  private cursorScreen: Vec2 | null = null;
  private last: LastCommit<Arc3Params> | null = null;
  private readonly gesture = new ClickGesture();

  get stage(): 'start' | 'pivot' | 'end' {
    return !this.start ? 'start' : !this.pivot ? 'pivot' : 'end';
  }
  get lastParams(): Arc3Params | null {
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
    return { anchor: this.pivot ?? this.start ?? undefined, plane: plane ?? undefined, lockAxis: null, lockSnap: this.lockSnap };
  }

  onPointerMove(e: ToolPointerEvent): void {
    this.track(e);
    this.ctx?.requestRender();
    this.ctx?.statusChanged();
  }

  onPointerDown(e: ToolPointerEvent): void {
    if (!this.gesture.down(e)) return;
    if (!this.start && e.inference) {
      this.track(e);
      this.begin(e.inference);
      this.gesture.handledOnDown();
    }
  }

  onPointerUp(e: ToolPointerEvent): void {
    if (!this.gesture.up(e)) return;
    if (this.stage === 'pivot' && e.inference) {
      this.track(e);
      this.pickPivot(e.inference.point);
    }
  }

  onClick(e: ToolPointerEvent): void {
    if (!this.gesture.click(e) || !e.inference) return;
    this.track(e);
    switch (this.stage) {
      case 'start':
        this.begin(e.inference);
        break;
      case 'pivot':
        this.pickPivot(e.inference.point);
        break;
      case 'end':
        this.commit(onPlane(this.plane, e.inference.point));
    }
  }

  onKeyDown(e: ToolKeyEvent): boolean {
    const lock = planeLockFromKey(e.key);
    if (lock !== undefined) {
      this.lockNormal = toggleLock(this.lockNormal, lock);
      if (this.start) this.plane = planeFromPointNormal(this.start, this.lockNormal ? AXIS_NORMAL[this.lockNormal] : (this.plane?.n ?? [0, 0, 1]));
      this.ctx?.requestRender();
      return true;
    }
    if (isShiftPress(e)) {
      const inf = this.cursorInference;
      this.lockSnap = inf?.primary ?? null;
      if (inf && !this.start) this.heldPlane = hoverPlane(inf);
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
      this.segments = Math.max(1, Math.round(v.count));
      if (this.stage === 'start' && this.last && this.ctx && undoLast(this.ctx, this.last)) {
        this.execute({ ...this.last.params, segments: this.segments });
        this.ctx.requestRender();
      }
      this.ctx?.statusChanged();
      return;
    }
    if (v.kind !== 'length' || v.meters <= MERGE_TOL) return;
    const from = this.stage === 'pivot' ? this.start : this.stage === 'end' ? this.pivot : null;
    if (!from || !this.cursorInference) return;
    const dir = this.lockSnap?.dir ?? v3sub(onPlane(this.plane, this.cursorInference.point), from);
    if (v3len(dir) <= MERGE_TOL) return;
    const p = v3addScaled(from, v3normalize(dir), v.meters);
    if (this.stage === 'pivot') this.pickPivot(p);
    else this.commit(p);
  }

  onCancel(): void {
    this.reset();
    this.ctx?.requestRender();
    this.ctx?.statusChanged();
  }

  overlay(): readonly OverlayPrimitive[] {
    const out: OverlayPrimitive[] = [];
    const inf = this.cursorInference;
    if (this.start) out.push({ kind: 'point', position: this.start, color: PREVIEW_COLOR, shape: 'square', size: 6 });
    if (this.start && inf && this.stage === 'pivot') {
      out.push({ kind: 'polyline', points: [this.start, onPlane(this.plane, inf.point)], color: PREVIEW_COLOR, width: 2 });
    } else if (this.start && this.pivot && inf) {
      out.push({ kind: 'point', position: this.pivot, color: PREVIEW_COLOR, shape: 'square', size: 6 });
      const tess = this.tessellation(onPlane(this.plane, inf.point));
      if (tess) out.push(...shapePreview(tess.points, false));
      else out.push({ kind: 'polyline', points: [this.start, this.pivot, onPlane(this.plane, inf.point)], color: PREVIEW_COLOR, width: 2 });
    }
    out.push(...inferenceOverlay(inf, this.cursorScreen ?? undefined));
    return out;
  }

  status(): ToolStatus {
    switch (this.stage) {
      case 'start':
        return { instructor: 'Select start point of arc.', vcbLabel: 'Length' };
      case 'pivot': {
        const len = this.start && this.cursorInference ? v3dist(this.start, onPlane(this.plane, this.cursorInference.point)) : 0;
        return { instructor: 'Select second point on arc or enter length.', vcbLabel: 'Length', vcbValue: formatLen(this.ctx, len), fields: [pointerField('Length', 'length', formatLen(this.ctx, len))] };
      }
      default: {
        const tess = this.cursorInference ? this.tessellation(onPlane(this.plane, this.cursorInference.point)) : null;
        return { instructor: 'Select end point of arc.', vcbLabel: 'Radius', vcbValue: tess ? formatLen(this.ctx, tess.curve.radius) : undefined };
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
    this.start = p;
    this.pivot = null;
    this.ctx?.statusChanged();
  }

  private pickPivot(p: Vec3): void {
    if (!this.start) return;
    const q = onPlane(this.plane, p);
    if (v3dist(this.start, q) <= MERGE_TOL) return;
    this.pivot = q;
    this.ctx?.statusChanged();
  }

  private tessellation(end: Vec3): Tessellation | null {
    if (!this.start || !this.pivot) return null;
    if (v3dist(end, this.pivot) <= MERGE_TOL || v3dist(end, this.start) <= MERGE_TOL) return null;
    return arcFrom3Points(this.start, this.pivot, end, this.segments);
  }

  private commit(end: Vec3): void {
    if (!this.ctx || !this.start || !this.pivot) return;
    if (!this.tessellation(end)) return;
    this.execute({ start: this.start, pivot: this.pivot, end, segments: this.segments });
    this.reset();
    this.ctx.requestRender();
    this.ctx.statusChanged();
  }

  private execute(params: Arc3Params): AddCurveResult | null {
    const ctx = this.ctx!;
    const tess = arcFrom3Points(params.start, params.pivot, params.end, params.segments);
    if (!tess) return null;
    const payload: AddCurveInput = { points: tess.points, closed: false, curve: tess.curve };
    const res = ctx.commands.execute('sketch.addCurve', payload) as AddCurveResult;
    this.last = { params, entry: hostOfTool(ctx).undoStack.peek() };
    return res;
  }

  private reset(): void {
    this.start = null;
    this.pivot = null;
    this.plane = null;
    this.lockNormal = null;
    this.heldPlane = null;
    this.lockSnap = null;
    this.gesture.reset();
  }
}
