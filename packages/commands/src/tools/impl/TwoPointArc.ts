// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { MERGE_TOL, planeFromPointNormal, v3addScaled, v3cross, v3dist, v3dot, v3len, v3lerp, v3normalize, v3sub } from '@pushform/core';
import type { MVec3, Plane, Vec2, Vec3 } from '@pushform/core';
import { arcFromBulge } from '@pushform/geom';
import type { Tessellation } from '@pushform/geom';
import type { Axis, InferenceOptions, InferenceResult, Snap } from '@pushform/inference';
import { SNAP_COLORS } from '@pushform/inference';
import type { VcbKind, VcbValue } from '../../vcb/parse';
import type { AddCurveInput, AddCurveResult, FilletResult } from '../../commands/curves';
import type { OverlayPrimitive } from '../overlay';
import type { Tool, ToolContext, ToolKeyEvent, ToolPointerEvent, ToolStatus } from '../Tool';
import { pointerField } from '../entry';
import { hostOfTool, inferenceOverlay, PREVIEW_COLOR } from '../toolUtil';
import { ARC_SEGMENTS } from './Arc';
import {
  contextCurveTangentAt,
  AXIS_NORMAL,
  ClickGesture,
  drawingPlaneAt,
  formatLen,
  hoverPlane,
  isShiftPress,
  onPlane,
  pixelTolerance,
  planeLockFromKey,
  shapePreview,
  toggleLock,
  undoLast,
  type LastCommit,
} from './drawingUtil';

export interface Arc2Params {
  readonly start: Vec3;
  readonly end: Vec3;
  readonly normal: Vec3;
  /** DXF bulge = tan(θ/4); positive bows to the left of start→end (CCW about `normal`). */
  readonly bulge: number;
  readonly segments: number;
}

/** Screen tolerance for the Half Circle / Tangent at Vertex bulge snaps. */
const SNAP_PX = 5;

type Hint = 'Half Circle' | 'Tangent at Vertex' | null;

interface Bulge {
  /** Signed sagitta (distance from the chord midpoint to the arc). */
  readonly sagitta: number;
  readonly hint: Hint;
}

/**
 * 2-Point Arc (A): Idle → Start → End (chord) → Bulge → commit. VCB: chord length in the
 * end stage; in the bulge stage the bulge (sagitta) as a length, `24r` radius, `20s` segments;
 * after the commit the same values re-edit the last arc. Half Circle inference when the bulge is
 * half the chord; Tangent at Vertex (cyan) when the arc starts at the end of an existing curve.
 * Double-click a corner (two edges meeting) to fillet it with the last radius.
 */
export class TwoPointArcTool implements Tool {
  readonly id = 'arc2';
  readonly title = '2 Point Arc';
  readonly cursor = 'crosshair';
  readonly vcbSchema: readonly VcbKind[] = ['length', 'radius', 'segments'];

  segments = ARC_SEGMENTS;
  /** Radius of the last arc drawn: the fillet radius for double-click corners. */
  lastRadius: number | null = null;

  private ctx: ToolContext | null = null;
  private start: Vec3 | null = null;
  private end: Vec3 | null = null;
  private plane: Plane | null = null;
  private tangent: MVec3 | null = null;
  private lockNormal: Axis | null = null;
  private heldPlane: Plane | null = null;
  private lockSnap: Snap | null = null;
  private cursorInference: InferenceResult | null = null;
  private cursorScreen: Vec2 | null = null;
  private cursorEvent: ToolPointerEvent | null = null;
  private last: LastCommit<Arc2Params> | null = null;
  private message: string | null = null;
  private readonly gesture = new ClickGesture();

  get stage(): 'start' | 'end' | 'bulge' {
    return !this.start ? 'start' : !this.end ? 'end' : 'bulge';
  }
  get lastParams(): Arc2Params | null {
    return this.last?.params ?? null;
  }
  /** Tangent direction at the start point when it is the end of a curve. */
  get tangentDir(): Vec3 | null {
    return this.tangent;
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
    return { anchor: this.start ?? undefined, plane: plane ?? undefined, lockAxis: null, lockSnap: this.lockSnap };
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
    if (this.stage === 'end' && e.inference) {
      this.track(e);
      this.pickEnd(e.inference.point);
    }
  }

