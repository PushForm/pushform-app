// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Vec2 } from '@pushform/core';
import type { InferenceOptions } from '@pushform/inference';
import type { EntityRef } from '@pushform/model';
import { SERVICE_INFERENCE } from '../../host/services';
import type { DeleteResult } from '../../commands/sketch';
import type { OverlayPrimitive } from '../overlay';
import type { Modifiers, Tool, ToolContext, ToolKeyEvent, ToolPointerEvent, ToolStatus } from '../Tool';
import { DRAG_PX, HOVER_COLOR, screenDist } from '../toolUtil';
import { opOf, type BoxSelectMode } from './Select';

/** Optional lasso extension of the inference engine. */
interface LassoPicker {
  pickLasso?(outline: readonly Vec2[], mode: BoxSelectMode, opts?: InferenceOptions): readonly EntityRef[];
}

/** Freehand points closer than this to the previous one are dropped (CSS px). */
const FREEHAND_STEP_PX = 3;

/**
 * `crossing` for an outline drawn clockwise on screen (selects what it touches), `window` for
 * counterclockwise (selects what it fully encloses). Screen y
 * points down, so a positive shoelace sum is clockwise as seen.
 */
export function lassoModeOf(outline: readonly Vec2[]): BoxSelectMode {
  let twiceArea = 0;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    twiceArea += outline[j]![0] * outline[i]![1] - outline[i]![0] * outline[j]![1];
  }
  return twiceArea > 0 ? 'crossing' : 'window';
}

/**
 * Lasso tool (Shift+Space). Drag to draw a freehand outline that closes
 * on release, or click outline points and double-click or press Enter to close it. Clockwise
 * selects what the outline touches, counterclockwise what it encloses; Ctrl adds, Shift toggles,
 * Ctrl+Shift removes. Esc drops the outline; Delete/Backspace deletes the selection.
 */
export class LassoTool implements Tool {
  readonly id = 'lasso';
  readonly title = 'Lasso';
  readonly cursor = 'crosshair';

  private ctx: ToolContext | null = null;
  private points: Vec2[] = [];
  /** Where the pointer went down, while a freehand drag may start. */
  private downScreen: Vec2 | null = null;
  private freehand = false;
  private suppressNextClick = false;
  private hoverScreen: Vec2 | null = null;
  private message: string | null = null;

  /** The outline drawn so far (screen px). */
  get outline(): readonly Vec2[] {
    return this.points;
  }

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
  }
  deactivate(): void {
    this.reset();
    this.ctx = null;
  }

  inferenceOptions(): InferenceOptions {
    return { pickOnly: true };
  }

  onPointerDown(e: ToolPointerEvent): void {
    if (e.button !== 0 || this.points.length) return;
    this.downScreen = e.screen;
  }

  onPointerMove(e: ToolPointerEvent): void {
    this.hoverScreen = e.screen;
    if (this.downScreen && (e.buttons & 1) !== 0) {
      if (!this.freehand && screenDist(this.downScreen, e.screen) > DRAG_PX) {
        this.freehand = true;
        this.points = [this.downScreen];
      }
      if (this.freehand && screenDist(this.points.at(-1)!, e.screen) >= FREEHAND_STEP_PX) this.points.push(e.screen);
    }
    this.ctx?.requestRender();
  }

  onPointerUp(e: ToolPointerEvent): void {
    if (e.button !== 0) return;
    this.downScreen = null;
    if (!this.freehand) return;
    this.freehand = false;
    this.suppressNextClick = true;
    if (screenDist(this.points.at(-1)!, e.screen) > 0) this.points.push(e.screen);
    this.finish(e.modifiers);
  }

  onClick(e: ToolPointerEvent): void {
    if (this.suppressNextClick) {
      this.suppressNextClick = false;
      return;
    }
    if (e.button !== 0) return;
    this.message = null;
    // The two clicks of a double-click land on one spot; keep a single point there.
    const last = this.points.at(-1);
    if (!last || screenDist(last, e.screen) > DRAG_PX) this.points.push(e.screen);
    this.ctx?.statusChanged();
  }

  onDoubleClick(e: ToolPointerEvent): void {
    if (e.button !== 0 || !this.points.length) return;
    this.finish(e.modifiers);
  }

  onKeyDown(e: ToolKeyEvent): boolean {
    if (e.key === 'Enter' && this.points.length) {
      this.finish(e.modifiers);
      return true;
    }
    if ((e.key !== 'Delete' && e.key !== 'Backspace') || this.points.length) return false;
    if (this.ctx?.commands.isEnabled('edit.delete')) {
      const res = this.ctx.commands.execute('edit.delete') as DeleteResult;
      this.message = res.message;
      this.ctx.statusChanged();
    }
    return true;
  }

  onCancel(): void {
    this.reset();
    this.ctx?.statusChanged();
    this.ctx?.requestRender();
  }

  overlay(): readonly OverlayPrimitive[] {
    if (!this.points.length) return [];
    // While clicking points, the outline runs on to the cursor and closes back to its start.
    const points = !this.freehand && this.hoverScreen ? [...this.points, this.hoverScreen] : this.points;
    return [{ kind: 'screenPolyline', points, color: HOVER_COLOR, dashed: lassoModeOf(points) === 'crossing', closed: true }];
  }

  status(): ToolStatus {
    const base = this.points.length && !this.freehand
      ? 'Click to add outline points; double-click or press Enter to select, Esc to cancel.'
      : 'Drag around entities to select them: clockwise selects what the outline touches, counterclockwise what it encloses. Ctrl = add, Shift = add/remove, Ctrl+Shift = remove.';
    return { instructor: this.message ? `${this.message} ${base}` : base, vcbLabel: '' };
  }

  private finish(mods: Modifiers): void {
    const outline = this.points;
    this.reset();
    if (outline.length >= 3 && this.ctx) {
      const engine = this.ctx.commands.ctx.services.get(SERVICE_INFERENCE) as LassoPicker | undefined;
      if (engine && typeof engine.pickLasso === 'function') {
        const refs = engine.pickLasso(outline, lassoModeOf(outline), this.inferenceOptions());
        const op = opOf(mods);
        if (refs.length || op === 'set') this.ctx.commands.execute(`selection.${op}`, { refs });
      }
    }
    this.ctx?.statusChanged();
    this.ctx?.requestRender();
  }

  private reset(): void {
    this.points = [];
    this.downScreen = null;
    this.freehand = false;
    this.message = null;
  }
}
