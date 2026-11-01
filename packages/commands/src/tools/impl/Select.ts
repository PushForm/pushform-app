// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Id, Vec2 } from '@pushform/core';
import type { InferenceOptions, PickHit } from '@pushform/inference';
import { containerAt, instanceAt, pathWithin } from '@pushform/model';
import type { EntityRef, Sketch } from '@pushform/model';
import { SERVICE_INFERENCE } from '../../host/services';
import type { DocumentHost } from '../../host/DocumentHost';
import { connectedSketchRefs, faceBoundingEdgeRefs, facesUsingEdge, surfaceRefs } from '../../commands/sketchQueries';
import type { DeleteResult } from '../../commands/sketch';
import type { OverlayPrimitive } from '../overlay';
import type { Modifiers, Tool, ToolContext, ToolKeyEvent, ToolPointerEvent, ToolStatus } from '../Tool';
import { ctrlLike, DRAG_PX, entityOverlay, HOVER_COLOR, hostOfTool, screenDist } from '../toolUtil';

export type BoxSelectMode = 'window' | 'crossing';

export interface BoxPickRect {
  readonly min: Vec2;
  readonly max: Vec2;
  /** `window`: fully inside (drag left→right); `crossing`: touching (drag right→left). */
  readonly mode: BoxSelectMode;
}

/** Optional box-pick extension of the inference engine (not part of the M1 contract yet). */
interface BoxPicker {
  pickBox?(rect: BoxPickRect, opts?: InferenceOptions): readonly EntityRef[];
}

export type SelectOp = 'set' | 'add' | 'toggle' | 'remove';

/** Max interval and movement between clicks that still count as a multi-click. */
const MULTI_CLICK_MS = 400;
const MULTI_CLICK_PX = 4;

/** Command ids of the edit-context commands (registered by `contextCommands`; optional here). */
const CONTEXT_ENTER = 'context.enter';
const CONTEXT_EXIT = 'context.exit';

/** The ref the Select tool acts on for a hit: the entity itself, or the instance below the context. */
export function selectableOf(hit: PickHit): EntityRef {
  return hit.selectable ?? hit.ref;
}

/**
 * Instance path a double-click on `hit` should open, or null when the hit lives in the current
 * context (then the M1 double-click expansion applies). The instance is the one directly below
 * `contextPath` on the hit's path, i.e. the thing the user sees from the open context.
 */
export function enterPathOf(hit: PickHit, contextPath: readonly Id[]): Id[] | null {
  const sel = selectableOf(hit);
  if (sel.kind === 'instance') return [...sel.path, sel.id];
  const path = hit.ref.path;
  if (path.length > contextPath.length && pathWithin(path, contextPath)) return [...path.slice(0, contextPath.length + 1)];
  return null;
}

/**
 * Select tool (Space). Hover highlight, click (Ctrl add, Shift toggle, Ctrl+Shift remove),
 * empty click clears (or exits the open edit context), double-click a sketch face = face + bounding
 * edges, double-click a sketch edge = edge + faces, double-click a body face = the body, double-click
 * a group/component = enter it (`context.enter`), triple-click = all connected sketch geometry, drag
 * box (L→R window, R→L crossing), Delete/Backspace = `edit.delete`, Esc with nothing selected =
 * exit one context level (`context.exit`).
 */
export class SelectTool implements Tool {
  readonly id = 'select';
  readonly title = 'Select';
  readonly cursor = 'default';
  readonly role = 'select' as const;

  private ctx: ToolContext | null = null;
  private hover: EntityRef | null = null;
  private downScreen: Vec2 | null = null;
  private dragTo: Vec2 | null = null;
  private suppressNextClick = false;
  private clickRun = 0;
  private lastClickAt = 0;
  private lastClickScreen: Vec2 | null = null;
  private message: string | null = null;
  private offContext: (() => void) | null = null;
  /** Injectable clock for multi-click detection (tests). */
  now: () => number = () => Date.now();

