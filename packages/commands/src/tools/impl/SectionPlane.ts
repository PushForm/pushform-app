// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Vec2, Vec3 } from '@pushform/core';
import { basisToWorld, formatLength, planeBasis, v3normalize } from '@pushform/core';
import type { Axis, InferenceOptions, InferenceResult } from '@pushform/inference';
import { SNAP_COLORS } from '@pushform/inference';
import type { UndoEntry } from '@pushform/model';
import type { CameraState } from '../../camera/CameraHost';
import type { VcbKind, VcbValue } from '../../vcb/parse';
import type { OverlayPrimitive } from '../overlay';
import type { Tool, ToolContext, ToolKeyEvent, ToolPointerEvent, ToolSettingValue, ToolStatus } from '../Tool';
import { lengthFrom, toggleSetting } from '../settings';
import { DRAG_PX, hostOfTool, inferenceOverlay, PREVIEW_COLOR, screenDist, worldPerPixelAt } from '../toolUtil';
import { pointerField } from '../entry';
import { AXIS_COLORS, AXIS_NORMAL } from './constructionUtil';

/** Side of the preview square and length of its arrow, in CSS px. */
const PREVIEW_PX = 120;
const ARROW_PX = 40;

/** A plane placed, or being placed, through `point` and moved `offset` along `normal`; the last one placed can be re-edited. */
interface Placement {
  readonly point: Vec3;
  normal: Vec3;
  offset: number;
  entry: UndoEntry | null;
}

const neg = (v: Vec3): Vec3 => [-v[0] + 0, -v[1] + 0, -v[2] + 0];
const along = (p: Vec3, n: Vec3, t: number): Vec3 => [p[0] + n[0] * t, p[1] + n[1] * t, p[2] + n[2] * t];

/** After the first click: the plane's orientation and starting point are set, and the cursor sets its offset. */
interface Offsetting {
  readonly point: Vec3;
  normal: Vec3;
  offset: number;
  readonly downScreen: Vec2;
  pressed: boolean;
  moved: boolean;
}

