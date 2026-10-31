// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { FaceLocalId, Id, Plane, Ray, Vec2, Vec3 } from '@pushform/core';
import {
  basisToLocal,
  LENGTH_TOL,
  PICK_PX,
  planeFromPointNormal,
  rayAt,
  rayPlane,
  raySegmentClosest,
  v3addScaled,
  v3cross,
  v3dot,
  v3len,
  v3normalize,
  v3scale,
  v3sub,
} from '@pushform/core';
import { m4transformPoint } from '@pushform/core';
import { lineLineClosest3D, pointInPolygon, pointInRing, querySegBVHRay, raycastBVH, raycastTriBVH, type BVH } from '@pushform/geom';
import { pathWithin, RegionCache, regionAt, type EntityRef, type Guide } from '@pushform/model';
import type { BodyIndex, IndexedCenter, IndexedSegment, IndexedVertex, SpatialIndex } from './SpatialIndex';
import type { InferenceInput, PickBoxMode, PickHit, PickRect } from './types';

/**
 * Depth slack (in screen pixel-sizes) when testing whether an edge/vertex candidate is hidden
 * behind the surface under the cursor: candidates on the surface itself (silhouette edges, loop
 * corners) sit within this band; anything deeper is occluded.
 */
export const OCCLUSION_PX = 4;

/** Points this far on the removed side of a cut still count as kept, so geometry lying in the cut stays pickable. */
const CUT_TOL = 1e-9;

export interface PickOptions {
  /** Restrict picking to these entity kinds (default: all). `body` covers faces and edges. */
  readonly kinds?: readonly EntityRef['kind'][] | undefined;
  /**
   * Entities that are neither pickable nor occluding (e.g. geometry being dragged). An
   * `instance` ref ignores everything inside that instance.
   */
  readonly ignore?: readonly EntityRef[] | undefined;
  /** The open edit context (instance path, default root): decides `PickHit.selectable` / `inContext`. */
  readonly context?: readonly Id[] | undefined;
  /** Pick dimensions and section planes; off by default so drawing tools keep reaching the faces under them. */
  readonly dimensions?: boolean | undefined;
}

/** How a picked entity relates to the edit context. */
export interface ContextResolution {
  readonly selectable: EntityRef;
  readonly inContext: boolean;
}

/** The surface under the cursor: a body face (with region) or a sketch face. */
export interface SurfaceCandidate {
  readonly ref: EntityRef;
  readonly point: Vec3;
  readonly t: number;
  readonly normal: Vec3;
  readonly plane: Plane;
  /** Body id + face id for body faces, null for sketch faces. */
  readonly bodyId: Id | null;
  readonly faceId: FaceLocalId | null;
}

export interface EdgeCandidate {
  readonly ref: EntityRef;
  readonly a: Vec3;
  readonly b: Vec3;
  /** Closest point on the segment. */
  readonly point: Vec3;
  /** Segment parameter 0..1 of `point`. */
  readonly s: number;
  /** Ray parameter of the closest approach. */
  readonly t: number;
  readonly screenDist: number;
  /** Unit direction a → b. */
  readonly dir: Vec3;
}

export interface VertexCandidate {
  readonly ref: EntityRef;
  readonly point: Vec3;
  readonly t: number;
  readonly screenDist: number;
  readonly vertex: IndexedVertex;
}

export interface CenterCandidate {
  readonly center: IndexedCenter;
  readonly point: Vec3;
  readonly t: number;
  readonly screenDist: number;
}

export interface GuideCandidate {
  readonly guide: Guide;
  readonly ref: EntityRef;
  readonly point: Vec3;
  readonly t: number;
  readonly screenDist: number;
  /** Direction for line/segment guides. */
  readonly dir: Vec3 | null;
}

/** A dimension under the cursor: the nearest point on one of its lines. */
export interface DimensionCandidate {
  readonly ref: EntityRef;
  readonly point: Vec3;
  readonly t: number;
  readonly screenDist: number;
}

/** A text under the cursor: on its label (screen distance 0) or near its leader line. */
export interface TextCandidate {
  readonly ref: EntityRef;
  readonly point: Vec3;
  readonly t: number;
  readonly screenDist: number;
}

/** Screen pixels per text point, at 96 px per inch, as the renderer draws text. */
const TEXT_PX_PER_PT = 96 / 72;
/** Estimated width of an average character and height of a line, in text heights, for a label's box. */
const TEXT_CHAR_WIDTH = 0.6, TEXT_LINE_HEIGHT = 1.25;

/**
 * A label's box on screen (CSS px): from its top-left corner for screen text, and for leader text starting (`left`) or
 * ending (`right`) at its label point, centered on it vertically.
 */
export function textLabelBox(text: string, fontSizePt: number, at: Vec2, align: 'topLeft' | 'left' | 'right'): PickRect {
  const lines = text.split('\n');
  const h = fontSizePt * TEXT_PX_PER_PT;
  const width = Math.max(...lines.map((l) => l.length)) * TEXT_CHAR_WIDTH * h, height = lines.length * TEXT_LINE_HEIGHT * h;
  const min: Vec2 = align === 'topLeft' ? [at[0], at[1]] : [align === 'left' ? at[0] : at[0] - width, at[1] - height / 2];
  return { min, max: [min[0] + width, min[1] + height] };
}

