// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Box3, Vec2, Vec3 } from '@pushform/core';
import { box3Center, box3Size, LENGTH_TOL, m4transformPoint, planeFromPointNormal, v3dot, v3len, v3normalize, v3sub } from '@pushform/core';
import type { InferenceOptions, InferenceResult, Snap } from '@pushform/inference';
import { SNAP_COLORS } from '@pushform/inference';
import type { EntityRef } from '@pushform/model';
import { m4scaleAbout, refsBounds } from '../../commands/transform';
import type { VcbKind, VcbValue } from '../../vcb/parse';
import type { OverlayPrimitive } from '../overlay';
import { NO_MODIFIERS } from '../Tool';
import type { Modifiers, ToolKeyEvent, ToolPointerEvent, ToolStatus } from '../Tool';
import { pointerField } from '../entry';
import { DRAG_PX, entityOverlay, HOVER_COLOR, inferenceOverlay, screenDist } from '../toolUtil';
import { AXIS_COLOR, AXIS_DIR, movedOutline, pickRef, refsKey, sectionPreviewFor, TransformToolBase, withoutSectionPlanes, worldToScreen } from './transformShared';
import type { TransformCommit } from './transformShared';
import type { SectionPreview, SectionPreviewTool } from '../sectionPreview';

/** Grip pick radius in CSS px. */
export const GRIP_PICK_PX = 8;
/** Grips drawn within this many CSS px of each other overlap on screen: the one nearest the viewer is picked. */
const GRIP_OVERLAP_PX = 3.5;
const BOX_COLOR = '#e8c400';
const GRIP_COLOR = '#2faa3c';
const GRIP_HOVER_COLOR = '#e53935';

export type GripKind = 'corner' | 'edge' | 'face';

export interface ScaleGrip {
  readonly index: number;
  readonly pos: Vec3;
  /** Axes (0 x, 1 y, 2 z) this grip scales. */
  readonly axes: readonly number[];
  /** `corner`: all active dims (uniform), `edge`: dims − 1, `face`: one axis. */
  readonly kind: GripKind;
}

export interface ScaleBox {
  readonly bounds: Box3;
  readonly center: Vec3;
  readonly size: Vec3;
  /** Axes with a non-zero extent (3 = solid box, 2 = planar selection, 1 = a line). */
  readonly dims: readonly number[];
  readonly grips: readonly ScaleGrip[];
}

type State =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'scaling';
      readonly refs: EntityRef[];
      readonly box: ScaleBox;
      readonly grip: ScaleGrip;
      readonly downScreen: Vec2;
      anchor: Vec3;
      factors: Vec3;
      /** Whether the drag scales every axis by one factor (a corner grip, or an edge or face grip with Shift). */
      uniform: boolean;
      pressed: boolean;
      moved: boolean;
    };

/** What a committed scale needs for a typed redo: its anchor, factors, box and grip, and whether the drag was uniform. */
interface ScaleEdit {
  readonly anchor: Vec3;
  factors: Vec3;
  readonly size: Vec3;
  readonly axes: readonly number[];
  readonly dims: readonly number[];
  readonly kind: GripKind;
  readonly uniform: boolean;
}

const IDLE: State = { kind: 'idle' };

/** The yellow box and its green grips for a bounds (26 for a solid, 8 for a planar selection, 2 for a line). */
export function buildScaleBox(bounds: Box3): ScaleBox {
  const center = box3Center(bounds);
  const size = box3Size(bounds);
  const dims: number[] = [];
  for (let a = 0; a < 3; a++) if (size[a]! > LENGTH_TOL) dims.push(a);
  const grips: ScaleGrip[] = [];
  const steps = [-1, 0, 1];
  const combos: number[][] = [[]];
  for (let i = 0; i < dims.length; i++) {
    const next: number[][] = [];
    for (const c of combos) for (const s of steps) next.push([...c, s]);
    combos.splice(0, combos.length, ...next);
  }
  for (const c of combos) {
    if (c.every((s) => s === 0)) continue;
    const pos: [number, number, number] = [center[0], center[1], center[2]];
    const axes: number[] = [];
    dims.forEach((a, i) => {
      const s = c[i]!;
      pos[a] = center[a]! + (s * size[a]!) / 2;
      if (s !== 0) axes.push(a);
    });
    const kind: GripKind = axes.length === dims.length ? 'corner' : axes.length === dims.length - 1 ? 'edge' : 'face';
    grips.push({ index: grips.length, pos, axes, kind });
  }
  return { bounds, center, size, dims, grips };
}

