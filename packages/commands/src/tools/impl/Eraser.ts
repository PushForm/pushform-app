// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Vec2 } from '@pushform/core';
import type { InferenceOptions } from '@pushform/inference';
import { entityRefKey } from '@pushform/model';
import type { EntityRef } from '@pushform/model';
import type { OverlayPrimitive } from '../overlay';
import type { Modifiers, Tool, ToolContext, ToolPointerEvent, ToolStatus } from '../Tool';
import { ctrlLike, entityOverlay, hostOfTool } from '../toolUtil';
import { samePath } from '../../commands/context';

const ERASE_COLOR = '#1e63d1';
const BODY_MESSAGE = 'Edges of a solid cannot be erased. Shift = hide, Ctrl = soften, or Push/Pull the face.';

/**
 * Eraser tool (E). Click or drag over sketch edges (and mesh parts, which go whole); everything touched is highlighted
 * and erased on release in one undo step. Shift = hide, Ctrl = soften + smooth,
 * Ctrl+Shift = unsoften. Body edges are a no-op with a status message in M1.
 */
export class EraserTool implements Tool {
  readonly id = 'eraser';
  readonly title = 'Eraser';
  readonly cursor = 'crosshair';

  private ctx: ToolContext | null = null;
  private marked = new Map<string, EntityRef>();
  private dragging = false;
  private suppressNextClick = false;
  private message: string | null = null;
  private cursorScreen: Vec2 | null = null;

  /** Sketch edges collected during the current drag. */
  get markedRefs(): EntityRef[] {
    return [...this.marked.values()];
  }

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
  }
  deactivate(): void {
    this.reset();
    this.ctx = null;
  }

  inferenceOptions(): InferenceOptions {
    return { pickOnly: true, kinds: ['sketchEdge', 'edge', 'imprintEdge', 'meshPart', 'guide', 'dimension', 'text'] };
  }

  onPointerMove(e: ToolPointerEvent): void {
    this.cursorScreen = e.screen;
    if (this.dragging && (e.buttons & 1) !== 0) this.mark(e);
    this.ctx?.requestRender();
  }

  onPointerDown(e: ToolPointerEvent): void {
    if (e.button !== 0) return;
    this.dragging = true;
    this.marked.clear();
    this.message = null;
    this.mark(e);
  }

  onPointerUp(e: ToolPointerEvent): void {
    if (e.button !== 0 || !this.dragging) return;
    this.dragging = false;
    this.mark(e);
    this.applyMarked(e.modifiers);
    this.suppressNextClick = true;
  }

  onClick(e: ToolPointerEvent): void {
    if (this.suppressNextClick) {
      this.suppressNextClick = false;
      return;
    }
    if (e.button !== 0) return;
    this.marked.clear();
    this.message = null;
    this.mark(e);
    this.applyMarked(e.modifiers);
  }

  onCancel(): void {
    this.reset();
    this.ctx?.requestRender();
    this.ctx?.statusChanged();
  }

  overlay(): readonly OverlayPrimitive[] {
    if (!this.ctx) return [];
    const state = hostOfTool(this.ctx).doc.state;
    const out: OverlayPrimitive[] = [];
    for (const ref of this.marked.values()) out.push(...entityOverlay(state, ref, ERASE_COLOR));
    if (this.message) out.push({ kind: 'cursorHint', text: this.message, screen: this.cursorScreen ?? undefined });
    return out;
  }

  status(): ToolStatus {
    const base = 'Click or drag over edges to erase. Shift = hide, Ctrl = soften/smooth, Ctrl+Shift = unsoften.';
    return { instructor: this.message ? `${this.message} ${base}` : base, vcbLabel: '' };
  }

  // --- internals ------------------------------------------------------------------------------

  private mark(e: ToolPointerEvent): void {
    const ref = e.inference?.hit?.ref;
    if (!ref) return;
    if (ref.kind === 'sketchEdge' || ref.kind === 'imprintEdge' || ref.kind === 'edge' || ref.kind === 'meshPart' || ref.kind === 'dimension' || ref.kind === 'text') {
      if (this.ctx && samePath(ref.path, hostOfTool(this.ctx).context.path)) this.marked.set(entityRefKey(ref), ref);
    } else if (ref.kind === 'face' || ref.kind === 'body') {
      this.message = BODY_MESSAGE;
      this.ctx?.statusChanged();
    }
  }

  private applyMarked(m: Modifiers): void {
    const marked = [...this.marked.values()];
    this.marked.clear();
    if (!this.ctx || marked.length === 0) return;
    const ctrl = ctrlLike(m);
    const flags = ctrl && m.shift ? { soft: false, smooth: false } : ctrl ? { soft: true, smooth: true } : m.shift ? { hidden: true } : null;
    const ids = marked.filter((r) => r.kind === 'sketchEdge').map((r) => r.id as number);
    const imprints = marked.filter((r) => r.kind === 'imprintEdge');
    const bodyEdges = marked.filter((r) => r.kind === 'edge');
    const dimensions = marked.filter((r) => r.kind === 'dimension').map((r) => r.id as number);
    const texts = marked.filter((r) => r.kind === 'text');
    const meshParts = marked.filter((r) => r.kind === 'meshPart');
    const run = (label: string, fn: () => void) => this.ctx!.commands.ctx.tx.transact(label, fn);
    run(flags ? 'Edge Flags' : 'Erase', () => {
      if (!this.ctx) return;
      if (ids.length) {
        if (flags) this.ctx.commands.execute('sketch.setEdgeFlags', { ids, ...flags });
        else this.ctx.commands.execute('sketch.eraseEdges', { ids });
      }
      if (imprints.length) {
        if (flags) this.ctx.commands.execute('edges.setFlags', { refs: imprints, ...flags });
        else this.ctx.commands.execute('imprint.erase', { refs: imprints });
      }
      // Dimensions have no hidden or soft state: the modifiers leave them alone.
      if (dimensions.length && !flags) this.ctx.commands.execute('dimension.delete', { ids: dimensions });
      // so do texts
      if (texts.length && !flags) this.ctx.commands.execute('text.delete', { refs: texts });
      // A mesh part goes whole: Shift hides it, Ctrl has no soft state to set, a plain stroke erases it.
      if (meshParts.length) {
        if (flags?.hidden) this.ctx.commands.execute('bodies.setHidden', { refs: meshParts, hidden: true });
        else if (!flags) {
          this.ctx.commands.execute('selection.set', { refs: meshParts });
          this.ctx.commands.execute('edit.delete', {});
        }
      }
      if (bodyEdges.length) {
        if (flags) this.ctx.commands.execute('edges.setFlags', { refs: bodyEdges, ...flags });
        else {
          this.message = BODY_MESSAGE;
          this.ctx.statusChanged();
        }
      }
    });
    this.ctx.requestRender();
  }

  private reset(): void {
    this.marked.clear();
    this.dragging = false;
    this.suppressNextClick = false;
    this.message = null;
  }
}