/** A section plane under the cursor: the nearest point on its outline. */
export interface SectionPlaneCandidate {
  readonly ref: EntityRef;
  readonly point: Vec3;
  readonly t: number;
  readonly screenDist: number;
}

/** Everything near the cursor, each list sorted nearest-on-screen first, occluded entries removed. */
export interface PickCandidates {
  readonly surface: SurfaceCandidate | null;
  readonly edges: readonly EdgeCandidate[];
  readonly vertices: readonly VertexCandidate[];
  readonly centers: readonly CenterCandidate[];
  readonly guides: readonly GuideCandidate[];
  readonly dimensions?: readonly DimensionCandidate[] | undefined;
  readonly texts?: readonly TextCandidate[] | undefined;
  readonly sectionPlanes?: readonly SectionPlaneCandidate[] | undefined;
}

const EMPTY: PickCandidates = { surface: null, edges: [], vertices: [], centers: [], guides: [], dimensions: [], texts: [], sectionPlanes: [] };

export class PickService {
  private readonly regions = new RegionCache();

  constructor(readonly index: SpatialIndex) {}

  /** Nearest entity under the cursor: a vertex within tolerance beats an edge, which beats a face. */
  pick(input: InferenceInput, opts: PickOptions = {}): PickHit | null {
    return this.contextualize(choosePick(this.candidates(input, opts)), opts.context ?? []);
  }

  /** Fill `selectable` / `inContext` of a raw hit for the given edit context. */
  contextualize(hit: PickHit | null, context: readonly Id[]): PickHit | null {
    if (!hit) return null;
    return { ...hit, ...this.resolveContext(hit.ref, context) };
  }

  /**
   * Context rules: an entity inside the context is itself; one deeper in the context
   * resolves to the instance one level below the context on its path; one outside the context
   * (an ancestor's sibling) resolves to the instance at the first step where the paths diverge,
   * or to itself when it lives directly in an ancestor container. Entities inside a locked
   * instance never count as `inContext`.
   */
  resolveContext(ref: EntityRef, context: readonly Id[]): ContextResolution {
    const path = ref.path;
    if (ref.kind === 'instance') {
      // an instance ref is "inside" the context when its container is the context
      const locked = this.index.container(path)?.locked ?? false;
      if (samePath(path, context)) return { selectable: ref, inContext: !locked };
      return { selectable: this.instanceBelow(context, [...path, ref.id]) ?? ref, inContext: false };
    }
    if (samePath(path, context)) {
      const locked = this.index.container(path)?.locked ?? false;
      return { selectable: ref, inContext: !locked };
    }
    if (pathWithin(path, context)) {
      return { selectable: { kind: 'instance', path: context, id: path[context.length]! }, inContext: false };
    }
    // outside the context: the instance at the divergence point, as seen from the shared ancestor
    let i = 0;
    while (i < path.length && i < context.length && path[i] === context[i]) i++;
    if (i < path.length) return { selectable: { kind: 'instance', path: path.slice(0, i), id: path[i]! }, inContext: false };
    return { selectable: ref, inContext: false };
  }

  /** The instance one level below `context` on `full` (an instance path), or null when `full` is not inside it. */
  private instanceBelow(context: readonly Id[], full: readonly Id[]): EntityRef | null {
    if (full.length <= context.length || !pathWithin(full, context)) return null;
    return { kind: 'instance', path: context, id: full[context.length]! };
  }