/**
 * Nearest grip within `GRIP_PICK_PX` of the cursor, or null. Of grips that overlap on screen, such as a
 * front and a back corner seen square on, the one nearest the viewer.
 */
export function pickGrip(box: ScaleBox, screen: Vec2, camera: ToolPointerEvent['camera'], viewport: { width: number; height: number }): ScaleGrip | null {
  const near: { grip: ScaleGrip; at: Vec2; d: number }[] = [];
  for (const grip of box.grips) {
    const at = worldToScreen(camera, viewport, grip.pos);
    if (!at) continue;
    const d = screenDist(at, screen);
    if (d <= GRIP_PICK_PX) near.push({ grip, at, d });
  }
  if (!near.length) return null;
  const closest = near.reduce((a, b) => (b.d < a.d ? b : a));
  const forward = v3normalize(v3sub(camera.target, camera.eye));
  const depth = (p: Vec3): number => v3dot(v3sub(p, camera.eye), forward);
  let best = closest;
  for (const c of near) {
    if (screenDist(c.at, closest.at) <= GRIP_OVERLAP_PX && depth(c.grip.pos) < depth(best.grip.pos) - LENGTH_TOL) best = c;
  }
  return best.grip;
}

/** Edges of the box (12 for a solid, 4 for a planar box, 1 for a line). */
function boxEdges(box: ScaleBox): Vec3[][] {
  const { bounds, dims } = box;
  const corners: Vec3[] = [];
  const n = 1 << dims.length;
  for (let i = 0; i < n; i++) {
    const p: [number, number, number] = [box.center[0], box.center[1], box.center[2]];
    dims.forEach((a, k) => {
      p[a] = i & (1 << k) ? bounds.max[a]! : bounds.min[a]!;
    });
    corners.push(p);
  }
  const edges: Vec3[][] = [];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < dims.length; k++) {
      if (i & (1 << k)) continue;
      edges.push([corners[i]!, corners[i | (1 << k)]!]);
    }
  }
  return edges;
}

/**
 * Scale (S). Yellow bounding box of the selection with green grips: corners scale uniformly,
 * edge midpoints two axes, face centres one axis. Drag a grip to scale about the opposite grip
 * (Ctrl or Alt = about the centre, Shift toggles uniform); commit on release or click. VCB: a factor,
 * `x,y,z` factors, a length with a unit (the size along a face grip's axis, or of the longest side an
 * edge or corner grip scales, the others following uniformly); negative mirrors.
 */
export class ScaleTool extends TransformToolBase implements SectionPreviewTool {
  /** The last section preview and what it was made for, so an unchanged one is the same object. */
  private sectionCache: { refs: readonly EntityRef[]; key: string; preview: SectionPreview | null } | null = null;

  /** Modifiers of the last pointer event, for the held-key tags. */
  private mods: Modifiers = NO_MODIFIERS;
  readonly id = 'scale';
  readonly title = 'Scale';
  readonly cursor = 'default';
  readonly vcbSchema: readonly VcbKind[] = ['length', 'list'];

  private state: State = IDLE;
  private refs: EntityRef[] = [];
  private box: ScaleBox | null = null;
  private boxKey = '';
  private hoverGrip: ScaleGrip | null = null;
  private hover: EntityRef | null = null;
  private cursorInference: InferenceResult | null = null;
  private cursorScreen: Vec2 | null = null;
  /** What each commit this tool made scaled, for typed redos. */
  private edits = new WeakMap<TransformCommit, ScaleEdit>();

  /** Current box (grips) of the selection, or null when nothing is selected. */
  get scaleBox(): ScaleBox | null {
    this.refresh();
    return this.box;
  }
  get hoveredGrip(): ScaleGrip | null {
    return this.hoverGrip;
  }
  /** Per-axis factors of the current drag, or null. */
  get dragFactors(): Vec3 | null {
    return this.state.kind === 'scaling' ? this.state.factors : null;
  }

