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
import type { ToolKeyEvent, ToolPointerEvent, ToolStatus } from '../Tool';
import { pointerField } from '../entry';
import { DRAG_PX, entityOverlay, HOVER_COLOR, inferenceOverlay, screenDist } from '../toolUtil';
import { AXIS_COLOR, AXIS_DIR, movedOutline, refsKey, TransformToolBase, worldToScreen } from './transformShared';

/** Grip pick radius in CSS px. */
export const GRIP_PICK_PX = 8;
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
      pressed: boolean;
      moved: boolean;
    };

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

/** Nearest grip within `GRIP_PICK_PX` of the cursor, or null. */
export function pickGrip(box: ScaleBox, screen: Vec2, camera: ToolPointerEvent['camera'], viewport: { width: number; height: number }): ScaleGrip | null {
  let best: ScaleGrip | null = null, bestD = GRIP_PICK_PX;
  for (const g of box.grips) {
    const s = worldToScreen(camera, viewport, g.pos);
    if (!s) continue;
    const d = screenDist(s, screen);
    if (d <= bestD) {
      bestD = d;
      best = g;
    }
  }
  return best;
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
 * `x,y,z` factors, a length with a unit (absolute size along the grip's axis); negative mirrors.
 */
export class ScaleTool extends TransformToolBase {
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
  private lastScale: { anchor: Vec3; factors: Vec3; size: Vec3; axes: readonly number[]; dims: readonly number[] } | null = null;

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
    this.boxKey = '';
    this.box = null;
    this.refresh();
  }
  protected override onDeactivate(): void {
    this.state = IDLE;
    this.box = null;
    this.hoverGrip = null;
    this.hover = null;
  }

  inferenceOptions(): InferenceOptions {
    const s = this.state;
    if (s.kind !== 'scaling') return { pickOnly: this.box !== null };
    const g = s.grip;
    const base = { anchor: g.pos, ignore: s.refs };
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
    this.cursorInference = e.inference;
    this.cursorScreen = e.screen;
    const s = this.state;
    if (s.kind === 'scaling') {
      if (!s.moved && screenDist(e.screen, s.downScreen) > DRAG_PX) s.moved = true;
      s.anchor = e.modifiers.ctrl || e.modifiers.alt ? s.box.center : this.opposite(s.box, s.grip);
      s.factors = this.factorsFor(e, s);
      this.ctx?.requestRender();
      this.ctx?.statusChanged();
      return;
    }
    this.refresh();
    const vp = this.ctx?.camera.viewportSize() ?? { width: 800, height: 600 };
    this.hoverGrip = this.box ? pickGrip(this.box, e.screen, e.camera, vp) : null;
    this.hover = this.box ? null : (e.inference?.hit?.ref ?? null);
    this.ctx?.requestRender();
  }

  onPointerDown(e: ToolPointerEvent): void {
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
      const hit = this.hover ?? e.inference?.hit?.ref ?? null;
      if (hit) {
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
    const box = this.box;
    this.state = {
      kind: 'scaling',
      refs: [...this.refs],
      box,
      grip,
      downScreen: e.screen,
      anchor: e.modifiers.ctrl || e.modifiers.alt ? box.center : this.opposite(box, grip),
      factors: [1, 1, 1],
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
    if ((e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift') && this.state.kind === 'scaling' && this.cursorInference) {
      // modifiers re-evaluate on the next move; just redraw
      this.ctx?.requestRender();
      return true;
    }
    return false;
  }

  onVcb(v: VcbValue): void {
    const s = this.state;
    if (s.kind === 'scaling') {
      const f = this.factorsFromVcb(v, s.factors, s.box.size, s.grip.axes, s.box.dims, s.grip.kind === 'corner');
      if (f) this.commit(s.anchor, f);
      return;
    }
    const last = this.lastScale;
    if (!last) return;
    const f = this.factorsFromVcb(v, last.factors, last.size, last.axes, last.dims, last.axes.length === last.dims.length);
    if (!f) return;
    last.factors = f;
    this.reapplyLast(m4scaleAbout(last.anchor, f));
    this.ctx?.statusChanged();
  }

  onCancel(): void {
    if (this.state.kind === 'scaling') {
      this.state = IDLE;
      this.ctx?.statusChanged();
      this.ctx?.requestRender();
      return;
    }
    this.lastCommit = null;
    this.lastScale = null;
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
      out.push(...movedOutline(state, s.refs, m));
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
      };
    }
    const instructor = this.lastError
      ? `Scale failed: ${this.lastError}`
      : this.box
        ? 'Drag a grip to scale. Corners = uniform, edges = two axes, faces = one axis. Hold Shift to maintain aspect ratio, Alt to keep the centre.'
        : 'Select the entities to scale.';
    const last = this.lastScale;
    return { instructor, vcbLabel: 'Scale', vcbValue: last ? this.fmtFactors(last.factors, last.dims) : undefined };
  }

  // --- internals ------------------------------------------------------------------------------

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
    const uniform = (grip.kind === 'corner') !== e.modifiers.shift;
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
   * Typed value → factors: bare number = factor; a length with a unit = absolute size along the
   * grip's axis; `x,y,z` = per-axis factors (blank keeps the current one); negative = mirror.
   */
  private factorsFromVcb(v: VcbValue, current: Vec3, size: Vec3, axes: readonly number[], dims: readonly number[], uniform: boolean): Vec3 | null {
    const f: [number, number, number] = [current[0], current[1], current[2]];
    const factorOf = (val: { kind: 'length'; meters: number; raw: number; unit: string | null }, axis: number): number | null => {
      if (val.unit === null) return val.raw;
      const extent = size[axis]!;
      return extent > LENGTH_TOL ? val.meters / extent : null;
    };
    if (v.kind === 'length') {
      const targets = uniform ? dims : axes;
      for (const a of targets) {
        const k = factorOf(v, a);
        if (k === null || k === 0) return null;
        f[a] = k;
      }
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
    this.lastScale = { anchor, factors, size: s.box.size, axes: s.grip.axes, dims: s.box.dims };
    this.commitTransform(refs, m4scaleAbout(anchor, factors), false, 'Scale');
  }
}
