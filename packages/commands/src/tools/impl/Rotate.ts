// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Vec2, Vec3 } from '@pushform/core';
import {
  formatAngleDeg,
  MERGE_TOL,
  planeFromPointNormal,
  planeProject,
  v3addScaled,
  v3anyPerpendicular,
  v3cross,
  v3dist,
  v3dot,
  v3len,
  v3normalize,
  v3parallel,
  v3sub,
} from '@pushform/core';
import type { Axis, InferenceOptions, InferenceResult } from '@pushform/inference';
import type { EntityRef } from '@pushform/model';
import { m4rotationAbout } from '../../commands/transform';
import type { VcbKind, VcbValue } from '../../vcb/parse';
import type { OverlayPrimitive } from '../overlay';
import type { ToolKeyEvent, ToolPointerEvent, ToolStatus } from '../Tool';
import { pointerField } from '../entry';
import { DRAG_PX, entityOverlay, HOVER_COLOR, inferenceOverlay, screenDist, worldPerPixelAt } from '../toolUtil';
import { AXIS_COLOR, AXIS_DIR, movedOutline, TransformToolBase, worldToScreen } from './transformShared';

/** Screen radius of the protractor in CSS px. */
export const PROTRACTOR_PX = 60;
/** Cursor distance from a tick (px on the protractor ring) that snaps to it. */
const TICK_SNAP_PX = 2;
const PROTRACTOR_COLOR = '#333333';
const DEG = Math.PI / 180;

type State =
  | { readonly kind: 'idle' }
  | { readonly kind: 'center'; readonly refs: EntityRef[]; readonly center: Vec3; readonly axis: Vec3 }
  | {
      readonly kind: 'rotating';
      readonly refs: EntityRef[];
      readonly center: Vec3;
      readonly axis: Vec3;
      readonly start: Vec3;
      readonly baseDir: Vec3;
      readonly downScreen: Vec2;
      pressed: boolean;
      moved: boolean;
      /** Radians, signed about `axis`. */
      angle: number;
    };

const IDLE: State = { kind: 'idle' };

/**
 * Rotate (Q). A protractor follows the cursor, oriented to the hovered face normal, an arrow-key
 * axis or a Shift-locked normal; click the centre, click the baseline start, rotate to the angle
 * (snapping to 15° ticks near the protractor, finer farther away, per the units' angle snap) and
 * click (or release after a drag) to commit. Ctrl toggles copy; VCB takes degrees or `rise:run`,
 * and after a copy `Nx` / `N/` radial arrays.
 */
export class RotateTool extends TransformToolBase {
  readonly id = 'rotate';
  readonly title = 'Rotate';
  readonly cursor = 'crosshair';
  readonly vcbSchema: readonly VcbKind[] = ['angle', 'slope', 'array'];

  private state: State = IDLE;
  private hover: EntityRef | null = null;
  private cursorInference: InferenceResult | null = null;
  private cursorScreen: Vec2 | null = null;
  private lockAxis: Axis | null = null;
  private lockedNormal: Vec3 | null = null;
  private hoverNormal: Vec3 | null = null;
  private copy = false;
  private camera: ToolPointerEvent['camera'] | null = null;

  get copyMode(): boolean {
    return this.copy;
  }
  /** Current rotation angle in degrees while rotating, or null. */
  get dragAngleDeg(): number | null {
    return this.state.kind === 'rotating' ? this.state.angle / DEG : null;
  }
  /** Normal of the protractor plane for the next click (or the fixed axis once the centre is set). */
  get protractorNormal(): Vec3 {
    if (this.state.kind !== 'idle') return this.state.axis;
    if (this.lockAxis) return AXIS_DIR[this.lockAxis];
    return this.lockedNormal ?? this.hoverNormal ?? AXIS_DIR.z;
  }

  protected override onActivate(): void {
    this.state = IDLE;
    this.copy = false;
    this.hover = null;
  }
  hasPendingWork(): boolean {
    return this.state.kind !== 'idle';
  }

