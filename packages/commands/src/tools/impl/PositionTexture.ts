// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { basisToLocal, basisToWorld, PushFormError, v3dot } from '@pushform/core';
import type { FaceLocalId, Id, Plane, PlaneBasis, Ray, Vec2, Vec3 } from '@pushform/core';
import {
  containerAt, sketchFaceLoops, uvAffineFromPoints, uvApply, uvApplyProjective, uvProjectiveFromPoints, uvProjectiveInvert,
  uvProjectiveMapping, uvToProjective,
} from '@pushform/model';
import type { EntityRef, Material, UvAffine, UvMapping, UvProjective } from '@pushform/model';
import { defineCommand } from '../../registry/Command';
import type { AnyCommand } from '../../registry/Command';
import { hostOf } from '../../host/services';
import type { DocumentHost } from '../../host/DocumentHost';
import { contextFrame, samePath, type ContextFrame } from '../../commands/context';
import { EntityRefSchema } from '../../commands/sketch';
import type { OverlayPrimitive } from '../overlay';
import type { Tool, ToolContext, ToolKeyEvent, ToolPointerEvent, ToolStatus } from '../Tool';
import { hostOfTool, screenDist } from '../toolUtil';
import { worldToScreen } from './transformShared';

/** Pin order: red (move), green (scale/rotate), blue (scale/shear), yellow (distort). */
export const PIN_KINDS = ['move', 'scaleRotate', 'scaleShear', 'distort'] as const;
export type PinKind = (typeof PIN_KINDS)[number];
export const PIN_COLORS = ['#e53935', '#43a047', '#1e88e5', '#fdd835'] as const;
/** Texture-tile corner of each pin (red at the tile origin, green along s, blue along t, yellow opposite). */
const PIN_TILE: readonly Vec2[] = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
];
/** Pick radius of a pin in CSS px. */
export const PIN_PICK_PX = 12;

export interface TextureTarget {
  readonly ref: EntityRef;
  readonly basis: PlaneBasis;
  readonly plane: Plane;
  readonly loops: readonly (readonly Vec3[])[];
  readonly uv: UvMapping;
  readonly material: Material;
}

/** The face a ref points at, with the textured material it shows on the front, or null. */
export function textureTargetOf(host: DocumentHost, ref: EntityRef): TextureTarget | null {
  if (ref.kind !== 'face' && ref.kind !== 'sketchFace') return null;
  let c;
  try {
    c = containerAt(host.doc.state, ref.path);
  } catch {
    return null;
  }
  const state = host.doc.state;
  if (ref.kind === 'face') {
    const body = c.bodies.get(ref.id);
    const f = body?.faces.get(ref.faceId);
    if (!body || !f) return null;
    const id = f.frontMaterialId ?? body.materialId;
    const material = id === null ? null : state.materials.get(id);
    if (!material?.texture) return null;
    return { ref, basis: f.basis, plane: f.plane, loops: f.loops, uv: f.uv, material };
  }
  const f = c.sketch.faces.get(ref.id);
  if (!f) return null;
  const material = f.frontMaterialId === null ? null : state.materials.get(f.frontMaterialId);
  if (!material?.texture) return null;
  return { ref, basis: f.basis, plane: f.plane, loops: sketchFaceLoops(c.sketch, f), uv: f.uv, material };
}

const rayPlane = (ray: Ray, plane: Plane): Vec3 | null => {
  const denom = v3dot(plane.n, ray.dir);
  if (Math.abs(denom) < 1e-12) return null;
  const t = -(v3dot(plane.n, ray.origin) + plane.d) / denom;
  return [ray.origin[0] + ray.dir[0] * t, ray.origin[1] + ray.dir[1] * t, ray.origin[2] + ray.dir[2] * t];
};

/** Similarity (rotation + uniform scale about `c`) sending `a` to `b`, as a face-space affine. */
export function similarityAbout(c: Vec2, a: Vec2, b: Vec2): UvAffine | null {
  const vx = a[0] - c[0], vy = a[1] - c[1], wx = b[0] - c[0], wy = b[1] - c[1];
  const l2 = vx * vx + vy * vy;
  if (l2 < 1e-18) return null;
  // complex division w / v = (cos θ · s, sin θ · s)
  const re = (wx * vx + wy * vy) / l2, im = (wy * vx - wx * vy) / l2;
  if (re * re + im * im < 1e-18) return null;
  return [re, -im, c[0] - re * c[0] + im * c[1], im, re, c[1] - im * c[0] - re * c[1]];
}

