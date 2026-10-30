// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Mat4, MMat4, UnitSettings, Vec2, Vec3 } from '@pushform/core';
import { formatLength, m4mul, m4transformPoint, MERGE_TOL, v3cross, v3dist, v3dot, v3len, v3normalize, v3sub } from '@pushform/core';
import type { Axis } from '@pushform/inference';
import { SNAP_COLORS } from '@pushform/inference';
import type { DocumentState, EntityContainer, EntityRef, UndoEntry } from '@pushform/model';
import { containerAt, entityRefKey, imageEntityCorners } from '@pushform/model';
import { contextFrame, pathKeyOf } from '../../commands/context';
import { surfaceRefs } from '../../commands/sketchQueries';
import type { CameraState } from '../../camera/CameraHost';
import type { DocumentHost } from '../../host/DocumentHost';
import type { OverlayPrimitive } from '../overlay';
import type { Tool, ToolContext, ToolStatus } from '../Tool';
import { hostOfTool } from '../toolUtil';

/** Light gray of the moved outline while dragging. */
export const OUTLINE_COLOR = '#a8a8a8';
export const AXIS_COLOR: Record<Axis, string> = { x: SNAP_COLORS.axisX, y: SNAP_COLORS.axisY, z: SNAP_COLORS.axisZ };
export const AXIS_DIR: Record<Axis, Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/** World → CSS px for a camera state, or null behind a perspective camera. */
export function worldToScreen(cam: CameraState, viewport: { width: number; height: number }, p: Vec3): Vec2 | null {
  const fwd = v3normalize(v3sub(cam.target, cam.eye));
  const rightRaw = v3cross(fwd, cam.up);
  if (v3len(rightRaw) < 1e-12) return null;
  const right = v3normalize(rightRaw);
  const up = v3cross(right, fwd);
  const d = v3sub(p, cam.eye);
  const x = v3dot(d, right), y = v3dot(d, up), z = v3dot(d, fwd);
  const { width: w, height: h } = viewport;
  if (cam.projection === 'parallel') {
    const s = h / Math.max(1e-9, cam.orthoHeight);
    return [w / 2 + x * s, h / 2 - y * s];
  }
  if (z <= 1e-9) return null;
  const f = h / 2 / Math.tan(((cam.fov / 2) * Math.PI) / 180);
  return [w / 2 + (x / z) * f, h / 2 - (y / z) * f];
}

/** Stable key of a ref list (selection change detection). */
export function refsKey(refs: readonly EntityRef[]): string {
  return refs.map(entityRefKey).join('|');
}

/**
 * Overlay polylines (world space) showing where `refs` end up under the world transform `m`:
 * body edges, instance edges, sketch edges touching moved vertices (stretched), and for body
 * faces/edges every edge of the body with the moved points displaced (the autofold stretch).
 * Refs may live in any context: each group of refs is drawn through its context matrix.
 */
export function movedOutline(state: DocumentState, refs: readonly EntityRef[], m: Mat4 | MMat4, color = OUTLINE_COLOR): OverlayPrimitive[] {
  const out: OverlayPrimitive[] = [];
  const groups = new Map<string, EntityRef[]>();
  for (const ref of refs) (groups.get(pathKeyOf(ref.path)) ?? groups.set(pathKeyOf(ref.path), []).get(pathKeyOf(ref.path))!).push(ref);
  for (const group of groups.values()) out.push(...movedOutlineInContext(state, group, m, color));
  return out;
}

