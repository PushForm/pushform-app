// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Vec2, Vec3 } from '@pushform/core';
import { basisToWorld, formatLength, planeBasis, v3normalize } from '@pushform/core';
import type { Axis, InferenceResult } from '@pushform/inference';
import type { UndoEntry } from '@pushform/model';
import type { CameraState } from '../../camera/CameraHost';
import type { VcbKind, VcbValue } from '../../vcb/parse';
import type { OverlayPrimitive } from '../overlay';
import type { Tool, ToolContext, ToolKeyEvent, ToolPointerEvent, ToolStatus } from '../Tool';
import { hostOfTool, inferenceOverlay, PREVIEW_COLOR, worldPerPixelAt } from '../toolUtil';
import { AXIS_COLORS, AXIS_NORMAL } from './constructionUtil';

/** Side of the preview square and length of its arrow, in CSS px. */
const PREVIEW_PX = 120;
const ARROW_PX = 40;

/** The last plane this tool placed, for a typed offset along its normal. */
interface Placement {
  readonly point: Vec3;
  readonly normal: Vec3;
  offset: number;
  entry: UndoEntry | null;
}

const neg = (v: Vec3): Vec3 => [-v[0] + 0, -v[1] + 0, -v[2] + 0];

/**
 * Section Plane: the plane follows the cursor, lying in the face under it with its arrows pointing into the
 * face, or, over empty space, square to the axis the view looks along most; Shift holds the current orientation and the
 * arrow keys hold the red (Right), green (Left) or blue (Up) axis, Down releasing it; tapping Ctrl reverses the arrows.
 * A click places the plane in the open edit context as its active cut, and a typed length then moves that plane along
 * its normal, in the same undo step.
 */
export class SectionPlaneTool implements Tool {
  readonly id = 'sectionPlane';
  readonly title = 'Section Plane';
  readonly cursor = 'crosshair';
  readonly vcbSchema: readonly VcbKind[] = ['length'];

