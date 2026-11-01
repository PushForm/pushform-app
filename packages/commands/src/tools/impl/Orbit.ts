// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { OverlayPrimitive } from '../overlay';
import type { Tool, ToolContext, ToolPointerEvent, ToolStatus } from '../Tool';

/** Orbit: drag rotates around the point under the cursor; Ctrl allows roll (free orbit). */
export class OrbitTool implements Tool {
  readonly id = 'orbit';
  readonly title = 'Orbit';
  readonly cursor = 'grab';
  readonly role = 'camera' as const;
  private ctx: ToolContext | null = null;
  private dragging = false;

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
  }
  deactivate(): void {
    if (this.dragging) this.ctx?.camera.orbitEnd();
    this.dragging = false;
    this.ctx = null;
  }
  onPointerDown(e: ToolPointerEvent): void {
    if (!this.ctx || (e.button !== 0 && e.button !== 1)) return;
    this.ctx.camera.orbitStart(e.screen, { free: e.modifiers.ctrl });
    this.dragging = true;
  }
  onPointerMove(e: ToolPointerEvent): void {
    if (!this.ctx || !this.dragging) return;
    this.ctx.camera.orbitDrag(e.screen);
    this.ctx.requestRender();
  }
  onPointerUp(): void {
    if (!this.ctx || !this.dragging) return;
    this.ctx.camera.orbitEnd();
    this.dragging = false;
  }
  onCancel(): void {
    if (this.dragging) this.ctx?.camera.orbitEnd();
    this.dragging = false;
  }
  overlay(): readonly OverlayPrimitive[] {
    return [];
  }
  status(): ToolStatus {
    return { instructor: 'Drag to orbit. Ctrl = free orbit (no gravity). Shift = Pan.', vcbLabel: '' };
  }
}
