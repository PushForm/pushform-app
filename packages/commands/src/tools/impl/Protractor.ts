// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { MVec3, Vec2, Vec3 } from '@pushform/core';
import { MERGE_TOL, v3addScaled, v3cross, v3dot, v3len, v3normalize, v3sub } from '@pushform/core';
import type { Axis, InferenceOptions, InferenceResult } from '@pushform/inference';
import type { VcbKind, VcbValue } from '../../vcb/parse';
import type { OverlayPrimitive } from '../overlay';
import type { Tool, ToolContext, ToolKeyEvent, ToolPointerEvent, ToolStatus } from '../Tool';
import { pointerField } from '../entry';
import { inferenceOverlay, PREVIEW_COLOR, worldPerPixelAt } from '../toolUtil';
import { AXIS_COLORS, AXIS_NORMAL, fmtAngle, GUIDE_COLOR, projectToPlane } from './constructionUtil';

/** Protractor radius in CSS px; inside it angles snap to 15° ticks. */
const PROTRACTOR_PX = 60;
const TICK_DEG = 15;
const CIRCLE_SEGMENTS = 72;

type State =
  | { readonly kind: 'idle' }
  | { readonly kind: 'center'; readonly center: Vec3; readonly n: Vec3 }
  | { readonly kind: 'baseline'; readonly center: Vec3; readonly n: Vec3; readonly base: Vec3 };

const IDLE: State = { kind: 'idle' };

/**
 * Protractor. The plane comes from the hovered face, an arrow-key axis lock, or Shift (holds the
 * current plane). Click the vertex (center), click the baseline direction, rotate to the angle
 * (15° ticks while the cursor is inside the protractor) and click → a guide line at that angle
 * (`guides.addLine`). VCB takes degrees or `rise:run`; Ctrl toggles guide creation.
 */
export class ProtractorTool implements Tool {
  readonly id = 'protractor';
  readonly title = 'Protractor';
  readonly cursor = 'crosshair';
  readonly vcbSchema: readonly VcbKind[] = ['angle', 'slope', 'length'];

  private ctx: ToolContext | null = null;
  private state: State = IDLE;
  private cursorInference: InferenceResult | null = null;
  private cursorScreen: Vec2 | null = null;
  private cursorCamera: ToolPointerEvent['camera'] | null = null;
  private lockNormal: Axis | null = null;
  private shiftNormal: Vec3 | null = null;
  private hoverNormal: Vec3 | null = null;
  private createGuides = true;
  private lastAngle: number | null = null;

