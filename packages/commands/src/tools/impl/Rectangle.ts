// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import {
  basisToWorld,
  basisToLocal,
  formatLength,
  MERGE_TOL,
  planeBasis,
  planeFromPointNormal,
  planeProject,
} from '@pushform/core';
import type { Plane, PlaneBasis, Vec2, Vec3 } from '@pushform/core';
import type { Axis, InferenceOptions, InferenceResult } from '@pushform/inference';
import { SNAP_COLORS } from '@pushform/inference';
import type { UndoEntry } from '@pushform/model';
import type { VcbKind, VcbValue } from '../../vcb/parse';
import type { OverlayPrimitive } from '../overlay';
import type { EntryField, Tool, ToolContext, ToolKeyEvent, ToolPointerEvent, ToolStatus } from '../Tool';
import { DIMENSION_OFFSET_PX, entryLength, field, lengthDimension, pxAt } from '../entry';
import { DRAG_PX, hostOfTool, inferenceOverlay, PREVIEW_COLOR, screenDist, worldPerPixelAt } from '../toolUtil';

const GOLDEN = (1 + Math.sqrt(5)) / 2;
/** Screen tolerance for the Square / Golden Section shape inferences. */
const SHAPE_PX = 2;

export interface RectangleParams {
  readonly a: Vec3;
  readonly b: Vec3;
  readonly c: Vec3;
  readonly d: Vec3;
}

interface LastRectangle {
  readonly basis: PlaneBasis;
  readonly w: number;
  readonly h: number;
  readonly entry: UndoEntry | null;
}

type ShapeHint = 'Square' | 'Golden Section' | null;

const AXIS_NORMAL: Record<Axis, Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/**
 * Rectangle tool (R). Idle → Corner1 → Dragging → commit. The drawing plane comes
 * from the hovered face at the first click, an arrow-key lock, or the inference plane (ground).
 * Width/height run along the plane basis (`planeBasis`). VCB `w,h` (either
 * omitted), negative flips; typing after the commit re-applies to the last rectangle. Width and
 * Height fields keep the pointer's side of the first corner unless typed negative; a value left
 * with Tab is locked into the preview.
 */
export class RectangleTool implements Tool {
  readonly id = 'rectangle';
  readonly title = 'Rectangle';
  readonly cursor = 'crosshair';
  readonly vcbSchema: readonly VcbKind[] = ['list', 'length'];

  private ctx: ToolContext | null = null;
  private corner: Vec3 | null = null;
  private plane: Plane | null = null;
  private basis: PlaneBasis | null = null;
  private lockNormal: Axis | null = null;
  private cursorInference: InferenceResult | null = null;
  private cursorScreen: Vec2 | null = null;
  private cursorCamera: ToolPointerEvent['camera'] | null = null;
  private last: LastRectangle | null = null;
  private downScreen: Vec2 | null = null;
  private suppressNextClick = false;
  private lockedW: number | null = null;
  private lockedH: number | null = null;

  get firstCorner(): Vec3 | null {
    return this.corner;
  }
  get planeLock(): Axis | null {
    return this.lockNormal;
  }
  /** Params of the last committed rectangle (for VCB re-apply), or null. */
  get lastParams(): RectangleParams | null {
    return this.last ? cornersOf(this.last.basis, this.last.w, this.last.h) : null;
  }

  hasPendingWork(): boolean {
    return this.corner !== null;
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
    let plane = this.plane;
    if (!plane && this.lockNormal) plane = planeFromPointNormal([0, 0, 0], AXIS_NORMAL[this.lockNormal]);
    return { anchor: this.corner ?? undefined, plane: plane ?? undefined, lockAxis: null };
  }

  onPointerMove(e: ToolPointerEvent): void {
    this.cursorInference = e.inference;
    this.cursorScreen = e.screen;
    this.cursorCamera = e.camera;
    this.ctx?.requestRender();
    this.ctx?.statusChanged();
  }

  onPointerDown(e: ToolPointerEvent): void {
    if (e.button !== 0) return;
    this.downScreen = e.screen;
    if (!this.corner && e.inference) {
      this.start(e.inference);
      this.suppressNextClick = true;
    }
  }

  onPointerUp(e: ToolPointerEvent): void {
    if (e.button !== 0 || !this.downScreen) return;
    const dragged = screenDist(this.downScreen, e.screen) > DRAG_PX;
    this.downScreen = null;
    if (dragged && this.corner && e.inference) {
      this.track(e);
      this.commitCurrent();
      this.suppressNextClick = true;
    }
  }

  onClick(e: ToolPointerEvent): void {
    if (this.suppressNextClick) {
      this.suppressNextClick = false;
      return;
    }
    if (e.button !== 0 || !e.inference) return;
    this.track(e);
    if (!this.corner) this.start(e.inference);
    else this.commitCurrent();
  }

