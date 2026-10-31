// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Vec2 } from '@pushform/core';
import type { InferenceOptions } from '@pushform/inference';
import type { EntityRef } from '@pushform/model';
import type { OverlayPrimitive } from '../overlay';
import type { Tool, ToolContext, ToolPointerEvent, ToolStatus } from '../Tool';
import { entityOverlay, hostOfTool } from '../toolUtil';
import { samePath } from '../../commands/context';
import { activeTagId } from '../../commands/tags';

const TAG_HOVER_COLOR = '#2d8f5b';

/**
 * Tag tool: click an entity of the current context to assign the active
 * tag (Tags panel pencil). Groups/components take the tag as a whole; faces and edges of a solid
 * get a per-face/edge tag. With no active tag the "Untagged" tag is assigned.
 */
export class TagTool implements Tool {
  readonly id = 'tag';
  readonly title = 'Tag';
  readonly cursor = 'crosshair';

  private ctx: ToolContext | null = null;
  private hover: EntityRef | null = null;
  private cursorScreen: Vec2 | null = null;
  private lastAssigned: string | null = null;

  /** Entity under the cursor (current context only). */
  get hoverRef(): EntityRef | null {
    return this.hover;
  }

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
  }
  deactivate(): void {
    this.hover = null;
    this.lastAssigned = null;
    this.ctx = null;
  }

  inferenceOptions(): InferenceOptions {
    return { pickOnly: true, kinds: ['instance', 'body', 'meshPart', 'face', 'edge', 'sketchEdge', 'sketchFace', 'guide'] };
  }

  onPointerMove(e: ToolPointerEvent): void {
    this.cursorScreen = e.screen;
    const next = this.pickable(e);
    if (next !== this.hover) {
      this.hover = next;
      this.ctx?.requestRender();
    }
  }

  onClick(e: ToolPointerEvent): void {
    if (e.button !== 0 || !this.ctx) return;
    const ref = this.pickable(e);
    if (!ref) return;
    const host = hostOfTool(this.ctx);
    const tagId = activeTagId(this.ctx.commands.ctx) ?? host.doc.state.defaultTagId;
    const n = this.ctx.commands.execute('tag.assign', { refs: [ref], tagId }) as number;
    const tag = host.doc.state.tags.get(tagId);
    this.lastAssigned = n ? `Tagged "${tag?.name ?? tagId}"` : null;
    this.ctx.statusChanged();
    this.ctx.requestRender();
  }

  onCancel(): void {
    this.hover = null;
    this.lastAssigned = null;
    this.ctx?.requestRender();
    this.ctx?.statusChanged();
  }

  overlay(): readonly OverlayPrimitive[] {
    if (!this.ctx || !this.hover) return [];
    const state = hostOfTool(this.ctx).doc.state;
    const out = entityOverlay(state, this.hover, TAG_HOVER_COLOR);
    const tag = this.activeTagName();
    if (tag) out.push({ kind: 'cursorHint', text: tag, screen: this.cursorScreen ?? undefined });
    return out;
  }

  status(): ToolStatus {
    const tag = this.activeTagName();
    const base = `Click an entity to assign the tag "${tag ?? 'Untagged'}". Set the active tag with the pencil in the Tags panel.`;
    return { instructor: this.lastAssigned ? `${this.lastAssigned}. ${base}` : base, vcbLabel: '' };
  }

  private activeTagName(): string | null {
    if (!this.ctx) return null;
    const host = hostOfTool(this.ctx);
    const id = activeTagId(this.ctx.commands.ctx) ?? host.doc.state.defaultTagId;
    return host.doc.state.tags.get(id)?.name ?? null;
  }

  /** The selectable entity under the cursor when it lives in the current edit context. */
  private pickable(e: ToolPointerEvent): EntityRef | null {
    const hit = e.inference?.hit;
    if (!hit || !this.ctx) return null;
    const ref = hit.selectable ?? hit.ref;
    return samePath(ref.path, hostOfTool(this.ctx).context.path) ? ref : null;
  }
}
