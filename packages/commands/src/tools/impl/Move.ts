// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { MMat4, Plane, Vec2, Vec3 } from '@pushform/core';
import { m4translation, MERGE_TOL, planeFromPointNormal, v3add, v3dot, v3len, v3normalize, v3scale, v3sub } from '@pushform/core';
import type { Axis, InferenceOptions, InferenceResult, Snap } from '@pushform/inference';
import { instanceAt } from '@pushform/model';
import type { ComponentBehaviors, EntityRef } from '@pushform/model';
import { glueAllows, placeOnFaceMatrix } from '../../commands/componentBehaviors';
import { contextFrame } from '../../commands/context';
import type { VcbKind, VcbValue } from '../../vcb/parse';
import type { OverlayPrimitive } from '../overlay';
import type { ToolKeyEvent, ToolPointerEvent, ToolStatus } from '../Tool';
import { pointerField } from '../entry';
import { EdgeLock } from '../edgeLock';
import { DRAG_PX, entityOverlay, HOVER_COLOR, inferenceOverlay, rubberBandColor, screenDist } from '../toolUtil';
import { AXIS_DIR, movedOutline, TransformToolBase } from './transformShared';

type State =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'moving';
      readonly refs: EntityRef[];
      readonly base: Vec3;
      readonly downScreen: Vec2;
      pressed: boolean;
      moved: boolean;
      delta: Vec3;
      /** The face a glue component would be placed on, world. */
      face: { readonly point: Vec3; readonly normal: Vec3 } | null;
    };

/** A single moved placement of a component with Glue To set; `plane` (world) when it is glued. */
interface GlueMove {
  readonly ref: EntityRef;
  readonly glueTo: ComponentBehaviors['glueTo'];
  readonly plane: Plane | null;
}

const IDLE: State = { kind: 'idle' };

/**
 * Move (M). Idle → pick a base point (hovering picks the entity under the cursor when nothing is
 * selected) → Moving: Δ = inference point − base with arrow-key axis locks and Shift lock;
 * commit on click (click-move-click) or on release after a drag. Ctrl tap toggles copy; Alt
 * requests autofold (the model autofolds sub-entity moves anyway). VCB: distance along the
 * current direction, `[x,y,z]`, `<x,y,z>`, and after a copy `3x` / `/3` arrays. A body face moved
 * along its normal with perpendicular neighbours is routed to push/pull by `transform.apply`.
 */
export class MoveTool extends TransformToolBase {
  readonly id = 'move';
  readonly title = 'Move';
  readonly vcbSchema: readonly VcbKind[] = ['length', 'absolute', 'relative', 'array'];

  private state: State = IDLE;
  private hover: EntityRef | null = null;
  private cursorInference: InferenceResult | null = null;
  private cursorScreen: Vec2 | null = null;
  private lockAxis: Axis | null = null;
  private lockSnap: Snap | null = null;
  /** ↓ lock parallel / perpendicular to the last inferred edge. */
  private readonly edgeLock = new EdgeLock();
  private copy = false;
  private autofold = false;
  private glue: GlueMove | null = null;

  get cursor(): string {
    return this.copy ? 'copy' : 'move';
  }
  /** Copy mode (Ctrl tap). */
  get copyMode(): boolean {
    return this.copy;
  }
  /** Alt pressed: autofold explicitly requested. */
  get autofoldRequested(): boolean {
    return this.autofold;
  }
  /** Current displacement while moving, or null. */
  get dragDelta(): Vec3 | null {
    return this.state.kind === 'moving' ? this.state.delta : null;
  }
  get axisLock(): Axis | null {
    return this.lockAxis;
  }

  protected override onActivate(): void {
    this.state = IDLE;
    this.hover = null;
    this.copy = false;
    this.autofold = false;
  }
  protected override onDeactivate(): void {
    this.state = IDLE;
    this.hover = null;
    this.lockAxis = null;
    this.lockSnap = null;
    this.edgeLock.clear();
  }

  inferenceOptions(): InferenceOptions {
    if (this.state.kind === 'moving') {
      return { anchor: this.state.base, lockAxis: this.lockAxis, lockSnap: this.lockSnap ?? this.edgeLock.snapAt(this.state.base), ignore: this.state.refs };
    }
    return { lockAxis: this.lockAxis, lockSnap: this.lockSnap };
  }

