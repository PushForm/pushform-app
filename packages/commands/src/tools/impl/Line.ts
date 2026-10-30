// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { formatLength, MERGE_TOL, planeFromPointNormal, v3addScaled, v3dist, v3normalize, v3sub } from '@pushform/core';
import type { Plane, Vec2, Vec3 } from '@pushform/core';
import type { Axis, InferenceMode, InferenceOptions, InferenceResult, Snap } from '@pushform/inference';
import type { UndoEntry } from '@pushform/model';
import type { VcbKind, VcbValue } from '../../vcb/parse';
import type { OverlayPrimitive } from '../overlay';
import type { Tool, ToolContext, ToolKeyEvent, ToolPointerEvent, ToolStatus } from '../Tool';
import { EdgeLock } from '../edgeLock';
import { DRAG_PX, hostOfTool, inferenceOverlay, rubberBandColor, screenDist } from '../toolUtil';

/** Alt cycles these inference modes, with the status text naming each but the first. */
const MODES: readonly { mode: InferenceMode; status: string }[] = [
  { mode: 'all', status: '' },
  { mode: 'none', status: 'Inference off (Alt).' },
  { mode: 'directional', status: 'Parallel and perpendicular inference only (Alt).' },
];

interface LastSegment {
  readonly from: Vec3;
  readonly to: Vec3;
  /** Undo entry the segment produced; VCB re-edits only while it is still on top. */
  readonly entry: UndoEntry | null;
}

/**
 * Line tool (L). Idle → FirstPoint → RubberBand; click-move-click or drag-release;
 * chains from the last end point until Esc or until the end lands on an existing vertex (loop
 * closed). Arrow keys lock an axis (↓ parallel/perpendicular to the last inferred edge), Shift holds the
 * current inference, Alt cycles the inference modes, VCB sets the length
 * (`[x,y,z]` absolute, `<x,y,z>` relative).
 */
export class LineTool implements Tool {
  readonly id = 'line';
  readonly title = 'Line';
  readonly cursor = 'crosshair';
  readonly vcbSchema: readonly VcbKind[] = ['length', 'absolute', 'relative'];

  private ctx: ToolContext | null = null;
  private from: Vec3 | null = null;
  private plane: Plane | null = null;
  private cursorInference: InferenceResult | null = null;
  private cursorScreen: Vec2 | null = null;
  private lockAxis: Axis | null = null;
  private lockSnap: Snap | null = null;
  private readonly edgeLock = new EdgeLock();
  private modeIndex = 0;
  private lastSegment: LastSegment | null = null;
  private movedSinceCommit = false;
  private downScreen: Vec2 | null = null;
  private suppressNextClick = false;

