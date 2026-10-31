// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { v3dot } from '@pushform/core';
import type { Vec2 } from '@pushform/core';
import type { InferenceOptions, PickHit } from '@pushform/inference';
import type { EntityRef } from '@pushform/model';
import { activeMaterialOf } from '../../host/services';
import type { ActiveMaterialHost } from '../../host/services';
import { detectPlatform } from '../../keymap/Keymap';
import type { Platform } from '../../keymap/Keymap';
import type { PaintMode, PaintResult, PaintSide } from '../../commands/materials';
import type { OverlayPrimitive } from '../overlay';
import type { Modifiers, Tool, ToolContext, ToolKeyEvent, ToolPointerEvent, ToolStatus } from '../Tool';
import { entityOverlay, HOVER_COLOR, hostOfTool } from '../toolUtil';

/**
 * Paint mode for a modifier set. `sampling` = the panel's Sample button.
 *
 * On a Mac, Ctrl+click is the context menu and never reaches the tool, so Option stands in for
 * Ctrl (adjacent fill, and with Shift replace on the object) and Cmd samples. Elsewhere Ctrl is
 * Ctrl and Alt samples.
 */
export function paintModeOf(m: Modifiers, sampling = false, platform: Platform = detectPlatform()): PaintMode {
  const mac = platform === 'mac';
  const ctrl = mac ? m.ctrl || m.alt : m.ctrl;
  const sample = mac ? m.meta : m.alt || m.meta;
  if (sampling || sample) return 'sample';
  if (ctrl && m.shift) return 'replaceOnObject';
  if (m.shift) return 'replaceAll';
  if (ctrl) return 'adjacent';
  return 'single';
}

/** The modifier keys of each mode, named for the platform (status text and help). */
export function paintModifierKeys(platform: Platform = detectPlatform()): { ctrl: string; sample: string } {
  return platform === 'mac' ? { ctrl: 'Option', sample: 'Cmd' } : { ctrl: 'Ctrl', sample: 'Alt' };
}

/** Side of the hit face the pointer sees: front when the face normal points toward the camera. */
export function hitSide(hit: PickHit | null, rayDir: readonly [number, number, number]): PaintSide {
  if (!hit?.normal) return 'front';
  return v3dot(hit.normal, rayDir) < 0 ? 'front' : 'back';
}

/**
 * Paint Bucket (B). Hover highlights the face / body / group under the cursor; a click
 * paints it with the active material. Ctrl = fill edge-connected faces with the same material,
 * Shift = replace that material everywhere in the context, Ctrl+Shift = replace it on the same
 * object, Alt = sample (the material under the cursor becomes the active one). On a Mac, Option
 * takes the place of Ctrl and Cmd samples (`paintModeOf`). Painting a group/component sets its
 * instance material; faces with explicit materials keep them.
 *
 * Selection: a plain click on an entity that is part of the current selection
 * paints the whole selection (faces, bodies, groups/components picked with Select or a drag box).
 * Clicking an unselected entity paints only that entity and leaves the selection alone.
 */
const PAINTABLE_KINDS: ReadonlySet<EntityRef['kind']> = new Set(['face', 'sketchFace', 'body', 'meshPart', 'instance']);
/** Selection highlight cap while hovering (the paint itself is not capped). */
const MAX_SELECTION_OVERLAY = 500;

export class PaintTool implements Tool {
  readonly id = 'paint';
  readonly title = 'Paint Bucket';
  readonly cursor = 'copy';

  private readonly platform: Platform = detectPlatform();
  private ctx: ToolContext | null = null;
  private hover: EntityRef | null = null;
  private hoverSide: PaintSide = 'front';
  private modifiers: Modifiers = { shift: false, ctrl: false, alt: false, meta: false };
  private cursorScreen: Vec2 | null = null;
  private message: string | null = null;
  private _sampling = false;
  private offMaterial: (() => void) | null = null;
  /** Last paint result (tests / status). */
  lastResult: PaintResult | null = null;