  // --- pointer --------------------------------------------------------------------------------

  onPointerMove(e: ToolPointerEvent): void {
    this.cursorInference = e.inference;
    this.edgeLock.observe(e.inference);
    this.cursorScreen = e.screen;
    if (this.state.kind === 'moving') {
      const s = this.state;
      if (!s.moved && screenDist(e.screen, s.downScreen) > DRAG_PX) s.moved = true;
      s.face = this.glueFace(e);
      s.delta = this.deltaFor(e, s.base);
      this.ctx?.requestRender();
      this.ctx?.statusChanged();
      return;
    }
    const host = this.host();
    const hit = e.inference?.hit?.ref ?? null;
    this.hover = host && host.selection.isEmpty ? hit : null;
    this.ctx?.requestRender();
  }

  onPointerDown(e: ToolPointerEvent): void {
    if (e.button !== 0) return;
    if (this.state.kind === 'moving') {
      const s = this.state;
      if (s.pressed) return;
      if (!s.moved && screenDist(e.screen, s.downScreen) <= DRAG_PX) {
        this.endMove();
        return;
      }
      s.face = this.glueFace(e);
      this.commit(this.deltaFor(e, s.base));
      return;
    }
    const inf = e.inference;
    if (!inf) return;
    const refs = this.targetRefs(this.hover ?? inf.hit?.ref ?? null);
    if (!refs.length) return;
    this.hover = null;
    this.lastError = null;
    this.glue = this.glueFor(refs);
    this.state = { kind: 'moving', refs, base: inf.point, downScreen: e.screen, pressed: true, moved: false, delta: [0, 0, 0], face: null };
    this.ctx?.statusChanged();
    this.ctx?.requestRender();
  }

  onPointerUp(e: ToolPointerEvent): void {
    if (e.button !== 0 || this.state.kind !== 'moving' || !this.state.pressed) return;
    const s = this.state;
    s.pressed = false;
    if (!s.moved && screenDist(e.screen, s.downScreen) <= DRAG_PX) return; // click-move-click continues
    s.face = this.glueFace(e);
    this.commit(this.deltaFor(e, s.base));
  }

  // --- keys / VCB -----------------------------------------------------------------------------

  onKeyDown(e: ToolKeyEvent): boolean {
    switch (e.key) {
      case 'ArrowRight':
        this.setLock('x');
        return true;
      case 'ArrowLeft':
        this.setLock('y');
        return true;
      case 'ArrowUp':
        this.setLock('z');
        return true;
      case 'ArrowDown': {
        const base = this.state.kind === 'moving' ? this.state.base : null;
        const plane = this.cursorInference?.plane ?? planeFromPointNormal(base ?? [0, 0, 0], [0, 0, 1]);
        if (this.edgeLock.toggle(base, this.cursorInference?.point ?? null, plane)) {
          this.lockAxis = null;
          this.applyLock();
        } else this.setLock(null);
        return true;
      }
      case 'Shift':
        if (!e.repeat) {
          const p = this.cursorInference?.primary ?? null;
          this.lockSnap = p && (p.dir || p.plane) ? p : null;
        }
        return true;
      case 'Control':
        if (!e.repeat) {
          this.copy = !this.copy;
          this.ctx?.statusChanged();
          this.ctx?.requestRender();
        }
        return true;
      case 'Alt':
        if (!e.repeat) this.autofold = true;
        return true;
      default:
        return false;
    }
  }

  onKeyUp(e: ToolKeyEvent): boolean {
    if (e.key === 'Shift') {
      this.lockSnap = null;
      return true;
    }
    return false;
  }