  /** Current anchor (start of the rubber band) or null when idle. */
  get anchor(): Vec3 | null {
    return this.from;
  }
  get axisLock(): Axis | null {
    return this.lockAxis;
  }

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
    this.modeIndex = 0;
  }
  deactivate(): void {
    this.reset();
    this.edgeLock.clear();
    this.lastSegment = null;
    this.ctx = null;
  }

  inferenceOptions(): InferenceOptions {
    return {
      anchor: this.from ?? undefined,
      plane: this.plane ?? undefined,
      lockAxis: this.lockAxis,
      lockSnap: this.lockSnap ?? this.edgeLock.snapAt(this.from),
      snapping: MODES[this.modeIndex]!.mode,
    };
  }

  onPointerMove(e: ToolPointerEvent): void {
    this.cursorInference = e.inference;
    this.edgeLock.observe(e.inference);
    this.cursorScreen = e.screen;
    this.movedSinceCommit = true;
    this.ctx?.requestRender();
    this.ctx?.statusChanged();
  }

  onPointerDown(e: ToolPointerEvent): void {
    if (e.button !== 0) return;
    this.downScreen = e.screen;
    if (!this.from && e.inference) {
      this.start(e.inference);
      this.suppressNextClick = true;
    }
  }

  onPointerUp(e: ToolPointerEvent): void {
    if (e.button !== 0 || !this.downScreen) return;
    const dragged = screenDist(this.downScreen, e.screen) > DRAG_PX;
    this.downScreen = null;
    if (dragged && this.from && e.inference) {
      // Drag-release draws the segment (this gesture is also accepted).
      this.cursorInference = e.inference;
      this.commitAt(e.inference);
      this.suppressNextClick = true;
    }
  }

  onClick(e: ToolPointerEvent): void {
    if (this.suppressNextClick) {
      this.suppressNextClick = false;
      return;
    }
    if (e.button !== 0 || !e.inference) return;
    this.cursorInference = e.inference;
    this.cursorScreen = e.screen;
    if (!this.from) this.start(e.inference);
    else this.commitAt(e.inference);
  }

  onKeyDown(e: ToolKeyEvent): boolean {
    switch (e.key) {
      case 'ArrowRight':
        this.setLock('x');
        return true;
      case 'ArrowLeft':
        this.setLock('y');
        return true;
      case 'ArrowUp':
        this.setLock('z');
        return true;
      case 'ArrowDown':
        if (this.edgeLock.toggle(this.from, this.cursorInference?.point ?? null, this.drawingPlane())) {
          this.lockAxis = null;
          this.ctx?.requestRender();
        } else this.setLock(null);
        return true;
      case 'Alt':
        if (!e.repeat) {
          this.modeIndex = (this.modeIndex + 1) % MODES.length;
          this.ctx?.statusChanged();
          this.ctx?.requestRender();
        }
        return true;
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
    if (!this.from) return;
    let to: Vec3 | null = null;
    if (v.kind === 'length') {
      if (!this.movedSinceCommit && this.lastSegment) {
        this.reapplyLast(v.meters);
        return;
      }
      const dir = this.lockDirection() ?? (this.cursorInference ? v3sub(this.cursorInference.point, this.from) : null);
      if (!dir || Math.hypot(dir[0], dir[1], dir[2]) < MERGE_TOL) return;
      to = v3addScaled(this.from, v3normalize(dir), v.meters);
    } else if (v.kind === 'absolute') {
      const cur = this.cursorInference?.point ?? this.from;
      to = [v.coords[0] ?? cur[0], v.coords[1] ?? cur[1], v.coords[2] ?? cur[2]];
    } else if (v.kind === 'relative') {
      to = [this.from[0] + (v.coords[0] ?? 0), this.from[1] + (v.coords[1] ?? 0), this.from[2] + (v.coords[2] ?? 0)];
    }
    if (to) this.commit(to, false);
  }

  onCancel(): void {
    // Esc cancels the current segment only; the tool stays active and earlier edges remain.
    this.reset();
    this.ctx?.requestRender();
    this.ctx?.statusChanged();
  }

  overlay(): readonly OverlayPrimitive[] {
    const inf = this.cursorInference;
    const out: OverlayPrimitive[] = [];
    if (this.from && inf) {
      out.push({ kind: 'polyline', points: [this.from, inf.point], color: rubberBandColor(inf.primary), width: 2 });
      out.push({ kind: 'point', position: this.from, color: '#111111', shape: 'square', size: 6 });
    }
    out.push(...inferenceOverlay(inf, this.cursorScreen ?? undefined));
    return out;
  }

  status(): ToolStatus {
    const mode = MODES[this.modeIndex]!.status;
    if (!this.from) return { instructor: mode ? `Select start point. ${mode}` : 'Select start point.', vcbLabel: 'Length' };
    const units = this.ctx ? hostOfTool(this.ctx).doc.state.meta.units : null;
    const len = this.cursorInference ? v3dist(this.from, this.cursorInference.point) : 0;
    return {
      instructor: mode ? `Select end point or enter value. ${mode}` : 'Select end point or enter value.',
      vcbLabel: 'Length',
      vcbValue: units ? formatLength(len, units) : undefined,
    };
  }

  // --- internals ------------------------------------------------------------------------------

  private start(inf: InferenceResult): void {
    this.from = inf.point;
    const hit = inf.hit;
    this.plane =
      hit && hit.normal && (hit.ref.kind === 'face' || hit.ref.kind === 'sketchFace')
        ? planeFromPointNormal(inf.point, hit.normal)
        : (inf.primary.plane ?? inf.plane);
    this.movedSinceCommit = false;
    this.ctx?.statusChanged();
  }

  private commitAt(inf: InferenceResult): void {
    // The chain ends when the end point lands on an existing vertex (loop closed).
    const endsChain = inf.primary.kind === 'endpoint';
    this.commit(inf.point, endsChain);
  }

  private commit(to: Vec3, endChain: boolean): void {
    if (!this.ctx || !this.from) return;
    if (v3dist(this.from, to) < MERGE_TOL) return;
    const from = this.from;
    const host = hostOfTool(this.ctx);
    const ids = this.ctx.commands.execute('sketch.addEdge', { a: from, b: to }) as number[];
    this.lastSegment = ids.length ? { from, to, entry: host.undoStack.peek() } : null;
    this.movedSinceCommit = false;
    if (endChain) {
      this.from = null;
      this.lockAxis = null;
      this.lockSnap = null;
      this.edgeLock.release();
    } else {
      this.from = to;
    }
    this.ctx.requestRender();
    this.ctx.statusChanged();
  }

  /** VCB typed right after a click: resize the last segment instead of starting a new one. */
  private reapplyLast(length: number): void {
    if (!this.ctx || !this.lastSegment) return;
    const host = hostOfTool(this.ctx);
    const seg = this.lastSegment;
    if (seg.entry && host.undoStack.peek() === seg.entry) host.undo();
    const dir = v3normalize(v3sub(seg.to, seg.from));
    const to = v3addScaled(seg.from, dir, length);
    this.from = seg.from;
    this.commit(to, false);
  }

  private lockDirection(): Vec3 | null {
    switch (this.lockAxis) {
      case 'x':
        return [1, 0, 0];
      case 'y':
        return [0, 1, 0];
      case 'z':
        return [0, 0, 1];
      default:
        return this.lockSnap?.dir ?? this.edgeLock.direction;
    }
  }

  /** The plane the line is drawn in: the start point's, else the cursor's inference plane, else the ground. */
  private drawingPlane(): Plane {
    return this.plane ?? this.cursorInference?.plane ?? planeFromPointNormal(this.from ?? [0, 0, 0], [0, 0, 1]);
  }

  private setLock(axis: Axis | null): void {
    this.lockAxis = axis !== null && this.lockAxis === axis ? null : axis;
    this.edgeLock.release();
    this.ctx?.requestRender();
  }

  private reset(): void {
    this.from = null;
    this.plane = null;
    this.lockAxis = null;
    this.lockSnap = null;
    this.edgeLock.release();
    this.downScreen = null;
    this.suppressNextClick = false;
    this.movedSinceCommit = false;
  }
}