  protected override onActivate(): void {
    this.state = IDLE;
    this.mods = NO_MODIFIERS;
    this.boxKey = '';
    this.box = null;
    this.refresh();
  }
  hasPendingWork(): boolean {
    return this.state.kind !== 'idle';
  }

  protected override onDeactivate(): void {
    this.state = IDLE;
    this.box = null;
    this.hoverGrip = null;
    this.hover = null;
  }

  /** Section planes being scaled, drawn and cutting where the scale would put them. */
  get sectionPreview(): SectionPreview | null {
    const s = this.state, state = this.docState();
    if (s.kind !== 'scaling' || !state) return null;
    const key = `${s.anchor.join(',')}|${s.factors.join(',')}`;
    const cached = this.sectionCache;
    if (cached && cached.refs === s.refs && cached.key === key) return cached.preview;
    const preview = sectionPreviewFor(state, s.refs, m4scaleAbout(s.anchor, s.factors), false);
    this.sectionCache = { refs: s.refs, key, preview };
    return preview;
  }

  inferenceOptions(): InferenceOptions {
    const s = this.state;
    if (s.kind !== 'scaling') return { pickOnly: this.box !== null };
    const g = s.grip;
    const base = { anchor: g.pos, ignore: s.refs };
    if (g.kind === 'corner' && !s.uniform && s.box.dims.length > 1) {
      // Shift on a corner scales each axis freely: no diagonal lock (only the flat box's own plane)
      if (s.box.dims.length === 3) return base;
      const flat = [0, 1, 2].find((a) => !s.box.dims.includes(a))!;
      const normal = AXIS_DIR[(['x', 'y', 'z'] as const)[flat]!];
      const lock: Snap = { kind: 'onPlane', point: g.pos, plane: planeFromPointNormal(g.pos, normal), color: SNAP_COLORS.onPlane, label: 'On Plane' };
      return { ...base, lockSnap: lock };
    }
    if (g.kind === 'face' || (g.kind === 'corner' && s.box.dims.length === 1)) {
      const a = g.axes[0]!;
      const axis = (['x', 'y', 'z'] as const)[a]!;
      const lock: Snap = { kind: 'onAxis', point: g.pos, dir: AXIS_DIR[axis], axis, color: AXIS_COLOR[axis], label: 'Along axis' };
      return { ...base, lockSnap: lock };
    }
    if (g.kind === 'edge' && s.box.dims.length === 3) {
      const inactive = [0, 1, 2].find((a) => !g.axes.includes(a))!;
      const normal = AXIS_DIR[(['x', 'y', 'z'] as const)[inactive]!];
      const lock: Snap = { kind: 'onPlane', point: g.pos, plane: planeFromPointNormal(g.pos, normal), color: SNAP_COLORS.onPlane, label: 'On Plane' };
      return { ...base, lockSnap: lock };
    }
    const dir = v3sub(g.pos, s.anchor);
    if (v3len(dir) > LENGTH_TOL) {
      const lock: Snap = { kind: 'fromPoint', point: g.pos, dir: v3normalize(dir), color: SNAP_COLORS.fromPoint, label: 'From Point' };
      return { ...base, lockSnap: lock };
    }
    return base;
  }

  // --- pointer --------------------------------------------------------------------------------

  onPointerMove(e: ToolPointerEvent): void {
    this.mods = e.modifiers;
    this.cursorInference = e.inference;
    this.cursorScreen = e.screen;
    const s = this.state;
    if (s.kind === 'scaling') {
      if (!s.moved && screenDist(e.screen, s.downScreen) > DRAG_PX) s.moved = true;
      s.uniform = this.isUniform(s.grip, e.modifiers.shift);
      s.anchor = e.modifiers.ctrl || e.modifiers.alt ? s.box.center : this.opposite(s.box, s.grip);
      s.factors = this.factorsFor(e, s);
      this.ctx?.requestRender();
      this.ctx?.statusChanged();
      return;
    }
    this.refresh();
    const vp = this.ctx?.camera.viewportSize() ?? { width: 800, height: 600 };
    this.hoverGrip = this.box ? pickGrip(this.box, e.screen, e.camera, vp) : null;
    this.hover = this.box ? null : pickRef(e.inference?.hit);
    this.ctx?.requestRender();
  }

