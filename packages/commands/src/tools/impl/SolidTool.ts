// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { InferenceOptions } from '@pushform/inference';
import type { Id } from '@pushform/core';
import type { EntityRef } from '@pushform/model';
import type { OverlayPrimitive } from '../overlay';
import type { Tool, ToolContext, ToolPointerEvent, ToolStatus } from '../Tool';
import { entityOverlay, HOVER_COLOR, hostOfTool } from '../toolUtil';
import { solidCommandId, SOLID_MODES, type SolidMode } from '../../commands/solids';
import { bodyIdOfRef, selectionBodyIds, stateOf } from './constructionUtil';

const TITLES: Record<SolidMode, string> = {
  union: 'Union',
  subtract: 'Subtract',
  trim: 'Trim',
  intersect: 'Intersect',
  split: 'Split',
  outerShell: 'Outer Shell',
};

/** Instructor text per mode and step (Solid Tools). */
const PROMPTS: Record<SolidMode, readonly [string, string]> = {
  union: ['① Select the first solid to join.', '② Select the second solid to join.'],
  subtract: ['① Select the solid to subtract with (it will be removed).', '② Select the solid to subtract from.'],
  trim: ['① Select the solid to trim with (it stays).', '② Select the solid to trim.'],
  intersect: ['① Select the first solid.', '② Select the second solid: only the shared volume is kept.'],
  split: ['① Select the first solid.', '② Select the second solid: both are split into pieces.'],
  outerShell: ['① Select the first solid (or preselect several).', '② Select the next solid to shell with.'],
};

const SELECTED_COLOR = '#f9a825';

/**
 * Solid Tools: one instance per mode (`solid.union`, `solid.subtract`, …). Click the first solid
 * (cursor ①), then the second (②) → runs `solids.<mode>`. With two (or, for Outer Shell, n)
 * bodies preselected the operation runs on activation. "Solid" = `body.valid`; a body that is
 * not valid reports an error in the status bar.
 */
export class SolidTool implements Tool {
  readonly id: string;
  readonly title: string;
  readonly cursor = 'crosshair';

  private ctx: ToolContext | null = null;
  private first: Id | null = null;
  private hoverBody: Id | null = null;
  private lastError: string | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly mode: SolidMode) {
    this.id = `solid.${mode}`;
    this.title = TITLES[mode];
  }

  /** Body chosen with the first click, or null. */
  get firstBodyId(): Id | null {
    return this.first;
  }
  get settled(): Promise<void> {
    return this.queue;
  }

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
    this.first = null;
    this.lastError = null;
    const ids = selectionBodyIds(hostOfTool(ctx));
    if (this.mode === 'outerShell' ? ids.length >= 2 : ids.length === 2) this.run(ids);
  }
  deactivate(): void {
    this.first = null;
    this.hoverBody = null;
    this.ctx = null;
  }

  inferenceOptions(): InferenceOptions {
    return { pickOnly: true, kinds: ['body', 'face', 'edge'] };
  }

  onPointerMove(e: ToolPointerEvent): void {
    const id = this.ctx ? bodyIdOfRef(e.inference?.hit?.ref, hostOfTool(this.ctx).context.path) : null;
    if (id !== this.hoverBody) {
      this.hoverBody = id;
      this.ctx?.requestRender();
    }
  }

  onClick(e: ToolPointerEvent): void {
    if (e.button !== 0 || !this.ctx) return;
    const id = bodyIdOfRef(e.inference?.hit?.ref, hostOfTool(this.ctx).context.path);
    if (id === null) return;
    if (this.first === null) {
      this.first = id;
      this.lastError = null;
      this.ctx.statusChanged();
      this.ctx.requestRender();
      return;
    }
    if (id === this.first) return;
    this.run([this.first, id]);
  }

  onCancel(): void {
    this.first = null;
    this.lastError = null;
    this.ctx?.requestRender();
    this.ctx?.statusChanged();
  }

  overlay(): readonly OverlayPrimitive[] {
    if (!this.ctx) return [];
    const out: OverlayPrimitive[] = [];
    const state = stateOf(this.ctx);
    const path = hostOfTool(this.ctx).context.path;
    if (this.first !== null) out.push(...entityOverlay(state, bodyRef(this.first, path), SELECTED_COLOR));
    if (this.hoverBody !== null && this.hoverBody !== this.first) out.push(...entityOverlay(state, bodyRef(this.hoverBody, path), HOVER_COLOR));
    return out;
  }

  status(): ToolStatus {
    if (this.lastError) return { instructor: `${this.title} failed: ${this.lastError}`, vcbLabel: '' };
    const [p1, p2] = PROMPTS[this.mode];
    return { instructor: this.first === null ? p1 : p2, vcbLabel: '' };
  }

  // --- internals ------------------------------------------------------------------------------

  private run(ids: readonly Id[]): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.first = null;
    const path = [...hostOfTool(ctx).context.path] as number[];
    const refs = ids.map((id) => ({ kind: 'body' as const, path, id: id as number }));
    const params = this.mode === 'outerShell' ? { bodies: refs } : { a: refs[0], b: refs[1] };
    this.queue = this.queue
      .then(async () => {
        await ctx.commands.execute(solidCommandId(this.mode), params);
        hostOfTool(ctx).selection.clear();
      })
      .catch((err: unknown) => {
        this.lastError = err instanceof Error ? err.message : String(err);
      })
      .then(() => {
        ctx.statusChanged();
        ctx.requestRender();
      });
    ctx.statusChanged();
    ctx.requestRender();
  }
}

const bodyRef = (id: Id, path: readonly Id[]): EntityRef => ({ kind: 'body', path, id });

/** One SolidTool per mode. */
export function solidTools(): SolidTool[] {
  return SOLID_MODES.map((m) => new SolidTool(m));
}