  onKeyDown(e: ToolKeyEvent): boolean {
    switch (e.key) {
      case 'ArrowUp':
        this.setLock('z');
        return true;
      case 'ArrowRight':
        this.setLock('x');
        return true;
      case 'ArrowLeft':
        this.setLock('y');
        return true;
      case 'ArrowDown':
        this.setLock(null);
        return true;
      default:
        return false;
    }
  }

  onVcb(v: VcbValue): void {
    let w: number | null = null, h: number | null = null;
    if (v.kind === 'list') {
      const [a, b] = v.values;
      if (a && a.kind === 'length') w = a.meters;
      if (b && b.kind === 'length') h = b.meters;
    } else if (v.kind === 'length') {
      w = v.meters;
    } else return;
    if (this.corner && this.basis) {
      const cur = this.dims();
      this.commit(this.basis, w ?? cur?.w ?? 0, h ?? cur?.h ?? 0);
      return;
    }
    if (this.last) {
      const host = this.ctx ? hostOfTool(this.ctx) : null;
      if (!host || !this.last.entry || host.undoStack.peek() !== this.last.entry) return;
      host.undo();
      this.commit(this.last.basis, w ?? this.last.w, h ?? this.last.h);
    }
  }

  onEntry(values: Readonly<Record<string, VcbValue>>): void {
    if (!this.corner || !this.basis) {
      const w = entryLength(values.width), h = entryLength(values.height);
      if (w !== null || h !== null) this.onVcb({ kind: 'list', values: [values.width?.kind === 'length' ? values.width : null, values.height?.kind === 'length' ? values.height : null] });
      return;
    }
    const cur = this.dims();
    if (!cur) return;
    const w = entryLength(values.width), h = entryLength(values.height);
    this.commit(this.basis, w === null ? cur.w : sideOf(cur.w) * w, h === null ? cur.h : sideOf(cur.h) * h);
  }

  onEntryLock(id: string, value: VcbValue | null): void {
    if (id === 'width') this.lockedW = entryLength(value);
    else if (id === 'height') this.lockedH = entryLength(value);
    this.ctx?.requestRender();
    this.ctx?.statusChanged();
  }

  onCancel(): void {
    this.reset();
    this.ctx?.requestRender();
    this.ctx?.statusChanged();
  }

  overlay(): readonly OverlayPrimitive[] {
    const out: OverlayPrimitive[] = [];
    const dims = this.dims();
    if (this.corner && this.basis && dims) {
      const { a, b, c, d } = cornersOf(this.basis, dims.w, dims.h);
      out.push({ kind: 'polygon', points: [a, b, c, d], color: SNAP_COLORS.onFace, opacity: 0.12 });
      out.push({ kind: 'polyline', points: [a, b, c, d], color: PREVIEW_COLOR, closed: true, width: 2 });
      out.push(...this.dimensions(dims.w, dims.h).overlay);
      if (dims.hint) {
        out.push({ kind: 'polyline', points: [a, c], color: SNAP_COLORS.onFace, dashed: true });
        out.push({ kind: 'cursorHint', text: dims.hint, screen: this.cursorScreen ?? undefined });
      }
    }
    out.push(...inferenceOverlay(this.cursorInference, this.cursorScreen ?? undefined));
    return out;
  }

  status(): ToolStatus {
    if (!this.corner) return { instructor: 'Select first corner.', vcbLabel: 'Dimensions' };
    const units = this.ctx ? hostOfTool(this.ctx).doc.state.meta.units : null;
    const dims = this.dims();
    return {
      instructor: 'Select opposite corner or enter value.',
      vcbLabel: 'Dimensions',
      vcbValue: units && dims ? `${formatLength(dims.w, units)}, ${formatLength(dims.h, units)}` : undefined,
      fields: dims ? this.dimensions(dims.w, dims.h).fields : [],
    };
  }

  // --- internals ------------------------------------------------------------------------------

  private track(e: ToolPointerEvent): void {
    this.cursorInference = e.inference;
    this.cursorScreen = e.screen;
    this.cursorCamera = e.camera;
  }

  private start(inf: InferenceResult): void {
    const p = inf.point;
    const hit = inf.hit;
    let plane: Plane;
    if (this.lockNormal) plane = planeFromPointNormal(p, AXIS_NORMAL[this.lockNormal]);
    else if (hit && hit.normal && (hit.ref.kind === 'face' || hit.ref.kind === 'sketchFace'))
      plane = planeFromPointNormal(p, hit.normal);
    else plane = inf.primary.plane ?? inf.plane;
    this.corner = p;
    this.plane = planeFromPointNormal(p, plane.n);
    this.basis = planeBasis(p, plane.n);
    this.ctx?.statusChanged();
  }