  onVcb(v: VcbValue): void {
    if (v.kind === 'array') {
      if (this.state.kind === 'idle' && this.arrayLast(v.count, v.mode)) this.ctx?.statusChanged();
      return;
    }
    if (this.state.kind === 'moving') {
      const delta = this.deltaFromVcb(v, this.state.base, this.state.delta);
      if (delta) this.commit(delta);
      return;
    }
    const last = this.lastCommit;
    if (!last) return;
    const prev: Vec3 = [last.matrix[12]!, last.matrix[13]!, last.matrix[14]!];
    const delta = this.deltaFromVcb(v, [0, 0, 0], prev, prev);
    if (!delta || v3len(delta) < MERGE_TOL) return;
    this.reapplyLast(m4translation(delta));
    this.ctx?.statusChanged();
  }

  onCancel(): void {
    if (this.state.kind === 'moving') {
      this.endMove();
      return;
    }
    this.lastCommit = null;
    this.lastError = null;
    this.hover = null;
    this.lockAxis = null;
    this.ctx?.requestRender();
  }

  // --- overlay / status -----------------------------------------------------------------------

  overlay(): readonly OverlayPrimitive[] {
    const state = this.docState();
    const out: OverlayPrimitive[] = [];
    if (!state) return out;
    const s = this.state;
    if (s.kind === 'moving') {
      const end = v3add(s.base, s.delta);
      if (s.face && this.glue) out.push(...movedOutline(state, s.refs, placeOnFaceMatrix(state, this.glue.ref, s.face.point, s.face.normal)));
      else if (v3len(s.delta) > MERGE_TOL) out.push(...movedOutline(state, s.refs, m4translation(s.delta)));
      out.push({ kind: 'polyline', points: [s.base, end], color: rubberBandColor(this.cursorInference?.primary), width: 2 });
      out.push({ kind: 'point', position: s.base, color: '#111111', shape: 'square', size: 6 });
    } else if (this.hover) {
      out.push(...entityOverlay(state, this.hover, HOVER_COLOR));
    }
    out.push(...inferenceOverlay(this.cursorInference, this.cursorScreen ?? undefined));
    return out;
  }

  status(): ToolStatus {
    const copyHint = this.copy ? ' [Copy]' : '';
    if (this.state.kind === 'moving') {
      return {
        instructor: this.state.face
          ? `Click to glue the component to this face.${copyHint}`
          : `Pick end point or enter distance. Ctrl = copy, arrows lock an axis.${copyHint}`,
        vcbLabel: 'Length',
        vcbValue: this.fmtLength(v3len(this.state.delta)),
        fields: [pointerField('Length', 'length', this.fmtLength(v3len(this.state.delta)))],
      };
    }
    const host = this.host();
    const instructor = this.lastError
      ? `Move failed: ${this.lastError}`
      : host && !host.selection.isEmpty
        ? `Pick a base point to move the selection.${copyHint}`
        : `Select objects or hover an entity, then pick a base point.${copyHint}`;
    const last = this.lastCommit;
    const lastLen = last ? v3len([last.matrix[12]!, last.matrix[13]!, last.matrix[14]!]) : null;
    return { instructor, vcbLabel: 'Length', vcbValue: lastLen === null ? undefined : this.fmtLength(lastLen) };
  }

  // --- internals ------------------------------------------------------------------------------

  private deltaFor(e: ToolPointerEvent, base: Vec3): Vec3 {
    const inf = e.inference;
    if (!inf) return [0, 0, 0];
    const d = v3sub(inf.point, base);
    const dir = this.lockDirection();
    return this.inGluePlane(dir ? v3scale(dir, v3dot(d, dir)) : d);
  }

  /** A glued placement moves only within its glue plane. */
  private inGluePlane(d: Vec3): Vec3 {
    const n = this.glue?.plane?.n;
    return n ? v3sub(d, v3scale(n, v3dot(d, n))) : d;
  }

  /** The moved placement, when it is one component with Glue To set. */
  private glueFor(refs: readonly EntityRef[]): GlueMove | null {
    const state = this.docState();
    const ref = refs.length === 1 ? refs[0]! : null;
    if (!state || !ref || ref.kind !== 'instance') return null;
    const inst = instanceAt(state, [...ref.path, ref.id]);
    const def = inst ? state.definitions.get(inst.definitionId) : undefined;
    if (!inst || !def || def.isGroup || def.behaviors.glueTo === 'none') return null;
    const plane = inst.gluedPlane ? contextFrame(state, ref.path).toWorldPlane(inst.gluedPlane) : null;
    return { ref, glueTo: def.behaviors.glueTo, plane };
  }

