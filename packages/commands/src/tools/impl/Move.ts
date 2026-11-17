// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { MMat4, Plane, Vec2, Vec3 } from '@pushform/core';
import { ANGLE_TOL, m4translation, MERGE_TOL, planeFromPointNormal, rayAt, v3add, v3cross, v3dot, v3len, v3normalize, v3scale, v3sub } from '@pushform/core';
import type { Axis, InferenceEngine, InferenceOptions, InferenceResult, Snap } from '@pushform/inference';
import { SNAP_COLORS } from '@pushform/inference';
import { containerAt, contextMatrix, instanceAt, worldSectionPlane } from '@pushform/model';
import type { ComponentBehaviors, EntityRef } from '@pushform/model';
import { glueAllows, placeOnFaceMatrix } from '../../commands/componentBehaviors';
import { contextFrame } from '../../commands/context';
import { planTransform } from '../../commands/transform';
import { SERVICE_INFERENCE } from '../../host/services';
import type { VcbKind, VcbValue } from '../../vcb/parse';
import type { OverlayPrimitive } from '../overlay';
import type { EntryField, ToolKeyEvent, ToolPointerEvent, ToolSettingValue, ToolStatus } from '../Tool';
import { toggleSetting } from '../settings';
import { entryLength } from '../entry';
import { EdgeLock } from '../edgeLock';
import { DRAG_PX, entityOverlay, HOVER_COLOR, inferenceOverlay, rubberBandColor, screenDist, worldPerPixelAt } from '../toolUtil';
import { AXIS_DIR, movedOutline, pickRef, sectionPreviewFor, TransformToolBase, withoutSectionPlanes, worldToScreen } from './transformShared';
import type { SectionPreview, SectionPreviewTool } from '../sectionPreview';
import { axisTag, EDGE_LOCKED, SHIFT_HELD } from '../held';

type State =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'moving';
      readonly refs: EntityRef[];
      readonly ignore: EntityRef[];
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

/** A message as a sentence, ending with a full stop. */
const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

/**
 * Move (M). Idle → pick a base point (hovering picks the entity under the cursor when nothing is
 * selected) → Moving: Δ = inference point − base with arrow-key axis locks and Shift lock;
 * commit on click (click-move-click) or on release after a drag. Ctrl tap toggles copy. Moved
 * faces and edges of a solid always fold into a valid solid. VCB: distance along the current
 * direction, `[x,y,z]`, `<x,y,z>`, and after a copy `3x` / `/3` arrays. A body face moved along
 * its normal with perpendicular neighbours is routed to push/pull by `transform.apply`.
 */
export class MoveTool extends TransformToolBase implements SectionPreviewTool {
  readonly id = 'move';
  readonly title = 'Move';
  readonly vcbSchema: readonly VcbKind[] = ['length', 'absolute', 'relative', 'array'];

  private state: State = IDLE;
  private hover: EntityRef | null = null;
  private cursorInference: InferenceResult | null = null;
  private cursorScreen: Vec2 | null = null;
  private pointer: ToolPointerEvent | null = null;
  private lockAxis: Axis | null = null;
  private lockSnap: Snap | null = null;
  /** While only parallel section planes move: the line through the base point along their normal. */
  private planeHold: Snap | null = null;
  /** The last section preview and what it was made for, so an unchanged one is the same object. */
  private sectionCache: { refs: readonly EntityRef[]; key: string; preview: SectionPreview | null } | null = null;
  /** ↓ lock parallel / perpendicular to the last inferred edge. */
  private readonly edgeLock = new EdgeLock();
  private copy = false;
  private glue: GlueMove | null = null;
  /** The base point of the last move, for an `[x,y,z]` typed after it. */
  private lastBase: Vec3 | null = null;
  /** Why the value just typed during the move changed nothing. */
  private hint: string | null = null;
  private offsets: Partial<Record<'x' | 'y' | 'z', number>> = {};
  private distance: number | null = null;