/** Rotation by `rad` about `c` (face space). */
export function rotationAbout(c: Vec2, rad: number): UvAffine {
  const cs = Math.cos(rad), sn = Math.sin(rad);
  return [cs, -sn, c[0] - cs * c[0] + sn * c[1], sn, cs, c[1] - sn * c[0] - cs * c[1]];
}

/** Reflection across the line through `c` with direction `d` (face space). */
export function reflectionAcross(c: Vec2, d: Vec2): UvAffine | null {
  const l2 = d[0] * d[0] + d[1] * d[1];
  if (l2 < 1e-18) return null;
  const dx = d[0] / Math.sqrt(l2), dy = d[1] / Math.sqrt(l2);
  const a = dx * dx - dy * dy, b = 2 * dx * dy;
  // R = [a b; b -a] about origin, then conjugate by c
  return [a, b, c[0] - a * c[0] - b * c[1], b, -a, c[1] - b * c[0] + a * c[1]];
}

/**
 * Position Texture (fixed-pin mode). Four pins sit on the
 * corners of one texture tile on the face: dragging the red pin moves the texture, the green pin
 * scales/rotates about the red one, the blue pin scales/shears (red and green fixed), the yellow
 * pin distorts (a projective placement through the four pins). Each drag commits one
 * `texture.position` step; Enter/Done keeps the result, Esc restores the original mapping.
 * Entered from the context menu `Texture › Position` (`texture.positionTool`).
 */
export class PositionTextureTool implements Tool {
  readonly id = 'texturePosition';
  readonly title = 'Position Texture';
  readonly cursor = 'move';
  /** The active instance (the pin menu commands act on it). */
  static current: PositionTextureTool | null = null;

  private ctx: ToolContext | null = null;
  private target: TextureTarget | null = null;
  private frame: ContextFrame | null = null;
  private worldPlane: Plane | null = null;
  private original: UvMapping = { kind: 'auto' };
  /** Current face → texture map (affine unless the yellow pin distorted it). */
  private matrix: UvProjective = uvToProjective({ kind: 'auto' }, 1, 1);
  /** Texture-space corners of the pinned tile. */
  private tile: Vec2[] = PIN_TILE.map((p) => [p[0], p[1]]);
  /** Face-space (u, v) position of each pin. */
  private pins: Vec2[] = [];
  private drag: { pin: number; start: Vec2; pinsAtStart: Vec2[]; matrixAtStart: UvProjective } | null = null;
  private message: string | null = null;
  private changed = false;
  /** Live mapping while a pin is dragged (the bootstrap can pass it to the adapter as an override). */
  liveUv: { ref: EntityRef; uv: UvMapping } | null = null;