  protected override onDeactivate(): void {
    this.state = IDLE;
    this.hover = null;
    this.lockAxis = null;
    this.lockedNormal = null;
  }

  inferenceOptions(): InferenceOptions {
    const s = this.state;
    if (s.kind === 'idle') return {};
    const plane = planeFromPointNormal(s.center, s.axis);
    return { anchor: s.center, plane, ignore: s.refs };
  }

  // --- pointer --------------------------------------------------------------------------------

  onPointerMove(e: ToolPointerEvent): void {
    this.cursorInference = e.inference;
    this.cursorScreen = e.screen;
    this.camera = e.camera;
    const s = this.state;
    if (s.kind === 'rotating') {
      if (!s.moved && screenDist(e.screen, s.downScreen) > DRAG_PX) s.moved = true;
      s.angle = this.angleFor(e, s);
      this.ctx?.requestRender();
      this.ctx?.statusChanged();
      return;
    }
    if (s.kind === 'idle') {
      const hit = e.inference?.hit ?? null;
      this.hoverNormal = hit?.normal && (hit.ref.kind === 'face' || hit.ref.kind === 'sketchFace') ? v3normalize(hit.normal) : null;
      const host = this.host();
      this.hover = host && host.selection.isEmpty ? (hit?.ref ?? null) : null;
    }
    this.ctx?.requestRender();
  }

  onPointerDown(e: ToolPointerEvent): void {
    if (e.button !== 0) return;
    this.camera = e.camera;
    const inf = e.inference;
    const s = this.state;
    if (s.kind === 'rotating') {
      if (s.pressed) return;
      if (!s.moved && screenDist(e.screen, s.downScreen) <= DRAG_PX) return;
      this.commit(this.angleFor(e, s));
      return;
    }
    if (!inf) return;
    if (s.kind === 'center') {
      const start = planeProject(planeFromPointNormal(s.center, s.axis), inf.point);
      if (v3dist(start, s.center) < MERGE_TOL) return;
      const baseDir = v3normalize(v3sub(start, s.center));
      this.state = { kind: 'rotating', refs: s.refs, center: s.center, axis: s.axis, start, baseDir, downScreen: e.screen, pressed: true, moved: false, angle: 0 };
      this.ctx?.statusChanged();
      this.ctx?.requestRender();
      return;
    }
    const refs = this.targetRefs(this.hover ?? inf.hit?.ref ?? null);
    if (!refs.length) return;
    this.hover = null;
    this.lastError = null;
    this.state = { kind: 'center', refs, center: inf.point, axis: this.protractorNormal };
    this.ctx?.statusChanged();
    this.ctx?.requestRender();
  }

