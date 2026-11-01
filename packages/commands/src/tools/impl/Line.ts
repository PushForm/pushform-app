// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { basisToWorld, formatLength, MERGE_TOL, planeBasis, planeFromPointNormal, v3add, v3addScaled, v3dist, v3dot, v3normalize, v3scale, v3sub } from '@pushform/core';
import type { Plane, Vec2, Vec3 } from '@pushform/core';
import type { Axis, InferenceMode, InferenceOptions, InferenceResult, Snap } from '@pushform/inference';
import type { UndoEntry } from '@pushform/model';
import type { VcbKind, VcbValue } from '../../vcb/parse';
import type { OverlayPrimitive } from '../overlay';
import type { EntryField, Tool, ToolContext, ToolKeyEvent, ToolPointerEvent, ToolStatus } from '../Tool';
import { angleDimension, DIMENSION_COLOR, DIMENSION_OFFSET_PX, entryDegrees, entryLength, field, leftOf, lengthDimension, pxAt } from '../entry';
import { formatDeg } from './drawingUtil';
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
 * (`[x,y,z]` absolute, `<x,y,z>` relative). Value fields take the length and the angle in the
 * drawing plane, measured from the plane's first axis; a value left with Tab is locked into the preview.
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
  private lockedLength: number | null = null;
  /** Locked angle in the drawing plane, radians. */
  private lockedAngle: number | null = null;

  /** Current anchor (start of the rubber band) or null when idle. */
  get anchor(): Vec3 | null {
    return this.from;
  }
  get axisLock(): Axis | null {
    return this.lockAxis;
  }

  hasPendingWork(): boolean {
    return this.from !== null;
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

  onEntry(values: Readonly<Record<string, VcbValue>>): void {
    if (!this.from) return;
    const typedLength = entryLength(values.length);
    const typedDeg = entryDegrees(values.angle);
    const angle = typedDeg !== null ? (typedDeg * Math.PI) / 180 : this.lockedAngle;
    if (angle === null) {
      const length = typedLength ?? this.lockedLength;
      if (length === null) return;
      if (this.lockedLength === null && typedLength !== null && values.length) {
        this.onVcb(values.length);
        return;
      }
      const to = this.endAt(length, null);
      if (to) this.commit(to, false);
      return;
    }
    const length = typedLength ?? this.lockedLength ?? this.cursorLength();
    const to = this.endAt(length, angle);
    if (to) this.commit(to, false);
  }

  onEntryLock(id: string, value: VcbValue | null): void {
    if (id === 'length') this.lockedLength = entryLength(value);
    else if (id === 'angle') {
      const deg = entryDegrees(value);
      this.lockedAngle = deg === null ? null : (deg * Math.PI) / 180;
    }
    this.ctx?.requestRender();
    this.ctx?.statusChanged();
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
    const to = this.target();
    if (this.from && inf && to) {
      out.push({ kind: 'polyline', points: [this.from, to], color: rubberBandColor(inf.primary), width: 2 });
      out.push({ kind: 'point', position: this.from, color: '#111111', shape: 'square', size: 6 });
      out.push(...this.dimensions(to).overlay);
    }
    out.push(...inferenceOverlay(inf, this.cursorScreen ?? undefined));
    return out;
  }

  status(): ToolStatus {
    const mode = MODES[this.modeIndex]!.status;
    if (!this.from) return { instructor: mode ? `Select start point. ${mode}` : 'Select start point.', vcbLabel: 'Length' };
    const units = this.ctx ? hostOfTool(this.ctx).doc.state.meta.units : null;
    const to = this.target();
    const len = to ? v3dist(this.from, to) : 0;
    const value = units ? formatLength(len, units) : undefined;
    return {
      instructor: mode ? `Select end point or enter value. ${mode}` : 'Select end point or enter value.',
      vcbLabel: 'Length',
      vcbValue: value,
      fields: to ? this.dimensions(to).fields : [],
    };
  }

  // --- internals ------------------------------------------------------------------------------

  /** Preview end point: the cursor, with any locked length or angle applied. */
  private target(): Vec3 | null {
    if (!this.from || !this.cursorInference) return null;
    if (this.lockedLength === null && this.lockedAngle === null) return this.cursorInference.point;
    const length = this.lockedLength ?? (this.lockedAngle !== null ? this.cursorLengthAlong(this.lockedAngle) : this.cursorLength());
    return this.endAt(length, this.lockedAngle) ?? this.cursorInference.point;
  }

  /** End point `length` from the start, at `angle` in the drawing plane, or along the pointer / locked direction when null. */
  private endAt(length: number, angle: number | null): Vec3 | null {
    if (!this.from) return null;
    if (angle !== null) {
      const b = planeBasis(this.from, this.drawingPlane().n);
      return basisToWorld(b, Math.cos(angle) * length, Math.sin(angle) * length);
    }
    const dir = this.lockDirection() ?? (this.cursorInference ? v3sub(this.cursorInference.point, this.from) : null);
    if (!dir || Math.hypot(dir[0], dir[1], dir[2]) < MERGE_TOL) return null;
    return v3addScaled(this.from, v3normalize(dir), length);
  }

  private cursorLength(): number {
    return this.from && this.cursorInference ? v3dist(this.from, this.cursorInference.point) : 0;
  }

  /** Distance of the pointer along the direction at `angle` in the drawing plane. */
  private cursorLengthAlong(angle: number): number {
    if (!this.from || !this.cursorInference) return 0;
    const b = planeBasis(this.from, this.drawingPlane().n);
    const dir = v3add(v3scale(b.u, Math.cos(angle)), v3scale(b.v, Math.sin(angle)));
    return v3dot(v3sub(this.cursorInference.point, this.from), dir);
  }

  /** Angle of `to` in the drawing plane, or null when the segment leaves the plane. */
  private angleOf(to: Vec3): number | null {
    if (!this.from) return null;
    const b = planeBasis(this.from, this.drawingPlane().n);
    const d = v3sub(to, this.from);
    const x = v3dot(d, b.u), y = v3dot(d, b.v), z = v3dot(d, b.n);
    const len = Math.hypot(x, y, z);
    if (len < MERGE_TOL || Math.abs(z) > MERGE_TOL + len * 1e-6) return null;
    return Math.atan2(y, x);
  }

  /** Length dimension beside the rubber band and the angle arc at its start, with their fields. */
  private dimensions(to: Vec3): { overlay: OverlayPrimitive[]; fields: EntryField[] } {
    const from = this.from!;
    const n = this.drawingPlane().n;
    const units = this.ctx ? hostOfTool(this.ctx).doc.state.meta.units : null;
    const overlay: OverlayPrimitive[] = [];
    const fields: EntryField[] = [];
    const len = v3dist(from, to);
    const side = leftOf(from, to, n);
    const lengthValue = units ? formatLength(len, units) : undefined;
    if (side) {
      const dim = lengthDimension(from, to, side, pxAt(this.ctx, from, DIMENSION_OFFSET_PX));
      overlay.push(...dim.overlay);
      fields.push(field('length', 'Length', 'length', lengthValue, dim.at, this.lockedLength !== null));
    } else fields.push(field('length', 'Length', 'length', lengthValue, undefined, this.lockedLength !== null));
    const angle = this.angleOf(to);
    if (angle !== null) {
      const b = planeBasis(from, n);
      const r = Math.min(len * 0.5, pxAt(this.ctx, from, 60));
      if (r > 0) {
        overlay.push({ kind: 'polyline', points: [from, basisToWorld(b, r * 1.2, 0)], color: DIMENSION_COLOR, width: 1, dashed: true });
        const dim = angleDimension(from, b.u, b.v, r, 0, angle, r + pxAt(this.ctx, from, 44));
        overlay.push(...dim.overlay);
        fields.push(field('angle', 'Angle', 'angle', formatDeg((angle * 180) / Math.PI), dim.at, this.lockedAngle !== null));
      }
    }
    return { overlay, fields };
  }

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
    if (this.lockedLength !== null || this.lockedAngle !== null) {
      const to = this.target();
      if (to) this.commit(to, false);
      return;
    }
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
    this.lockedLength = null;
    this.lockedAngle = null;
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
    this.lockedLength = null;
    this.lockedAngle = null;
  }
}
