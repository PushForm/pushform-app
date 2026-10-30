// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { MVec3, Vec2, Vec3 } from '@pushform/core';
import { MERGE_TOL, v3addScaled, v3cross, v3len, v3normalize, v3sub } from '@pushform/core';
import type { Axis, InferenceOptions, InferenceResult } from '@pushform/inference';
import type { OverlayPrimitive } from '../overlay';
import type { Tool, ToolContext, ToolKeyEvent, ToolPointerEvent, ToolStatus } from '../Tool';
import { definitionAt } from '@pushform/model';
import { currentFrame } from '../../commands/context';
import { hostOfTool, inferenceOverlay } from '../toolUtil';
import { AXIS_COLORS, projectToPlane } from './constructionUtil';

/** Which axis is placed first/second; the third is the right-handed cross product. */
const ORDERS: readonly (readonly [Axis, Axis, Axis])[] = [
  ['x', 'y', 'z'],
  ['y', 'z', 'x'],
  ['z', 'x', 'y'],
];
const AXIS_NAME: Record<Axis, string> = { x: 'red', y: 'green', z: 'blue' };

type State =
  | { readonly kind: 'idle' }
  | { readonly kind: 'origin'; readonly origin: Vec3 }
  | { readonly kind: 'first'; readonly origin: Vec3; readonly first: Vec3 };

const IDLE: State = { kind: 'idle' };

/** Axes picked with the Axes tool, in world coordinates. */
export interface PickedAxes {
  readonly origin: MVec3;
  readonly x: MVec3;
  readonly y: MVec3;
  readonly z: MVec3;
}

/**
 * Axes tool. Click the origin, click the red direction (Alt before that switches to placing green
 * or blue first), click the second axis direction; the third axis follows right-handedly.
 * Double-click places the origin at a point keeping the current orientation. Writes `axes.set`.
 */
export class AxesTool implements Tool {
  readonly id: string = 'axes';
  readonly title: string = 'Axes';
  readonly cursor = 'crosshair';

  protected ctx: ToolContext | null = null;
  private state: State = IDLE;
  private orderIndex = 0;
  private cursorInference: InferenceResult | null = null;
  private cursorScreen: Vec2 | null = null;