  get targetRef(): EntityRef | null {
    return this.target?.ref ?? null;
  }
  get currentMatrix(): UvProjective {
    return this.matrix;
  }
  /** Face-space pin positions (tests / overlays). */
  get pinPositions(): readonly Vec2[] {
    return this.pins;
  }
  /** World position of pin `i`. */
  pinWorld(i: number): Vec3 | null {
    const p = this.pins[i];
    if (!p || !this.target || !this.frame) return null;
    return this.frame.toWorld(basisToWorld(this.target.basis, p[0], p[1]));
  }

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
    PositionTextureTool.current = this;
  }
  deactivate(): void {
    if (PositionTextureTool.current === this) PositionTextureTool.current = null;
    this.target = null;
    this.frame = null;
    this.drag = null;
    this.liveUv = null;
    this.pins = [];
    this.message = null;
    this.ctx = null;
  }

  /** Start positioning the texture of `ref` (a face of the current context with a textured material). */
  begin(ref: EntityRef): void {
    if (!this.ctx) throw new PushFormError('tool.inactive', 'Position Texture is not active');
    const host = hostOfTool(this.ctx);
    if (!samePath(ref.path, host.context.path)) throw new PushFormError('context.mismatch', 'The face is not in the current edit context');
    const target = textureTargetOf(host, ref);
    if (!target) throw new PushFormError('texture.none', 'The face has no texture to position');
    this.target = target;
    this.frame = contextFrame(host.doc.state, ref.path);
    this.worldPlane = this.frame.toWorldPlane(target.plane);
    this.original = target.uv;
    const { widthM, heightM } = target.material.texture!;
    this.matrix = uvToProjective(target.uv, widthM, heightM);
    // Pin the tile containing the face's minimum (s, t) corner.
    let sMin = Infinity, tMin = Infinity;
    for (const p of target.loops[0] ?? []) {
      const l = basisToLocal(target.basis, p);
      const st = uvApplyProjective(this.matrix, l[0], l[1]);
      sMin = Math.min(sMin, st[0]);
      tMin = Math.min(tMin, st[1]);
    }
    const k = Number.isFinite(sMin) ? Math.floor(sMin + 1e-9) : 0, l = Number.isFinite(tMin) ? Math.floor(tMin + 1e-9) : 0;
    this.tile = PIN_TILE.map((p): Vec2 => [k + p[0], l + p[1]]);
    this.recomputePins();
    this.changed = false;
    this.message = null;
    this.ctx.statusChanged();
    this.ctx.requestRender();
  }

  onPointerDown(e: ToolPointerEvent): void {
    if (e.button !== 0 || !this.ctx || !this.target) return;
    const pin = this.pinAt(e);
    if (pin < 0) return;
    const start = this.faceUv(e.ray);
    if (!start) return;
    this.drag = { pin, start, pinsAtStart: this.pins.map((p) => [p[0], p[1]]), matrixAtStart: this.matrix };
    this.message = null;
  }

  onPointerMove(e: ToolPointerEvent): void {
    if (!this.drag || !this.target) {
      this.ctx?.requestRender();
      return;
    }
    const p = this.faceUv(e.ray);
    if (!p) return;
    this.applyDrag(this.drag.pin, p);
    this.liveUv = { ref: this.target.ref, uv: uvProjectiveMapping(this.matrix) };
    this.ctx?.requestRender();
  }

  onPointerUp(e: ToolPointerEvent): void {
    if (e.button !== 0 || !this.drag) return;
    this.drag = null;
    this.liveUv = null;
    this.commit();
  }

  onKeyDown(e: ToolKeyEvent): boolean {
    if (e.key === 'Enter') {
      this.done();
      return true;
    }
    return false;
  }

  /** Esc: cancel a drag, or restore the original mapping and leave the tool. */
  onCancel(): void {
    if (this.drag) {
      this.matrix = this.drag.matrixAtStart;
      this.pins = this.drag.pinsAtStart;
      this.drag = null;
      this.liveUv = null;
      this.ctx?.requestRender();
      return;
    }
    if (this.target && this.changed && this.ctx) {
      this.ctx.commands.execute('texture.position', { ref: this.target.ref, uv: this.original });
    }
    this.exit();
  }

  // --- menu operations ------------------------------------------------------------------------

  /** Keep the current mapping and return to the Select tool. */
  done(): void {
    if (this.drag) {
      this.drag = null;
      this.liveUv = null;
      this.commit();
    }
    this.exit();
  }

  /** Back to the automatic mapping. */
  reset(): void {
    if (!this.target || !this.ctx) return;
    const { widthM, heightM } = this.target.material.texture!;
    this.matrix = uvToProjective({ kind: 'auto' }, widthM, heightM);
    this.recomputePins();
    this.ctx.commands.execute('texture.position', { ref: this.target.ref, uv: { kind: 'auto' } });
    this.changed = true;
    this.ctx.requestRender();
  }

  /** Mirror the texture about the red pin: `leftRight` across the tile's t axis, else across its s axis. */
  flip(axis: 'leftRight' | 'upDown'): void {
    const c = this.pins[0], a = this.pins[1], b = this.pins[2];
    if (!c || !a || !b) return;
    const dir: Vec2 = axis === 'leftRight' ? [b[0] - c[0], b[1] - c[1]] : [a[0] - c[0], a[1] - c[1]];
    const F = reflectionAcross(c, dir);
    if (F) this.applyFaceTransform(F, true);
  }

  /** Rotate the texture about the red pin by `deg` (counter-clockwise on the face). */
  rotate(deg: number): void {
    const c = this.pins[0];
    if (!c) return;
    this.applyFaceTransform(rotationAbout(c, (deg * Math.PI) / 180), true);
  }

  overlay(): readonly OverlayPrimitive[] {
    if (!this.target || !this.frame) return [];
    const out: OverlayPrimitive[] = [];
    const world = (p: Vec2): Vec3 => this.frame!.toWorld(basisToWorld(this.target!.basis, p[0], p[1]));
    const quad = [this.pins[0], this.pins[1], this.pins[3], this.pins[2]].filter((p): p is Vec2 => !!p).map(world);
    if (quad.length === 4) {
      out.push({ kind: 'polygon', points: quad, color: '#ffffff', opacity: 0.12 });
      out.push({ kind: 'polyline', points: quad, color: '#333333', closed: true, dashed: true, width: 1 });
    }
    this.pins.forEach((p, i) => {
      out.push({ kind: 'point', position: world(p), color: PIN_COLORS[i]!, shape: this.drag?.pin === i ? 'diamond' : 'circle', size: 14 });
    });
    if (this.message) out.push({ kind: 'cursorHint', text: this.message });
    return out;
  }

  status(): ToolStatus {
    const base = this.target
      ? 'Drag a pin: red = move, green = scale/rotate, blue = scale/shear, yellow = distort. Right-click for Done, Reset, Flip, Rotate. Enter = done, Esc = cancel.'
      : 'Right-click a textured face and choose Texture › Position.';
    return { instructor: this.message ? `${this.message} ${base}` : base, vcbLabel: '' };
  }

  // --- internals ------------------------------------------------------------------------------

  private exit(): void {
    const ctx = this.ctx;
    this.target = null;
    this.frame = null;
    this.pins = [];
    this.liveUv = null;
    if (ctx) {
      try {
        ctx.commands.execute('tool.activate', { id: 'select' });
      } catch {
        // no select tool registered (tests)
      }
      ctx.requestRender();
      ctx.statusChanged();
    }
  }

  private commit(): void {
    if (!this.target || !this.ctx) return;
    this.ctx.commands.execute('texture.position', { ref: this.target.ref, uv: uvProjectiveMapping(this.matrix) });
    this.changed = true;
    this.ctx.requestRender();
  }

  /** Face-space (u, v) under the ray, or null when the ray misses the face plane. */
  private faceUv(ray: Ray): Vec2 | null {
    if (!this.target || !this.frame || !this.worldPlane) return null;
    const w = rayPlane(ray, this.worldPlane);
    if (!w) return null;
    const l = basisToLocal(this.target.basis, this.frame.toLocal(w));
    return [l[0], l[1]];
  }

  private pinAt(e: ToolPointerEvent): number {
    if (!this.ctx) return -1;
    const size = this.ctx.camera.viewportSize();
    let best = -1, bestD = PIN_PICK_PX;
    this.pins.forEach((_, i) => {
      const w = this.pinWorld(i);
      const s = w ? worldToScreen(e.camera, size, w) : null;
      if (!s) return;
      const d = screenDist(s, e.screen);
      if (d <= bestD) {
        best = i;
        bestD = d;
      }
    });
    return best;
  }

  private recomputePins(): void {
    const inv = uvProjectiveInvert(this.matrix);
    this.pins = this.tile.map((t): Vec2 => (inv ? uvApplyProjective(inv, t[0], t[1]) : [0, 0]));
  }

  /** The map sending the four pins to their tile corners, or null when they no longer form a quadrilateral. */
  private matrixOf(pins: readonly Vec2[]): UvProjective | null {
    const [p0, p1, p2, p3] = pins, [t0, t1, t2, t3] = this.tile;
    if (!p0 || !p1 || !p2 || !p3 || !t0 || !t1 || !t2 || !t3) return null;
    // Corners in order around the tile: red, green, yellow, blue.
    return uvProjectiveFromPoints([p0, p1, p3, p2], [t0, t1, t3, t2]);
  }

  /** Move pin `pin` to face position `p`; the other pins follow per the pin's role. */
  private applyDrag(pin: number, p: Vec2): void {
    const start = this.drag!;
    const P = start.pinsAtStart;
    const c = P[0]!, g = P[1]!, b = P[2]!;
    let A: UvAffine | null = null;
    switch (pin) {
      case 0:
        A = [1, 0, p[0] - c[0], 0, 1, p[1] - c[1]];
        break;
      case 1:
        A = similarityAbout(c, g, p);
        break;
      case 2:
        A = uvAffineFromPoints([c, g, b], [c, g, p]);
        break;
      default:
        break;
    }
    // The yellow pin moves alone (a distortion); the others carry every pin with their face transform.
    const pins = pin === 3 ? [c, g, b, p] : A ? P.map((q) => uvApply(A!, q[0], q[1])) : null;
    const m = pins && this.matrixOf(pins);
    if (!pins || !m) return;
    this.matrix = m;
    this.pins = pins;
  }

  /** Apply a face-space transform `A` to the pins (texture follows: M' = M ∘ A⁻¹) and commit. */
  private applyFaceTransform(A: UvAffine, commit: boolean): void {
    const pins = this.pins.map((q) => uvApply(A, q[0], q[1]));
    const m = this.matrixOf(pins);
    if (!m) return;
    this.matrix = m;
    this.pins = pins;
    if (commit) this.commit();
  }
}