  /** Entity under the cursor, or null. */
  get hoverRef(): EntityRef | null {
    return this.hover;
  }
  /** Current drag box, or null. */
  get dragBox(): BoxPickRect | null {
    if (!this.downScreen || !this.dragTo) return null;
    return boxOf(this.downScreen, this.dragTo);
  }

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
    const host = this.host();
    // The status line names the open group/component; refresh it when the context changes.
    this.offContext = host ? host.events.on('contextChanged', () => ctx.statusChanged()) : null;
  }
  deactivate(): void {
    this.reset();
    this.hover = null;
    this.offContext?.();
    this.offContext = null;
    this.ctx = null;
  }

  inferenceOptions(): InferenceOptions {
    return { pickOnly: true };
  }

  onPointerMove(e: ToolPointerEvent): void {
    const hit = e.inference?.hit ?? null;
    this.hover = hit ? selectableOf(hit) : null;
    if (this.downScreen && (e.buttons & 1) !== 0) this.dragTo = e.screen;
    this.ctx?.requestRender();
  }

  onPointerDown(e: ToolPointerEvent): void {
    if (e.button !== 0) return;
    this.downScreen = e.screen;
    this.dragTo = null;
  }

  onPointerUp(e: ToolPointerEvent): void {
    if (e.button !== 0 || !this.downScreen) return;
    const start = this.downScreen;
    this.downScreen = null;
    this.dragTo = null;
    if (screenDist(start, e.screen) <= DRAG_PX) return;
    this.suppressNextClick = true;
    this.boxSelect(boxOf(start, e.screen), e.modifiers);
  }

  onClick(e: ToolPointerEvent): void {
    if (this.suppressNextClick) {
      this.suppressNextClick = false;
      return;
    }
    if (e.button !== 0) return;
    this.message = null;
    const run = this.countClick(e.screen);
    const hit = e.inference?.hit ?? null;
    const ref = hit ? selectableOf(hit) : null;
    this.hover = ref;
    if (run >= 3 && ref) {
      this.apply(this.connected(ref), e.modifiers);
      return;
    }
    if (ref) {
      // A face of a smooth surface selects the whole surface.
      const host = this.host();
      this.apply(host ? surfaceRefs(host.doc.state, ref) : [ref], e.modifiers);
    }
    else if (opOf(e.modifiers) === 'set') {
      // Empty click: in an edit context this closes it (click outside the group).
      if (!this.exitContext()) this.apply([], 'set');
    }
  }

  onDoubleClick(e: ToolPointerEvent): void {
    if (e.button !== 0) return;
    const hit = e.inference?.hit ?? null;
    if (!hit) return;
    const ref = selectableOf(hit);
    this.hover = ref;
    const host = this.host();
    // Double-clicking a section plane turns its container's cut on or off.
    if (ref.kind === 'sectionPlane' && host && this.ctx) {
      const active = containerAt(host.doc.state, ref.path).activeSectionPlaneId === ref.id;
      this.ctx.commands.tryExecute('sectionPlane.setActive', { path: [...ref.path], id: ref.id, active: !active });
      this.ctx.requestRender();
      return;
    }
    // Double-clicking a text opens it for editing in place.
    if (ref.kind === 'text' && this.ctx) {
      this.ctx.commands.tryExecute('ui.editText', { ref });
      return;
    }
    const enter = host ? enterPathOf(hit, host.context.path) : null;
    if (enter && this.ctx?.commands.isEnabled(CONTEXT_ENTER)) {
      // Entering clears the selection (DocumentHost.setContext); the click that preceded the
      // double-click already selected the instance.
      this.ctx.commands.execute(CONTEXT_ENTER, { path: enter });
      this.hover = null;
      this.clickRun = 0;
      this.ctx.requestRender();
      return;
    }
    this.apply(this.expand(hit.ref), e.modifiers);
  }

  onKeyDown(e: ToolKeyEvent): boolean {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return false;
    if (!this.ctx) return true;
    if (this.ctx.commands.isEnabled('edit.delete')) {
      const res = this.ctx.commands.execute('edit.delete') as DeleteResult;
      this.message = res.message;
      this.hover = null;
      this.ctx.statusChanged();
    }
    return true;
  }

  /** Esc: cancel a drag / message; with nothing selected inside a context, close one level. */
  onCancel(): void {
    const wasDragging = this.downScreen !== null;
    this.reset();
    const host = this.host();
    if (!wasDragging && host && host.selection.isEmpty) this.exitContext();
    this.ctx?.requestRender();
  }

  overlay(): readonly OverlayPrimitive[] {
    const out: OverlayPrimitive[] = [];
    const box = this.dragBox;
    if (box) {
      out.push({ kind: 'screenRect', a: box.min, b: box.max, color: HOVER_COLOR, dashed: box.mode === 'crossing' });
    } else if (this.hover && this.ctx) {
      out.push(...entityOverlay(hostOfTool(this.ctx).doc.state, this.hover, HOVER_COLOR));
    }
    return out;
  }

  status(): ToolStatus {
    const base = 'Select objects. Ctrl = add, Shift = add/remove, Ctrl+Shift = remove. Drag for a selection box.';
    const editing = this.editingLabel();
    const text = this.message ? `${this.message} ${base}` : base;
    return { instructor: editing ? `${editing} ${text}` : text, vcbLabel: '' };
  }

  // --- internals ------------------------------------------------------------------------------

  private host(): DocumentHost | null {
    if (!this.ctx) return null;
    try {
      return hostOfTool(this.ctx);
    } catch {
      return null;
    }
  }

  /** "Editing Group: name" / "Editing Component: name" while an edit context is open. */
  private editingLabel(): string | null {
    const host = this.host();
    if (!host || host.context.path.length === 0) return null;
    try {
      const inst = instanceAt(host.doc.state, host.context.path);
      const def = inst ? host.doc.state.definitions.get(inst.definitionId) : undefined;
      if (!inst || !def) return null;
      const name = inst.name || def.name;
      return `Editing ${def.isGroup ? 'Group' : 'Component'}: ${name}.`;
    } catch {
      return null;
    }
  }

  /** Close one context level when one is open and the command exists. Returns true when it did. */
  private exitContext(): boolean {
    const host = this.host();
    if (!host || !this.ctx || host.context.path.length === 0) return false;
    if (!this.ctx.commands.isEnabled(CONTEXT_EXIT)) return false;
    this.ctx.commands.execute(CONTEXT_EXIT);
    this.hover = null;
    return true;
  }

  private apply(refs: readonly EntityRef[], mods: Modifiers | SelectOp): void {
    if (!this.ctx) return;
    const op = typeof mods === 'string' ? mods : opOf(mods);
    this.ctx.commands.execute(`selection.${op}`, { refs });
    this.ctx.requestRender();
  }

  private boxSelect(rect: BoxPickRect, mods: Modifiers): void {
    if (!this.ctx) return;
    const engine = this.ctx.commands.ctx.services.get(SERVICE_INFERENCE) as BoxPicker | undefined;
    if (!engine || typeof engine.pickBox !== 'function') return;
    const refs = engine.pickBox(rect, this.inferenceOptions());
    if (refs.length || opOf(mods) === 'set') this.apply(refs, mods);
  }

  /** Sketch of the container that owns `ref` (root, or the definition opened at `ref.path`). */
  private sketchOf(ref: EntityRef): Sketch | null {
    const host = this.host();
    if (!host) return null;
    try {
      return containerAt(host.doc.state, ref.path).sketch;
    } catch {
      return null;
    }
  }

  /** Double-click expansion: sketch face + its edges, sketch edge + its faces, body face → body. */
  private expand(ref: EntityRef): EntityRef[] {
    const sketch = this.sketchOf(ref);
    if (!sketch) return [ref];
    const path = ref.path;
    switch (ref.kind) {
      case 'sketchFace':
        return [ref, ...faceBoundingEdgeRefs(sketch, ref.id).map((r) => ({ ...r, path }))];
      case 'sketchEdge':
        return [ref, ...facesUsingEdge(sketch, ref.id).map((id): EntityRef => ({ kind: 'sketchFace', path, id }))];
      case 'face':
      case 'edge':
        // A body's faces select the whole body.
        return [{ kind: 'body', path, id: ref.id }];
      default:
        return [ref];
    }
  }

  private connected(ref: EntityRef): EntityRef[] {
    const sketch = this.sketchOf(ref);
    if (!sketch) return [ref];
    const refs = connectedSketchRefs(sketch, ref).map((r) => ({ ...r, path: ref.path }));
    return refs.length ? refs : this.expand(ref);
  }

  private countClick(screen: Vec2): number {
    const t = this.now();
    const near = this.lastClickScreen ? screenDist(this.lastClickScreen, screen) <= MULTI_CLICK_PX : false;
    this.clickRun = near && t - this.lastClickAt <= MULTI_CLICK_MS ? this.clickRun + 1 : 1;
    this.lastClickAt = t;
    this.lastClickScreen = screen;
    return this.clickRun;
  }

  private reset(): void {
    this.downScreen = null;
    this.dragTo = null;
    this.suppressNextClick = false;
    this.clickRun = 0;
    this.message = null;
  }
}

/** Selection operation for click modifiers: Ctrl add, Shift toggle, Ctrl+Shift remove, none replace. */
export function opOf(m: Modifiers): SelectOp {
  const ctrl = ctrlLike(m);
  if (ctrl && m.shift) return 'remove';
  if (ctrl) return 'add';
  if (m.shift) return 'toggle';
  return 'set';
}

function boxOf(start: Vec2, end: Vec2): BoxPickRect {
  return {
    min: [Math.min(start[0], end[0]), Math.min(start[1], end[1])],
    max: [Math.max(start[0], end[0]), Math.max(start[1], end[1])],
    mode: end[0] >= start[0] ? 'window' : 'crossing',
  };
}
