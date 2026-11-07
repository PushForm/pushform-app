// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Mat4, MMat4, UnitSettings, Vec2, Vec3 } from '@pushform/core';
import { formatLength, m4mul, m4transformPoint, MERGE_TOL, v3add, v3cross, v3dist, v3dot, v3len, v3normalize, v3scale, v3sub } from '@pushform/core';
import type { Axis, PickHit } from '@pushform/inference';
import { hitSelectable, SNAP_COLORS } from '@pushform/inference';
import type { DocumentState, EntityContainer, EntityRef, MeshPartGeometry, UndoEntry } from '@pushform/model';
import { containerAt, contentWorldBounds, contextMatrix, entityRefKey, imageEntityCorners, sectionPlaneCorners, worldSectionPlane } from '@pushform/model';
import { mapNormal } from '../../commands/sectionPlanes';
import type { SectionPreview } from '../sectionPreview';
import { contextFrame, pathKeyOf } from '../../commands/context';
import { surfaceRefs } from '../../commands/sketchQueries';
import { transformRefusal } from '../../commands/transform';
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

/** What a press on `hit` picks up when nothing is selected: what a Select click there would select. */
export function pickRef(hit: PickHit | null | undefined): EntityRef | null {
  return hit ? hitSelectable(hit) : null;
}

/** Stable key of a ref list (selection change detection). */
export function refsKey(refs: readonly EntityRef[]): string {
  return refs.map(entityRefKey).join('|');
}

/**
 * Overlay polylines (world space) showing where `refs` end up under the world transform `m`:
 * body edges, instance edges, sketch edges touching moved vertices (stretched), guides, leader and
 * model text (leader line and text), and for body faces/edges every edge of the body with the moved
 * points displaced (the stretch the model folds into a valid solid).
 * Refs may live in any context: each group of refs is drawn through its context matrix.
 */
export function movedOutline(state: DocumentState, refs: readonly EntityRef[], m: Mat4 | MMat4, color = OUTLINE_COLOR): OverlayPrimitive[] {
  const out: OverlayPrimitive[] = [];
  const groups = new Map<string, EntityRef[]>();
  for (const ref of refs) (groups.get(pathKeyOf(ref.path)) ?? groups.set(pathKeyOf(ref.path), []).get(pathKeyOf(ref.path))!).push(ref);
  for (const group of groups.values()) out.push(...movedOutlineInContext(state, group, m, color));
  return out;
}

function* meshPartEdgePolylines(g: MeshPartGeometry): Generator<Vec3[]> {
  const p = g.edgePositions;
  for (let e = 0; e + 1 < g.edgeOffsets.length; e++) {
    const line: Vec3[] = [];
    for (let i = g.edgeOffsets[e]! * 3; i < g.edgeOffsets[e + 1]! * 3; i += 3) line.push([p[i]!, p[i + 1]!, p[i + 2]!]);
    yield line;
  }
}

/**
 * The section planes among `refs` transformed by `m` (world coordinates), for a tool's live preview: moved planes, or
 * copies when `copy`; null when no section plane is transformed.
 */
export function sectionPreviewFor(state: DocumentState, refs: readonly EntityRef[], m: Mat4 | MMat4, copy: boolean): SectionPreview | null {
  const planes: SectionPreview['moved'][number][] = [];
  for (const r of refs) {
    if (r.kind !== 'sectionPlane') continue;
    try {
      const sp = containerAt(state, r.path).sectionPlanes.get(r.id);
      if (!sp) continue;
      const { normal, d } = worldSectionPlane(sp.plane, contextMatrix(state, r.path));
      // a point of the plane and its normal, both mapped, keep the side it cuts away
      const point = m4transformPoint(m, [-normal[0] * d, -normal[1] * d, -normal[2] * d]);
      const n = mapNormal(m, normal);
      planes.push({ path: r.path, id: r.id, normal: [n[0], n[1], n[2]], d: -v3dot(n, point) });
    } catch {
      // a plane that is gone is not previewed
    }
  }
  return planes.length ? { moved: copy ? [] : planes, copies: copy ? planes : [], added: null } : null;
}