  /** All pick candidates around the cursor (used by the inference engine). */
  candidates(input: InferenceInput, opts: PickOptions = {}): PickCandidates {
    if (!this.index.hasState) return EMPTY;
    const filter = new RefFilter(opts);
    const { ray, pixelSizeAt } = input;
    const surface = this.pickSurface(ray, filter);
    // What an active cut removes is not drawn, so it is neither picked nor snapped to.
    const clipped = (ref: EntityRef | null | undefined, p: Vec3): boolean => !!ref && this.isClipped(ref.path, p);
    // Candidates at the same point (a corner reported by several entities, a center on a vertex)
    // shift the ray identically; one occlusion query per distinct point serves them all.
    const occlusion = new Map<string, boolean>();
    const occluded = (p: Vec3, t: number): boolean => {
      if (!surface) return false;
      const key = `${p[0]},${p[1]},${p[2]}|${t}`;
      let hidden = occlusion.get(key);
      if (hidden === undefined) occlusion.set(key, (hidden = this.occluded(ray, p, t, surface, filter, pixelSizeAt)));
      return hidden;
    };

    const edges: EdgeCandidate[] = [];
    if (filter.wants('edge') || filter.wants('sketchEdge')) {
      const radius = (t: number): number => PICK_PX.edge * pixelSizeAt(t);
      const sources: { segments: readonly IndexedSegment[]; bvh: BVH }[] = [];
      if (filter.wants('edge')) for (const b of this.index.bodies()) sources.push({ segments: b.segments, bvh: b.segBVH });
      if (filter.wants('sketchEdge')) for (const sk of this.index.sketches()) sources.push({ segments: sk.segments, bvh: sk.segBVH });
      for (const src of sources) {
        for (const h of querySegBVHRay(src.bvh, src.segments, ray, radius)) {
          const seg = src.segments[h.seg]!;
          if (filter.ignored(seg.ref)) continue;
          const point = v3addScaled(seg.a, v3sub(seg.b, seg.a), h.s);
          if (clipped(seg.ref, point) || occluded(point, h.t)) continue;
          const px = pixelSizeAt(h.t);
          edges.push({
            ref: seg.ref,
            a: seg.a,
            b: seg.b,
            point,
            s: h.s,
            t: h.t,
            screenDist: px > 0 ? Math.sqrt(h.distSq) / px : 0,
            dir: v3normalize(v3sub(seg.b, seg.a)),
          });
        }
      }
      edges.sort(byScreenThenDepth);
    }

    const vertices: VertexCandidate[] = [];
    if (filter.wants('edge') || filter.wants('sketchVertex')) {
      const vi = this.index.vertices();
      const radius = (t: number): number => PICK_PX.vertex * pixelSizeAt(t);
      for (const h of querySegBVHRay(vi.bvh, vi.segments, ray, radius)) {
        const v = vi.items[h.seg]!;
        if (!filter.wants(v.ref.kind) || filter.ignored(v.ref)) continue;
        if (clipped(v.ref, v.p) || occluded(v.p, h.t)) continue;
        const px = pixelSizeAt(h.t);
        vertices.push({ ref: v.ref, point: v.p, t: h.t, screenDist: px > 0 ? Math.sqrt(h.distSq) / px : 0, vertex: v });
      }
      vertices.sort(byScreenThenDepth);
    }

    const centers: CenterCandidate[] = [];
    {
      const ci = this.index.centers();
      const radius = (t: number): number => PICK_PX.vertex * pixelSizeAt(t);
      for (const h of querySegBVHRay(ci.bvh, ci.segments, ray, radius)) {
        const c = ci.items[h.seg]!;
        if (c.ref && (!filter.wants(c.ref.kind) || filter.ignored(c.ref))) continue;
        if (clipped(c.ref, c.p) || occluded(c.p, h.t)) continue;
        const px = pixelSizeAt(h.t);
        centers.push({ center: c, point: c.p, t: h.t, screenDist: px > 0 ? Math.sqrt(h.distSq) / px : 0 });
      }
      centers.sort(byScreenThenDepth);
    }

    const guides: GuideCandidate[] = [];
    if (filter.wants('guide')) {
      for (const { guide: g, ref } of this.index.guides()) {
        if (filter.ignored(ref)) continue;
        const c = guideClosest(ray, g);
        if (!c) continue;
        const px = pixelSizeAt(c.t);
        const screenDist = px > 0 ? c.dist / px : 0;
        if (screenDist > PICK_PX.guide) continue;
        if (clipped(ref, c.point) || occluded(c.point, c.t)) continue;
        guides.push({ guide: g, ref, point: c.point, t: c.t, screenDist, dir: c.dir });
      }
      guides.sort(byScreenThenDepth);
    }

    const dimensions: DimensionCandidate[] = [];
    if (opts.dimensions && filter.wants('dimension')) {
      for (const { segments, ref } of this.index.dimensions()) {
        if (filter.ignored(ref)) continue;
        let best: DimensionCandidate | null = null;
        for (const [a, b] of segments) {
          const c = raySegmentClosest(ray, a, b);
          const point = rayAt(ray, c.t);
          const px = pixelSizeAt(c.t);
          const screenDist = px > 0 ? Math.sqrt(c.distSq) / px : 0;
          if (screenDist > PICK_PX.edge || (best && screenDist >= best.screenDist)) continue;
          best = { ref, point, t: c.t, screenDist };
        }
        if (best && !clipped(ref, best.point) && !occluded(best.point, best.t)) dimensions.push(best);
      }
      dimensions.sort(byScreenThenDepth);
    }

    const texts: TextCandidate[] = [];
    const { project, view } = input;
    if (opts.dimensions && filter.wants('text') && project && view) {
      const [sx, sy] = input.screen;
      for (const tx of this.index.texts()) {
        if (filter.ignored(tx.ref)) continue;
        if (tx.kind === 'screen') {
          // drawn over the model, so never hidden by it
          const box = textLabelBox(tx.text, tx.fontSizePt, [tx.position[0] * view.width, tx.position[1] * view.height], 'topLeft');
          if (sx >= box.min[0] && sx <= box.max[0] && sy >= box.min[1] && sy <= box.max[1]) texts.push({ ref: tx.ref, point: rayAt(input.ray, 0), t: 0, screenDist: 0 });
          continue;
        }
        const label: Vec3 = tx.viewOffset
          ? v3addScaled(v3addScaled(tx.position, view.right, tx.viewOffset[0]), view.up, tx.viewOffset[1])
          : tx.offset ? v3addScaled(tx.position, tx.offset, 1) : tx.position;
        const labelAt = project(label);
        const box = textLabelBox(tx.text, tx.fontSizePt, labelAt, labelAt[0] >= project(tx.position)[0] ? 'left' : 'right');
        let best: TextCandidate | null = null;
        if (sx >= box.min[0] && sx <= box.max[0] && sy >= box.min[1] && sy <= box.max[1]) {
          const t = v3dot(v3sub(label, input.ray.origin), input.ray.dir);
          best = { ref: tx.ref, point: label, t, screenDist: 0 };
        } else if (tx.leaderShown) {
          const c = raySegmentClosest(input.ray, tx.position, label);
          const px = pixelSizeAt(c.t);
          const screenDist = px > 0 ? Math.sqrt(c.distSq) / px : 0;
          if (screenDist <= PICK_PX.edge) best = { ref: tx.ref, point: rayAt(input.ray, c.t), t: c.t, screenDist };
        }
        // the label is drawn over the model; only its leader can be hidden
        if (best && !clipped(tx.ref, best.point) && (best.screenDist === 0 || !occluded(best.point, best.t))) texts.push(best);
      }
      texts.sort(byScreenThenDepth);
    }

    const sectionPlanes: SectionPlaneCandidate[] = [];
    if (opts.dimensions && filter.wants('sectionPlane')) {
      for (const { segments, ref } of this.index.sectionPlanes()) {
        if (filter.ignored(ref)) continue;
        let best: SectionPlaneCandidate | null = null;
        for (const [a, b] of segments) {
          const c = raySegmentClosest(ray, a, b);
          const point = rayAt(ray, c.t);
          const px = pixelSizeAt(c.t);
          const screenDist = px > 0 ? Math.sqrt(c.distSq) / px : 0;
          if (screenDist > PICK_PX.edge || (best && screenDist >= best.screenDist)) continue;
          best = { ref, point, t: c.t, screenDist };
        }
        if (best && !occluded(best.point, best.t)) sectionPlanes.push(best);
      }
      sectionPlanes.sort(byScreenThenDepth);
    }

    return { surface, edges, vertices, centers, guides, dimensions, texts, sectionPlanes };
  }