  /** Axis placed with the first direction click. */
  get firstAxis(): Axis {
    return ORDERS[this.orderIndex]![0];
  }
  get origin(): Vec3 | null {
    return this.state.kind === 'idle' ? null : this.state.origin;
  }

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
    this.state = IDLE;
  }
  deactivate(): void {
    this.state = IDLE;
    this.orderIndex = 0;
    this.ctx = null;
  }

  inferenceOptions(): InferenceOptions {
    return { anchor: this.origin ?? undefined };
  }

  onPointerMove(e: ToolPointerEvent): void {
    this.cursorInference = e.inference;
    this.cursorScreen = e.screen;
    this.ctx?.requestRender();
  }

  onClick(e: ToolPointerEvent): void {
    const ctx = this.ctx;
    if (e.button !== 0 || !e.inference || !ctx) return;
    this.cursorInference = e.inference;
    const p = e.inference.point;
    const s = this.state;
    if (s.kind === 'idle') {
      this.state = { kind: 'origin', origin: p };
    } else if (s.kind === 'origin') {
      const d = v3sub(p, s.origin);
      if (v3len(d) <= MERGE_TOL) return;
      this.state = { kind: 'first', origin: s.origin, first: v3normalize(d) };
    } else {
      const d = projectToPlane(v3sub(p, s.origin), s.first);
      if (v3len(d) <= MERGE_TOL) return;
      this.place(s.origin, s.first, v3normalize(d));
    }
    // placing may switch tools (a component axes pick returns to Select), so keep this event's context
    ctx.statusChanged();
    ctx.requestRender();
  }

  onDoubleClick(e: ToolPointerEvent): void {
    if (e.button !== 0 || !e.inference || !this.ctx) return;
    const p = e.inference.point;
    const host = hostOfTool(this.ctx);
    const frame = currentFrame(host);
    const axes = definitionAt(host.doc.state, host.context.path).axes;
    this.state = IDLE;
    const ctx = this.ctx;
    this.apply({ origin: [p[0], p[1], p[2]], x: frame.toWorldDir(axes.x), y: frame.toWorldDir(axes.y), z: frame.toWorldDir(axes.z) });
    ctx.statusChanged();
    ctx.requestRender();
  }

  onKeyDown(e: ToolKeyEvent): boolean {
    if (e.key !== 'Alt' && e.key !== 'Control') return false;
    if (!e.repeat && this.state.kind !== 'first') {
      this.orderIndex = (this.orderIndex + 1) % ORDERS.length;
      this.ctx?.statusChanged();
      this.ctx?.requestRender();
    }
    return true;
  }

  onCancel(): void {
    this.state = IDLE;
    this.ctx?.requestRender();
    this.ctx?.statusChanged();
  }

  overlay(): readonly OverlayPrimitive[] {
    const out: OverlayPrimitive[] = [];
    const s = this.state;
    const inf = this.cursorInference;
    const [a0, a1, a2] = ORDERS[this.orderIndex]!;
    if (s.kind !== 'idle') out.push({ kind: 'point', position: s.origin, color: '#111111', shape: 'square', size: 6 });
    if (s.kind === 'origin' && inf) {
      out.push({ kind: 'polyline', points: [s.origin, inf.point], color: AXIS_COLORS[a0], width: 2 });
    } else if (s.kind === 'first') {
      out.push({ kind: 'polyline', points: [s.origin, v3addScaled(s.origin, s.first, 1)], color: AXIS_COLORS[a0], width: 2 });
      if (inf) {
        const d = projectToPlane(v3sub(inf.point, s.origin), s.first);
        if (v3len(d) > MERGE_TOL) {
          const second = v3normalize(d);
          out.push({ kind: 'polyline', points: [s.origin, v3addScaled(s.origin, second, 1)], color: AXIS_COLORS[a1], width: 2 });
          const third = v3cross(s.first, second);
          out.push({ kind: 'polyline', points: [s.origin, v3addScaled(s.origin, third, 1)], color: AXIS_COLORS[a2], width: 1, dashed: true });
        }
      }
    }
    out.push(...inferenceOverlay(inf, this.cursorScreen ?? undefined));
    return out;
  }

  status(): ToolStatus {
    const [a0, a1] = ORDERS[this.orderIndex]!;
    const s = this.state;
    if (s.kind === 'idle') return { instructor: `Click to place the axes origin (double-click keeps the orientation). Alt switches to the ${AXIS_NAME[ORDERS[(this.orderIndex + 1) % 3]![0]]} axis first.`, vcbLabel: '' };
    if (s.kind === 'origin') return { instructor: `Click to set the ${AXIS_NAME[a0]} axis direction.`, vcbLabel: '' };
    return { instructor: `Click to set the ${AXIS_NAME[a1]} axis direction.`, vcbLabel: '' };
  }

  // --- internals ------------------------------------------------------------------------------

  private place(origin: Vec3, first: Vec3, second: Vec3): void {
    if (!this.ctx) return;
    const [a0, a1, a2] = ORDERS[this.orderIndex]!;
    const third = v3cross(first, second);
    const dirs: Record<Axis, MVec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    dirs[a0] = [first[0], first[1], first[2]];
    dirs[a1] = [second[0], second[1], second[2]];
    dirs[a2] = third;
    this.state = IDLE;
    this.apply({ origin: [origin[0], origin[1], origin[2]], x: dirs.x, y: dirs.y, z: dirs.z });
  }

  /** Use the picked axes (world): the Axes tool places the context's axes. */
  protected apply(axes: PickedAxes): void {
    this.ctx?.commands.execute('axes.set', axes);
  }
}
