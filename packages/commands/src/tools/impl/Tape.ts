// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { MVec3, Vec2, Vec3 } from '@pushform/core';
import { MERGE_TOL, planeFromPointNormal, v3addScaled, v3dist, v3len, v3normalize, v3sub } from '@pushform/core';
import type { Axis, InferenceOptions, InferenceResult, Snap } from '@pushform/inference';
import type { EntityRef } from '@pushform/model';
import type { VcbKind, VcbValue } from '../../vcb/parse';
import type { OverlayPrimitive } from '../overlay';
import type { Tool, ToolContext, ToolKeyEvent, ToolPointerEvent, ToolStatus } from '../Tool';
import { EdgeLock } from '../edgeLock';
import { inferenceOverlay, PREVIEW_COLOR } from '../toolUtil';
import { AXIS_NORMAL, closestOnLine, edgeSegment, fmtLength, GUIDE_COLOR, stateOf } from './constructionUtil';

export type TapeMode = 'guideLine' | 'guidePoint' | 'measure';
const MODE_CYCLE: readonly TapeMode[] = ['guideLine', 'guidePoint', 'measure'];

/** Half-length of the preview guide line drawn in the overlay (world units). */
const GUIDE_PREVIEW_HALF = 1000;

type State =
  | { readonly kind: 'idle' }
  | {
      /** Started on an edge: the guide will be parallel to it. */
      readonly kind: 'fromEdge';
      readonly from: Vec3;
      readonly dir: Vec3;
      readonly ref: EntityRef;
    }
  | { readonly kind: 'fromPoint'; readonly from: Vec3 };

export interface TapeMeasurement {
  readonly a: Vec3;
  readonly b: Vec3;
  readonly length: number;
}

export interface PendingResize {
  readonly measured: number;
  readonly target: number;
  readonly factor: number;
}

const IDLE: State = { kind: 'idle' };

/**
 * Tape Measure (T). Modes cycle with Ctrl/Alt: Guide Lines (default) → Guide Points → Measure.
 * - Guide Lines: click an edge, move away perpendicular, click (or type the offset) → infinite
 *   guide parallel to the edge through the offset point. Clicking a point instead starts a guide
 *   point with a dashed leader.
 * - Guide Points: click a point, click (or type the distance) → guide point + leader.
 * - Measure: click two points; the Measurements box reads the live length; hovering an edge shows
 *   its length. Typing a new length after a measurement proposes resizing the whole model: the
 *   tool exposes `pendingResize` and the UI confirms with `confirmResize()` (`model.resize`).
 * Arrow keys lock an axis; Shift holds the current inference.
 */
export class TapeTool implements Tool {
  readonly id = 'tape';
  readonly title = 'Tape Measure';
  readonly cursor = 'crosshair';
  readonly vcbSchema: readonly VcbKind[] = ['length'];

  private ctx: ToolContext | null = null;
  private state: State = IDLE;
  private modeIndex = 0;
  private cursorInference: InferenceResult | null = null;
  private cursorScreen: Vec2 | null = null;
  private lockAxis: Axis | null = null;
  private lockSnap: Snap | null = null;
  /** ↓ lock parallel / perpendicular to the last inferred edge. */
  private readonly edgeLock = new EdgeLock();
  private hoverEdgeLength: number | null = null;
  private lastMeasurement: TapeMeasurement | null = null;
  private resize: PendingResize | null = null;

  get mode(): TapeMode {
    return MODE_CYCLE[this.modeIndex]!;
  }
  get anchor(): Vec3 | null {
    return this.state.kind === 'idle' ? null : this.state.from;
  }
  get lastMeasure(): TapeMeasurement | null {
    return this.lastMeasurement;
  }
  /** A proposed model resize (typed length after a measurement) waiting for the UI's "Resize model?" confirmation. */
  get pendingResize(): PendingResize | null {
    return this.resize;
  }

  setMode(mode: TapeMode): void {
    this.modeIndex = MODE_CYCLE.indexOf(mode);
    this.ctx?.statusChanged();
  }

  /** Apply the pending resize (`model.resize`). Returns false when nothing is pending. */
  confirmResize(): boolean {
    const r = this.resize;
    if (!r || !this.ctx) return false;
    this.resize = null;
    this.ctx.commands.execute('model.resize', { factor: r.factor });
    if (this.lastMeasurement) {
      const m = this.lastMeasurement;
      this.lastMeasurement = { a: m.a, b: m.b, length: m.length * r.factor };
    }
    this.ctx.statusChanged();
    this.ctx.requestRender();
    return true;
  }

