// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { m4mul, m4transformPoint, v3dot, v3normalize, v3sub } from '@pushform/core';
import type { Id, Vec2, Vec3 } from '@pushform/core';
import { containerAt, meshPartBounds, surfaceFaceIds } from '@pushform/model';
import type { EntityRef, DocumentState, EntityContainer } from '@pushform/model';
import type { InferenceResult, Snap, SnapKind } from '@pushform/inference';
import type { CameraState } from '../camera/CameraHost';
import type { CommandRegistry } from '../registry/CommandRegistry';
import { hostOf } from '../host/services';
import type { DocumentHost } from '../host/DocumentHost';
import { contextFrame } from '../commands/context';
import { sketchSurfaceFaceIds } from '../commands/sketchQueries';
import { definitionBounds } from '../commands/transform';
import type { OverlayPrimitive, PointGlyphShape } from './overlay';
import type { Modifiers, ToolContext } from './Tool';

/** Pointer distance in CSS px below which a down/up pair counts as a click, not a drag. */
export const DRAG_PX = 3;

export const HOVER_COLOR = '#1e63d1';
export const PREVIEW_COLOR = '#111111';

export const screenDist = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Document host behind a tool context (via the registry's command context). */
export function hostOfTool(ctx: ToolContext): DocumentHost {
  return hostOf(ctx.commands.ctx);
}
export function hostOfRegistry(commands: CommandRegistry): DocumentHost {
  return hostOf(commands.ctx);
}

/** Win Ctrl = Mac Option: both count as the "Ctrl" modifier. */
export const ctrlLike = (m: Modifiers): boolean => m.ctrl || m.alt;

/**
 * World length of one CSS pixel at point `p` for the given camera. Used for screen-space
 * tolerances ("Square within 2 px") without a full projection.
 */
export function worldPerPixelAt(camera: CameraState, viewportHeight: number, p: Vec3): number {
  const h = Math.max(1, viewportHeight);
  if (camera.projection === 'parallel') return camera.orthoHeight / h;
  const fwd = v3normalize(v3sub(camera.target, camera.eye));
  const dist = Math.max(1e-3, v3dot(v3sub(p, camera.eye), fwd));
  return (2 * dist * Math.tan(((camera.fov / 2) * Math.PI) / 180)) / h;
}

const GLYPH_BY_KIND: Partial<Record<SnapKind, PointGlyphShape>> = {
  endpoint: 'circle',
  midpoint: 'circle',
  center: 'circle',
  origin: 'circle',
  onEdge: 'square',
  onAxis: 'square',
  guide: 'square',
  fromPoint: 'square',
  perpendicular: 'square',
  parallel: 'square',
  tangent: 'square',
  onFace: 'diamond',
  onPlane: 'diamond',
  intersection: 'x',
};

/** Glyph for the primary snap, dashed secondary inference lines and the tooltip near the cursor. */
export function inferenceOverlay(r: InferenceResult | null, screen?: Vec2): OverlayPrimitive[] {
  if (!r) return [];
  const out: OverlayPrimitive[] = [];
  const shape = GLYPH_BY_KIND[r.primary.kind];
  if (shape) out.push({ kind: 'point', position: r.primary.point, color: r.primary.color, shape, size: 8 });
  for (const l of r.lines) out.push({ kind: 'polyline', points: [l.a, l.b], color: l.color, dashed: l.dashed });
  if (r.tooltip) out.push({ kind: 'cursorHint', text: r.tooltip, screen });
  return out;
}

/** Rubber-band color: the axis color when snapped to an axis, else black. */
export function rubberBandColor(primary: Snap | null | undefined): string {
  return primary && primary.kind === 'onAxis' ? primary.color : PREVIEW_COLOR;
}

/** Corner index pairs of a bounds box (bit 0 = x max, bit 1 = y max, bit 2 = z max). */
const BOX_EDGES: readonly [number, number][] = [[0, 1], [1, 3], [3, 2], [2, 0], [4, 5], [5, 7], [7, 6], [6, 4], [0, 4], [1, 5], [2, 6], [3, 7]];

/** Overlay primitives (world space) outlining an entity of any edit context (hover / eraser highlight). */
export function entityOverlay(state: DocumentState, ref: EntityRef, color: string): OverlayPrimitive[] {
  let root: EntityContainer;
  try {
    root = containerAt(state, ref.path);
  } catch {
    return [];
  }
  const frame = contextFrame(state, ref.path);
  const w = (p: Vec3): Vec3 => frame.toWorld(p);
  const sketch = root.sketch;
  switch (ref.kind) {
    case 'sketchEdge': {
      const e = sketch.edges.get(ref.id);
      const a = e && sketch.vertices.get(e.a), b = e && sketch.vertices.get(e.b);
      return a && b ? [{ kind: 'polyline', points: [w(a.p), w(b.p)], color, width: 3 }] : [];
    }
    case 'sketchVertex': {
      const v = sketch.vertices.get(ref.id);
      return v ? [{ kind: 'point', position: w(v.p), color, shape: 'square', size: 8 }] : [];
    }
    case 'sketchFace': {
      const f = sketch.faces.get(ref.id);
      if (!f) return [];
      const loopsOf = (face: typeof f): Vec3[][] =>
        face.loops.map((loop) => {
          const pts: Vec3[] = [];
          for (const r of loop) {
            const e = sketch.edges.get(r.edgeId);
            const v = e && sketch.vertices.get(r.forward ? e.a : e.b);
            if (v) pts.push(w(v.p));
          }
          return pts;
        });
      const ids = sketchSurfaceFaceIds(sketch, ref.id);
      if (ids.length > 1) {
        // A smooth surface highlights as one: every face filled, its soft edges not outlined.
        const out: OverlayPrimitive[] = [];
        const hard = new Set<Id>();
        for (const id of ids) {
          const face = sketch.faces.get(id);
          if (!face) continue;
          const loops = loopsOf(face);
          if (loops[0]) out.push({ kind: 'polygon', points: loops[0], holes: loops.slice(1), color, opacity: 0.25 });
          for (const loop of face.loops) for (const r of loop) if (!sketch.edges.get(r.edgeId)?.soft) hard.add(r.edgeId);
        }
        for (const id of hard) {
          const e = sketch.edges.get(id);
          const a = e && sketch.vertices.get(e.a), b = e && sketch.vertices.get(e.b);
          if (a && b) out.push({ kind: 'polyline', points: [w(a.p), w(b.p)], color, width: 2 });
        }
        return out;
      }
      const loops = loopsOf(f);
      return [
        { kind: 'polygon', points: loops[0] ?? [], holes: loops.slice(1), color, opacity: 0.25 },
        ...loops.map((l): OverlayPrimitive => ({ kind: 'polyline', points: l, color, closed: true, width: 2 })),
      ];
    }
    case 'face': {
      const b = root.bodies.get(ref.id);
      const f = b?.faces.get(ref.faceId);
      if (!b || !f) return [];
      const ids = surfaceFaceIds(b, ref.faceId);
      if (ids.length > 1) {
        // A smooth surface highlights as one: every face filled, outlined only along its hard boundary.
        const inside = new Set(ids);
        const out: OverlayPrimitive[] = [];
        for (const id of ids) {
          const loops = b.faces.get(id)?.loops.map((l) => l.map(w));
          if (loops?.[0]) out.push({ kind: 'polygon', points: loops[0], holes: loops.slice(1), color, opacity: 0.25 });
        }
        for (const e of b.edges.values()) {
          if (inside.has(e.faceA) !== inside.has(e.faceB)) out.push({ kind: 'polyline', points: e.polyline.map(w), color, width: 2 });
        }
        return out;
      }
      const loops = f.loops.map((l) => l.map(w));
      const outer = loops[0] ?? [];
      return [
        { kind: 'polygon', points: outer, holes: loops.slice(1), color, opacity: 0.25 },
        ...loops.map((l): OverlayPrimitive => ({ kind: 'polyline', points: l, color, closed: true, width: 2 })),
      ];
    }
    case 'edge': {
      const e = root.bodies.get(ref.id)?.edges.get(ref.edgeKey);
      return e ? [{ kind: 'polyline', points: e.polyline.map(w), color, width: 3 }] : [];
    }
    case 'body': {
      const b = root.bodies.get(ref.id);
      if (!b) return [];
      // Soft and hidden edges are not drawn, so they are not outlined either.
      return [...b.edges.values()]
        .filter((e) => !e.soft && !e.hidden)
        .map((e): OverlayPrimitive => ({ kind: 'polyline', points: e.polyline.map(w), color, width: 2 }));
    }
    case 'meshPart': {
      // Outlining every packed edge of a large import is too slow: the bounds box stands in.
      const part = root.meshParts.get(ref.id);
      const lb = part && meshPartBounds(part.geometry);
      if (!lb) return [];
      const c = (i: number): Vec3 => w([i & 1 ? lb.max[0] : lb.min[0], i & 2 ? lb.max[1] : lb.min[1], i & 4 ? lb.max[2] : lb.min[2]]);
      return BOX_EDGES.map(([a, b]): OverlayPrimitive => ({ kind: 'polyline', points: [c(a), c(b)], color, width: 2 }));
    }
    case 'instance': {
      const inst = root.instances.get(ref.id);
      const lb = inst && definitionBounds(state, inst.definitionId);
      if (!inst || !lb) return [];
      const m = m4mul(frame.matrix, inst.transform);
      const c = (i: number): Vec3 => m4transformPoint(m, [i & 1 ? lb.max[0] : lb.min[0], i & 2 ? lb.max[1] : lb.min[1], i & 4 ? lb.max[2] : lb.min[2]]);
      return BOX_EDGES.map(([a, b]): OverlayPrimitive => ({ kind: 'polyline', points: [c(a), c(b)], color, width: 2 }));
    }
    case 'guide': {
      const g = root.guides.get(ref.id);
      if (!g) return [];
      if (g.kind === 'point') return [{ kind: 'point', position: w(g.origin), color, shape: 'x', size: 8 }];
      if (g.kind === 'segment') return [{ kind: 'polyline', points: [w(g.origin), w(g.end)], color, width: 2, dashed: true }];
      const o = w(g.origin), d = frame.toWorldDir(g.dir);
      return [{ kind: 'polyline', points: [[o[0] - d[0] * 1e3, o[1] - d[1] * 1e3, o[2] - d[2] * 1e3], [o[0] + d[0] * 1e3, o[1] + d[1] * 1e3, o[2] + d[2] * 1e3]], color, width: 2, dashed: true }];
    }
    default:
      return [];
  }
}