  /**
   * Rectangle selection in the edit context (`opts.context`, default root). `window` keeps
   * entities whose projected geometry lies fully inside the rect, `crossing` keeps entities
   * touching it. Bodies of the context are returned as `body` refs, its sketch edges and faces as
   * their own refs, and the instances placed directly in the context as `instance` refs (judged
   * by the world geometry of their whole subtree). Entities of other containers are never
   * returned. Requires `input.project`.
   */
  pickBox(rect: PickRect, input: Pick<InferenceInput, 'project'>, mode: PickBoxMode = 'window', opts: PickOptions = {}): EntityRef[] {
    return this.pickRegion(rectRegion(normalizeRect(rect)), input, mode, opts);
  }

  /**
   * Lasso selection: as `pickBox`, inside a closed screen outline (even-odd, so a self-crossing
   * outline excludes the parts it wraps twice). In `window` mode an edge must not cross the
   * outline, so an edge spanning a concave notch is not inside. Fewer than three points select nothing.
   */
  pickLasso(outline: readonly Vec2[], input: Pick<InferenceInput, 'project'>, mode: PickBoxMode = 'window', opts: PickOptions = {}): EntityRef[] {
    if (outline.length < 3) return [];
    return this.pickRegion(outlineRegion(outline), input, mode, opts);
  }