  cancelResize(): void {
    this.resize = null;
    this.ctx?.statusChanged();
  }

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
    this.state = IDLE;
  }
  deactivate(): void {
    this.reset();
    this.lastMeasurement = null;
    this.resize = null;
    this.edgeLock.clear();
    this.ctx = null;
  }

  inferenceOptions(): InferenceOptions {
    return { anchor: this.anchor ?? undefined, lockAxis: this.lockAxis, lockSnap: this.lockSnap ?? this.edgeLock.snapAt(this.anchor) };
  }

  onPointerMove(e: ToolPointerEvent): void {
    this.cursorInference = e.inference;
    this.edgeLock.observe(e.inference);
    this.cursorScreen = e.screen;
    if (this.state.kind === 'idle' && this.ctx) {
      const hit = e.inference?.hit ?? null;
      const seg = hit ? edgeSegment(stateOf(this.ctx), hit.ref) : null;
      this.hoverEdgeLength = seg ? v3dist(seg.a, seg.b) : null;
    }
    this.ctx?.requestRender();
    this.ctx?.statusChanged();
  }

  onClick(e: ToolPointerEvent): void {
    if (e.button !== 0 || !e.inference || !this.ctx) return;
    this.cursorInference = e.inference;
    this.cursorScreen = e.screen;
    const inf = e.inference;
    if (this.state.kind === 'idle') {
      this.start(inf);
      return;
    }
    this.finish(inf.point);
  }

  onKeyDown(e: ToolKeyEvent): boolean {
    switch (e.key) {
      case 'Control':
      case 'Alt':
        if (!e.repeat) {
          this.modeIndex = (this.modeIndex + 1) % MODE_CYCLE.length;
          this.ctx?.statusChanged();
        }
        return true;
      case 'ArrowRight':
        this.setLock('x');
        return true;
      case 'ArrowLeft':
        this.setLock('y');
        return true;
      case 'ArrowUp':
        this.setLock('z');
        return true;
      case 'ArrowDown': {
        const plane = this.cursorInference?.plane ?? planeFromPointNormal(this.anchor ?? [0, 0, 0], [0, 0, 1]);
        if (this.edgeLock.toggle(this.anchor, this.cursorInference?.point ?? null, plane)) {
          this.lockAxis = null;
          this.ctx?.requestRender();
        } else this.setLock(null);
        return true;
      }
      case 'Shift':
        if (!e.repeat) this.lockSnap = this.cursorInference?.primary ?? null;
        return true;
      default:
        return false;
    }
  }

  onKeyUp(e: ToolKeyEvent): boolean {
    if (e.key !== 'Shift') return false;
    this.lockSnap = null;
    return true;
  }

  onVcb(v: VcbValue): void {
    if (v.kind !== 'length' || !this.ctx) return;
    const s = this.state;
    if (s.kind === 'idle') {
      // typed length after a measurement: propose resizing the model
      const m = this.lastMeasurement;
      if (m && m.length > MERGE_TOL && v.meters > 0) {
        this.resize = { measured: m.length, target: v.meters, factor: v.meters / m.length };
        this.ctx.statusChanged();
      }
      return;
    }
    const cursor = this.cursorInference?.point;
    const lockDir = this.lockDirection();
    let dir: Vec3 | null = null;
    if (s.kind === 'fromEdge') {
      // offset direction: perpendicular from the edge line toward the cursor (or the locked axis)
      const toward = lockDir ?? (cursor ? v3sub(cursor, closestOnLine(cursor, s.from, s.dir)) : null);
      if (toward && v3len(toward) > MERGE_TOL) dir = v3normalize(toward);
    } else {
      const toward = lockDir ?? (cursor ? v3sub(cursor, s.from) : null);
      if (toward && v3len(toward) > MERGE_TOL) dir = v3normalize(toward);
    }
    if (!dir) return;
    this.finish(v3addScaled(s.from, dir, v.meters));
  }

  onCancel(): void {
    this.reset();
    this.ctx?.requestRender();
    this.ctx?.statusChanged();
  }

  overlay(): readonly OverlayPrimitive[] {
    const inf = this.cursorInference;
    const out: OverlayPrimitive[] = [];
    const s = this.state;
    if (s.kind !== 'idle' && inf) {
      const p = inf.point;
      if (s.kind === 'fromEdge' && this.mode === 'guideLine') {
        const foot = closestOnLine(p, s.from, s.dir);
        out.push({ kind: 'polyline', points: [foot, p], color: PREVIEW_COLOR, dashed: true, width: 1 });
        out.push({
          kind: 'polyline',
          points: [v3addScaled(p, s.dir, -GUIDE_PREVIEW_HALF), v3addScaled(p, s.dir, GUIDE_PREVIEW_HALF)],
          color: GUIDE_COLOR,
          dashed: true,
          width: 1,
        });
        out.push({ kind: 'label', position: p, text: fmtLength(this.ctx, v3dist(foot, p)), offset: [12, -12] });
      } else {
        out.push({ kind: 'polyline', points: [s.from, p], color: this.mode === 'measure' ? PREVIEW_COLOR : GUIDE_COLOR, dashed: true, width: 1 });
        out.push({ kind: 'label', position: p, text: fmtLength(this.ctx, v3dist(s.from, p)), offset: [12, -12] });
      }
      out.push({ kind: 'point', position: s.from, color: PREVIEW_COLOR, shape: 'square', size: 6 });
    }
    out.push(...inferenceOverlay(inf, this.cursorScreen ?? undefined));
    return out;
  }

  status(): ToolStatus {
    const s = this.state;
    const modeName = this.mode === 'guideLine' ? 'Guide Lines' : this.mode === 'guidePoint' ? 'Guide Points' : 'Measure';
    const tail = ` [${modeName}: Ctrl cycles]`;
    if (this.resize) {
      return {
        instructor: `Resize model by ${this.resize.factor.toFixed(4)}? Confirm to resize, Esc to cancel.`,
        vcbLabel: 'Length',
        vcbValue: fmtLength(this.ctx, this.resize.target),
      };
    }
    if (s.kind === 'idle') {
      const instructor =
        this.mode === 'measure'
          ? `Select start point to measure, or hover an edge.${tail}`
          : this.mode === 'guidePoint'
            ? `Select start point for the guide point.${tail}`
            : `Select an edge for a parallel guide line, or a point for a guide point.${tail}`;
      const value = this.hoverEdgeLength ?? this.lastMeasurement?.length ?? null;
      return { instructor, vcbLabel: 'Length', vcbValue: value === null ? undefined : fmtLength(this.ctx, value) };
    }
    let live = 0;
    if (this.cursorInference) {
      const p = this.cursorInference.point;
      live = s.kind === 'fromEdge' && this.mode === 'guideLine' ? v3dist(closestOnLine(p, s.from, s.dir), p) : v3dist(s.from, p);
    }
    const instructor =
      this.mode === 'measure'
        ? `Select end point or enter value.${tail}`
        : s.kind === 'fromEdge' && this.mode === 'guideLine'
          ? `Select offset for the guide line or enter value.${tail}`
          : `Select the guide point position or enter value.${tail}`;
    return { instructor, vcbLabel: 'Length', vcbValue: fmtLength(this.ctx, live) };
  }

  // --- internals ------------------------------------------------------------------------------

  private start(inf: InferenceResult): void {
    if (!this.ctx) return;
    this.resize = null;
    const hit = inf.hit;
    const seg = hit ? edgeSegment(stateOf(this.ctx), hit.ref) : null;
    // Guide Lines from an edge (not from its endpoint: that makes a guide point)
    if (this.mode === 'guideLine' && seg && inf.primary.kind !== 'endpoint' && v3dist(seg.a, seg.b) > MERGE_TOL) {
      const dir = v3normalize(v3sub(seg.b, seg.a));
      this.state = { kind: 'fromEdge', from: closestOnLine(inf.point, seg.a, dir), dir, ref: hit!.ref };
    } else {
      this.state = { kind: 'fromPoint', from: inf.point };
    }
    this.ctx.statusChanged();
    this.ctx.requestRender();
  }

  private finish(to: Vec3): void {
    const s = this.state;
    if (s.kind === 'idle' || !this.ctx) return;
    const from = s.from;
    if (this.mode === 'measure') {
      const length = v3dist(from, to);
      if (length > MERGE_TOL) this.lastMeasurement = { a: from, b: to, length };
    } else if (s.kind === 'fromEdge' && this.mode === 'guideLine') {
      const foot = closestOnLine(to, from, s.dir);
      const offset = v3sub(to, foot);
      if (v3len(offset) > MERGE_TOL) {
        const point: MVec3 = [foot[0] + offset[0], foot[1] + offset[1], foot[2] + offset[2]];
        this.ctx.commands.execute('guides.addLine', { point, dir: [s.dir[0], s.dir[1], s.dir[2]] });
      }
    } else if (v3dist(from, to) > MERGE_TOL) {
      this.ctx.commands.execute('guides.addPoint', { point: [to[0], to[1], to[2]], leaderFrom: [from[0], from[1], from[2]] });
    }
    this.state = IDLE;
    this.lockAxis = null;
    this.lockSnap = null;
    this.edgeLock.release();
    this.ctx.statusChanged();
    this.ctx.requestRender();
  }

  private lockDirection(): Vec3 | null {
    if (this.lockAxis) return AXIS_NORMAL[this.lockAxis];
    return this.lockSnap?.dir ?? this.edgeLock.direction;
  }

  private setLock(axis: Axis | null): void {
    this.lockAxis = axis !== null && this.lockAxis === axis ? null : axis;
    this.edgeLock.release();
    this.ctx?.requestRender();
  }

  private reset(): void {
    this.state = IDLE;
    this.lockAxis = null;
    this.lockSnap = null;
    this.edgeLock.release();
    this.resize = null;
    this.hoverEdgeLength = null;
  }
}
