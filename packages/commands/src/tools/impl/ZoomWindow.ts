// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Vec2 } from '@pushform/core';
import type { OverlayPrimitive } from '../overlay';
import type { Tool, ToolContext, ToolPointerEvent, ToolStatus } from '../Tool';

/** Zoom Window: drag a rectangle; the camera frames it on release. */
export class ZoomWindowTool implements Tool {
  readonly id = 'zoomWindow';
  readonly title = 'Zoom Window';
  readonly cursor = 'crosshair';
  readonly role = 'camera' as const;
  private ctx: ToolContext | null = null;
  private a: Vec2 | null = null;
  private b: Vec2 | null = null;

  hasPendingWork(): boolean {
    return this.a !== null;
  }

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
  }
  deactivate(): void {
    this.a = this.b = null;
    this.ctx = null;
  }
  onPointerDown(e: ToolPointerEvent): void {
    if (e.button !== 0) return;
    this.a = e.screen;
    this.b = e.screen;
  }
  onPointerMove(e: ToolPointerEvent): void {
    if (!this.a) return;
    this.b = e.screen;
    this.ctx?.requestRender();
  }
  onPointerUp(e: ToolPointerEvent): void {
    if (!this.ctx || !this.a || e.button !== 0) return;
    const a = this.a,
      b = e.screen;
    this.a = this.b = null;
    if (Math.abs(a[0] - b[0]) < 3 || Math.abs(a[1] - b[1]) < 3) return;
    this.ctx.camera.zoomWindow(a, b);
    this.ctx.requestRender();
  }
  onCancel(): void {
    this.a = this.b = null;
  }
  overlay(): readonly OverlayPrimitive[] {
    if (!this.a || !this.b) return [];
    return [{ kind: 'screenRect', a: this.a, b: this.b, color: '#1e63d1', dashed: true }];
  }
  status(): ToolStatus {
    return { instructor: 'Drag a rectangle to zoom into it.', vcbLabel: '' };
  }
}