/** `refs` without their section planes, which a live section preview draws instead of an outline. */
export function withoutSectionPlanes(refs: readonly EntityRef[]): EntityRef[] {
  return refs.filter((r) => r.kind !== 'sectionPlane');
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
  /** Half the length an infinite guide line is drawn with: the size of the context's contents, at least 1 m. */
  let span: number | null = null;
  const guideSpan = (): number => {
    if (span === null) {
      const b = contentWorldBounds(state, path);
      span = Math.max(1, b ? v3dist(b.min, b.max) : 0);
    }
    return span;
  };
  const wholeBodies = new Set<number>();
  const movedSketchVertices = new Set<number>();
  const movedBodyPoints = new Map<number, Vec3[]>();
  const sketch = root.sketch;
  for (const ref of refs) {
    switch (ref.kind) {
      case 'sectionPlane': {
        // the plane's rectangle as drawn, framing its container's contents, then moved
        const sp = root.sectionPlanes.get(ref.id);
        if (!sp) break;
        const { normal, d } = worldSectionPlane(sp.plane, frame.matrix);
        const corners = sectionPlaneCorners(normal, d, contentWorldBounds(state, path));
        push([...corners, corners[0]].map((p) => m4transformPoint(m, p)));
        break;
      }
      case 'body': {
        const b = root.bodies.get(ref.id);
        if (!b) break;
        wholeBodies.add(ref.id);
        for (const e of b.edges.values()) push(e.polyline.map(moved));
        break;
      }
      case 'meshPart': {
        const part = root.meshParts.get(ref.id);
        if (part) for (const line of meshPartEdgePolylines(part.geometry)) push(line.map(moved));
        break;
      }
      case 'instance': {
        const inst = root.instances.get(ref.id);
        const def = inst && state.definitions.get(inst.definitionId);
        if (!inst || !def) break;
        const draw = (entities: EntityContainer, matrix: Mat4 | MMat4, ancestors: ReadonlySet<number>): void => {
          const point = (p: Vec3): Vec3 => m4transformPoint(matrix, p);
          for (const body of entities.bodies.values()) for (const edge of body.edges.values()) push(edge.polyline.map(point));
          for (const part of entities.meshParts.values()) for (const line of meshPartEdgePolylines(part.geometry)) push(line.map(point));
          for (const edge of entities.sketch.edges.values()) {
            const a = entities.sketch.vertices.get(edge.a), b = entities.sketch.vertices.get(edge.b);
            if (a && b) push([point(a.p), point(b.p)]);
          }
          for (const image of entities.images.values()) {
            const corners = imageEntityCorners(image);
            push([...corners, corners[0]!].map(point));
          }
          for (const child of entities.instances.values()) {
            if (ancestors.has(child.definitionId)) continue;
            const childDef = state.definitions.get(child.definitionId);
            if (!childDef) continue;
            draw(childDef.entities, m4mul(matrix, child.transform), new Set([...ancestors, child.definitionId]));
          }
        };
        draw(def.entities, m4mul(mm, inst.transform), new Set([def.id]));
        break;
      }
      case 'image': {
        const image = root.images.get(ref.id);
        if (image) push([...imageEntityCorners(image), imageEntityCorners(image)[0]!].map(moved));
        break;
      }
      case 'guide': {
        const g = root.guides.get(ref.id);
        if (!g) break;
        if (g.kind === 'point') out.push({ kind: 'point', position: moved(g.origin), color, shape: 'cross', size: 8 });
        else if (g.kind === 'segment') out.push({ kind: 'polyline', points: [moved(g.origin), moved(g.end)], color, width: 1, dashed: true });
        else out.push({ kind: 'polyline', points: [moved(v3add(g.origin, v3scale(g.dir, -guideSpan()))), moved(v3add(g.origin, v3scale(g.dir, guideSpan())))], color, width: 1, dashed: true });
        break;
      }
      case 'text': {
        // screen text is fixed to the screen and does not move
        const t = root.texts.get(ref.id);
        if (!t || t.kind === 'screen') break;
        const anchor = moved(t.position);
        const label = t.offset ? moved(v3add(t.position, t.offset)) : anchor;
        if (t.offset) push([anchor, label]);
        out.push({ kind: 'label', position: label, text: t.text, color });
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
  copy: boolean;
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
  /** Key of the refs a press selected from an empty selection, until the operation ends. */
  private pickedUp: string | null = null;

  /** Resolves when every queued commit / re-apply has settled (tests). */
  get settled(): Promise<void> {
    return this.queue;
  }

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
    this.lastCommit = null;
    this.lastError = null;
    this.pickedUp = null;
    this.onActivate();
  }
  deactivate(): void {
    this.onDeactivate();
    this.lastCommit = null;
    this.pickedUp = null;
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

  /**
   * Entities a transform acts on as it starts: the selection, else what a Select click on `hover` (see
   * `pickRef`) selects, a face of a smooth surface standing for the whole surface; those are selected
   * until Esc ends the operation (`dropPickup`). Empty, with the reason in `lastError`, when the
   * transform (a copy when `copy`) is refused, so nothing is picked up or previewed.
   */
  protected targetRefs(hover: EntityRef | null, copy = false): EntityRef[] {
    const host = this.host();
    if (!host) return [];
    const picking = host.selection.isEmpty;
    const refs = !picking ? host.selection.refs : hover ? surfaceRefs(host.doc.state, hover) : [];
    if (!refs.length || this.refuse(refs, copy)) return [];
    if (picking) {
      this.ctx?.commands.execute('selection.set', { refs });
      this.pickedUp = refsKey(refs);
    }
    return refs;
  }

  /** True, with the reason in `lastError` and the status updated, when transforming `refs` is refused. */
  protected refuse(refs: readonly EntityRef[], copy: boolean): boolean {
    const host = this.host();
    const why = host ? transformRefusal(host, refs, copy, this.title) : null;
    if (!why) return false;
    this.lastError = why;
    this.ctx?.statusChanged();
    this.ctx?.requestRender();
    return true;
  }

  /** The operation ended without a change (Esc): what a press picked up from an empty selection is deselected. */
  protected dropPickup(): void {
    const key = this.pickedUp;
    this.pickedUp = null;
    const host = this.host();
    if (key !== null && host && refsKey(host.selection.refs) === key) this.ctx?.commands.execute('selection.set', { refs: [] });
  }

  /** The operation ended with a change: what a press picked up stays selected. */
  protected keepPickup(): void {
    this.pickedUp = null;
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
    this.keepPickup();
    this.enqueue(async () => {
      await ctx.commands.execute('transform.apply', { refs, matrix, copy, label });
      commit.entry = hostOfTool(ctx).undoStack.peek();
      commit.applied = true;
      ctx.committed?.();
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
  protected reapplyLast(matrix: MMat4, copy?: boolean): boolean {
    const ctx = this.ctx;
    const last = this.lastCommit;
    if (!ctx || !last) return false;
    last.matrix = matrix;
    if (copy !== undefined) last.copy = copy;
    this.enqueue(async () => {
      if (this.lastCommit !== last || !this.lastIsOnTop()) return;
      const host = hostOfTool(ctx);
      host.undo();
      last.applied = false;
      try {
        await ctx.commands.execute('transform.apply', { refs: last.refs, matrix, copy: last.copy, label: last.label });
      } catch (err) {
        host.redo();
        throw err;
      }
      last.entry = host.undoStack.peek();
      last.applied = true;
      ctx.committed?.();
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