// ---------------------------------------------------------------------------------------------
// Commands: entry from the context menu and the pin menu (Done / Reset / Flip / Rotate)

function currentTool(): PositionTextureTool {
  const t = PositionTextureTool.current;
  if (!t) throw new PushFormError('tool.inactive', 'Position Texture is not active');
  return t;
}

export const texturePositionTool = defineCommand({
  id: 'texture.positionTool',
  title: 'Position Texture',
  category: 'tool',
  params: z.object({ ref: EntityRefSchema }),
  undoable: false,
  run(ctx, p): boolean {
    const host = hostOf(ctx);
    if (p.ref.kind !== 'face' && p.ref.kind !== 'sketchFace') throw new PushFormError('texture.none', 'Texture positioning needs a face');
    const path = p.ref.path as Id[], id = p.ref.id as Id;
    const ref: EntityRef =
      p.ref.kind === 'face'
        ? { kind: 'face', path, id, faceId: p.ref.faceId as FaceLocalId, region: p.ref.region ?? null }
        : { kind: 'sketchFace', path, id };
    if (!textureTargetOf(host, ref)) throw new PushFormError('texture.none', 'The face has no texture to position');
    if (!ctx.tools) throw new PushFormError('tool.unknown', 'No tool host');
    ctx.tools.activate('texturePosition');
    currentTool().begin(ref);
    return true;
  },
});

export const texturePinDone = defineCommand({
  id: 'texture.pin.done',
  title: 'Done',
  category: 'edit',
  params: z.object({}),
  undoable: false,
  run: () => currentTool().done(),
});
export const texturePinReset = defineCommand({
  id: 'texture.pin.reset',
  title: 'Reset',
  category: 'edit',
  params: z.object({}),
  undoable: false,
  run: () => currentTool().reset(),
});
export const texturePinFlip = defineCommand({
  id: 'texture.pin.flip',
  title: 'Flip',
  category: 'edit',
  params: z.object({ axis: z.enum(['leftRight', 'upDown']) }),
  undoable: false,
  run: (_ctx, p) => currentTool().flip(p.axis),
});
export const texturePinRotate = defineCommand({
  id: 'texture.pin.rotate',
  title: 'Rotate',
  category: 'edit',
  params: z.object({ degrees: z.number() }),
  undoable: false,
  run: (_ctx, p) => currentTool().rotate(p.degrees),
});

export const positionTextureCommands: readonly AnyCommand[] = [texturePositionTool, texturePinDone, texturePinReset, texturePinFlip, texturePinRotate];