  /** Entity under the cursor (the bootstrap mirrors it into the viewport highlight). */
  get hoverRef(): EntityRef | null {
    return this.hover;
  }
  /** One-shot sample mode (Materials panel › Sample): the next click samples instead of painting. */
  get sampling(): boolean {
    return this._sampling;
  }
  setSampling(on: boolean): void {
    this._sampling = on;
    this.ctx?.statusChanged();
  }

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
    this.offMaterial = this.materials()?.onChange(() => ctx.statusChanged()) ?? null;
  }
  deactivate(): void {
    this.offMaterial?.();
    this.offMaterial = null;
    this.hover = null;
    this.message = null;
    this._sampling = false;
    this.ctx = null;
  }

  inferenceOptions(): InferenceOptions {
    return { pickOnly: true, kinds: ['face', 'sketchFace'] };
  }

  onPointerMove(e: ToolPointerEvent): void {
    this.cursorScreen = e.screen;
    this.modifiers = e.modifiers;
    const hit = e.inference?.hit ?? null;
    this.hover = hit ? (hit.selectable ?? hit.ref) : null;
    this.hoverSide = hitSide(hit, e.ray.dir);
    this.ctx?.requestRender();
  }

  onKeyDown(e: ToolKeyEvent): boolean {
    this.modifiers = e.modifiers;
    this.ctx?.statusChanged();
    return false;
  }
  onKeyUp(e: ToolKeyEvent): boolean {
    this.modifiers = e.modifiers;
    this.ctx?.statusChanged();
    return false;
  }

  onClick(e: ToolPointerEvent): void {
    if (e.button !== 0 || !this.ctx) return;
    const hit = e.inference?.hit ?? null;
    const ref = hit ? (hit.selectable ?? hit.ref) : null;
    this.hover = ref;
    this.message = null;
    if (!ref) return;
    const mode = paintModeOf(e.modifiers, this._sampling, this.platform);
    const side = hitSide(hit, e.ray.dir);
    if (!this.inContext(ref)) {
      this.message = 'Open the group or component to paint inside it.';
      this.ctx.statusChanged();
      return;
    }
    const materials = this.materials();
    const materialId = materials?.get() ?? null;
    if (mode === 'sample') {
      const sampled = this.ctx.commands.execute('paint.sample', { ref, side }) as number | null;
      this._sampling = false;
      this.message = sampled === null ? 'Sampled the default material.' : `Sampled ${this.materialName(sampled)}.`;
      this.ctx.statusChanged();
      return;
    }
    // A plain click on a selected entity paints everything that is selected.
    const selected = mode === 'single' && this.isSelected(ref) ? this.paintableSelection() : null;
    const refs = selected && selected.length > 0 ? selected : [ref];
    this.lastResult = this.ctx.commands.execute('paint.apply', { refs, materialId, mode, side }) as PaintResult;
    this.ctx.requestRender();
    this.ctx.statusChanged();
  }

  onCancel(): void {
    this.hover = null;
    this.message = null;
    this._sampling = false;
    this.ctx?.requestRender();
    this.ctx?.statusChanged();
  }

  overlay(): readonly OverlayPrimitive[] {
    if (!this.ctx || !this.hover) return [];
    const state = hostOfTool(this.ctx).doc.state;
    const mode = paintModeOf(this.modifiers, this._sampling, this.platform);
    // hovering a selected entity previews the whole selection getting painted
    const refs = mode === 'single' && this.isSelected(this.hover) ? this.paintableSelection().slice(0, MAX_SELECTION_OVERLAY) : [this.hover];
    const out: OverlayPrimitive[] = [];
    for (const r of refs) out.push(...entityOverlay(state, r, HOVER_COLOR));
    if (this.message) out.push({ kind: 'cursorHint', text: this.message, screen: this.cursorScreen ?? undefined });
    return out;
  }

  status(): ToolStatus {
    const mode = paintModeOf(this.modifiers, this._sampling, this.platform);
    const name = this.activeName();
    const verb =
      mode === 'sample' ? 'Click to sample a material.'
      : mode === 'adjacent' ? `Click to paint connected faces with ${name}.`
      : mode === 'replaceAll' ? `Click to replace that material with ${name} everywhere in the context.`
      : mode === 'replaceOnObject' ? `Click to replace that material with ${name} on the same object.`
      : `Click a face or object to paint it with ${name}.`;
    const k = paintModifierKeys(this.platform);
    const keys = `${k.ctrl} = adjacent, Shift = replace all, ${k.ctrl}+Shift = replace on object, ${k.sample} = sample.`;
    const side = this.hover && (this.hover.kind === 'face' || this.hover.kind === 'sketchFace') && this.hoverSide === 'back' ? ' (back side)' : '';
    const text = `${verb}${side} ${keys}`;
    return { instructor: this.message ? `${this.message} ${text}` : text, vcbLabel: '' };
  }

  // --- internals ------------------------------------------------------------------------------

  private inContext(ref: EntityRef): boolean {
    if (!this.ctx) return false;
    const path = hostOfTool(this.ctx).context.path;
    return ref.path.length === path.length && ref.path.every((id, i) => id === path[i]);
  }

  /**
   * Whether the entity under the cursor belongs to the selection: selected itself, or a face of a
   * selected body (a drag-selected "shape" selects the body, so clicking any of its faces counts).
   */
  private isSelected(ref: EntityRef): boolean {
    if (!this.ctx) return false;
    const sel = hostOfTool(this.ctx).selection;
    if (sel.size === 0) return false;
    if (sel.has(ref)) return true;
    if (ref.kind === 'face') return sel.has({ kind: 'body', path: ref.path, id: ref.id });
    return false;
  }

  /** Selected entities the Paint command can take, limited to the current context. */
  private paintableSelection(): EntityRef[] {
    if (!this.ctx) return [];
    return hostOfTool(this.ctx)
      .selection.refs.filter((r) => PAINTABLE_KINDS.has(r.kind) && this.inContext(r));
  }

  private materials(): ActiveMaterialHost | null {
    return this.ctx ? activeMaterialOf(this.ctx.commands.ctx) : null;
  }

  private activeName(): string {
    const id = this.materials()?.get() ?? null;
    return id === null ? 'the default material' : this.materialName(id);
  }

  private materialName(id: number): string {
    if (!this.ctx) return `material ${id}`;
    try {
      return hostOfTool(this.ctx).doc.state.materials.get(id as never)?.name ?? `material ${id}`;
    } catch {
      return `material ${id}`;
    }
  }
}