  private pickRegion(region: ScreenRegion, input: Pick<InferenceInput, 'project'>, mode: PickBoxMode, opts: PickOptions): EntityRef[] {
    if (!input.project || !this.index.hasState) return [];
    const project: (p: Vec3) => Vec2 = input.project;
    const filter = new RefFilter(opts);
    const context = opts.context ?? [];
    const out: EntityRef[] = [];
    const inside = (p: Vec3): boolean => region.contains(project(p));

    /** Accumulates window/crossing evidence for one selectable (a body or an instance subtree). */
    class Acc {
      all = true;
      any = false;
      count = 0;
      done(): boolean {
        return mode === 'window' ? !this.all : this.any;
      }
      point(p: Vec3): void {
        if (this.done()) return;
        this.count++;
        if (inside(p)) this.any = true;
        else this.all = false;
      }
      segment(a: Vec3, b: Vec3): void {
        if (this.done()) return;
        if (mode === 'crossing') {
          if (region.touches(project(a), project(b))) this.any = true;
        } else if (!region.convex && region.crossesBoundary(project(a), project(b))) this.all = false;
      }
      ring(loop: readonly Vec3[]): void {
        if (mode !== 'crossing' || this.any || loop.length < 3) return;
        const ring = loop.map(project);
        if (region.probes.some((c) => pointInRing(c, ring))) this.any = true;
      }
      keep(): boolean {
        return mode === 'window' ? this.count > 0 && this.all : this.any;
      }
    }
    const addBody = (acc: Acc, b: BodyIndex): void => {
      const verts = b.mesh.verts;
      for (let i = 0; i < verts.length && !acc.done(); i += 3) acc.point([verts[i]!, verts[i + 1]!, verts[i + 2]!]);
      for (const s of b.segments) acc.segment(s.a, s.b);
      for (const f of b.faces.values()) if (f.loops[0]) acc.ring(f.loops[0]);
    };
    const addImage = (acc: Acc, c: readonly Vec3[]): void => {
      for (const p of c) acc.point(p);
      for (let i = 0; i < 4; i++) acc.segment(c[i]!, c[(i + 1) % 4]!);
      acc.ring(c);
    };
    const images = this.index.images();

    if (filter.wants('body')) {
      for (const b of this.index.bodiesAt(context)) {
        const ref: EntityRef = { kind: 'body', path: context, id: b.id };
        if (filter.ignored(ref)) continue;
        const acc = new Acc();
        addBody(acc, b);
        if (acc.keep()) out.push(ref);
      }
    }
    const sk = this.index.sketch(context);
    if (sk) {
      if (filter.wants('sketchEdge')) {
        for (const s of sk.segments) {
          if (filter.ignored(s.ref)) continue;
          const pa = project(s.a), pb = project(s.b);
          if (mode === 'window' ? region.encloses(pa, pb) : region.touches(pa, pb)) out.push(s.ref);
        }
      }
      if (filter.wants('sketchFace')) {
        for (const f of sk.faces) {
          if (filter.ignored(f.ref) || !f.visible) continue;
          const loops = f.loops.map((loop) => loop.map(project));
          const edges = (test: (a: Vec2, b: Vec2) => boolean): boolean =>
            loops.some((loop) => loop.some((p, i) => test(p, loop[(i + 1) % loop.length]!)));
          let keep: boolean;
          if (mode === 'window') keep = loops.some((loop) => loop.length > 0) && !edges((a, b) => !region.encloses(a, b));
          else {
            keep = edges(region.touches);
            if (!keep && loops[0]) {
              const ring = loops[0];
              keep = region.probes.some((c) => pointInRing(c, ring));
            }
          }
          if (keep) out.push(f.ref);
        }
      }
    }
    if (filter.wants('image')) {
      for (const image of images) {
        if (!samePath(image.ref.path, context) || filter.ignored(image.ref)) continue;
        const acc = new Acc();
        addImage(acc, image.corners);
        if (acc.keep()) out.push(image.ref);
      }
    }
    if (filter.wants('instance')) {
      // instances directly in the context: gather the world geometry of every container below them
      const accs = new Map<Id, Acc>();
      for (const entry of this.index.containerEntries()) {
        if (entry.path.length <= context.length || !pathWithin(entry.path, context)) continue;
        const instId = entry.path[context.length]!;
        const ref: EntityRef = { kind: 'instance', path: context, id: instId };
        if (filter.ignored(ref)) continue;
        let acc = accs.get(instId);
        if (!acc) accs.set(instId, (acc = new Acc()));
        for (const b of this.index.bodiesAt(entry.path)) addBody(acc, b);
        const esk = this.index.sketch(entry.path);
        if (esk) {
          for (const v of esk.vertices) acc.point(v.p);
          for (const s of esk.segments) acc.segment(s.a, s.b);
          for (const f of esk.faces) if (f.visible && f.loops[0]) acc.ring(f.loops[0]);
        }
        for (const image of images) if (samePath(image.ref.path, entry.path)) addImage(acc, image.corners);
      }
      for (const [id, acc] of accs) if (acc.keep()) out.push({ kind: 'instance', path: context, id });
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------

  /**
   * Nearest body face or sketch face along the ray, strictly closer than `maxT` (default: any
   * distance). Sketch faces go through the sketch and face bounds trees, so only faces whose
   * bounds the ray crosses before the current best are tested against their plane and polygon.
   */
  private pickSurface(ray: Ray, filter: RefFilter, maxT = Infinity): SurfaceCandidate | null {
    let best: SurfaceCandidate | null = null;
    if (filter.wants('face')) {
      for (const b of this.index.bodies()) {
        const hit = raycastTriBVH(b.triBVH, b.mesh, ray, best ? best.t : maxT);
        if (!hit) continue;
        const faceId = b.mesh.faceId[hit.tri] as FaceLocalId | undefined;
        if (faceId === undefined) continue;
        const face = b.faces.get(faceId);
        if (!face) continue;
        const ref0: EntityRef = { kind: 'face', path: b.path, id: b.id, faceId, region: null };
        const cut = this.isClipped(b.path, hit.point);
        if (filter.ignored(ref0) || !face.visible || cut) {
          // the ignored or cut-away face does not occlude either: keep looking behind it along this ray, past the cuts
          const kept = cut ? this.keptRange(ray, b.path) : null;
          if (kept && kept[0] > kept[1]) continue;
          const behind = this.pickSurfaceBehind(ray, b, kept ? Math.max(hit.t, kept[0]) : hit.t, filter);
          if (behind && behind.t < (best ? best.t : maxT)) best = behind;
          continue;
        }
        best = {
          ref: { ...ref0, region: this.regionOf(b, faceId, hit.point) },
          point: hit.point,
          t: hit.t,
          normal: face.plane.n,
          plane: face.plane,
          bodyId: b.id,
          faceId,
        };
      }
    }
    if (filter.wants('meshPart')) {
      for (const part of this.index.meshParts()) {
        const hit = raycastTriBVH(part.triBVH, part.mesh, ray, best ? best.t : maxT);
        if (!hit) continue;
        const ref: EntityRef = { kind: 'meshPart', path: part.path, id: part.id };
        // An ignored or cut-away part does not occlude: the ray continues past it.
        if (filter.ignored(ref) || this.isClipped(part.path, hit.point)) continue;
        // The plane of the triangle under the pointer, facing the ray (MOD3830).
        const m = part.mesh, t = hit.tri * 3, a = m.tris[t]! * 3, b = m.tris[t + 1]! * 3, c = m.tris[t + 2]! * 3;
        const pa: Vec3 = [m.verts[a]!, m.verts[a + 1]!, m.verts[a + 2]!];
        const cross = v3cross(v3sub([m.verts[b]!, m.verts[b + 1]!, m.verts[b + 2]!], pa), v3sub([m.verts[c]!, m.verts[c + 1]!, m.verts[c + 2]!], pa));
        if (v3len(cross) <= LENGTH_TOL) continue;
        let normal = v3normalize(cross);
        if (v3dot(normal, ray.dir) > 0) normal = v3scale(normal, -1);
        best = { ref, point: hit.point, t: hit.t, normal, plane: planeFromPointNormal(hit.point, normal), bodyId: null, faceId: null };
      }
    }
    if (filter.wants('sketchFace')) {
      const tree = this.index.sketchFaces();
      // the nearest sheet face found so far (assigned from inside the traversal callbacks)
      const found: { face: SurfaceCandidate | null } = { face: null };
      const hit = raycastBVH(
        tree.bvh,
        ray,
        (si, limit) => {
          const sk = tree.sketches[si]!;
          const inner = raycastBVH(
            sk.faceBVH,
            ray,
            (fi, lim) => {
              const f = sk.faces[fi]!;
              if (!f.visible || filter.ignored(f.ref)) return null;
              const t = rayPlane(ray, f.plane);
              if (t === null || t >= lim) return null;
              const p = rayAt(ray, t);
              if (this.isClipped(f.ref.path, p)) return null;
              const local = f.inverse ? m4transformPoint(f.inverse, p) : p;
              const l = basisToLocal(f.face.basis, local);
              if (!pointInPolygon([l[0], l[1]], f.polygonUv)) return null;
              found.face = { ref: f.ref, point: p, t, normal: f.plane.n, plane: f.plane, bodyId: null, faceId: null };
              return t;
            },
            limit,
          );
          return inner ? inner.t : null;
        },
        best ? best.t : maxT,
      );
      if (hit && found.face) best = found.face;
    }
    // Placed pictures are surfaces too: picked, and hiding what is behind them.
    if (filter.wants('image')) {
      for (const image of this.index.images()) {
        if (filter.ignored(image.ref)) continue;
        const t = rayPlane(ray, image.plane);
        if (t === null || t < 0 || t >= (best ? best.t : maxT)) continue;
        const p = rayAt(ray, t);
        if (!insideParallelogram(p, image.corners) || this.isClipped(image.ref.path, p)) continue;
        best = { ref: image.ref, point: p, t, normal: image.plane.n, plane: image.plane, bodyId: null, faceId: null };
      }
    }
    return best;
  }

  /** Imprint region under a world point of a face (regions live in the face's local basis). */
  private regionOf(b: BodyIndex, faceId: FaceLocalId, worldPoint: Vec3): number | null {
    const imprint = b.body.imprints.get(faceId);
    const face = b.body.faces.get(faceId);
    if (!imprint || imprint.edges.size === 0 || !face) return null;
    const local = b.inverse ? m4transformPoint(b.inverse, worldPoint) : worldPoint;
    const l = basisToLocal(face.basis, local);
    const idx = regionAt(this.regions.get(b.body, faceId), [l[0], l[1]]);
    return idx >= 0 ? idx : null;
  }

  /** Re-cast past an ignored face of a body (bounded number of steps). */
  private pickSurfaceBehind(ray: Ray, b: BodyIndex, fromT: number, filter: RefFilter): SurfaceCandidate | null {
    let t0 = fromT;
    for (let step = 0; step < 8; step++) {
      const origin = rayAt(ray, t0 + 1e-9);
      const hit = raycastTriBVH(b.triBVH, b.mesh, { origin, dir: ray.dir });
      if (!hit) return null;
      const t = t0 + 1e-9 + hit.t;
      const faceId = b.mesh.faceId[hit.tri] as FaceLocalId | undefined;
      const face = faceId !== undefined ? b.faces.get(faceId) : undefined;
      if (faceId !== undefined && face) {
        const ref0: EntityRef = { kind: 'face', path: b.path, id: b.id, faceId, region: null };
        if (!filter.ignored(ref0) && face.visible && !this.isClipped(b.path, rayAt(ray, t))) {
          const point = rayAt(ray, t);
          const ref: EntityRef = { ...ref0, region: this.regionOf(b, faceId, point) };
          return { ref, point, t, normal: face.plane.n, plane: face.plane, bodyId: b.id, faceId };
        }
      }
      t0 = t;
    }
    return null;
  }

  /** Whether an active cut that applies to entities at `path` removes `p`. */
  private isClipped(path: readonly Id[], p: Vec3): boolean {
    for (const c of this.index.cuts()) {
      if (!pathWithin(path, c.path)) continue;
      if (c.normal[0] * p[0] + c.normal[1] * p[1] + c.normal[2] * p[2] + c.d < -CUT_TOL) return true;
    }
    return false;
  }

  /** The ray parameters `[from, to]` within which every cut applying to `path` keeps the ray's points; empty when from > to. */
  private keptRange(ray: Ray, path: readonly Id[]): [number, number] {
    let from = 0, to = Infinity;
    for (const c of this.index.cuts()) {
      if (!pathWithin(path, c.path)) continue;
      const s0 = c.normal[0] * ray.origin[0] + c.normal[1] * ray.origin[1] + c.normal[2] * ray.origin[2] + c.d;
      const sd = c.normal[0] * ray.dir[0] + c.normal[1] * ray.dir[1] + c.normal[2] * ray.dir[2];
      if (Math.abs(sd) < 1e-12) {
        if (s0 < -CUT_TOL) return [1, 0];
        continue;
      }
      const t = -s0 / sd;
      if (sd > 0) from = Math.max(from, t);
      else to = Math.min(to, t);
    }
    return [from, to];
  }

  /**
   * True when point `p` (ray parameter `t` of its closest approach) is hidden behind a surface.
   * Fast path: anything not deeper than the surface under the cursor is visible. Otherwise a
   * parallel ray through `p` is cast and `p` is occluded when a surface lies clearly in front of it.
   */
  private occluded(
    ray: Ray,
    p: Vec3,
    t: number,
    surface: SurfaceCandidate | null,
    filter: RefFilter,
    pixelSizeAt: (t: number) => number,
  ): boolean {
    if (!surface) return false;
    const slack = OCCLUSION_PX * pixelSizeAt(surface.t);
    if (t <= surface.t + slack) return false;
    const q = rayAt(ray, t);
    const shifted: Ray = { origin: v3addScaled(ray.origin, v3sub(p, q), 1), dir: ray.dir };
    // only a surface clearly in front of `p` matters, so the query stops at that depth
    return this.pickSurface(shifted, filter, t - slack) !== null;
  }
}

/** Whether `p`, in the plane of the parallelogram `c` (corners from its origin), lies inside it. */
export function insideParallelogram(p: Vec3, c: readonly [Vec3, Vec3, Vec3, Vec3]): boolean {
  const e1 = v3sub(c[1], c[0]), e2 = v3sub(c[3], c[0]), d = v3sub(p, c[0]);
  // Solve d = s e1 + t e2 in the plane (Gram matrix of the two sides).
  const a = v3dot(e1, e1), b = v3dot(e1, e2), cc = v3dot(e2, e2), r1 = v3dot(d, e1), r2 = v3dot(d, e2);
  const det = a * cc - b * b;
  if (det <= 0) return false;
  const s = (r1 * cc - r2 * b) / det, t = (r2 * a - r1 * b) / det;
  return s >= 0 && s <= 1 && t >= 0 && t <= 1;
}

// ---------------------------------------------------------------------------------------------
// Precedence

/** Vertex within tolerance > edge > surface. Body corners are reported through an incident edge. */
export function choosePick(c: PickCandidates): PickHit | null {
  // A click on a text's label picks the text, over whatever is drawn beneath it.
  const label = c.texts?.[0];
  if (label && label.screenDist === 0) return { ref: label.ref, point: label.point, t: label.t, screenDist: 0 };
  const v = c.vertices[0];
  if (v) return { ref: v.ref, point: v.point, t: v.t, screenDist: v.screenDist };
  const e = c.edges[0];
  if (e) return { ref: e.ref, point: e.point, t: e.t, screenDist: e.screenDist };
  // A dimension drawn over a face is picked before the face.
  const d = c.dimensions?.[0];
  if (d) return { ref: d.ref, point: d.point, t: d.t, screenDist: d.screenDist };
  // So is a text's leader line.
  if (label) return { ref: label.ref, point: label.point, t: label.t, screenDist: label.screenDist };
  // So is a section plane's outline.
  const sp = c.sectionPlanes?.[0];
  if (sp) return { ref: sp.ref, point: sp.point, t: sp.t, screenDist: sp.screenDist };
  const s = c.surface;
  if (s) return { ref: s.ref, point: s.point, t: s.t, normal: s.normal, screenDist: 0 };
  return null;
}

function byScreenThenDepth(a: { screenDist: number; t: number }, b: { screenDist: number; t: number }): number {
  const d = a.screenDist - b.screenDist;
  return Math.abs(d) > 1 ? d : a.t - b.t || d;
}

// ---------------------------------------------------------------------------------------------
// Filters

const BODY_KINDS: readonly EntityRef['kind'][] = ['face', 'edge', 'imprintEdge'];

export function samePath(a: readonly Id[], b: readonly Id[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Resolves `kinds` / `ignore` options into predicates. */
export class RefFilter {
  private readonly kinds: ReadonlySet<EntityRef['kind']> | null;
  private readonly ignore: readonly EntityRef[];

  constructor(opts: PickOptions) {
    this.kinds = opts.kinds ? new Set(opts.kinds) : null;
    this.ignore = opts.ignore ?? [];
  }

  wants(kind: EntityRef['kind']): boolean {
    if (!this.kinds) return true;
    if (this.kinds.has(kind)) return true;
    // A mesh part is a surface to a tool that picks faces, and a whole object to one that picks bodies (MOD3830).
    if (kind === 'meshPart') return this.kinds.has('face') || this.kinds.has('body');
    // `body` implies its faces and edges, and vice versa for box selection
    if (kind === 'body') return BODY_KINDS.some((k) => this.kinds!.has(k));
    return BODY_KINDS.includes(kind) && this.kinds.has('body');
  }

  ignored(ref: EntityRef): boolean {
    for (const ig of this.ignore) {
      if (ig.kind === 'instance') {
        // everything inside the ignored instance (and the instance itself) is ignored
        if (ref.kind === 'instance' && ref.id === ig.id && samePath(ig.path, ref.path)) return true;
        if (ref.kind !== 'instance' && ref.path.length > ig.path.length && ref.path[ig.path.length] === ig.id && pathWithin(ref.path, ig.path)) return true;
        continue;
      }
      if (ig.id !== ref.id || !samePath(ig.path, ref.path)) continue;
      if (ig.kind === ref.kind) {
        if (ref.kind === 'face' && ig.kind === 'face' && ig.faceId !== ref.faceId) continue;
        if (ref.kind === 'edge' && ig.kind === 'edge' && ig.edgeKey !== ref.edgeKey) continue;
        return true;
      }
      if (ig.kind === 'body' && BODY_KINDS.includes(ref.kind)) return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Guides

function guideClosest(ray: Ray, g: Guide): { point: Vec3; t: number; dist: number; dir: Vec3 | null } | null {
  switch (g.kind) {
    case 'point': {
      const t = Math.max(0, v3dot(v3sub(g.origin, ray.origin), ray.dir));
      const q = rayAt(ray, t);
      return { point: g.origin, t, dist: Math.hypot(q[0] - g.origin[0], q[1] - g.origin[1], q[2] - g.origin[2]), dir: null };
    }
    case 'line': {
      const dir = v3normalize(g.dir);
      const c = lineLineClosest3D(ray.origin, ray.dir, g.origin, dir);
      if (c.parallel || c.t < 0) return null;
      return { point: c.q, t: c.t, dist: Math.sqrt(c.distSq), dir };
    }
    case 'segment': {
      const c = raySegmentClosest(ray, g.origin, g.end);
      const point = v3addScaled(g.origin, v3sub(g.end, g.origin), c.s);
      return { point, t: c.t, dist: Math.sqrt(c.distSq), dir: v3normalize(v3sub(g.end, g.origin)) };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 2D selection regions

/** A screen area to select in (CSS px): the Select tool's box or the Lasso tool's outline. */
interface ScreenRegion {
  /** Convex regions skip `crossesBoundary`: a segment with both ends inside stays inside. */
  readonly convex: boolean;
  /** Points of the region; one inside a face's outline means the region touches the face. */
  readonly probes: readonly Vec2[];
  contains(p: Vec2): boolean;
  /** The segment lies at least partly inside. */
  touches(a: Vec2, b: Vec2): boolean;
  /** The segment lies entirely inside. */
  encloses(a: Vec2, b: Vec2): boolean;
  crossesBoundary(a: Vec2, b: Vec2): boolean;
}

function rectRegion(r: PickRect): ScreenRegion {
  const contains = (p: Vec2): boolean => pointInRect(p, r);
  return {
    convex: true,
    probes: [r.min, [r.max[0], r.min[1]], r.max, [r.min[0], r.max[1]]],
    contains,
    touches: (a, b) => segIntersectsRect(a, b, r),
    encloses: (a, b) => contains(a) && contains(b),
    crossesBoundary: () => false,
  };
}

function outlineRegion(outline: readonly Vec2[]): ScreenRegion {
  const ring = outline.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
  const bounds: PickRect = { min: [Math.min(...xs), Math.min(...ys)], max: [Math.max(...xs), Math.max(...ys)] };
  const contains = (p: Vec2): boolean => pointInRect(p, bounds) && pointInRing(p, ring);
  const crossesBoundary = (a: Vec2, b: Vec2): boolean => {
    if (!segIntersectsRect(a, b, bounds)) return false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) if (segmentsCross(a, b, ring[j]!, ring[i]!)) return true;
    return false;
  };
  return {
    convex: false,
    probes: ring,
    contains,
    touches: (a, b) => contains(a) || contains(b) || crossesBoundary(a, b),
    encloses: (a, b) => contains(a) && contains(b) && !crossesBoundary(a, b),
    crossesBoundary,
  };
}

/** Segments a–b and c–d share a point (touching counts). */
function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const side = (p: Vec2, q: Vec2, r: Vec2): number => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const within = (p: Vec2, q: Vec2, r: Vec2): boolean =>
    Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) && Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
  const d1 = side(c, d, a), d2 = side(c, d, b), d3 = side(a, b, c), d4 = side(a, b, d);
  if (d1 !== d2 && d3 !== d4 && d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0) return true;
  return (d1 === 0 && within(c, d, a)) || (d2 === 0 && within(c, d, b)) || (d3 === 0 && within(a, b, c)) || (d4 === 0 && within(a, b, d));
}

// ---------------------------------------------------------------------------------------------
// 2D rect helpers

function normalizeRect(r: PickRect): PickRect {
  return {
    min: [Math.min(r.min[0], r.max[0]), Math.min(r.min[1], r.max[1])],
    max: [Math.max(r.min[0], r.max[0]), Math.max(r.min[1], r.max[1])],
  };
}

function pointInRect(p: Vec2, r: PickRect): boolean {
  return Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[0] >= r.min[0] && p[0] <= r.max[0] && p[1] >= r.min[1] && p[1] <= r.max[1];
}

/** Liang–Barsky segment/rect overlap test. */
export function segIntersectsRect(a: Vec2, b: Vec2, r: PickRect): boolean {
  if (![a[0], a[1], b[0], b[1]].every(Number.isFinite)) return false;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  let t0 = 0, t1 = 1;
  const checks: [number, number][] = [
    [-dx, a[0] - r.min[0]],
    [dx, r.max[0] - a[0]],
    [-dy, a[1] - r.min[1]],
    [dy, r.max[1] - a[1]],
  ];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
  }
  return t0 <= t1;
}