  get guidesEnabled(): boolean {
    return this.createGuides;
  }
  get center(): Vec3 | null {
    return this.state.kind === 'idle' ? null : this.state.center;
  }
  /** Plane normal the protractor currently lies in. */
  get planeNormal(): Vec3 {
    if (this.state.kind !== 'idle') return this.state.n;
    return this.currentNormal();
  }
  /** Current angle (degrees, CCW about the plane normal from the baseline) while setting the angle. */
  get angle(): number | null {
    return this.state.kind === 'baseline' && this.cursorInference ? this.angleFor(this.cursorInference.point, this.cursorCamera) : null;
  }

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
    this.state = IDLE;
  }
  deactivate(): void {
    this.reset();
    this.ctx = null;
  }

  inferenceOptions(): InferenceOptions {
    const s = this.state;
    if (s.kind === 'idle') return {};
    return { anchor: s.center, plane: { n: s.n, d: -v3dot(s.n, s.center) } };
  }

  onPointerMove(e: ToolPointerEvent): void {
    this.cursorInference = e.inference;
    this.cursorScreen = e.screen;
    this.cursorCamera = e.camera;
    const hit = e.inference?.hit;
    this.hoverNormal = hit?.normal && (hit.ref.kind === 'face' || hit.ref.kind === 'sketchFace') ? hit.normal : null;
    this.ctx?.requestRender();
    this.ctx?.statusChanged();
  }

  onClick(e: ToolPointerEvent): void {
    if (e.button !== 0 || !e.inference || !this.ctx) return;
    this.cursorInference = e.inference;
    this.cursorScreen = e.screen;
    this.cursorCamera = e.camera;
    const p = e.inference.point;
    const s = this.state;
    if (s.kind === 'idle') {
      const hit = e.inference.hit;
      this.hoverNormal = hit?.normal && (hit.ref.kind === 'face' || hit.ref.kind === 'sketchFace') ? hit.normal : null;
      this.state = { kind: 'center', center: p, n: this.currentNormal() };
    } else if (s.kind === 'center') {
      const v = projectToPlane(v3sub(p, s.center), s.n);
      if (v3len(v) <= MERGE_TOL) return;
      this.state = { kind: 'baseline', center: s.center, n: s.n, base: v3normalize(v) };
    } else {
      this.commit(this.angleFor(p, e.camera));
    }
    this.ctx.statusChanged();
    this.ctx.requestRender();
  }

  onKeyDown(e: ToolKeyEvent): boolean {
    switch (e.key) {
      case 'Control':
      case 'Alt':
        if (!e.repeat) {
          this.createGuides = !this.createGuides;
          this.ctx?.statusChanged();
        }
        return true;
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
        if (!e.repeat) this.shiftNormal = this.currentNormal();
        return true;
      default:
        return false;
    }
  }

  onKeyUp(e: ToolKeyEvent): boolean {
    if (e.key !== 'Shift') return false;
    this.shiftNormal = null;
    return true;
  }

  onVcb(v: VcbValue): void {
    let degrees: number | null = null;
    if (v.kind === 'angle' || v.kind === 'slope') degrees = v.degrees;
    else if (v.kind === 'length' && v.unit === null) degrees = v.raw; // bare number = degrees
    if (degrees === null) return;
    if (this.state.kind === 'baseline') this.commit(degrees);
  }

  onCancel(): void {
    this.state = IDLE;
    this.ctx?.requestRender();
    this.ctx?.statusChanged();
  }

  overlay(): readonly OverlayPrimitive[] {
    const out: OverlayPrimitive[] = [];
    const s = this.state;
    const inf = this.cursorInference;
    const center = s.kind === 'idle' ? inf?.point : s.center;
    if (center) {
      const n = s.kind === 'idle' ? this.currentNormal() : s.n;
      const r = this.radiusAt(center);
      const u = s.kind === 'baseline' ? s.base : anyPerp(n);
      const w = v3cross(n, u);
      const ring: Vec3[] = [];
      for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
        const a = (2 * Math.PI * i) / CIRCLE_SEGMENTS;
        ring.push(v3addScaled(v3addScaled(center, u, r * Math.cos(a)), w, r * Math.sin(a)));
      }
      const color = this.lockNormal ? AXIS_COLORS[this.lockNormal] : PREVIEW_COLOR;
      out.push({ kind: 'polyline', points: ring, color, closed: true, width: 1 });
      for (let deg = 0; deg < 360; deg += TICK_DEG) {
        const a = (deg * Math.PI) / 180;
        const len = deg % 90 === 0 ? 0.2 : deg % 45 === 0 ? 0.12 : 0.07;
        const d: MVec3 = v3addScaled(v3scaleV(u, Math.cos(a)), w, Math.sin(a));
        out.push({ kind: 'polyline', points: [v3addScaled(center, d, r * (1 - len)), v3addScaled(center, d, r)], color, width: 1 });
      }
      if (s.kind === 'baseline') {
        out.push({ kind: 'polyline', points: [center, v3addScaled(center, s.base, r)], color: PREVIEW_COLOR, width: 2 });
        if (inf) {
          const deg = this.angleFor(inf.point, this.cursorCamera);
          const dir = this.rotate(s.base, s.n, deg);
          out.push({ kind: 'polyline', points: [center, v3addScaled(center, dir, r)], color: GUIDE_COLOR, width: 2 });
          out.push({
            kind: 'polyline',
            points: [v3addScaled(center, dir, -1000), v3addScaled(center, dir, 1000)],
            color: GUIDE_COLOR,
            dashed: true,
            width: 1,
          });
          out.push({ kind: 'label', position: inf.point, text: fmtAngle(deg), offset: [12, -12] });
        }
      } else if (s.kind === 'center' && inf) {
        out.push({ kind: 'polyline', points: [center, inf.point], color: PREVIEW_COLOR, width: 2 });
      }
    }
    out.push(...inferenceOverlay(inf, this.cursorScreen ?? undefined));
    return out;
  }

  status(): ToolStatus {
    const s = this.state;
    const guide = this.createGuides ? '' : ' [Guide creation off: Ctrl toggles]';
    if (s.kind === 'idle') return { instructor: `Click to place the protractor (hover a face to align it).${guide}`, vcbLabel: 'Angle' };
    if (s.kind === 'center') return { instructor: `Click to set the baseline.${guide}`, vcbLabel: 'Angle' };
    const deg = this.cursorInference ? this.angleFor(this.cursorInference.point, this.cursorCamera) : (this.lastAngle ?? 0);
    return { instructor: `Click to set the angle or enter value (degrees or rise:run).${guide}`, vcbLabel: 'Angle', vcbValue: fmtAngle(deg), fields: [pointerField('Angle', 'angle', fmtAngle(deg))] };
  }

  // --- internals ------------------------------------------------------------------------------

  private currentNormal(): Vec3 {
    if (this.lockNormal) return AXIS_NORMAL[this.lockNormal];
    if (this.shiftNormal) return this.shiftNormal;
    if (this.hoverNormal) return this.hoverNormal;
    return this.cursorInference?.plane.n ?? [0, 0, 1];
  }

  private radiusAt(center: Vec3): number {
    const cam = this.cursorCamera;
    if (!cam || !this.ctx) return 0.5;
    return PROTRACTOR_PX * worldPerPixelAt(cam, this.ctx.camera.viewportSize().height, center);
  }

  /** Angle (degrees) of `p` about the center from the baseline, snapped to 15° inside the protractor. */
  private angleFor(p: Vec3, camera: ToolPointerEvent['camera'] | null): number {
    const s = this.state;
    if (s.kind !== 'baseline') return 0;
    const v = projectToPlane(v3sub(p, s.center), s.n);
    const len = v3len(v);
    if (len <= MERGE_TOL) return 0;
    const w = v3cross(s.n, s.base);
    let deg = (Math.atan2(v3dot(v, w), v3dot(v, s.base)) * 180) / Math.PI;
    const r = camera ? this.radiusAt(s.center) : 0;
    if (len <= r) deg = Math.round(deg / TICK_DEG) * TICK_DEG;
    return deg;
  }

  private rotate(base: Vec3, n: Vec3, deg: number): MVec3 {
    const a = (deg * Math.PI) / 180;
    const w = v3cross(n, base);
    return v3normalize(v3addScaled(v3scaleV(base, Math.cos(a)), w, Math.sin(a)));
  }

  private commit(deg: number): void {
    const s = this.state;
    if (s.kind !== 'baseline' || !this.ctx) return;
    this.lastAngle = deg;
    if (this.createGuides) {
      const dir = this.rotate(s.base, s.n, deg);
      this.ctx.commands.execute('guides.addLine', { point: [s.center[0], s.center[1], s.center[2]], dir: [dir[0], dir[1], dir[2]] });
    }
    this.state = IDLE;
    this.ctx.statusChanged();
    this.ctx.requestRender();
  }

  private setLock(axis: Axis | null): void {
    this.lockNormal = axis !== null && this.lockNormal === axis ? null : axis;
    this.ctx?.requestRender();
  }

  private reset(): void {
    this.state = IDLE;
    this.lockNormal = null;
    this.shiftNormal = null;
    this.hoverNormal = null;
  }
}

const v3scaleV = (v: Vec3, s: number): MVec3 => [v[0] * s, v[1] * s, v[2] * s];

function anyPerp(n: Vec3): MVec3 {
  const ref: Vec3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  return v3normalize(v3cross(ref, n));
}
