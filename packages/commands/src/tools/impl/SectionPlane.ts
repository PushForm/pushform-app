// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Vec2, Vec3 } from '@pushform/core';
import { basisToWorld, planeBasis, v3normalize } from '@pushform/core';
import type { Axis, InferenceResult } from '@pushform/inference';
import type { CameraState } from '../../camera/CameraHost';
import type { OverlayPrimitive } from '../overlay';
import type { Tool, ToolContext, ToolKeyEvent, ToolPointerEvent, ToolStatus } from '../Tool';
import { inferenceOverlay, PREVIEW_COLOR, worldPerPixelAt } from '../toolUtil';
import { AXIS_COLORS, AXIS_NORMAL } from './constructionUtil';

/** Side of the preview square and length of its arrow, in CSS px. */
const PREVIEW_PX = 120;
const ARROW_PX = 40;

/**
 * Section Plane: the plane follows the cursor, lying in the face under it with its arrows pointing into the
 * face, or, over empty space, square to the axis the view looks along most; Shift holds the current orientation and the
 * arrow keys hold the red (Right), green (Left) or blue (Up) axis, Down releasing it. A click places the plane in the
 * open edit context as its active cut.
 */
export class SectionPlaneTool implements Tool {
  readonly id = 'sectionPlane';
  readonly title = 'Section Plane';
  readonly cursor = 'crosshair';

  private ctx: ToolContext | null = null;
  private point: Vec3 | null = null;
  /** Direction of the side the cut keeps. */
  private normal: Vec3 = [0, 0, -1];
  private locked: Vec3 | null = null;
  private axis: Axis | null = null;
  private camera: CameraState | null = null;
  private inference: InferenceResult | null = null;
  private screen: Vec2 | null = null;

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
    this.reset();
  }
  deactivate(): void {
    this.reset();
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
    this.normal = this.locked ?? this.orientation(e);
    this.ctx?.requestRender();
    this.ctx?.statusChanged();
  }

  /** Into the face under the cursor, else away from the viewer along the axis the view looks along most. */
  private orientation(e: ToolPointerEvent): Vec3 {
    const n = e.inference?.hit?.normal;
    if (n) return [-n[0] + 0, -n[1] + 0, -n[2] + 0];
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
    this.ctx.commands.tryExecute('sectionPlane.add', { point: [point[0], point[1], point[2]], normal: [...(this.locked ?? this.orientation(e))] });
    this.ctx.statusChanged();
    this.ctx.requestRender();
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
      if (!e.repeat && !this.axis) this.locked = this.normal;
    } else return false;
    if (this.locked) this.normal = this.locked;
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
    return {
      instructor: 'Click to place a section plane. Shift holds its orientation; Right, Left and Up hold the red, green and blue axes.',
      vcbLabel: '',
    };
  }
}