  onPointerDown(e: ToolPointerEvent): void {
    this.mods = e.modifiers;
    if (e.button !== 0) return;
    const s = this.state;
    if (s.kind === 'scaling') {
      if (s.pressed) return;
      if (!s.moved && screenDist(e.screen, s.downScreen) <= DRAG_PX) return;
      s.factors = this.factorsFor(e, s);
      this.commit(s.anchor, s.factors);
      return;
    }
    this.refresh();
    if (!this.box) {
      const hit = this.hover ?? pickRef(e.inference?.hit);
      if (hit) {
        this.lastError = null;
        this.targetRefs(hit);
        this.hover = null;
        this.refresh();
        this.ctx?.statusChanged();
        this.ctx?.requestRender();
      }
      return;
    }
    const vp = this.ctx?.camera.viewportSize() ?? { width: 800, height: 600 };
    const grip = pickGrip(this.box, e.screen, e.camera, vp);
    if (!grip) return;
    this.lastError = null;
    if (this.refuse(this.refs, false)) return;
    const box = this.box;
    this.state = {
      kind: 'scaling',
      refs: [...this.refs],
      box,
      grip,
      downScreen: e.screen,
      anchor: e.modifiers.ctrl || e.modifiers.alt ? box.center : this.opposite(box, grip),
      factors: [1, 1, 1],
      uniform: this.isUniform(grip, e.modifiers.shift),
      pressed: true,
      moved: false,
    };
    this.ctx?.statusChanged();
    this.ctx?.requestRender();
  }

  onPointerUp(e: ToolPointerEvent): void {
    if (e.button !== 0 || this.state.kind !== 'scaling' || !this.state.pressed) return;
    const s = this.state;
    s.pressed = false;
    if (!s.moved && screenDist(e.screen, s.downScreen) <= DRAG_PX) return;
    s.factors = this.factorsFor(e, s);
    this.commit(s.anchor, s.factors);
  }