  get cursor(): string {
    return this.copy ? 'copy' : 'move';
  }
  /** Copy mode (Ctrl tap). */
  get copyMode(): boolean {
    return this.copy;
  }
  /** Section planes being moved, drawn and cutting where the move would put them; copies are drawn without cutting. */
  get sectionPreview(): SectionPreview | null {
    const s = this.state;
    const state = this.docState();
    if (s.kind !== 'moving' || !state || (s.face && this.glue) || v3len(s.delta) <= MERGE_TOL) return null;
    const key = `${s.delta.join(',')}|${this.copy}`;
    const cached = this.sectionCache;
    if (cached && cached.refs === s.refs && cached.key === key) return cached.preview;
    const preview = sectionPreviewFor(state, s.refs, m4translation(s.delta), this.copy);
    this.sectionCache = { refs: s.refs, key, preview };
    return preview;
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
    this.planeHold = null;
    this.hover = null;
    this.copy = false;
  }
  hasPendingWork(): boolean {
    return this.state.kind !== 'idle';
  }

  protected override onDeactivate(): void {
    this.state = IDLE;
    this.planeHold = null;
    this.hover = null;
    this.lockAxis = null;
    this.lockSnap = null;
    this.edgeLock.clear();
    this.offsets = {};
    this.distance = null;
    this.pointer = null;
    this.cursorInference = null;
    this.cursorScreen = null;
    this.hint = null;
    this.glue = null;
    this.sectionCache = null;
  }

  inferenceOptions(): InferenceOptions {
    if (this.state.kind === 'moving') {
      const hold = this.lockAxis ? null : this.planeHold;
      return { anchor: this.state.base, lockAxis: this.lockSnap ? null : this.lockAxis, lockSnap: this.lockSnap ?? this.edgeLock.snapAt(this.state.base) ?? hold, ignore: this.state.ignore, lineMode: 'rail' };
    }
    // section planes and dimensions under the cursor can be picked up
    return { lockAxis: this.lockAxis, lockSnap: this.lockSnap, annotations: true };
  }

  // --- pointer --------------------------------------------------------------------------------

  onPointerMove(e: ToolPointerEvent): void {
    this.pointer = e;
    this.cursorInference = e.inference;
    this.edgeLock.observe(e.inference);
    this.cursorScreen = e.screen;
    if (this.state.kind === 'moving') {
      const s = this.state;
      if (!s.moved && screenDist(e.screen, s.downScreen) > DRAG_PX) s.moved = true;
      this.hint = null;
      s.face = this.glueFace(e);
      s.delta = this.deltaFor(e, s.base);
      this.ctx?.requestRender();
      this.ctx?.statusChanged();
      return;
    }
    const host = this.host();
    // with nothing selected, a press picks up what a Select click would select
    this.hover = host && host.selection.isEmpty ? pickRef(e.inference?.hit) : null;
    this.ctx?.requestRender();
  }

  onPointerDown(e: ToolPointerEvent): void {
    if (e.button !== 0) return;
    if (this.state.kind === 'moving') {
      const s = this.state;
      if (s.pressed) return;
      if (!s.moved && screenDist(e.screen, s.downScreen) <= DRAG_PX) {
        this.endMove();
        this.dropPickup();
        return;
      }
      this.finishAt(e);
      return;
    }
    const inf = e.inference;
    if (!inf) return;
    this.lastError = null;
    this.lastNotice = null;
    const refs = this.targetRefs(this.hover ?? pickRef(inf.hit), this.copy);
    if (!refs.length) return;
    this.hover = null;
    this.lastError = null;
    this.glue = this.glueFor(refs);
    // a section plane picked up by its outline moves from the point on the outline under the cursor
    const base = inf.hit?.ref.kind === 'sectionPlane' ? inf.hit.point : inf.point;
    this.planeHold = this.normalHold(refs, base);
    const plan = planTransform(this.docState()!, refs, m4translation([0, 0, 0]), this.copy, 'Move');
    const ignore = refs.filter((r) => !plan.bodies.has(r.id));
    for (const id of plan.bodies.keys()) ignore.push({ kind: 'body', path: [...plan.path], id });
    this.offsets = {};
    this.distance = null;
    this.cursorScreen = e.screen;
    this.cursorInference = inf;
    this.pointer = e;
    this.state = { kind: 'moving', refs, ignore, base, downScreen: e.screen, pressed: true, moved: false, delta: [0, 0, 0], face: null };
    this.ctx?.statusChanged();
    this.ctx?.requestRender();
  }