  onPointerUp(e: ToolPointerEvent): void {
    if (e.button !== 0 || this.state.kind !== 'rotating' || !this.state.pressed) return;
    const s = this.state;
    s.pressed = false;
    if (!s.moved && screenDist(e.screen, s.downScreen) <= DRAG_PX) return;
    this.commit(this.angleFor(e, s));
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
      case 'ArrowDown':
        this.setLock(null);
        return true;
      case 'Shift':
        if (!e.repeat && this.state.kind === 'idle') this.lockedNormal = this.protractorNormal;
        return true;
      case 'Control':
        if (!e.repeat) {
          this.copy = !this.copy;
          this.ctx?.statusChanged();
        }
        return true;
      default:
        return false;
    }
  }

  onKeyUp(e: ToolKeyEvent): boolean {
    if (e.key === 'Shift') {
      this.lockedNormal = null;
      return true;
    }
    return false;
  }

  onVcb(v: VcbValue): void {
    if (v.kind === 'array') {
      if (this.state.kind === 'idle' && this.arrayLast(v.count, v.mode)) this.ctx?.statusChanged();
      return;
    }
    if (v.kind !== 'angle' && v.kind !== 'slope') return;
    const rad = v.degrees * DEG;
    if (this.state.kind === 'rotating') {
      this.commit(rad);
      return;
    }
    const last = this.lastRotation;
    if (!last) return;
    last.angle = rad;
    this.reapplyLast(m4rotationAbout(last.center, last.axis, rad));
    this.ctx?.statusChanged();
  }

  onCancel(): void {
    if (this.state.kind !== 'idle') {
      this.state = IDLE;
      this.ctx?.statusChanged();
      this.ctx?.requestRender();
      return;
    }
    this.lastCommit = null;
    this.lastRotation = null;
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
    const center = s.kind === 'idle' ? (this.cursorInference?.point ?? null) : s.center;
    const normal = this.protractorNormal;
    if (center) out.push(...this.protractor(center, normal));
    if (s.kind === 'rotating') {
      const radius = Math.max(v3dist(s.start, s.center), this.protractorRadius(s.center));
      const cur = this.rotatedDir(s.baseDir, s.axis, s.angle);
      out.push({ kind: 'polyline', points: [s.center, v3addScaled(s.center, s.baseDir, radius)], color: '#111111', width: 1, dashed: true });
      out.push({ kind: 'polyline', points: [s.center, v3addScaled(s.center, cur, radius)], color: '#111111', width: 2 });
      if (Math.abs(s.angle) > 1e-9) out.push(...movedOutline(state, s.refs, m4rotationAbout(s.center, s.axis, s.angle)));
      out.push({ kind: 'label', position: v3addScaled(s.center, cur, radius), text: this.fmtAngle(s.angle), offset: [12, -12] });
    } else if (s.kind === 'center' && this.cursorInference) {
      out.push({ kind: 'polyline', points: [s.center, this.cursorInference.point], color: '#111111', width: 1, dashed: true });
    } else if (this.hover) {
      out.push(...entityOverlay(state, this.hover, HOVER_COLOR));
    }
    out.push(...inferenceOverlay(this.cursorInference, this.cursorScreen ?? undefined));
    return out;
  }

  status(): ToolStatus {
    const copyHint = this.copy ? ' [Copy]' : '';
    const s = this.state;
    if (s.kind === 'rotating') {
      return { instructor: `Pick second point or enter angle. Ctrl = copy.${copyHint}`, vcbLabel: 'Angle', vcbValue: this.fmtAngle(s.angle), fields: [pointerField('Angle', 'angle', this.fmtAngle(s.angle))] };
    }
    if (s.kind === 'center') return { instructor: `Pick first point of the baseline.${copyHint}`, vcbLabel: 'Angle' };
    const instructor = this.lastError ? `Rotate failed: ${this.lastError}` : `Pick the centre of rotation. Hover a face to align the protractor, arrows lock an axis.${copyHint}`;
    const last = this.lastRotation;
    return { instructor, vcbLabel: 'Angle', vcbValue: last ? this.fmtAngle(last.angle) : undefined };
  }

  // --- internals ------------------------------------------------------------------------------

  private lastRotation: { center: Vec3; axis: Vec3; angle: number } | null = null;

  private fmtAngle(rad: number): string {
    const u = this.units();
    return formatAngleDeg(rad / DEG, u?.anglePrecision ?? 1);
  }

  private rotatedDir(baseDir: Vec3, axis: Vec3, angle: number): Vec3 {
    const perp = v3cross(axis, baseDir);
    return v3normalize([
      baseDir[0] * Math.cos(angle) + perp[0] * Math.sin(angle),
      baseDir[1] * Math.cos(angle) + perp[1] * Math.sin(angle),
      baseDir[2] * Math.cos(angle) + perp[2] * Math.sin(angle),
    ]);
  }

  private protractorRadius(center: Vec3): number {
    const cam = this.camera;
    const h = this.ctx?.camera.viewportSize().height ?? 600;
    return cam ? PROTRACTOR_PX * worldPerPixelAt(cam, h, center) : 0.5;
  }

  private protractorColor(normal: Vec3): string {
    for (const a of ['x', 'y', 'z'] as const) if (v3parallel(normal, AXIS_DIR[a], 1e-6)) return AXIS_COLOR[a];
    return PROTRACTOR_COLOR;
  }

  /** Circle with 15° ticks (longer every 90°) in the plane through `center` with `normal`. */
  private protractor(center: Vec3, normal: Vec3): OverlayPrimitive[] {
    const r = this.protractorRadius(center);
    const color = this.protractorColor(normal);
    const u = v3anyPerpendicular(normal), v = v3cross(normal, u);
    const at = (angle: number, radius: number): Vec3 => [
      center[0] + (u[0] * Math.cos(angle) + v[0] * Math.sin(angle)) * radius,
      center[1] + (u[1] * Math.cos(angle) + v[1] * Math.sin(angle)) * radius,
      center[2] + (u[2] * Math.cos(angle) + v[2] * Math.sin(angle)) * radius,
    ];
    const ring: Vec3[] = [];
    for (let i = 0; i < 72; i++) ring.push(at((i / 72) * 2 * Math.PI, r));
    const out: OverlayPrimitive[] = [{ kind: 'polyline', points: ring, color, closed: true, width: 1.5 }];
    for (let i = 0; i < 24; i++) {
      const a = i * 15 * DEG;
      const inner = i % 6 === 0 ? 0.75 : 0.88;
      out.push({ kind: 'polyline', points: [at(a, r * inner), at(a, r)], color, width: 1 });
    }
    out.push({ kind: 'point', position: center, color, shape: 'cross', size: 8 });
    return out;
  }

  /** Signed angle of the cursor about the axis, snapped to the angle grid when close to a tick. */
  private angleFor(e: ToolPointerEvent, s: Extract<State, { kind: 'rotating' }>): number {
    const inf = e.inference;
    if (!inf) return s.angle;
    const p = planeProject(planeFromPointNormal(s.center, s.axis), inf.point);
    const d = v3sub(p, s.center);
    if (v3len(d) < MERGE_TOL) return s.angle;
    const dir = v3normalize(d);
    const raw = Math.atan2(v3dot(v3cross(s.baseDir, dir), s.axis), v3dot(s.baseDir, dir));
    return this.snapAngle(raw, e, s.center);
  }

  private snapAngle(angle: number, e: ToolPointerEvent, center: Vec3): number {
    const units = this.units();
    const vp = this.ctx?.camera.viewportSize() ?? { width: 800, height: 600 };
    const c = worldToScreen(e.camera, vp, center);
    const rPx = c ? Math.max(1, screenDist(c, e.screen)) : PROTRACTOR_PX;
    const nearProtractor = rPx <= PROTRACTOR_PX * 1.5;
    const gridDeg = units?.angleSnap ?? (nearProtractor ? 15 : null);
    if (gridDeg === null || gridDeg <= 0) return angle;
    const grid = gridDeg * DEG;
    const tol = TICK_SNAP_PX / rPx;
    const nearest = Math.round(angle / grid) * grid;
    return Math.abs(angle - nearest) <= tol ? nearest : angle;
  }

  private setLock(axis: Axis | null): void {
    this.lockAxis = axis !== null && this.lockAxis === axis ? null : axis;
    this.ctx?.requestRender();
  }

  private commit(angle: number): void {
    const s = this.state;
    if (s.kind !== 'rotating') return;
    const { refs, center, axis } = s;
    const copy = this.copy;
    this.state = IDLE;
    if (Math.abs(angle) < 1e-9) {
      this.ctx?.statusChanged();
      this.ctx?.requestRender();
      return;
    }
    this.lastRotation = { center, axis, angle };
    this.commitTransform(refs, m4rotationAbout(center, axis, angle), copy, 'Rotate');
  }
}