  onKeyDown(e: ToolKeyEvent): boolean {
    if (e.key === 'Shift') this.setShift(true);
    if ((e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift') && this.state.kind === 'scaling' && this.cursorInference) {
      // the factors re-evaluate on the next move; just redraw
      this.ctx?.requestRender();
      return true;
    }
    return false;
  }

  onKeyUp(e: ToolKeyEvent): boolean {
    if (e.key !== 'Shift') return false;
    this.setShift(false);
    return this.state.kind === 'scaling';
  }

  /** Shift went down or up: the drag's uniform mode (and its inference lock) follows before the next move. */
  private setShift(down: boolean): void {
    this.mods = { ...this.mods, shift: down };
    const s = this.state;
    if (s.kind !== 'scaling') return;
    s.uniform = this.isUniform(s.grip, down);
    this.ctx?.statusChanged();
  }

  onVcb(v: VcbValue): void {
    const s = this.state;
    if (s.kind === 'scaling') {
      const f = this.factorsFromVcb(v, { anchor: s.anchor, factors: s.factors, size: s.box.size, axes: s.grip.axes, dims: s.box.dims, kind: s.grip.kind, uniform: s.uniform });
      if (f) this.commit(s.anchor, f);
      return;
    }
    const last = this.lastScale();
    if (!last) return;
    const f = this.factorsFromVcb(v, last);
    if (!f || f.every((k) => Math.abs(k - 1) < 1e-9)) return;
    last.factors = f;
    this.reapplyLast(m4scaleAbout(last.anchor, f));
    this.ctx?.statusChanged();
  }

  onCancel(): void {
    this.dropPickup();
    if (this.state.kind === 'scaling') {
      this.state = IDLE;
      this.ctx?.statusChanged();
      this.ctx?.requestRender();
      return;
    }
    this.lastCommit = null;
    this.lastError = null;
    this.ctx?.requestRender();
  }

  // --- overlay / status -----------------------------------------------------------------------

  overlay(): readonly OverlayPrimitive[] {
    const state = this.docState();
    const out: OverlayPrimitive[] = [];
    if (!state) return out;
    const s = this.state;
    if (s.kind === 'scaling') {
      const m = m4scaleAbout(s.anchor, s.factors);
      for (const e of boxEdges(s.box)) out.push({ kind: 'polyline', points: e.map((p) => m4transformPoint(m, p)), color: BOX_COLOR, width: 1.5 });
      // section planes are drawn, with their cuts, where they would go (sectionPreview)
      out.push(...movedOutline(state, withoutSectionPlanes(s.refs), m));
      out.push({ kind: 'point', position: m4transformPoint(m, s.grip.pos), color: GRIP_HOVER_COLOR, shape: 'square', size: 10 });
      out.push({ kind: 'point', position: s.anchor, color: '#111111', shape: 'square', size: 6 });
      out.push({ kind: 'label', position: m4transformPoint(m, s.grip.pos), text: this.fmtFactors(s.factors, s.box.dims), offset: [12, -12] });
    } else {
      this.refresh();
      const box = this.box;
      if (box) {
        for (const e of boxEdges(box)) out.push({ kind: 'polyline', points: e, color: BOX_COLOR, width: 1.5 });
        for (const g of box.grips) {
          const hovered = this.hoverGrip?.index === g.index;
          out.push({ kind: 'point', position: g.pos, color: hovered ? GRIP_HOVER_COLOR : GRIP_COLOR, shape: 'square', size: hovered ? 10 : 7 });
        }
      } else if (this.hover) {
        out.push(...entityOverlay(state, this.hover, HOVER_COLOR));
      }
    }
    out.push(...inferenceOverlay(this.cursorInference, this.cursorScreen ?? undefined));
    return out;
  }

  status(): ToolStatus {
    const s = this.state;
    if (s.kind === 'scaling') {
      return {
        instructor: s.grip.kind === 'corner'
          ? 'Drag the grip or enter a scale factor. Aspect ratio is kept; hold Shift to scale freely. Hold Alt (or Ctrl) to keep the centre.'
          : 'Drag the grip or enter a scale factor. Hold Shift to maintain aspect ratio, Alt (or Ctrl) to keep the centre.',
        vcbLabel: 'Scale',
        vcbValue: this.fmtFactors(s.factors, s.box.dims),
        fields: [pointerField('Scale', 'number', this.fmtFactors(s.factors, s.box.dims))],
        ...this.heldTags(s.grip.kind === 'corner'),
      };
    }
    const instructor = this.lastError
      ? `Scale failed: ${this.lastError}`
      : this.box
        ? 'Drag a grip to scale. Corners = uniform, edges = two axes, faces = one axis. Hold Shift to maintain aspect ratio, Alt to keep the centre.'
        : 'Select the entities to scale.';
    const last = this.lastScale();
    return { instructor, vcbLabel: 'Scale', vcbValue: last ? this.fmtFactors(last.factors, last.dims) : undefined };
  }

  /** Tags for the held keys while a grip is dragged: Shift's aspect ratio and Ctrl or Alt's centre. */
  private heldTags(corner: boolean): { held?: string[] } {
    const held: string[] = [];
    if (this.mods.shift) held.push(corner ? 'Free aspect ratio · Shift' : 'Uniform · Shift');
    if (this.mods.ctrl || this.mods.alt) held.push('About the center · Ctrl/Alt');
    return held.length ? { held } : {};
  }

  // --- internals ------------------------------------------------------------------------------

  /**
   * The scale just committed, while typing can still redo it: the last commit, still the last change (or
   * still being applied). Null after a tool switch, Esc, another change, or a failed commit.
   */
  private lastScale(): ScaleEdit | null {
    const last = this.lastCommit;
    const edit = last ? this.edits.get(last) : undefined;
    if (!last || !edit) return null;
    if (last.applied && !this.lastIsOnTop()) return null;
    return edit;
  }

  /** A corner grip scales uniformly and an edge or face grip per axis; Shift switches each to the other. */
  private isUniform(grip: ScaleGrip, shift: boolean): boolean {
    return (grip.kind === 'corner') !== shift;
  }

  /** Rebuild the box when the selection or the document changed. */
  private refresh(): void {
    const host = this.host();
    if (!host) return;
    const refs = host.selection.refs;
    const key = `${host.doc.version}:${refsKey(refs)}`;
    if (key === this.boxKey) return;
    this.boxKey = key;
    this.refs = refs;
    const bounds = refs.length ? refsBounds(host.doc.state, refs) : null;
    this.box = bounds ? buildScaleBox(bounds) : null;
    this.hoverGrip = null;
  }

  private opposite(box: ScaleBox, grip: ScaleGrip): Vec3 {
    return [2 * box.center[0] - grip.pos[0], 2 * box.center[1] - grip.pos[1], 2 * box.center[2] - grip.pos[2]];
  }

  private fmtFactors(f: Vec3, dims: readonly number[]): string {
    const vals = dims.map((a) => f[a]!);
    if (vals.every((v) => Math.abs(v - (vals[0] ?? 1)) < 1e-9)) return (vals[0] ?? 1).toFixed(2);
    return dims.map((a) => `${'xyz'[a]}: ${f[a]!.toFixed(2)}`).join(', ');
  }

  /** Factors for the cursor: uniform along the grip–anchor line, else per axis. */
  private factorsFor(e: ToolPointerEvent, s: Extract<State, { kind: 'scaling' }>): Vec3 {
    const inf = e.inference;
    if (!inf) return s.factors;
    const { grip, box, anchor } = s;
    const cursor = inf.point;
    const uniform = this.isUniform(grip, e.modifiers.shift);
    const f: [number, number, number] = [1, 1, 1];
    if (uniform) {
      const d = v3sub(grip.pos, anchor);
      const len = v3len(d);
      if (len <= LENGTH_TOL) return s.factors;
      const t = v3dot(v3sub(cursor, anchor), v3normalize(d)) / len;
      if (!Number.isFinite(t)) return s.factors;
      for (const a of box.dims) f[a] = t;
      return f;
    }
    for (const a of grip.axes) {
      const span = grip.pos[a]! - anchor[a]!;
      if (Math.abs(span) <= LENGTH_TOL) continue;
      const t = (cursor[a]! - anchor[a]!) / span;
      if (Number.isFinite(t)) f[a] = t;
    }
    return f;
  }

  /**
   * Typed value → factors: bare number = factor for the grip's axes (every axis when uniform); a length
   * with a unit = the size along a face grip's axis, or of the longest side an edge or corner grip
   * scales, the others following uniformly; `x,y,z` = per-axis factors (blank keeps the current one);
   * negative = mirror.
   */
  private factorsFromVcb(v: VcbValue, edit: ScaleEdit): Vec3 | null {
    const { factors: current, size, axes, dims, kind, uniform } = edit;
    const f: [number, number, number] = [current[0], current[1], current[2]];
    const factorOf = (val: { kind: 'length'; meters: number; raw: number; unit: string | null }, axis: number): number | null => {
      if (val.unit === null) return val.raw;
      const extent = size[axis]!;
      return extent > LENGTH_TOL ? val.meters / extent : null;
    };
    if (v.kind === 'length') {
      const targets = uniform ? dims : axes;
      // the side a length sets: a face grip's axis, else the longest side the grip scales
      const ref = kind === 'face' ? axes[0]! : axes.reduce((a, b) => (size[b]! > size[a]! ? b : a));
      const k = factorOf(v, ref);
      if (k === null || k === 0) return null;
      for (const a of targets) f[a] = k;
      return f;
    }
    if (v.kind === 'list') {
      const targets = v.values.length === dims.length ? dims : [0, 1, 2];
      for (let i = 0; i < Math.min(3, v.values.length); i++) {
        const val = v.values[i];
        const a = targets[i];
        if (val === null || val === undefined || a === undefined) continue;
        if (val.kind !== 'length') return null;
        const k = factorOf(val, a);
        if (k === null || k === 0) return null;
        f[a] = k;
      }
      return f;
    }
    return null;
  }

  private commit(anchor: Vec3, factors: Vec3): void {
    const s = this.state;
    if (s.kind !== 'scaling') return;
    const refs = s.refs;
    this.state = IDLE;
    if (factors.some((k) => !Number.isFinite(k) || Math.abs(k) < 1e-6) || factors.every((k) => Math.abs(k - 1) < 1e-9)) {
      this.ctx?.statusChanged();
      this.ctx?.requestRender();
      return;
    }
    this.commitTransform(refs, m4scaleAbout(anchor, factors), false, 'Scale');
    const edit: ScaleEdit = { anchor, factors, size: s.box.size, axes: s.grip.axes, dims: s.box.dims, kind: s.grip.kind, uniform: s.uniform };
    if (this.lastCommit) this.edits.set(this.lastCommit, edit);
  }
}