  onPointerUp(e: ToolPointerEvent): void {
    if (e.button !== 0 || this.state.kind !== 'moving' || !this.state.pressed) return;
    const s = this.state;
    s.pressed = false;
    if (!s.moved && screenDist(e.screen, s.downScreen) <= DRAG_PX) return; // click-move-click continues
    this.finishAt(e);
  }

  // --- keys / VCB -----------------------------------------------------------------------------

  onKeyDown(e: ToolKeyEvent): boolean {
    if (e.repeat && (e.key.startsWith('Arrow') || e.key === 'Shift')) return true;
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
          this.lockSnap = null;
          this.offsets = {};
          this.applyLock();
        } else {
          this.hint = 'Infer an edge before pressing Down to lock parallel or perpendicular.';
          this.ctx?.statusChanged();
        }
        return true;
      }
      case 'Shift':
        if (!e.repeat) {
          const s = this.state;
          const p = this.cursorInference?.primary;
          const dir = this.lockDirection() ?? p?.dir ?? (s.kind === 'moving' && v3len(s.delta) >= MERGE_TOL ? s.delta : null);
          if (dir && s.kind === 'moving') {
            this.lockSnap = { kind: 'parallel', point: s.base, dir: v3normalize(dir), color: p?.color ?? SNAP_COLORS.parallel, label: 'Held Direction' };
            this.applyLock();
          }
        }
        return true;
      case 'Control':
        if (!e.repeat) this.toggleCopy();
        return true;
      default:
        return false;
    }
  }

  onKeyUp(e: ToolKeyEvent): boolean {
    if (e.key === 'Shift') {
      this.lockSnap = null;
      this.applyLock();
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
      if (delta) {
        // a typed value is the move, even with the pointer over a face the component would glue to
        this.state.face = null;
        this.commit(delta);
      }
      else if (v.kind === 'length') {
        // before the pointer has moved, a length has no direction to go without an axis lock
        this.hint = 'Move the pointer or lock an axis with an arrow key, then type the length.';
        this.ctx?.statusChanged();
      }
      return;
    }
    const last = this.lastCommit;
    if (!last) return;
    const prev: Vec3 = [last.matrix[12]!, last.matrix[13]!, last.matrix[14]!];
    // [x,y,z] puts the last move's base point there; a glued placement stays in its glue plane
    this.glue = this.glueFor(last.refs);
    const delta = this.deltaFromVcb(v, this.lastBase ?? [0, 0, 0], prev, prev);
    this.glue = null;
    if (!delta || v3len(delta) < MERGE_TOL) return;
    this.reapplyLast(m4translation(delta));
    this.ctx?.statusChanged();
  }

  onCancel(): void {
    if (this.state.kind === 'moving') {
      this.endMove();
      this.dropPickup();
      return;
    }
    this.lastCommit = null;
    this.lastBase = null;
    this.lastError = null;
    this.lastNotice = null;
    this.hover = null;
    this.lockAxis = null;
    this.ctx?.requestRender();
  }

  onEntry(values: Readonly<Record<string, VcbValue>>): void {
    if (this.state.kind !== 'moving') {
      const last = this.lastCommit;
      if (!last || !this.lastIsOnTop()) return;
      if (values['distance']) { this.onVcb(values['distance']); return; }
      const prev: Vec3 = [last.matrix[12]!, last.matrix[13]!, last.matrix[14]!];
      this.reapplyLast(m4translation([entryLength(values['x']) ?? prev[0], entryLength(values['y']) ?? prev[1], entryLength(values['z']) ?? prev[2]]));
      return;
    }
    const distance = values['distance'];
    if (distance) { this.onVcb(distance); return; }
    for (const id of ['x', 'y', 'z'] as const) {
      const n = entryLength(values[id]);
      if (n !== null) this.onEntryLock(id, values[id]!);
    }
    this.state.face = null;
    this.commit(this.state.delta);
  }

  onEntryLock(id: string, value: VcbValue | null): void {
    if (this.state.kind !== 'moving') return;
    if (id === 'distance') {
      this.distance = null;
      if (value) {
        const delta = this.deltaFromVcb(value, this.state.base, this.state.delta);
        if (delta) {
          this.offsets = {};
          this.distance = entryLength(value);
          this.state.delta = delta;
          this.state.face = null;
        } else {
          this.hint = 'Move the pointer or lock an axis with an arrow key, then type the length.';
        }
      }
    } else if (id === 'x' || id === 'y' || id === 'z') {
      const n = entryLength(value);
      if (n === null) delete this.offsets[id];
      else {
        this.lockAxis = null;
        this.lockSnap = null;
        this.edgeLock.release();
        this.distance = null;
        this.offsets[id] = n;
      }
      this.state.delta = this.withOffsets(this.state.delta);
      this.state.face = null;
    }
    this.ctx?.requestRender();
    this.ctx?.statusChanged();
  }

  // --- overlay / status -----------------------------------------------------------------------

  overlay(): readonly OverlayPrimitive[] {
    const state = this.docState();
    const out: OverlayPrimitive[] = [];
    if (!state) return out;
    const s = this.state;
    if (s.kind === 'moving') {
      const end = v3add(s.base, s.delta);
      if (s.face && this.glue) out.push(...movedOutline(state, s.refs, placeOnFaceMatrix(state, this.glue.ref, s.face.point, s.face.normal, s.base), undefined, this.copy));
      // section planes are drawn, with their cuts, where they would go (sectionPreview)
      else if (v3len(s.delta) > MERGE_TOL) out.push(...movedOutline(state, withoutSectionPlanes(s.refs), m4translation(s.delta), undefined, this.copy));
      out.push({ kind: 'polyline', points: [s.base, end], color: rubberBandColor(this.cursorInference?.primary), width: 2 });
      out.push({ kind: 'point', position: s.base, color: '#111111', shape: 'square', size: 6 });
    } else if (this.hover) {
      out.push(...entityOverlay(state, this.hover, HOVER_COLOR));
    }
    out.push(...inferenceOverlay(this.cursorInference, this.cursorScreen ?? undefined));
    return out;
  }

  status(): ToolStatus {
    const held = [...axisTag(this.lockAxis), ...(this.lockSnap ? [SHIFT_HELD] : []), ...(this.edgeLock.active ? [EDGE_LOCKED] : [])];
    const moving = this.state.kind === 'moving' ? this.state : null;
    const last = this.lastCommit && this.lastIsOnTop() ? this.lastCommit : null;
    const delta = moving?.delta ?? (last ? [last.matrix[12]!, last.matrix[13]!, last.matrix[14]!] as Vec3 : [0, 0, 0]);
    const enabled = Boolean(moving || last);
    const fields: EntryField[] = [
      { id: 'distance', label: 'Distance', kind: 'length', value: enabled ? this.fmtLength(v3len(delta)) : '', locked: this.distance !== null, location: 'bar', disabled: !enabled },
      ...(['x', 'y', 'z'] as const).map((id, i): EntryField => ({ id, label: `Δ${id.toUpperCase()}`, kind: 'length', value: enabled ? this.fmtLength(delta[i]!) : '', locked: this.offsets[id] !== undefined, location: 'bar', disabled: !enabled })),
    ];
    const constraint = this.lockSnap ? 'Held direction' : axisTag(this.lockAxis)[0] ?? this.edgeLock.snapAt(moving?.base ?? null)?.label ?? (this.planeHold ? 'Section normal' : 'Free');
    return { ...this.baseStatus(), fields, placing: false, settings: [toggleSetting('copy', 'Copy', this.copy, 'primary'), { kind: 'note', id: 'constraint', text: constraint }], ...(held.length ? { held } : {}) };
  }

  /** The bar switched Copy just after a commit: redo it as a copy, or as a plain move, in one undo step. */
  adjustLast(id: string): boolean {
    const last = this.lastCommit;
    if (id !== 'copy' || !last || !this.lastIsOnTop()) return false;
    return this.reapplyLast(last.matrix, this.copy);
  }

  protected override restoreCopy(copy: boolean): void {
    this.copy = copy;
  }

  onSetting(id: string, value: ToolSettingValue): void {
    if (typeof value !== 'boolean' || id !== 'copy') return;
    this.copy = value;
    this.ctx?.requestRender();
    this.ctx?.statusChanged();
  }

  private baseStatus(): ToolStatus {
    if (this.state.kind === 'moving') {
      return {
        instructor: this.lastError
          ? sentence(this.lastError)
          : this.hint
            ? this.hint
            : this.state.face
            ? `Click to glue the component to this face.`
            : `Pick end point or enter distance. Arrows lock an axis.`,
        vcbLabel: 'Length',
        vcbValue: this.fmtLength(v3len(this.state.delta)),
      };
    }
    const host = this.host();
    const instructor = this.lastError
      ? `Move failed: ${this.lastError}`
      : this.lastNotice
        ? this.lastNotice
        : host && !host.selection.isEmpty
        ? `Pick a base point to move the selection.`
        : `Select objects or hover an entity, then pick a base point.`;
    const last = this.lastCommit;
    const lastLen = last ? v3len([last.matrix[12]!, last.matrix[13]!, last.matrix[14]!]) : null;
    return { instructor, vcbLabel: 'Length', vcbValue: lastLen === null ? undefined : this.fmtLength(lastLen) };
  }

  // --- internals ------------------------------------------------------------------------------

  private deltaFor(e: ToolPointerEvent, base: Vec3): Vec3 {
    const inf = e.inference;
    if (!inf) return this.state.kind === 'moving' ? this.state.delta : [0, 0, 0];
    const d = v3sub(inf.point, base);
    const dir = this.lockDirection();
    return this.withOffsets(this.inGluePlane(dir ? v3scale(dir, v3dot(d, dir)) : d));
  }

  private withOffsets(d: Vec3): Vec3 {
    if (this.distance !== null && v3len(d) >= MERGE_TOL) d = v3scale(v3normalize(d), this.distance);
    return this.inGluePlane([this.offsets.x ?? d[0], this.offsets.y ?? d[1], this.offsets.z ?? d[2]]);
  }

  /** A stationary release/click uses the last displayed destination, not a fresh pick of the source. */
  private finishAt(e: ToolPointerEvent): void {
    const s = this.state;
    if (s.kind !== 'moving') return;
    if (!this.cursorScreen || screenDist(e.screen, this.cursorScreen) > 0) {
      s.face = this.glueFace(e);
      s.delta = this.deltaFor(e, s.base);
    }
    this.commit(s.delta);
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

  /**
   * Displacement from a typed value: a length along the current direction, `[x,y,z]` or `<x,y,z>`. A glued
   * placement stays in its glue plane: a length goes along the direction laid in the plane, and
   * coordinates are projected onto it.
   */
  private deltaFromVcb(v: VcbValue, base: Vec3, current: Vec3, fallbackDir: Vec3 | null = null): Vec3 | null {
    if (v.kind === 'length') {
      const raw = v3len(current) >= MERGE_TOL ? current : this.lockDirection() ?? (fallbackDir && v3len(fallbackDir) >= MERGE_TOL ? fallbackDir : null);
      const dir = raw ? this.inGluePlane(raw) : null;
      return dir && v3len(dir) >= MERGE_TOL ? v3scale(v3normalize(dir), v.meters) : null;
    }
    if (v.kind === 'absolute') {
      const cur: Vec3 = [base[0] + current[0], base[1] + current[1], base[2] + current[2]];
      return this.inGluePlane([(v.coords[0] ?? cur[0]) - base[0], (v.coords[1] ?? cur[1]) - base[1], (v.coords[2] ?? cur[2]) - base[2]]);
    }
    if (v.kind === 'relative') return this.inGluePlane([v.coords[0] ?? 0, v.coords[1] ?? 0, v.coords[2] ?? 0]);
    return null;
  }

  private lockDirection(): Vec3 | null {
    return this.lockSnap?.dir ? v3normalize(this.lockSnap.dir) : this.lockAxis ? AXIS_DIR[this.lockAxis] : (this.edgeLock.direction ?? this.planeHold?.dir ?? null);
  }

  /** When every moved entity is a section plane and their planes are parallel: a hold along their normal through `base`. */
  private normalHold(refs: readonly EntityRef[], base: Vec3): Snap | null {
    const state = this.docState();
    if (!state || !refs.length || refs.some((r) => r.kind !== 'sectionPlane')) return null;
    let normal: Vec3 | null = null;
    for (const r of refs) {
      let n: Vec3;
      try {
        const sp = containerAt(state, r.path).sectionPlanes.get(r.id);
        if (!sp) return null;
        n = worldSectionPlane(sp.plane, contextMatrix(state, r.path)).normal;
      } catch {
        return null;
      }
      if (!normal) normal = v3normalize(n);
      else if (v3len(v3cross(normal, v3normalize(n))) > ANGLE_TOL) return null;
    }
    return normal ? { kind: 'perpendicular', point: base, dir: normal, color: SNAP_COLORS.perpendicular, label: 'Along Section Plane Normal' } : null;
  }

  /** Ctrl tap: switch Copy; during a move, a switch that would make the move one that is refused is not made. */
  private toggleCopy(): void {
    const s = this.state;
    if (s.kind === 'moving' && this.refuse(s.refs, !this.copy)) return;
    if (s.kind === 'moving') this.lastError = null;
    this.copy = !this.copy;
    this.ctx?.statusChanged();
    this.ctx?.requestRender();
  }

  private setLock(axis: Axis | null): void {
    this.lockAxis = axis !== null && this.lockAxis === axis ? null : axis;
    this.lockSnap = null;
    this.offsets = {};
    this.edgeLock.release();
    this.applyLock();
  }

  /** Re-project the current displacement onto the locked direction, if any. */
  private applyLock(): void {
    // a locked move does not glue: the face found before the lock is no longer the target
    if (this.state.kind === 'moving' && (this.lockAxis || this.lockSnap || this.edgeLock.active)) this.state.face = null;
    if (this.state.kind === 'moving' && this.cursorInference) {
      const ctx = this.ctx;
      const pointer = this.pointer;
      const engine = ctx?.commands.ctx.services.get(SERVICE_INFERENCE) as InferenceEngine | undefined;
      if (ctx && engine && pointer) {
        const camera = ctx.camera.getState(), size = ctx.camera.viewportSize();
        this.cursorInference = engine.resolve({
          ray: pointer.ray, screen: pointer.screen,
          pixelSizeAt: (t) => worldPerPixelAt(camera, size.height, rayAt(pointer.ray, t)),
          project: (p) => worldToScreen(camera, size, p) ?? [Infinity, Infinity],
        }, this.inferenceOptions());
      }
      const d = v3sub(this.cursorInference.point, this.state.base);
      const dir = this.lockDirection();
      this.state.delta = this.withOffsets(this.inGluePlane(dir ? v3scale(dir, v3dot(d, dir)) : d));
    }
    this.ctx?.requestRender();
    this.ctx?.statusChanged();
  }

  private endMove(): void {
    this.state = IDLE;
    this.planeHold = null;
    this.lockAxis = null;
    this.lockSnap = null;
    this.hint = null;
    this.offsets = {};
    this.distance = null;
    this.edgeLock.clear();
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
    this.planeHold = null;
    this.glue = null;
    this.lockAxis = null;
    this.lockSnap = null;
    this.hint = null;
    this.offsets = {};
    this.distance = null;
    this.edgeLock.clear();
    const ctx = this.ctx;
    if (s.face && glue && ctx) {
      const { point, normal } = s.face;
      this.lastCommit = null;
      this.enqueue(async () => {
        // the pointer keeps its place on the component: the base point is where it was picked up
        await ctx.commands.execute('component.placeOnFace', { ref: glue.ref, point: [point[0], point[1], point[2]], normal: [normal[0], normal[1], normal[2]], copy, grab: [s.base[0], s.base[1], s.base[2]] });
        ctx.statusChanged();
        ctx.requestRender();
      });
      return;
    }
    if (v3len(delta) < MERGE_TOL) {
      // nothing moved: there is no move to redo, and none from before either
      this.lastCommit = null;
      this.lastBase = null;
      this.ctx?.statusChanged();
      this.ctx?.requestRender();
      return;
    }
    const matrix: MMat4 = m4translation(delta);
    this.lastBase = s.base;
    this.commitTransform(refs, matrix, copy, 'Move');
  }
}
