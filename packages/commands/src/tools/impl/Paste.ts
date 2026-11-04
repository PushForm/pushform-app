// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Vec2, Vec3 } from '@pushform/core';
import { m4translation, m4mul, m4rotationAxis } from '@pushform/core';
import type { InferenceResult } from '@pushform/inference';
import { clipboardRefs, modelClipboard, type ModelClipboard, type ModelClipboardStore } from '../../commands/clipboard';
import type { OverlayPrimitive } from '../overlay';
import type { Tool, ToolContext, ToolPointerEvent, ToolKeyEvent, ToolStatus } from '../Tool';
import { inferenceOverlay } from '../toolUtil';
import { movedOutline } from './transformShared';

/**
 * Paste: the clipboard's copy follows the cursor, held at its insertion point, without
 * touching the document; a click places it with `edit.pasteAt` and returns to Select. Escape or
 * another tool cancels.
 */
export class PasteTool implements Tool {
  readonly id = 'paste';
  readonly title = 'Paste';
  readonly cursor = 'copy';

  private ctx: ToolContext | null = null;
  private clip: ModelClipboard | null = null;
  private point: Vec3 | null = null;
  private inference: InferenceResult | null = null;
  private screen: Vec2 | null = null;
  private error: string | null = null;
  private angle = 0;

  constructor(private readonly store: ModelClipboardStore = modelClipboard) {}

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
    this.clip = this.store.current;
    this.point = null; this.angle = 0;
    this.error = null;
  }
  deactivate(): void {
    this.ctx = null;
    this.clip = null;
    this.point = null;
    this.inference = null;
  }

  onPointerMove(e: ToolPointerEvent): void {
    this.inference = e.inference;
    this.screen = e.screen;
    this.point = e.inference?.point ?? null;
    this.ctx?.requestRender();
  }

  onPointerDown(e: ToolPointerEvent): void {
    const ctx = this.ctx;
    if (e.button !== 0 || !ctx || !this.clip || !e.inference) return;
    const point = e.inference.point;
    try {
      ctx.commands.execute('edit.pasteAt', { point: [point[0], point[1], point[2]], angle: this.angle });
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      ctx.statusChanged();
      return;
    }
    ctx.commands.execute('tool.select');
  }

  onKeyDown(event: ToolKeyEvent): boolean {
    if (event.key.toLowerCase() !== 'r' || event.repeat || event.modifiers.ctrl || event.modifiers.meta) return false;
    this.angle += Math.PI / 2; this.ctx?.requestRender(); return true;
  }

  onCancel(): void {
    this.ctx?.commands.execute('tool.select');
  }

  overlay(): readonly OverlayPrimitive[] {
    const out: OverlayPrimitive[] = [];
    if (this.clip && this.point) out.push(...movedOutline(this.clip.state, clipboardRefs(this.clip), m4mul(m4translation(this.point), m4mul(m4rotationAxis([0,0,1], this.angle), m4translation([-this.clip.insertionPoint[0], -this.clip.insertionPoint[1], -this.clip.insertionPoint[2]])))));
    out.push(...inferenceOverlay(this.inference, this.screen ?? undefined));
    return out;
  }

  status(): ToolStatus {
    const instructor = this.error
      ? `Paste failed: ${this.error}`
      : this.clip
        ? 'Click to place. R rotates 90 degrees. Esc cancels.'
        : 'Nothing to paste. Copy something first.';
    return { instructor, vcbLabel: '' };
  }
}
