// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { OverlayPrimitive } from '../overlay';
import type { Tool, ToolContext, ToolPointerEvent, ToolStatus } from '../Tool';

/** Pan: drag moves the camera parallel to the view plane. */
export class PanTool implements Tool {
  readonly id = 'pan';
  readonly title = 'Pan';
  readonly cursor = 'move';
  readonly role = 'camera' as const;
  private ctx: ToolContext | null = null;
  private dragging = false;

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
  }
  deactivate(): void {
    if (this.dragging) this.ctx?.camera.panEnd();
    this.dragging = false;
    this.ctx = null;
  }
  onPointerDown(e: ToolPointerEvent): void {
    if (!this.ctx || (e.button !== 0 && e.button !== 1)) return;
    this.ctx.camera.panStart(e.screen);
    this.dragging = true;
  }
  onPointerMove(e: ToolPointerEvent): void {
    if (!this.ctx || !this.dragging) return;
    this.ctx.camera.panDrag(e.screen);
    this.ctx.requestRender();
  }
  onPointerUp(): void {
    if (!this.ctx || !this.dragging) return;
    this.ctx.camera.panEnd();
    this.dragging = false;
  }
  onCancel(): void {
    if (this.dragging) this.ctx?.camera.panEnd();
    this.dragging = false;
  }
  overlay(): readonly OverlayPrimitive[] {
    return [];
  }
  status(): ToolStatus {
    return { instructor: 'Drag to pan.', vcbLabel: '' };
  }
}
