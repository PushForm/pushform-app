// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { DefId, Id, Vec2, Vec3 } from '@pushform/core';
import { m4translation } from '@pushform/core';
import type { InferenceResult } from '@pushform/inference';
import { createEntityContainer } from '@pushform/model';
import type { ComponentDefinition, DocumentState, EntityRef } from '@pushform/model';
import { componentPlacement, type ComponentPlacementStore } from '../../commands/components';
import type { OverlayPrimitive } from '../overlay';
import type { Tool, ToolContext, ToolPointerEvent, ToolStatus } from '../Tool';
import { hostOfTool, inferenceOverlay } from '../toolUtil';
import { movedOutline } from './transformShared';

/** The placeholder ids the outline preview uses for its stand-in model and instance. */
const PREVIEW_ROOT = -1 as DefId, PREVIEW_INSTANCE = -1 as Id;

/**
 * Place Component: the chosen component follows the cursor by its insertion point (its definition's origin),
 * outlined, without touching the document; a click places it with `component.place` and returns to Select. Escape or
 * another tool cancels.
 */
export class PlaceComponentTool implements Tool {
  readonly id = 'placeComponent';
  readonly title = 'Place Component';
  readonly cursor = 'copy';

  private ctx: ToolContext | null = null;
  private definitionId: DefId | null = null;
  private preview: { state: DocumentState; refs: EntityRef[] } | null = null;
  private point: Vec3 | null = null;
  private inference: InferenceResult | null = null;
  private screen: Vec2 | null = null;
  private error: string | null = null;

  constructor(private readonly store: ComponentPlacementStore = componentPlacement) {}

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
    this.definitionId = this.store.current;
    this.point = null;
    this.error = null;
    this.preview = this.definitionId === null ? null : previewModel(hostOfTool(ctx).doc.state, this.definitionId);
  }
  deactivate(): void {
    this.ctx = null;
    this.preview = null;
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
    if (e.button !== 0 || !ctx || this.definitionId === null || !e.inference) return;
    const point = e.inference.point;
    try {
      ctx.commands.execute('component.place', { definitionId: this.definitionId, point: [point[0], point[1], point[2]] });
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
    if (this.preview && this.point) out.push(...movedOutline(this.preview.state, this.preview.refs, m4translation(this.point)));
    out.push(...inferenceOverlay(this.inference, this.screen ?? undefined));
    return out;
  }

  status(): ToolStatus {
    const name = this.definitionId === null ? null : (this.ctx ? hostOfTool(this.ctx).doc.state.definitions.get(this.definitionId)?.name : undefined);
    const instructor = this.error ? `Place failed: ${this.error}` : name ? `Click to place ${name}. Esc cancels.` : 'Choose a component in the Components panel first.';
    return { instructor, vcbLabel: '' };
  }
}

/** A stand-in model holding one placement of the component at the origin, for its outline. */
function previewModel(state: DocumentState, definitionId: DefId): { state: DocumentState; refs: EntityRef[] } | null {
  const def = state.definitions.get(definitionId);
  const root = state.definitions.get(state.rootDefinitionId);
  if (!def || !root) return null;
  const entities = createEntityContainer();
  entities.instances.set(PREVIEW_INSTANCE, {
    id: PREVIEW_INSTANCE, definitionId, transform: m4translation([0, 0, 0]) as never, name: '', materialId: null,
    tagId: state.defaultTagId, hidden: false, locked: false, castShadows: true, receiveShadows: true, attributes: {},
  });
  entities.order.push(PREVIEW_INSTANCE);
  const previewRoot: ComponentDefinition = { ...root, id: PREVIEW_ROOT, entities };
  const definitions = new Map(state.definitions);
  definitions.set(PREVIEW_ROOT, previewRoot);
  return { state: { ...state, definitions, rootDefinitionId: PREVIEW_ROOT }, refs: [{ kind: 'instance', path: [], id: PREVIEW_INSTANCE }] };
}