  private ctx: ToolContext | null = null;
  private point: Vec3 | null = null;
  /** Direction of the side the cut keeps. */
  private normal: Vec3 = [0, 0, -1];
  private locked: Vec3 | null = null;
  private axis: Axis | null = null;
  private camera: CameraState | null = null;
  private inference: InferenceResult | null = null;
  private screen: Vec2 | null = null;
  /** Tapping Ctrl reverses the arrows of the planes this tool places until it is tapped again. */
  private reversed = false;
  private last: Placement | null = null;

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
    this.reversed = false;
    this.last = null;
    this.reset();
  }
  deactivate(): void {
    this.reset();
    this.last = null;
    this.ctx = null;
  }
  private reset(): void {
    this.point = null;
    this.locked = null;
    this.axis = null;
    this.inference = null;
  }

  onPointerMove(e: ToolPointerEvent): void {
    this.inference = e.inference;
    this.screen = e.screen;
    this.camera = e.camera;
    this.point = e.inference?.point ?? null;
    this.normal = this.directed(this.locked ?? this.orientation(e));
    this.ctx?.requestRender();
    this.ctx?.statusChanged();
  }

  /** `n` as placed: reversed while Ctrl's reversal is on. */
  private directed(n: Vec3): Vec3 {
    return this.reversed ? neg(n) : n;
  }

  /** Into the face under the cursor, else away from the viewer along the axis the view looks along most. */
  private orientation(e: ToolPointerEvent): Vec3 {
    const n = e.inference?.hit?.normal;
    if (n) return neg(n);
    return this.axisAway('x', e.camera, true);
  }

  /** An axis pointing away from the viewer; with `best`, the axis the view looks along most instead of `axis`. */
  private axisAway(axis: Axis, camera: CameraState, best = false): Vec3 {
    const view = v3normalize([camera.target[0] - camera.eye[0], camera.target[1] - camera.eye[1], camera.target[2] - camera.eye[2]]);
    let a = AXIS_NORMAL[axis];
    if (best) a = (['x', 'y', 'z'] as const).map((k) => AXIS_NORMAL[k]).reduce((m, c) => (Math.abs(c[0] * view[0] + c[1] * view[1] + c[2] * view[2]) > Math.abs(m[0] * view[0] + m[1] * view[1] + m[2] * view[2]) ? c : m));
    const s = a[0] * view[0] + a[1] * view[1] + a[2] * view[2] < 0 ? -1 : 1;
    return [a[0] * s, a[1] * s, a[2] * s];
  }

  onPointerDown(e: ToolPointerEvent): void {
    if (e.button !== 0 || !this.ctx) return;
    const point = e.inference?.point ?? this.point;
    if (!point) return;
    const placement: Placement = { point: [point[0], point[1], point[2]], normal: this.directed(this.locked ?? this.orientation(e)), offset: 0, entry: null };
    this.last = this.place(placement, 0) ? placement : null;
    this.ctx.statusChanged();
    this.ctx.requestRender();
  }

  /** Add the plane of `p` moved `offset` along its normal; remembers the undo entry it made. */
  private place(p: Placement, offset: number): boolean {
    const ctx = this.ctx;
    if (!ctx) return false;
    const n = v3normalize(p.normal);
    const point: Vec3 = [p.point[0] + n[0] * offset, p.point[1] + n[1] * offset, p.point[2] + n[2] * offset];
    const r = ctx.commands.tryExecute('sectionPlane.add', { point, normal: [...p.normal] });
    if (!r.ok) return false;
    p.offset = offset;
    p.entry = hostOfTool(ctx).undoStack.peek();
    return true;
  }

  /** A typed length moves the plane just placed along its normal, replacing any earlier offset, in the same undo step. */
  onVcb(v: VcbValue): void {
    const last = this.last, ctx = this.ctx;
    if (v.kind !== 'length' || !last || !ctx) return;
    const host = hostOfTool(ctx);
    if (!last.entry || host.undoStack.peek() !== last.entry) {
      this.last = null;
      ctx.statusChanged();
      return;
    }
    host.undo();
    if (!this.place(last, v.meters)) {
      // put the original placement back when the offset one is refused
      this.place(last, last.offset);
    }
    ctx.statusChanged();
    ctx.requestRender();
  }

  onKeyDown(e: ToolKeyEvent): boolean {
    const axis = ({ ArrowRight: 'x', ArrowLeft: 'y', ArrowUp: 'z' } as const)[e.key as 'ArrowRight' | 'ArrowLeft' | 'ArrowUp'];
    if (axis) {
      this.axis = this.axis === axis ? null : axis;
      this.locked = this.axis && this.camera ? this.axisAway(this.axis, this.camera) : null;
    } else if (e.key === 'ArrowDown') {
      this.axis = null;
      this.locked = null;
    } else if (e.key === 'Shift') {
      if (!e.repeat && !this.axis) this.locked = this.directed(this.normal);
    } else if (e.key === 'Control') {
      if (e.repeat) return true;
      this.reversed = !this.reversed;
      this.normal = neg(this.normal);
    } else return false;
    if (this.locked) this.normal = this.directed(this.locked);
    this.ctx?.requestRender();
    this.ctx?.statusChanged();
    return true;
  }

  onKeyUp(e: ToolKeyEvent): boolean {
    if (e.key !== 'Shift' || this.axis) return false;
    this.locked = null;
    return true;
  }

  onCancel(): void {
    this.reset();
    this.ctx?.requestRender();
  }

  overlay(): readonly OverlayPrimitive[] {
    const out: OverlayPrimitive[] = [];
    const p = this.point, cam = this.camera, ctx = this.ctx;
    if (p && cam && ctx) {
      const wpp = worldPerPixelAt(cam, ctx.camera.viewportSize().height, p);
      const half = (PREVIEW_PX / 2) * wpp, len = ARROW_PX * wpp;
      const basis = planeBasis(p, this.normal);
      const color = this.axis ? AXIS_COLORS[this.axis] : PREVIEW_COLOR;
      out.push({ kind: 'polygon', points: [basisToWorld(basis, -half, -half), basisToWorld(basis, half, -half), basisToWorld(basis, half, half), basisToWorld(basis, -half, half)], color, opacity: 0.15 });
      out.push({ kind: 'polyline', points: [basisToWorld(basis, -half, -half), basisToWorld(basis, half, -half), basisToWorld(basis, half, half), basisToWorld(basis, -half, half)], color, closed: true, width: 2 });
      out.push({ kind: 'polyline', points: [p, [p[0] + this.normal[0] * len, p[1] + this.normal[1] * len, p[2] + this.normal[2] * len]], color, width: 2 });
    }
    out.push(...inferenceOverlay(this.inference, this.screen ?? undefined));
    return out;
  }

  status(): ToolStatus {
    const reversed = this.reversed ? ' Arrows reversed.' : '';
    const last = this.last && this.ctx ? this.last : null;
    const units = last && this.ctx ? hostOfTool(this.ctx).doc.state.meta.units : null;
    return {
      instructor: `Click to place a section plane, then type an offset. Shift holds its orientation; Right, Left and Up hold the red, green and blue axes, Down releases them; Ctrl reverses the arrows.${reversed}`,
      vcbLabel: last ? 'Offset' : '',
      vcbValue: last && units ? formatLength(last.offset, units) : undefined,
    };
  }
}