  onClick(e: ToolPointerEvent): void {
    if (!this.gesture.click(e) || !e.inference) return;
    this.track(e);
    this.message = null;
    switch (this.stage) {
      case 'start':
        this.begin(e.inference);
        break;
      case 'end':
        this.pickEnd(e.inference.point);
        break;
      case 'bulge': {
        const b = this.currentBulge();
        if (b) this.commitSagitta(b.sagitta);
      }
    }
  }

  /** Double-click a corner: fillet it with the last arc's radius (repeat-arc workflow). */
  onDoubleClick(e: ToolPointerEvent): void {
    if (e.button !== 0 || !e.inference || !this.ctx) return;
    if (this.lastRadius === null) {
      this.message = 'Draw an arc first to set the fillet radius.';
      this.ctx.statusChanged();
      return;
    }
    this.reset();
    this.gesture.reset();
    try {
      this.ctx.commands.execute('sketch.fillet', { vertex: e.inference.point, radius: this.lastRadius, segments: this.segments }) as FilletResult;
      this.last = null;
      this.message = null;
    } catch (err) {
      this.message = err instanceof Error ? err.message : String(err);
    }
    this.ctx.requestRender();
    this.ctx.statusChanged();
  }

  onKeyDown(e: ToolKeyEvent): boolean {
    const lock = planeLockFromKey(e.key);
    if (lock !== undefined) {
      this.lockNormal = toggleLock(this.lockNormal, lock);
      if (this.start && this.stage === 'end') {
        this.plane = planeFromPointNormal(this.start, this.lockNormal ? AXIS_NORMAL[this.lockNormal] : (this.plane?.n ?? [0, 0, 1]));
      }
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
      if (this.stage === 'start' && this.last) this.reapplyLast({ segments: this.segments });
      this.ctx?.statusChanged();
      return;
    }
    switch (this.stage) {
      case 'start': {
        if (!this.last) return;
        const chord = v3dist(this.last.params.start, this.last.params.end);
        if (v.kind === 'length') this.reapplyLast({ bulge: this.bulgeOf(v.meters, chord, this.last.params.bulge) });
        else if (v.kind === 'radius') {
          const s = sagittaForRadius(v.meters, chord);
          if (s !== null) this.reapplyLast({ bulge: this.bulgeOf(s, chord, this.last.params.bulge) });
        }
        return;
      }
      case 'end': {
        if (v.kind !== 'length' || !this.start || v.meters <= MERGE_TOL) return;
        const dir = this.lockSnap?.dir ?? (this.cursorInference ? v3sub(onPlane(this.plane, this.cursorInference.point), this.start) : null);
        if (!dir || v3len(dir) <= MERGE_TOL) return;
        this.pickEnd(v3addScaled(this.start, v3normalize(dir), v.meters));
        return;
      }
      case 'bulge': {
        const chord = this.chord();
        if (!chord) return;
        const side = Math.sign(this.currentBulge()?.sagitta ?? 1) || 1;
        if (v.kind === 'length') this.commitSagitta(Math.abs(v.meters) * side);
        else if (v.kind === 'radius') {
          const s = sagittaForRadius(v.meters, chord.d);
          if (s !== null) this.commitSagitta(s * side);
          else this.message = 'Radius must be at least half the chord.';
        }
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
    if (this.start) out.push({ kind: 'point', position: this.start, color: PREVIEW_COLOR, shape: 'square', size: 6 });
    if (this.start && inf && this.stage === 'end') {
      const to = onPlane(this.plane, inf.point);
      out.push({ kind: 'polyline', points: [this.start, to], color: PREVIEW_COLOR, width: 2 });
      // Preview of the tangent arc to the cursor when the start continues a curve.
      const t = this.tangentArc(this.start, to);
      if (t) out.push(...shapePreview(t.points, false, SNAP_COLORS.tangent));
    } else if (this.start && this.end && this.stage === 'bulge') {
      out.push({ kind: 'polyline', points: [this.start, this.end], color: PREVIEW_COLOR, dashed: true });
      const b = this.currentBulge();
      const tess = b ? this.tessellation(b.sagitta) : null;
      if (tess) out.push(...shapePreview(tess.points, false, b?.hint === 'Tangent at Vertex' ? SNAP_COLORS.tangent : PREVIEW_COLOR));
      if (b?.hint) out.push({ kind: 'cursorHint', text: b.hint, screen: this.cursorScreen ?? undefined });
    }
    out.push(...inferenceOverlay(inf, this.cursorScreen ?? undefined));
    return out;
  }

  status(): ToolStatus {
    if (this.message) return { instructor: this.message, vcbLabel: 'Bulge' };
    switch (this.stage) {
      case 'start':
        return { instructor: 'Select start point of arc, or double-click a corner to fillet it.', vcbLabel: 'Length' };
      case 'end': {
        const len = this.start && this.cursorInference ? v3dist(this.start, onPlane(this.plane, this.cursorInference.point)) : 0;
        return { instructor: 'Select end point of arc or enter length.', vcbLabel: 'Length', vcbValue: formatLen(this.ctx, len), fields: [pointerField('Length', 'length', formatLen(this.ctx, len))] };
      }
      default: {
        const b = this.currentBulge();
        const value = formatLen(this.ctx, Math.abs(b?.sagitta ?? 0));
        return { instructor: 'Select bulge or enter value.', vcbLabel: 'Bulge', vcbValue: value, fields: [pointerField('Bulge', 'length', value)] };
      }
    }
  }

  // --- internals ------------------------------------------------------------------------------

  private track(e: ToolPointerEvent): void {
    this.cursorInference = e.inference;
    this.cursorScreen = e.screen;
    this.cursorEvent = e;
  }

  private begin(inf: InferenceResult): void {
    const p = inf.point;
    this.plane = drawingPlaneAt(inf, p, this.lockNormal, this.heldPlane);
    this.start = p;
    this.end = null;
    this.tangent = this.ctx ? contextCurveTangentAt(hostOfTool(this.ctx), p) : null;
    this.ctx?.statusChanged();
  }

  private pickEnd(p: Vec3): void {
    if (!this.start) return;
    const end = onPlane(this.plane, p);
    if (v3dist(this.start, end) <= MERGE_TOL) return;
    this.end = end;
    this.ctx?.statusChanged();
  }

  /** Chord geometry: direction, length, midpoint, in-plane left normal and the arc plane normal. */
  private chord(): { dir: MVec3; d: number; mid: MVec3; left: MVec3; n: MVec3 } | null {
    if (!this.start || !this.end || !this.plane) return null;
    const c = v3sub(this.end, this.start);
    const d = v3len(c);
    if (d <= MERGE_TOL) return null;
    const dir = v3normalize(c);
    let n = v3sub(this.plane.n, v3addScaled([0, 0, 0], dir, v3dot(this.plane.n, dir)));
    n = v3len(n) > 1e-9 ? v3normalize(n) : v3normalize(this.plane.n);
    const left = v3normalize(v3cross(n, dir));
    return { dir, d, mid: v3lerp(this.start, this.end, 0.5), left, n };
  }

  /** Sagitta of the arc tangent to `tangent` at start, ending at `end` (signed, in the chord frame), or null. */
  private tangentSagitta(ch: { dir: MVec3; d: number; left: MVec3 }): number | null {
    if (!this.tangent) return null;
    const cos = Math.max(-1, Math.min(1, v3dot(this.tangent, ch.dir)));
    const alpha = Math.acos(cos);
    if (alpha < 1e-6 || Math.PI - alpha < 1e-6) return null;
    const side = v3dot(this.tangent, ch.left) >= 0 ? 1 : -1;
    return side * Math.tan(alpha / 2) * (ch.d / 2);
  }

  private currentBulge(): Bulge | null {
    const ch = this.chord();
    if (!ch || !this.cursorInference) return null;
    const p = onPlane(this.plane, this.cursorInference.point);
    let sagitta = v3dot(v3sub(p, ch.mid), ch.left);
    const tol = pixelTolerance(this.ctx, this.cursorEvent, ch.mid, SNAP_PX);
    let hint: Hint = null;
    const ts = this.tangentSagitta(ch);
    if (ts !== null && Math.abs(sagitta - ts) <= tol) {
      sagitta = ts;
      hint = 'Tangent at Vertex';
    } else if (Math.abs(Math.abs(sagitta) - ch.d / 2) <= tol) {
      sagitta = (Math.sign(sagitta) || 1) * (ch.d / 2);
      hint = 'Half Circle';
    }
    return { sagitta, hint };
  }

  /**
   * DXF bulge for a sagitta signed along the chord's `left` (sign kept from `fallback` when the
   * sagitta carries none). A positive DXF bulge sweeps CCW about the normal, i.e. bows to the
   * right of a→b, hence the negation.
   */
  private bulgeOf(sagitta: number, chord: number, fallback = -1): number {
    const sign = Math.sign(sagitta) || -Math.sign(fallback) || 1;
    return (-sign * 2 * Math.abs(sagitta)) / chord;
  }

  private tessellation(sagitta: number): Tessellation | null {
    const ch = this.chord();
    if (!ch || !this.start || !this.end || Math.abs(sagitta) <= MERGE_TOL) return null;
    return arcFromBulge(this.start, this.end, this.bulgeOf(sagitta, ch.d), ch.n, this.segments);
  }

  /** Arc from `start` tangent to the curve there, ending at `to` (end-stage preview). */
  private tangentArc(start: Vec3, to: Vec3): Tessellation | null {
    if (!this.tangent || !this.plane) return null;
    const c = v3sub(to, start);
    const d = v3len(c);
    if (d <= MERGE_TOL) return null;
    const dir = v3normalize(c);
    const n = v3normalize(this.plane.n);
    const left = v3normalize(v3cross(n, dir));
    const cos = Math.max(-1, Math.min(1, v3dot(this.tangent, dir)));
    const alpha = Math.acos(cos);
    if (alpha < 1e-6 || Math.PI - alpha < 1e-6) return null;
    const side = v3dot(this.tangent, left) >= 0 ? 1 : -1;
    return arcFromBulge(start, to, -side * Math.tan(alpha / 2), n, this.segments);
  }

  private commitSagitta(sagitta: number): void {
    const ch = this.chord();
    if (!this.ctx || !this.start || !this.end || !ch) return;
    if (Math.abs(sagitta) <= MERGE_TOL) return;
    this.execute({ start: this.start, end: this.end, normal: ch.n, bulge: this.bulgeOf(sagitta, ch.d), segments: this.segments });
    this.reset();
    this.ctx.requestRender();
    this.ctx.statusChanged();
  }

  private execute(params: Arc2Params): AddCurveResult | null {
    const ctx = this.ctx!;
    const tess = arcFromBulge(params.start, params.end, params.bulge, params.normal, params.segments);
    if (!tess) return null;
    const payload: AddCurveInput = { points: tess.points, closed: false, curve: tess.curve };
    const res = ctx.commands.execute('sketch.addCurve', payload) as AddCurveResult;
    this.last = { params, entry: hostOfTool(ctx).undoStack.peek() };
    this.lastRadius = tess.curve.radius;
    return res;
  }

  private reapplyLast(patch: Partial<Arc2Params>): void {
    if (!this.ctx || !this.last) return;
    const next = { ...this.last.params, ...patch };
    if (Math.abs(next.bulge) < 1e-12) return;
    if (!undoLast(this.ctx, this.last)) return;
    this.execute(next);
    this.ctx.requestRender();
    this.ctx.statusChanged();
  }

  private reset(): void {
    this.start = null;
    this.end = null;
    this.plane = null;
    this.tangent = null;
    this.lockNormal = null;
    this.heldPlane = null;
    this.lockSnap = null;
    this.gesture.reset();
  }
}

/** Sagitta of the minor arc with radius `r` over chord `d`, or null when r < d/2. */
export function sagittaForRadius(r: number, d: number): number | null {
  const h = d / 2;
  if (r < h - MERGE_TOL) return null;
  return r - Math.sqrt(Math.max(0, r * r - h * h));
}