function movedOutlineInContext(state: DocumentState, refs: readonly EntityRef[], m: Mat4 | MMat4, color: string): OverlayPrimitive[] {
  const path = refs[0]?.path ?? [];
  let root: EntityContainer;
  try {
    root = containerAt(state, path);
  } catch {
    return [];
  }
  const frame = contextFrame(state, path);
  /** local → world after the move */
  const mm = frame.identity ? m : m4mul(m, frame.matrix);
  const moved = (p: Vec3): Vec3 => m4transformPoint(mm, p);
  const still = (p: Vec3): Vec3 => frame.toWorld(p);
  const out: OverlayPrimitive[] = [];
  const push = (points: readonly Vec3[]): void => {
    if (points.length >= 2) out.push({ kind: 'polyline', points, color, width: 1 });
  };
  const wholeBodies = new Set<number>();
  const movedSketchVertices = new Set<number>();
  const movedBodyPoints = new Map<number, Vec3[]>();
  const sketch = root.sketch;
  for (const ref of refs) {
    switch (ref.kind) {
      case 'body': {
        const b = root.bodies.get(ref.id);
        if (!b) break;
        wholeBodies.add(ref.id);
        for (const e of b.edges.values()) push(e.polyline.map(moved));
        break;
      }
      case 'instance': {
        const inst = root.instances.get(ref.id);
        const def = inst && state.definitions.get(inst.definitionId);
        if (!inst || !def) break;
        const im = m4mul(mm, inst.transform);
        for (const b of def.entities.bodies.values()) for (const e of b.edges.values()) push(e.polyline.map((p) => m4transformPoint(im, p)));
        for (const e of def.entities.sketch.edges.values()) {
          const a = def.entities.sketch.vertices.get(e.a), b = def.entities.sketch.vertices.get(e.b);
          if (a && b) push([m4transformPoint(im, a.p), m4transformPoint(im, b.p)]);
        }
        break;
      }
      case 'image': {
        const image = root.images.get(ref.id);
        if (image) push([...imageEntityCorners(image), imageEntityCorners(image)[0]!].map(moved));
        break;
      }
      case 'sketchVertex':
        movedSketchVertices.add(ref.id);
        break;
      case 'sketchEdge': {
        const e = sketch.edges.get(ref.id);
        if (e) {
          movedSketchVertices.add(e.a);
          movedSketchVertices.add(e.b);
        }
        break;
      }
      case 'sketchFace': {
        const f = sketch.faces.get(ref.id);
        for (const loop of f?.loops ?? []) {
          for (const r of loop) {
            const e = sketch.edges.get(r.edgeId);
            if (e) {
              movedSketchVertices.add(e.a);
              movedSketchVertices.add(e.b);
            }
          }
        }
        break;
      }
      case 'face': {
        const f = root.bodies.get(ref.id)?.faces.get(ref.faceId);
        if (!f) break;
        const list = movedBodyPoints.get(ref.id) ?? [];
        for (const loop of f.loops) list.push(...loop);
        movedBodyPoints.set(ref.id, list);
        break;
      }
      case 'edge': {
        const e = root.bodies.get(ref.id)?.edges.get(ref.edgeKey);
        if (!e) break;
        const list = movedBodyPoints.get(ref.id) ?? [];
        list.push(...e.polyline);
        movedBodyPoints.set(ref.id, list);
        break;
      }
      default:
        break;
    }
  }
  if (movedSketchVertices.size) {
    for (const e of sketch.edges.values()) {
      const ma = movedSketchVertices.has(e.a), mb = movedSketchVertices.has(e.b);
      if (!ma && !mb) continue;
      const a = sketch.vertices.get(e.a)?.p, b = sketch.vertices.get(e.b)?.p;
      if (!a || !b) continue;
      push([ma ? moved(a) : still(a), mb ? moved(b) : still(b)]);
    }
  }
  for (const [bodyId, points] of movedBodyPoints) {
    if (wholeBodies.has(bodyId)) continue;
    const b = root.bodies.get(bodyId as EntityRef['id']);
    if (!b) continue;
    const isMoved = (p: Vec3): boolean => points.some((q) => v3dist(p, q) <= MERGE_TOL);
    for (const e of b.edges.values()) push(e.polyline.map((p) => (isMoved(p) ? moved(p) : still(p))));
  }
  return out;
}

/** The last transform a tool committed, for VCB re-edits and arrays. */
export interface TransformCommit {
  readonly refs: EntityRef[];
  matrix: MMat4;
  readonly copy: boolean;
  readonly label: string;
  /** Undo entry the commit produced (re-edits only while it is still on top). */
  entry: UndoEntry | null;
  applied: boolean;
}

/**
 * Shared machinery of Move / Rotate / Scale: a serial queue of async `transform.apply` commits,
 * the last commit for VCB re-edits (undo + re-apply, one undo entry) and `Nx` / `N/` arrays.
 */
export abstract class TransformToolBase implements Tool {
  abstract readonly id: string;
  abstract readonly title: string;