  /** Width and Height dimensions outside the preview's first two edges, with their fields. */
  private dimensions(w: number, h: number): { overlay: OverlayPrimitive[]; fields: EntryField[] } {
    const basis = this.basis!;
    const units = this.ctx ? hostOfTool(this.ctx).doc.state.meta.units : null;
    const { a, b, d } = cornersOf(basis, w, h);
    const off = pxAt(this.ctx, a, DIMENSION_OFFSET_PX);
    const neg = (v: Vec3, s: number): Vec3 => [-v[0] * s, -v[1] * s, -v[2] * s];
    const wd = lengthDimension(a, b, neg(basis.v, sideOf(h)), off);
    const hd = lengthDimension(a, d, neg(basis.u, sideOf(w)), off);
    const fmt = (m: number) => (units ? formatLength(Math.abs(m), units) : undefined);
    return {
      overlay: [...wd.overlay, ...hd.overlay],
      fields: [
        field('width', 'Width', 'length', fmt(w), wd.at, this.lockedW !== null),
        field('height', 'Height', 'length', fmt(h), hd.at, this.lockedH !== null),
      ],
    };
  }

  /** Current width/height along the basis from the cursor, with Square / Golden snapping and locked values. */
  private dims(): { w: number; h: number; hint: ShapeHint } | null {
    if (!this.corner || !this.plane || !this.basis || !this.cursorInference) return null;
    const p = planeProject(this.plane, this.cursorInference.point);
    const l = basisToLocal(this.basis, p);
    let w = l[0], h = l[1];
    if (this.lockedW !== null || this.lockedH !== null) {
      if (this.lockedW !== null) w = sideOf(w) * this.lockedW;
      if (this.lockedH !== null) h = sideOf(h) * this.lockedH;
      return { w, h, hint: null };
    }
    let hint: ShapeHint = null;
    const tol = this.shapeTolerance(p);
    const aw = Math.abs(w), ah = Math.abs(h);
    if (aw > tol && ah > tol) {
      if (Math.abs(aw - ah) <= tol) {
        h = Math.sign(h) * aw; // width is the master dimension
        hint = 'Square';
      } else {
        const big = Math.max(aw, ah), small = Math.min(aw, ah);
        if (Math.abs(big - small * GOLDEN) <= tol) {
          if (aw > ah) w = Math.sign(w) * ah * GOLDEN;
          else h = Math.sign(h) * aw * GOLDEN;
          hint = 'Golden Section';
        }
      }
    }
    return { w, h, hint };
  }

  private shapeTolerance(at: Vec3): number {
    if (!this.cursorCamera || !this.ctx) return 0;
    const height = this.ctx.camera.viewportSize().height;
    return SHAPE_PX * worldPerPixelAt(this.cursorCamera, height, at);
  }

  private commitCurrent(): void {
    const dims = this.dims();
    if (!this.basis || !dims) return;
    this.commit(this.basis, dims.w, dims.h);
  }

  private commit(basis: PlaneBasis, w: number, h: number): void {
    if (!this.ctx) return;
    if (Math.abs(w) < MERGE_TOL || Math.abs(h) < MERGE_TOL) return;
    const host = hostOfTool(this.ctx);
    this.ctx.commands.execute('sketch.rectangle', cornersOf(basis, w, h));
    this.last = { basis, w, h, entry: host.undoStack.peek() };
    this.reset();
    this.ctx.requestRender();
    this.ctx.statusChanged();
  }

  private setLock(axis: Axis | null): void {
    this.lockNormal = axis !== null && this.lockNormal === axis ? null : axis;
    if (this.corner) {
      const n = this.lockNormal ? AXIS_NORMAL[this.lockNormal] : (this.plane?.n ?? [0, 0, 1]);
      this.plane = planeFromPointNormal(this.corner, n);
      this.basis = planeBasis(this.corner, n);
    }
    this.ctx?.requestRender();
  }

  private reset(): void {
    this.corner = null;
    this.plane = null;
    this.basis = null;
    this.lockNormal = null;
    this.downScreen = null;
    this.suppressNextClick = false;
    this.lockedW = null;
    this.lockedH = null;
  }
}

/** Sign of the pointer's side along an axis, positive when on the axis itself. */
function sideOf(x: number): number {
  return x < 0 ? -1 : 1;
}

function cornersOf(basis: PlaneBasis, w: number, h: number): RectangleParams {
  return {
    a: basis.origin,
    b: basisToWorld(basis, w, 0),
    c: basisToWorld(basis, w, h),
    d: basisToWorld(basis, 0, h),
  };
}
