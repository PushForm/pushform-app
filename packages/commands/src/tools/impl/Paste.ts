// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Vec2, Vec3 } from '@pushform/core';
import { m4translation, v3sub } from '@pushform/core';
import type { InferenceResult } from '@pushform/inference';
import { clipboardRefs, modelClipboard, type ModelClipboard, type ModelClipboardStore } from '../../commands/clipboard';
import type { OverlayPrimitive } from '../overlay';
import type { Tool, ToolContext, ToolPointerEvent, ToolStatus } from '../Tool';
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

  constructor(private readonly store: ModelClipboardStore = modelClipboard) {}

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
    this.clip = this.store.current;
    this.point = null;
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
      ctx.commands.execute('edit.pasteAt', { point: [point[0], point[1], point[2]] });
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      ctx.statusChanged();
      return;
    }
    ctx.commands.execute('tool.select');
  }

  onCancel(): void {
    this.ctx?.commands.execute('tool.select');
  }

  overlay(): readonly OverlayPrimitive[] {
    const out: OverlayPrimitive[] = [];
    if (this.clip && this.point) out.push(...movedOutline(this.clip.state, clipboardRefs(this.clip), m4translation(v3sub(this.point, this.clip.insertionPoint))));
    out.push(...inferenceOverlay(this.inference, this.screen ?? undefined));
    return out;
  }

  status(): ToolStatus {
    const instructor = this.error
      ? `Paste failed: ${this.error}`
      : this.clip
        ? 'Click to place the pasted entities. Esc cancels.'
        : 'Nothing to paste. Copy something first.';
    return { instructor, vcbLabel: '' };
  }
}
