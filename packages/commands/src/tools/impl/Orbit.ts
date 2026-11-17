// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { OverlayPrimitive } from '../overlay';
import type { Tool, ToolContext, ToolPointerEvent, ToolStatus } from '../Tool';

/**
 * Orbit: drag rotates around the point under the cursor; Ctrl allows roll (free orbit). Shift held
 * when the drag starts pans for that drag instead, as the Pan tool does.
 */
export class OrbitTool implements Tool {
  readonly id = 'orbit';
  readonly title = 'Orbit';
  readonly cursor = 'grab';
  readonly role = 'camera' as const;
  private ctx: ToolContext | null = null;
  private drag: 'orbit' | 'pan' | null = null;

  /** What the current drag does, or null when not dragging. */
  get dragMode(): 'orbit' | 'pan' | null {
    return this.drag;
  }

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
  }
  deactivate(): void {
    this.endDrag();
    this.ctx = null;
  }
  onPointerDown(e: ToolPointerEvent): void {
    if (!this.ctx || (e.button !== 0 && e.button !== 1)) return;
    this.endDrag();
    if (e.modifiers.shift) {
      this.ctx.camera.panStart(e.screen);
      this.drag = 'pan';
    } else {
      this.ctx.camera.orbitStart(e.screen, { free: e.modifiers.ctrl });
      this.drag = 'orbit';
    }
  }
  onPointerMove(e: ToolPointerEvent): void {
    if (!this.ctx || !this.drag) return;
    if (this.drag === 'pan') this.ctx.camera.panDrag(e.screen);
    else this.ctx.camera.orbitDrag(e.screen);
    this.ctx.requestRender();
  }
  onPointerUp(): void {
    this.endDrag();
  }
  onCancel(): void {
    this.endDrag();
  }
  overlay(): readonly OverlayPrimitive[] {
    return [];
  }
  status(): ToolStatus {
    return { instructor: 'Drag to orbit. Ctrl = free orbit (no gravity). Shift = Pan.', vcbLabel: '' };
  }

  private endDrag(): void {
    if (this.drag === 'pan') this.ctx?.camera.panEnd();
    else if (this.drag === 'orbit') this.ctx?.camera.orbitEnd();
    this.drag = null;
  }
}
