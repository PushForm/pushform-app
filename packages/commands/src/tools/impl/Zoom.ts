// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Vec2 } from '@pushform/core';
import type { VcbKind, VcbValue } from '../../vcb/parse';
import type { OverlayPrimitive } from '../overlay';
import type { Tool, ToolContext, ToolPointerEvent, ToolStatus } from '../Tool';

/**
 * Zoom: drag up zooms in, drag down zooms out (around the drag start point).
 * VCB: `35deg` sets the field of view, `50mm` sets the focal length.
 */
export class ZoomTool implements Tool {
  readonly id = 'zoom';
  readonly title = 'Zoom';
  readonly cursor = 'zoom-in';
  readonly role = 'camera' as const;
  readonly vcbSchema: readonly VcbKind[] = ['angle', 'length'];
  private ctx: ToolContext | null = null;
  private anchor: Vec2 | null = null;
  private lastY = 0;

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
  }
  deactivate(): void {
    this.anchor = null;
    this.ctx = null;
  }
  onPointerDown(e: ToolPointerEvent): void {
    if (e.button !== 0) return;
    this.anchor = e.screen;
    this.lastY = e.screen[1];
  }
  onPointerMove(e: ToolPointerEvent): void {
    if (!this.ctx || !this.anchor) return;
    const dy = e.screen[1] - this.lastY;
    this.lastY = e.screen[1];
    if (dy === 0) return;
    // 200 px of drag ≈ 2x zoom.
    const factor = Math.pow(2, dy / 200);
    this.ctx.camera.zoomAt(this.anchor, factor);
    this.ctx.requestRender();
  }
  onPointerUp(): void {
    this.anchor = null;
  }
  onVcb(v: VcbValue): void {
    if (!this.ctx) return;
    if (v.kind === 'angle') this.ctx.camera.setFov(v.degrees);
    else if (v.kind === 'length' && v.unit === 'mm') this.ctx.camera.setFocalLength(v.raw);
    else if (v.kind === 'length' && v.unit === null) this.ctx.camera.setFov(v.raw);
    this.ctx.requestRender();
    this.ctx.statusChanged();
  }
  onCancel(): void {
    this.anchor = null;
  }
  overlay(): readonly OverlayPrimitive[] {
    return [];
  }
  status(): ToolStatus {
    const fov = this.ctx?.camera.getState().fov ?? 35;
    return {
      instructor: 'Drag up/down to zoom. Type an angle (35deg) or focal length (50mm) to set the field of view.',
      vcbLabel: 'Field of View',
      vcbValue: `${fov.toFixed(1)} deg`,
    };
  }
}