  /** The face under the cursor a glue component would be placed on, with its normal toward the viewer. */
  private glueFace(e: ToolPointerEvent): { point: Vec3; normal: Vec3 } | null {
    const g = this.glue;
    const hit = e.inference?.hit;
    if (!g || !hit || !e.inference || !hit.normal || (hit.ref.kind !== 'face' && hit.ref.kind !== 'sketchFace')) return null;
    if (this.lockAxis || this.lockSnap || this.edgeLock.active) return null;
    const own = [...g.ref.path, g.ref.id];
    if (hit.ref.path.length >= own.length && own.every((id, i) => hit.ref.path[i] === id)) return null;
    if (!glueAllows(g.glueTo, hit.normal)) return null;
    const n = v3normalize(hit.normal);
    return { point: e.inference.point, normal: v3dot(n, e.ray.dir) > 0 ? v3scale(n, -1) : n };
  }

  /** Displacement from a typed value: a length along the current direction, `[x,y,z]` or `<x,y,z>`. */
  private deltaFromVcb(v: VcbValue, base: Vec3, current: Vec3, fallbackDir: Vec3 | null = null): Vec3 | null {
    if (v.kind === 'length') {
      const dir = this.lockDirection() ?? (v3len(current) >= MERGE_TOL ? v3normalize(current) : fallbackDir && v3len(fallbackDir) >= MERGE_TOL ? v3normalize(fallbackDir) : null);
      return dir ? v3scale(dir, v.meters) : null;
    }
    if (v.kind === 'absolute') {
      const cur: Vec3 = [base[0] + current[0], base[1] + current[1], base[2] + current[2]];
      return [(v.coords[0] ?? cur[0]) - base[0], (v.coords[1] ?? cur[1]) - base[1], (v.coords[2] ?? cur[2]) - base[2]];
    }
    if (v.kind === 'relative') return [v.coords[0] ?? 0, v.coords[1] ?? 0, v.coords[2] ?? 0];
    return null;
  }

  private lockDirection(): Vec3 | null {
    if (this.lockAxis) return AXIS_DIR[this.lockAxis];
    return this.lockSnap?.dir ? v3normalize(this.lockSnap.dir) : this.edgeLock.direction;
  }

  private setLock(axis: Axis | null): void {
    this.lockAxis = axis !== null && this.lockAxis === axis ? null : axis;
    this.edgeLock.release();
    this.applyLock();
  }

  /** Re-project the current displacement onto the locked direction, if any. */
  private applyLock(): void {
    if (this.state.kind === 'moving' && this.cursorInference) {
      const d = v3sub(this.cursorInference.point, this.state.base);
      const dir = this.lockDirection();
      this.state.delta = this.inGluePlane(dir ? v3scale(dir, v3dot(d, dir)) : d);
    }
    this.ctx?.requestRender();
  }

  private endMove(): void {
    this.state = IDLE;
    this.edgeLock.release();
    this.glue = null;
    this.ctx?.statusChanged();
    this.ctx?.requestRender();
  }

  private commit(delta: Vec3): void {
    const s = this.state;
    if (s.kind !== 'moving') return;
    const refs = s.refs;
    const copy = this.copy;
    const glue = this.glue;
    this.state = IDLE;
    this.glue = null;
    this.lockAxis = null;
    this.lockSnap = null;
    this.edgeLock.release();
    const ctx = this.ctx;
    if (s.face && glue && ctx) {
      const { point, normal } = s.face;
      this.lastCommit = null;
      this.enqueue(async () => {
        await ctx.commands.execute('component.placeOnFace', { ref: glue.ref, point: [point[0], point[1], point[2]], normal: [normal[0], normal[1], normal[2]], copy });
        ctx.statusChanged();
        ctx.requestRender();
      });
      return;
    }
    if (v3len(delta) < MERGE_TOL) {
      this.ctx?.statusChanged();
      this.ctx?.requestRender();
      return;
    }
    const matrix: MMat4 = m4translation(delta);
    this.commitTransform(refs, matrix, copy, 'Move');
  }
}