  protected ctx: ToolContext | null = null;
  protected lastCommit: TransformCommit | null = null;
  protected lastError: string | null = null;
  private queue: Promise<void> = Promise.resolve();

  /** Resolves when every queued commit / re-apply has settled (tests). */
  get settled(): Promise<void> {
    return this.queue;
  }

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
    this.lastCommit = null;
    this.lastError = null;
    this.onActivate();
  }
  deactivate(): void {
    this.onDeactivate();
    this.lastCommit = null;
    this.ctx = null;
  }
  protected onActivate(): void {}
  protected onDeactivate(): void {}

  abstract onCancel(): void;
  abstract overlay(): readonly OverlayPrimitive[];
  abstract status(): ToolStatus;

  protected host(): DocumentHost | null {
    return this.ctx ? hostOfTool(this.ctx) : null;
  }
  protected docState(): DocumentState | null {
    return this.host()?.doc.state ?? null;
  }
  protected units(): UnitSettings | null {
    return this.docState()?.meta.units ?? null;
  }
  protected fmtLength(meters: number): string {
    const u = this.units();
    return u ? formatLength(meters, u) : meters.toFixed(4);
  }

  /** Entities a transform tool acts on: the selection, else the hovered entity. */
  protected targetRefs(hover: EntityRef | null): EntityRef[] {
    const host = this.host();
    if (!host) return [];
    if (!host.selection.isEmpty) return host.selection.refs;
    if (hover) {
      // A hovered face of a smooth surface stands for the whole surface, as its highlight shows.
      const refs = surfaceRefs(host.doc.state, hover);
      this.ctx?.commands.execute('selection.set', { refs });
      return refs;
    }
    return [];
  }

  protected enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((err: unknown) => {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.lastCommit = null;
      this.ctx?.statusChanged();
      this.ctx?.requestRender();
    });
  }

  /** Queue a `transform.apply` and remember it as the last commit. */
  protected commitTransform(refs: EntityRef[], matrix: MMat4, copy: boolean, label: string): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const commit: TransformCommit = { refs, matrix, copy, label, entry: null, applied: false };
    this.lastCommit = commit;
    this.lastError = null;
    this.enqueue(async () => {
      await ctx.commands.execute('transform.apply', { refs, matrix, copy, label });
      commit.entry = hostOfTool(ctx).undoStack.peek();
      commit.applied = true;
      ctx.statusChanged();
      ctx.requestRender();
    });
    ctx.statusChanged();
    ctx.requestRender();
  }

  /** True when the last commit is still the top undo entry (so it may be re-edited). */
  protected lastIsOnTop(): boolean {
    const host = this.host();
    const last = this.lastCommit;
    return !!host && !!last && last.applied && last.entry !== null && host.undoStack.peek() === last.entry;
  }

  /** VCB re-edit: undo the last commit and re-apply it with a new matrix (still one undo entry). */
  protected reapplyLast(matrix: MMat4): boolean {
    const ctx = this.ctx;
    const last = this.lastCommit;
    if (!ctx || !last) return false;
    last.matrix = matrix;
    this.enqueue(async () => {
      if (this.lastCommit !== last || !this.lastIsOnTop()) return;
      const host = hostOfTool(ctx);
      host.undo();
      last.applied = false;
      await ctx.commands.execute('transform.apply', { refs: last.refs, matrix, copy: last.copy, label: last.label });
      last.entry = host.undoStack.peek();
      last.applied = true;
      ctx.statusChanged();
      ctx.requestRender();
    });
    return true;
  }

  /** `3x` / `/3` after a copy: replace the single copy by an array (one undo entry). */
  protected arrayLast(count: number, mode: 'external' | 'internal'): boolean {
    const ctx = this.ctx;
    const last = this.lastCommit;
    if (!ctx || !last || !last.copy) return false;
    this.enqueue(async () => {
      if (this.lastCommit !== last || !this.lastIsOnTop()) return;
      const host = hostOfTool(ctx);
      host.undo();
      last.applied = false;
      await ctx.commands.execute('transform.array', { refs: last.refs, matrix: last.matrix, count, mode, label: last.label });
      last.entry = host.undoStack.peek();
      last.applied = true;
      ctx.statusChanged();
      ctx.requestRender();
    });
    return true;
  }
}