/**
 * Section Plane, in two clicks. Before the first, the plane follows the cursor, lying in the face under it with its arrows
 * pointing into the face, or, over empty space, square to the axis the view looks along most; Shift holds the current
 * orientation and the arrow keys hold the red (Right), green (Left) or blue (Up) axis, Down releasing it. The first click
 * fixes the orientation and a starting point; moving the cursor then slides the plane along its normal, and a second
 * click, a typed offset or the bar's Offset places it in the open edit context as its active cut. Reverse, in the tool
 * options bar or by tapping Ctrl, reverses the arrows. Just after a placement, the bar's Offset and Reverse, or a typed
 * offset, change that plane in the same undo step.
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
  private offsetting: Offsetting | null = null;

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
    this.offsetting = null;
  }

  hasPendingWork(): boolean {
    return this.offsetting !== null;
  }

  /** While setting the offset, the cursor is held to the line through the starting point along the plane's normal. */
  inferenceOptions(): InferenceOptions {
    const o = this.offsetting;
    if (!o) return {};
    return { anchor: o.point, lockSnap: { kind: 'perpendicular', point: o.point, dir: o.normal, color: SNAP_COLORS.perpendicular, label: 'Along Section Plane Normal' } };
  }

  onPointerMove(e: ToolPointerEvent): void {
    this.inference = e.inference;
    this.screen = e.screen;
    this.camera = e.camera;
    const o = this.offsetting;
    if (o) {
      if (!o.moved && screenDist(e.screen, o.downScreen) > DRAG_PX) o.moved = true;
      o.offset = this.offsetAt(o, e);
    } else {
      this.point = e.inference?.point ?? null;
      this.normal = this.directed(this.locked ?? this.orientation(e));
    }
    this.ctx?.requestRender();
    this.ctx?.statusChanged();
  }

  /** Signed distance of the cursor's point from the starting point along the normal, positive the way the arrows point. */
  private offsetAt(o: Offsetting, e: ToolPointerEvent): number {
    const p = e.inference?.point;
    if (!p) return o.offset;
    const n = v3normalize(o.normal);
    return (p[0] - o.point[0]) * n[0] + (p[1] - o.point[1]) * n[1] + (p[2] - o.point[2]) * n[2];
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
    const o = this.offsetting;
    if (o) {
      // the second click places the plane
      if (!o.pressed) this.commit(this.offsetAt(o, e));
      return;
    }
    const point = e.inference?.point ?? this.point;
    if (!point) return;
    const normal = v3normalize(this.directed(this.locked ?? this.orientation(e)));
    this.offsetting = { point: [point[0], point[1], point[2]], normal, offset: 0, downScreen: e.screen, pressed: true, moved: false };
    this.normal = normal;
    this.ctx.statusChanged();
    this.ctx.requestRender();
  }

  onPointerUp(e: ToolPointerEvent): void {
    const o = this.offsetting;
    if (e.button !== 0 || !o || !o.pressed) return;
    o.pressed = false;
    // a press dragged away places the plane on release; a click waits for the second click
    if (o.moved || screenDist(e.screen, o.downScreen) > DRAG_PX) this.commit(this.offsetAt(o, e));
  }

  /** Place the plane being offset at `offset`, as the open context's active cut, and remember it for re-editing. */
  private commit(offset: number): void {
    const o = this.offsetting, ctx = this.ctx;
    if (!o || !ctx) return;
    this.offsetting = null;
    this.point = along(o.point, o.normal, offset);
    const placement: Placement = { point: o.point, normal: o.normal, offset: 0, entry: null };
    this.last = this.place(placement, offset) ? placement : null;
    if (this.last) ctx.committed?.();
    ctx.statusChanged();
    ctx.requestRender();
  }

  /** Undo the last placement and place it again changed by `change`, as one undo step; false when it is no longer on top. */
  private replaceLast(change: (p: Placement) => number): boolean {
    const last = this.last, ctx = this.ctx;
    if (!last || !ctx) return false;
    const host = hostOfTool(ctx);
    if (!last.entry || host.undoStack.peek() !== last.entry) {
      this.last = null;
      ctx.statusChanged();
      return false;
    }
    const before = last.offset;
    host.undo();
    const placement: Placement = { ...last };
    const offset = change(placement);
    if (this.place(placement, offset)) this.last = placement;
    // put the original placement back when the changed one is refused
    else this.place(last, before);
    ctx.committed?.();
    ctx.statusChanged();
    ctx.requestRender();
    return true;
  }

  /** Add the plane of `p` moved `offset` along its normal; remembers the undo entry it made. */
  private place(p: Placement, offset: number): boolean {
    const ctx = this.ctx;
    if (!ctx) return false;
    const point = along(p.point, v3normalize(p.normal), offset);
    const r = ctx.commands.tryExecute('sectionPlane.add', { point, normal: [...p.normal] });
    if (!r.ok) return false;
    p.offset = offset;
    p.entry = hostOfTool(ctx).undoStack.peek();
    return true;
  }

  /**
   * A typed length: while setting the offset it places the plane at that offset; just after a placement it moves that
   * plane to that offset from its starting point, replacing the earlier one, in the same undo step.
   */
  onVcb(v: VcbValue): void {
    if (v.kind !== 'length') return;
    if (this.offsetting) this.commit(v.meters);
    else this.replaceLast(() => v.meters);
  }

  /** Reverse, from the bar or a Ctrl tap: the arrows point the other way; a plane being offset stays where it is. */
  private setReversed(on: boolean): void {
    if (on === this.reversed) return;
    this.reversed = on;
    this.normal = neg(this.normal);
    const o = this.offsetting;
    if (o) {
      o.normal = neg(o.normal);
      o.offset = -o.offset + 0;
    }
  }

  onSetting(id: string, value: ToolSettingValue): void {
    if (id === 'reverse' && typeof value === 'boolean') this.setReversed(value);
    else if (id === 'offset' && this.offsetting) {
      const meters = lengthFrom(value);
      if (meters !== null) this.commit(meters);
    } else return;
    this.ctx?.statusChanged();
    this.ctx?.requestRender();
  }

  /** Offset or Reverse changed just after a placement: move that plane, or turn it around where it lies, in the same undo step. */
  adjustLast(id: string, value: ToolSettingValue): boolean {
    if (id === 'offset') {
      const meters = lengthFrom(value);
      return meters !== null && this.replaceLast(() => meters);
    }
    if (id !== 'reverse') return false;
    return this.replaceLast((p) => {
      const offset = -p.offset;
      p.normal = neg(p.normal);
      return offset;
    });
  }

  onKeyDown(e: ToolKeyEvent): boolean {
    if (this.offsetting) {
      // the orientation is fixed after the first click; only Reverse still applies
      if (e.key !== 'Control') return false;
      if (!e.repeat) this.setReversed(!this.reversed);
      this.ctx?.requestRender();
      this.ctx?.statusChanged();
      return true;
    }
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
      if (!e.repeat) this.setReversed(!this.reversed);
    } else return false;
    if (this.locked) this.normal = this.directed(this.locked);
    this.ctx?.requestRender();
    this.ctx?.statusChanged();
    return true;
  }

  onKeyUp(e: ToolKeyEvent): boolean {
    if (e.key !== 'Shift' || this.axis || this.offsetting) return false;
    this.locked = null;
    return true;
  }

  /** Escape: while setting the offset, back to choosing the orientation; otherwise clear the holds. */
  onCancel(): void {
    if (this.offsetting) this.offsetting = null;
    else this.reset();
    this.ctx?.statusChanged();
    this.ctx?.requestRender();
  }

  overlay(): readonly OverlayPrimitive[] {
    const out: OverlayPrimitive[] = [];
    const o = this.offsetting;
    const p = o ? along(o.point, o.normal, o.offset) : this.point, cam = this.camera, ctx = this.ctx;
    if (o) {
      // from the starting point to the plane
      out.push({ kind: 'polyline', points: [o.point, p!], color: SNAP_COLORS.perpendicular, width: 1, dashed: true });
      out.push({ kind: 'point', position: o.point, color: '#111111', shape: 'square', size: 6 });
    }
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
    const ctx = this.ctx;
    const units = ctx ? hostOfTool(ctx).doc.state.meta.units : null;
    const fmt = (m: number): string => (units ? formatLength(m, units) : m.toFixed(4));
    const reverse = toggleSetting('reverse', 'Reverse', this.reversed, 'primary');
    const o = this.offsetting;
    if (o) {
      const value = fmt(o.offset);
      return {
        instructor: 'Move to set how far the plane lies from the starting point, then click to place it, or type the offset.',
        vcbLabel: 'Offset',
        vcbValue: value,
        fields: [pointerField('Offset', 'length', value)],
        settings: [reverse, { kind: 'quantity', id: 'offset', label: 'Offset', value, quantity: 'length' }],
      };
    }
    // the last placement can be changed while it is the last change in the model
    const last = this.last && ctx && this.last.entry && hostOfTool(ctx).undoStack.peek() === this.last.entry ? this.last : null;
    return {
      instructor: 'Click a face, or in space, to set the plane\'s orientation and starting point. Shift holds the orientation; Right, Left and Up hold the red, green and blue axes, Down releases them.',
      vcbLabel: last ? 'Offset' : '',
      vcbValue: last ? fmt(last.offset) : undefined,
      settings: [reverse, { kind: 'quantity', id: 'offset', label: 'Offset', value: last ? fmt(last.offset) : '', quantity: 'length', disabled: !last }],
    };
  }
}
