// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { CurveId, FaceLocalId, Id, MMat4, MeshData, Plane, TagId, Vec3 } from '@pushform/core';
import { LENGTH_TOL, MERGE_TOL, m4invert, m4transformDir, m4transformPoint, planeFromPointNormal, v3dist, v3normalize } from '@pushform/core';
import { buildBoxBVH, buildSegBVH, buildSegBVHSteps, buildTriBVH, SpatialHash, type BVH, type PolygonsWithHoles, type Segment3 } from '@pushform/geom';
import {
  imageEntityCorners,
  contentWorldBounds,
  dimensionDrawing,
  imprintEdgesWorld,
  sectionPlaneCorners,
  worldSectionPlane,
  resolveDimension,
  pathKey,
  sketchFacePolygonUv,
  tagVisible,
  walkInstances,
  type Body,
  type ComponentDefinition,
  type Curve,
  type DocumentState,
  type EdgeKey,
  type EdgeRecord,
  type EntityContainer,
  type EntityRef,
  type FaceRecord,
  type Guide,
  type TextEntity,
  type Sketch,
  type SketchFace,
} from '@pushform/model';

/** A pickable straight segment in WORLD space: one piece of a body edge polyline or one sketch edge. */
export interface IndexedSegment extends Segment3 {
  readonly ref: EntityRef;
}

/** A pickable point (world space): a sketch vertex or a body loop corner (reported through an incident edge). */
export interface IndexedVertex {
  readonly p: Vec3;
  /** `sketchVertex` for sketch vertices, `edge` (an incident edge) for body corners. */
  readonly ref: EntityRef;
  /** Body corners: every incident edge key (used for occlusion tests against the hit face). */
  readonly edgeKeys: readonly EdgeKey[];
}

/** Center of a circle/arc/polygon curve (body or sketch), world space. */
export interface IndexedCenter {
  readonly p: Vec3;
  readonly curveId: CurveId;
  /** The curve with world-space center and normal. */
  readonly curve: Curve;
  /** First edge of the curve (an `edge` or `sketchEdge` ref), used as the snap's entity reference. */
  readonly ref: EntityRef | null;
}

/** A guide transformed to world space with its ref. */
export interface IndexedGuide {
  readonly guide: Guide;
  readonly ref: EntityRef;
}

/** A section plane's outline in world space, for picking. */
export interface IndexedSectionPlane {
  readonly segments: readonly (readonly [Vec3, Vec3])[];
  readonly ref: EntityRef;
}

/** A placed picture in world space: its corners counter-clockwise from its origin corner, and its plane. */
export interface IndexedImage {
  readonly ref: EntityRef;
  readonly corners: readonly [Vec3, Vec3, Vec3, Vec3];
  readonly plane: Plane;
}

/** An active cut: it removes the points `p` of entities inside `path` with `dot(normal, p) + d < 0`. */
export interface IndexedCut {
  readonly path: readonly Id[];
  readonly normal: Vec3;
  readonly d: number;
}

/** A drawn dimension's lines in world space, for picking. */
export interface IndexedDimension {
  readonly segments: ReadonlyArray<readonly [Vec3, Vec3]>;
  readonly ref: EntityRef;
}

/** A drawn text, for picking: its anchor and label offset in world space, or its screen position. */
export interface IndexedText {
  readonly ref: EntityRef;
  readonly kind: 'leader' | 'screen';
  /** Leader text: the world anchor. Screen text: [x, y, 0] as fractions of the view from its top-left corner. */
  readonly position: Vec3;
  /** A pushpin label offset, world. */
  readonly offset: Vec3 | null;
  /** A view-based label offset along the view's right and up directions. */
  readonly viewOffset: readonly [number, number] | null;
  /** Whether a leader line is drawn. */
  readonly leaderShown: boolean;
  readonly text: string;
  readonly fontSizePt: number;
}

/** A body face as seen in world space. */
export interface WorldFace {
  readonly id: FaceLocalId;
  readonly record: FaceRecord;
  readonly plane: Plane;
  /** Outer loop first, then holes (world positions). */
  readonly loops: readonly (readonly Vec3[])[];
  /** False when the face or its tag is hidden (neither pickable nor occluding). */
  readonly visible: boolean;
}

/** A body edge as seen in world space. */
export interface WorldEdge {
  readonly key: EdgeKey;
  readonly record: EdgeRecord;
  readonly polyline: readonly Vec3[];
}

export interface BodyIndex {
  readonly id: Id;
  readonly version: number;
  /** Instance path of the container owning the body (empty = root). */
  readonly path: readonly Id[];
  /** The body record (LOCAL coordinates of its container). */
  readonly body: Body;
  /** local→world of the container, null at the root (identity). */
  readonly matrix: MMat4 | null;
  /** world→local, null at the root. */
  readonly inverse: MMat4 | null;
  /** Mesh in world space (the body's own mesh at the root). */
  readonly mesh: MeshData;
  readonly faces: ReadonlyMap<FaceLocalId, WorldFace>;
  readonly edges: ReadonlyMap<EdgeKey, WorldEdge>;
  /** Curves with world-space center / normal. */
  readonly curves: ReadonlyMap<CurveId, Curve>;
  readonly triBVH: BVH;
  readonly segments: readonly IndexedSegment[];
  readonly segBVH: BVH;
  readonly corners: readonly IndexedVertex[];
}

export interface SketchFaceIndex {
  readonly face: SketchFace;
  readonly ref: EntityRef;
  /** Face polygon in its own (LOCAL) basis (outer first, then holes). */
  readonly polygonUv: PolygonsWithHoles;
  /** 3D loop points in world space (outer first, then holes). */
  readonly loops: readonly (readonly Vec3[])[];
  /** World-space plane. */
  readonly plane: Plane;
  /** world→local of the owning container, null at the root. */
  readonly inverse: MMat4 | null;
  readonly visible: boolean;
}

export interface SketchIndex {
  readonly sketch: Sketch;
  readonly path: readonly Id[];
  readonly segments: readonly IndexedSegment[];
  readonly segBVH: BVH;
  readonly vertices: readonly IndexedVertex[];
  readonly faces: readonly SketchFaceIndex[];
  /** World-space bounds tree over `faces` (primitive i = `faces[i]`), the ray broad phase for surface picking. */
  readonly faceBVH: BVH;
}

/** Broad phase over every indexed sketch holding faces: primitive i of `bvh` is `sketches[i]`. */
export interface SketchFaceTree {
  readonly sketches: readonly SketchIndex[];
  readonly bvh: BVH;
}

/** Degenerate-segment BVH over points so that ray cone queries work for vertices and centers. */
export interface PointIndex<T extends { readonly p: Vec3 }> {
  readonly items: readonly T[];
  readonly segments: readonly Segment3[];
  readonly bvh: BVH;
}

function pointIndex<T extends { readonly p: Vec3 }>(items: readonly T[]): PointIndex<T> {
  const segments: Segment3[] = items.map((it) => ({ a: it.p, b: it.p }));
  return { items, segments, bvh: buildSegBVH(segments, { maxLeaf: 8 }) };
}

/** `pointIndex` that yields between large subtrees of its tree. */
function* pointIndexSteps<T extends { readonly p: Vec3 }>(items: readonly T[]): Generator<void, PointIndex<T>, void> {
  const segments: Segment3[] = items.map((it) => ({ a: it.p, b: it.p }));
  yield;
  return { items, segments, bvh: yield* buildSegBVHSteps(segments, { maxLeaf: 8 }) };
}

/** One indexed entity container: the root or the definition behind a visible instance path. */
export interface ContainerEntry {
  readonly key: string;
  readonly path: readonly Id[];
  readonly container: EntityContainer;
  readonly definition: ComponentDefinition;
  /** local→world of the container's entities; null at the root (identity). */
  readonly matrix: MMat4 | null;
  /** world→local; null at the root. */
  readonly inverse: MMat4 | null;
  /** True when any instance on `path` is locked. */
  readonly locked: boolean;
  /** Whether the instance at the end of `path` is a group (false at the root and for components). */
  readonly isGroup: boolean;
}

interface ContainerState {
  entry: ContainerEntry;
  matrixKey: string;
  bodyIndices: Map<Id, BodyIndex>;
  bodyKeyed: Map<Id, Body>;
  sketchIndex: SketchIndex | null;
  sketchKeyed: Sketch | null;
  guides: IndexedGuide[];
  guidesKeyed: ReadonlyMap<Id, Guide> | null;
  dimensions: IndexedDimension[];
  /** Dimensions follow their attachments in the container, so they are keyed on the whole container. */
  dimensionsKeyed: EntityContainer | null;
  texts: IndexedText[];
  textsKeyed: ReadonlyMap<Id, TextEntity> | null;
}

/** Walk the instance path from the root definition to the definition it opens. */
export function definitionAtPath(state: DocumentState, path: readonly Id[]): ComponentDefinition | null {
  let def = state.definitions.get(state.rootDefinitionId) ?? null;
  for (const instanceId of path) {
    if (!def) return null;
    const inst = def.entities.instances.get(instanceId);
    def = inst ? (state.definitions.get(inst.definitionId) ?? null) : null;
  }
  return def;
}

// Entities on a hidden tag, or a tag inside a hidden tag folder, are neither drawn nor pickable: the same rule as drawing.
export { tagVisible };

/**
 * Whole-model spatial index: the root container and every instance reachable through
 * `walkInstances`, with all geometry transformed to WORLD space and every ref tagged with the
 * instance path of its container. Hidden instances (flag or tag) are skipped with their
 * subtrees; hidden / tag-hidden bodies, edges, sketch entities and guides are not indexed.
 *
 * Built lazily on first access and refreshed incrementally: a container is kept when its visit
 * matrix is unchanged; inside it a body is rebuilt only when its geometry (`version`, mesh,
 * edges, imprints) or visibility changes, the sketch when the sketch object identity changes
 * (immer structural sharing keeps untouched objects identical). A definition used by several
 * instances is indexed once per instance (the transforms differ).
 */
export class SpatialIndex {
  private state: DocumentState | null = null;
  private dirty = true;
  private tagsKeyed: ReadonlyMap<TagId, unknown> | null = null;
  /** Hidden Geometry setting the indexed bodies and sketches were built with. */
  private hiddenKeyed: boolean | null = null;

  private containers = new Map<string, ContainerState>();
  private bodyList: readonly BodyIndex[] = [];
  private sketchList: readonly SketchIndex[] = [];
  private guideList: readonly IndexedGuide[] = [];
  private dimensionList: readonly IndexedDimension[] = [];
  private textList: readonly IndexedText[] = [];
  private vertexIndex: PointIndex<IndexedVertex> | null = null;
  private centerIndex: PointIndex<IndexedCenter> | null = null;
  private sketchFaceTree: SketchFaceTree | null = null;
  /** Bumped whenever a rebuild changed anything (memo key for derived caches). */
  private gen = 0;

  /**
   * @param path Home context of the index (kept for callers that index one context; the index
   * always covers the whole model and `path` only affects `entities()`'s default).
   */
  constructor(readonly path: readonly Id[] = []) {}

  /** The rebuild in progress, advanced a slice at a time by `ensureFor` (PF-189). */
  private job: Generator<void, void, void> | null = null;
  /** While finite, rebuilding stops at this `performance.now()` time and queries see an empty index. */
  private deadline = Infinity;
  /** A rebuild changed indexed geometry that the flat lists do not show yet. */
  private unpublished = false;

  /** Point the index at a new document state; the rebuild happens on the next query. */
  setState(state: DocumentState): void {
    if (state === this.state) return;
    this.state = state;
    this.dirty = true;
    // A rebuild of an earlier state restarts; what it finished is kept and reused container by container.
    this.job = null;
  }

  /** True while the index lags its document state. */
  get building(): boolean {
    return this.dirty || this.job !== null;
  }

  /**
   * Advance the rebuild for about `budgetMs` (at least one step) and say whether it is complete. The app calls this
   * in idle time so that opening a large model never builds the whole index in one task.
   */
  ensureFor(budgetMs: number): boolean {
    const previous = this.deadline;
    this.deadline = Math.min(previous, performance.now() + budgetMs);
    try {
      return this.ensure();
    } finally {
      this.deadline = previous;
    }
  }

  /**
   * Run `query` giving the rebuild at most `budgetMs`; if it is still incomplete, the queries inside see an empty
   * index rather than waiting for it (hover while a large model is still being indexed).
   */
  within<T>(budgetMs: number, query: () => T): T {
    const previous = this.deadline;
    this.deadline = Math.min(previous, performance.now() + budgetMs);
    try {
      return query();
    } finally {
      this.deadline = previous;
    }
  }

  get hasState(): boolean {
    return this.state !== null;
  }

  /** The state currently indexed (null before `setState`). */
  get documentState(): DocumentState | null {
    return this.state;
  }

  /** Monotonic counter bumped whenever the index content changed; -1 while an incomplete index reads as empty. */
  get generation(): number {
    return this.ensure() ? this.gen : -1;
  }

  /**
   * Rebuild whatever changed, and say whether the index is complete. Cheap when nothing did. Outside `ensureFor` and
   * `within` it always completes; inside them it stops at their deadline.
   */
  ensure(): boolean {
    if (this.dirty) {
      this.dirty = false;
      this.job = this.rebuild();
    }
    const job = this.job;
    if (!job) return true;
    do {
      if (job.next().done) {
        this.job = null;
        return true;
      }
    } while (performance.now() < this.deadline);
    return false;
  }

  /** The rebuild, one step per changed body, sketch or container, so that it can stop between steps. */
  private *rebuild(): Generator<void, void, void> {
    const state = this.state;
    if (!state) {
      this.containers.clear();
      yield* this.publish(true);
      return;
    }
    // Soft and hidden edges are indexed only while Hidden Geometry shows them, so toggling it rebuilds as a tag change does.
    const tagsChanged = state.tags !== this.tagsKeyed || showHiddenGeometry(state) !== this.hiddenKeyed;
    // Keyed only once the rebuild completes, so that a restarted rebuild still sees the tag change. Changes are
    // recorded on the index for the same reason: a rebuild that restarts must still publish what the first one did.
    if (tagsChanged) this.unpublished = true;
    const seen = new Set<string>();

    const root = state.definitions.get(state.rootDefinitionId);
    if (root) {
      seen.add('');
      if (yield* this.syncContainer(state, { path: [], definition: root, matrix: null, locked: false, isGroup: false }, tagsChanged)) this.unpublished = true;
      const hidden = new Set<string>();
      for (const v of walkInstances(state)) {
        const parentKey = pathKey(v.path.slice(0, -1));
        const key = pathKey(v.path);
        if (hidden.has(parentKey) || v.instance.hidden || !tagVisible(state, v.instance.tagId)) {
          hidden.add(key);
          continue;
        }
        seen.add(key);
        const parent = this.containers.get(parentKey);
        const locked = (parent?.entry.locked ?? false) || v.instance.locked;
        if (yield* this.syncContainer(state, { path: v.path, definition: v.definition, matrix: v.matrix, locked, isGroup: v.definition.isGroup }, tagsChanged))
          this.unpublished = true;
        yield;
      }
    }
    for (const key of [...this.containers.keys()]) {
      if (!seen.has(key)) {
        this.containers.delete(key);
        this.unpublished = true;
      }
    }
    this.tagsKeyed = state.tags;
    this.hiddenKeyed = showHiddenGeometry(state);
    yield* this.publish(this.unpublished);
    this.unpublished = false;
  }

  /** Sync one container, yielding after each rebuilt body; returns true when any indexed geometry of it changed. */
  private *syncContainer(
    state: DocumentState,
    visit: { path: readonly Id[]; definition: ComponentDefinition; matrix: MMat4 | null; locked: boolean; isGroup: boolean },
    forceAll: boolean,
  ): Generator<void, boolean, void> {
    const key = pathKey(visit.path);
    const matrixKey = visit.matrix ? visit.matrix.join(',') : '';
    const container = visit.definition.entities;
    let cs = this.containers.get(key);
    let changed = false;
    if (!cs || cs.matrixKey !== matrixKey || forceAll) {
      const inverse = visit.matrix ? m4invert(visit.matrix) : null;
      cs = {
        entry: { key, path: visit.path, container, definition: visit.definition, matrix: visit.matrix, inverse, locked: visit.locked, isGroup: visit.isGroup },
        matrixKey,
        bodyIndices: new Map(),
        bodyKeyed: new Map(),
        sketchIndex: null,
        sketchKeyed: null,
        guides: [],
        guidesKeyed: null,
        dimensions: [],
        dimensionsKeyed: null,
        texts: [],
        textsKeyed: null,
      };
      this.containers.set(key, cs);
      changed = true;
    } else if (cs.entry.container !== container || cs.entry.locked !== visit.locked || cs.entry.definition !== visit.definition) {
      cs.entry = { ...cs.entry, container, definition: visit.definition, locked: visit.locked, isGroup: visit.isGroup };
    }
    const { matrix, inverse } = cs.entry;
    const path = cs.entry.path;

    // bodies: rebuild changed, drop removed / hidden
    for (const id of [...cs.bodyIndices.keys()]) {
      const body = container.bodies.get(id);
      if (!body || !bodyVisible(state, body)) {
        cs.bodyIndices.delete(id);
        cs.bodyKeyed.delete(id);
        changed = true;
      }
    }
    for (const [id, body] of container.bodies) {
      if (!bodyVisible(state, body)) continue;
      const prev = cs.bodyKeyed.get(id);
      if (prev === body) continue;
      const prevIdx = cs.bodyIndices.get(id);
      if (
        prevIdx &&
        prev &&
        prev.version === body.version &&
        prev.mesh === body.mesh &&
        prev.edges === body.edges &&
        prev.imprints === body.imprints &&
        prev.faces === body.faces &&
        prev.curves === body.curves
      ) {
        // only non-geometric attributes changed: keep the BVHs, refresh the body reference
        cs.bodyIndices.set(id, { ...prevIdx, body });
      } else {
        cs.bodyIndices.set(id, buildBodyIndex(state, body, path, matrix, inverse));
        cs.bodyKeyed.set(id, body);
        changed = true;
        yield;
        continue;
      }
      cs.bodyKeyed.set(id, body);
    }
    // sketch
    if (cs.sketchKeyed !== container.sketch) {
      cs.sketchIndex = yield* buildSketchIndex(state, container.sketch, path, matrix, inverse);
      cs.sketchKeyed = container.sketch;
      changed = true;
      yield;
    }
    // guides
    if (cs.guidesKeyed !== container.guides) {
      cs.guides = [];
      for (const g of container.guides.values()) {
        if (g.hidden || !tagVisible(state, g.tagId)) continue;
        cs.guides.push({ guide: matrix ? transformGuide(matrix, g) : g, ref: { kind: 'guide', path, id: g.id } });
      }
      cs.guidesKeyed = container.guides;
      changed = true;
    }
    // dimensions
    if (cs.dimensionsKeyed !== container) {
      const nextDimensions: IndexedDimension[] = [];
      for (const d of container.dimensions.values()) {
        if (d.hidden || !tagVisible(state, d.tagId)) continue;
        const drawing = dimensionDrawing(d, resolveDimension(state, container, d));
        const w = (p: Vec3): Vec3 => (matrix ? m4transformPoint(matrix, p) : p);
        nextDimensions.push({ segments: drawing.lines.map(([a, b]) => [w(a), w(b)] as const), ref: { kind: 'dimension', path, id: d.id } });
      }
      changed = changed || nextDimensions.length > 0 || cs.dimensions.length > 0;
      cs.dimensions = nextDimensions;
      cs.dimensionsKeyed = container;
    }
    // texts
    if (cs.textsKeyed !== container.texts) {
      const nextTexts: IndexedText[] = [];
      for (const t of container.texts.values()) {
        if (t.hidden || !tagVisible(state, t.tagId) || !t.text) continue;
        const leader = t.kind === 'leader';
        nextTexts.push({
          ref: { kind: 'text', path, id: t.id },
          kind: t.kind,
          position: leader && matrix ? m4transformPoint(matrix, t.position) : t.position,
          offset: leader && t.offset && !t.viewOffset ? (matrix ? m4transformDir(matrix, t.offset) : t.offset) : null,
          viewOffset: leader && t.viewOffset ? t.viewOffset : null,
          leaderShown: leader && t.leader !== 'none',
          text: t.text,
          fontSizePt: t.fontSizePt,
        });
      }
      changed = changed || nextTexts.length > 0 || cs.texts.length > 0;
      cs.texts = nextTexts;
      cs.textsKeyed = container.texts;
    }
    return changed;
  }

  /** Recompute the flat lists and point BVHs after a change, yielding between the large builds. */
  private *publish(changed: boolean): Generator<void, void, void> {
    if (!changed && this.vertexIndex && this.centerIndex && this.sketchFaceTree) return;
    const bodies: BodyIndex[] = [];
    const sketches: SketchIndex[] = [];
    const withFaces: SketchIndex[] = [];
    const guides: IndexedGuide[] = [];
    const dimensions: IndexedDimension[] = [];
    const texts: IndexedText[] = [];
    const verts: IndexedVertex[] = [];
    const centers: IndexedCenter[] = [];
    // Loops rather than spreads: a sketch can hold more vertices than a call takes arguments.
    const append = <T>(into: T[], items: readonly T[]): void => { for (const item of items) into.push(item); };
    for (const cs of this.containers.values()) {
      const path = cs.entry.path;
      for (const b of cs.bodyIndices.values()) {
        bodies.push(b);
        append(verts, b.corners);
        for (const c of b.curves.values()) centers.push(centerEntry(c, b.id, path));
      }
      if (cs.sketchIndex) {
        sketches.push(cs.sketchIndex);
        if (cs.sketchIndex.faces.length) withFaces.push(cs.sketchIndex);
        append(verts, cs.sketchIndex.vertices);
        const m = cs.entry.matrix;
        for (const c of cs.entry.container.sketch.curves.values()) centers.push(centerEntry(m ? transformCurve(m, c) : c, null, path));
      }
      append(guides, cs.guides);
      append(dimensions, cs.dimensions);
      append(texts, cs.texts);
    }
    yield;
    const vertexIndex = yield* pointIndexSteps(verts);
    const centerIndex = yield* pointIndexSteps(centers);
    // one box per sketch (the root bounds of its face tree), so a ray skips whole containers
    const boxes = new Float64Array(withFaces.length * 6);
    withFaces.forEach((sk, i) => boxes.set(sk.faceBVH.bounds.subarray(0, 6), i * 6));
    // Published together, so that no query sees lists of one rebuild with trees of another.
    this.bodyList = bodies;
    this.sketchList = sketches;
    this.guideList = guides;
    this.dimensionList = dimensions;
    this.textList = texts;
    this.vertexIndex = vertexIndex;
    this.centerIndex = centerIndex;
    this.sketchFaceTree = { sketches: withFaces, bvh: buildBoxBVH(boxes, { maxLeaf: 4 }) };
    this.gen += 1;
  }

  // ------------------------------------------------------------------------------------------
  // Queries

  // Every query sees an empty index while a rebuild under `within` is incomplete, never a mix of two states.

  /** The entity container at `path` (default: the index's home path); null before `setState` or when hidden. */
  entities(path: readonly Id[] = this.path): EntityContainer | null {
    if (!this.ensure()) return null;
    return this.containers.get(pathKey(path))?.entry.container ?? null;
  }

  /** Indexed (visible) containers, root first. */
  containerEntries(): readonly ContainerEntry[] {
    if (!this.ensure()) return [];
    return [...this.containers.values()].map((c) => c.entry);
  }

  /** The indexed container at `path`, or undefined when it is hidden / does not exist. */
  container(path: readonly Id[]): ContainerEntry | undefined {
    if (!this.ensure()) return undefined;
    return this.containers.get(pathKey(path))?.entry;
  }

  /** All indexed bodies of the whole model (world space). */
  bodies(): readonly BodyIndex[] {
    if (!this.ensure()) return [];
    return this.bodyList;
  }

  /** Indexed bodies of one container. */
  bodiesAt(path: readonly Id[]): readonly BodyIndex[] {
    if (!this.ensure()) return [];
    const cs = this.containers.get(pathKey(path));
    return cs ? [...cs.bodyIndices.values()] : [];
  }

  body(id: Id, path: readonly Id[] = []): BodyIndex | undefined {
    if (!this.ensure()) return undefined;
    return this.containers.get(pathKey(path))?.bodyIndices.get(id);
  }

  /** The sketch index of one container (default root), null when the container is not indexed. */
  sketch(path: readonly Id[] = []): SketchIndex | null {
    if (!this.ensure()) return null;
    return this.containers.get(pathKey(path))?.sketchIndex ?? null;
  }

  /** Sketch indices of every indexed container. */
  sketches(): readonly SketchIndex[] {
    if (!this.ensure()) return [];
    return this.sketchList;
  }

  /** Every sketch with faces behind a bounds tree (world space), for ray queries against sheet faces. */
  sketchFaces(): SketchFaceTree {
    if (!this.ensure()) return EMPTY_SKETCH_FACES;
    return this.sketchFaceTree ?? EMPTY_SKETCH_FACES;
  }

  /** All sketch vertices and body loop corners of the model as a point BVH (world space). */
  vertices(): PointIndex<IndexedVertex> {
    if (!this.ensure()) return EMPTY_POINTS as PointIndex<IndexedVertex>;
    return this.vertexIndex ?? pointIndex([]);
  }

  /** Circle/arc/polygon centers from body and sketch curves (world space). */
  centers(): PointIndex<IndexedCenter> {
    if (!this.ensure()) return EMPTY_POINTS as PointIndex<IndexedCenter>;
    return this.centerIndex ?? pointIndex([]);
  }

  /** Visible guides of every indexed container, transformed to world space. */
  guides(): readonly IndexedGuide[] {
    if (!this.ensure()) return [];
    return this.guideList;
  }

  /** Visible texts of every indexed container. */
  texts(): readonly IndexedText[] {
    if (!this.ensure()) return [];
    return this.textList;
  }

  /** Visible dimensions of every indexed container, as world-space segments. */
  dimensions(): readonly IndexedDimension[] {
    if (!this.ensure()) return [];
    return this.dimensionList;
  }

  private sectionMemo: { state: DocumentState; cuts: IndexedCut[]; planes: IndexedSectionPlane[] } | null = null;

  /** Active cuts and drawn section planes of the indexed containers, under the active style. */
  private sectionData(): { cuts: readonly IndexedCut[]; planes: readonly IndexedSectionPlane[] } {
    if (!this.ensure()) return { cuts: [], planes: [] };
    const state = this.state;
    if (!state) return { cuts: [], planes: [] };
    if (this.sectionMemo?.state === state) return this.sectionMemo;
    const style = state.styles.get(state.activeStyleId)?.modeling;
    const cuts: IndexedCut[] = [], planes: IndexedSectionPlane[] = [];
    for (const cs of this.containers.values()) {
      const { container, path, matrix } = cs.entry;
      if (!container.sectionPlanes.size) continue;
      let bounds: ReturnType<typeof contentWorldBounds> | undefined;
      for (const sp of container.sectionPlanes.values()) {
        const { normal, d } = worldSectionPlane(sp.plane, matrix ?? IDENTITY);
        if (container.activeSectionPlaneId === sp.id && style?.sectionCutsVisible !== false) cuts.push({ path, normal, d });
        if (style?.sectionPlanesVisible === false || sp.hidden || !tagVisible(state, sp.tagId)) continue;
        bounds ??= contentWorldBounds(state, path);
        const c = sectionPlaneCorners(normal, d, bounds);
        planes.push({ segments: [[c[0], c[1]], [c[1], c[2]], [c[2], c[3]], [c[3], c[0]]], ref: { kind: 'sectionPlane', path, id: sp.id } });
      }
    }
    this.sectionMemo = { state, cuts, planes };
    return this.sectionMemo;
  }

  private imageMemo: { state: DocumentState; images: IndexedImage[] } | null = null;

  /** Visible placed pictures of the indexed containers, in world space. */
  images(): readonly IndexedImage[] {
    if (!this.ensure()) return [];
    const state = this.state;
    if (!state) return [];
    if (this.imageMemo?.state === state) return this.imageMemo.images;
    const images: IndexedImage[] = [];
    for (const cs of this.containers.values()) {
      const { container, path, matrix } = cs.entry;
      for (const image of container.images.values()) {
        if (image.hidden || !tagVisible(state, image.tagId)) continue;
        const c = imageEntityCorners(image).map(p => (matrix ? m4transformPoint(matrix, p) : p)) as [Vec3, Vec3, Vec3, Vec3];
        const e1 = [c[1][0] - c[0][0], c[1][1] - c[0][1], c[1][2] - c[0][2]] as const, e2 = [c[3][0] - c[0][0], c[3][1] - c[0][1], c[3][2] - c[0][2]] as const;
        const n: Vec3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        if (Math.hypot(n[0], n[1], n[2]) <= LENGTH_TOL * LENGTH_TOL) continue;
        images.push({ ref: { kind: 'image', path, id: image.id }, corners: c, plane: planeFromPointNormal(c[0], v3normalize(n)) });
      }
    }
    this.imageMemo = { state, images };
    return images;
  }

  /** Active cuts that remove geometry from view. */
  cuts(): readonly IndexedCut[] {
    return this.sectionData().cuts;
  }

  /** Outlines of the drawn section planes, for picking. */
  sectionPlanes(): readonly IndexedSectionPlane[] {
    return this.sectionData().planes;
  }
}

const IDENTITY: MMat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const EMPTY_SKETCH_FACES: SketchFaceTree = { sketches: [], bvh: buildBoxBVH(new Float64Array(0)) };
const EMPTY_POINTS: PointIndex<never> = pointIndex<never>([]);

// ---------------------------------------------------------------------------------------------
// Visibility

function bodyVisible(state: DocumentState, body: Body): boolean {
  return !body.hidden && tagVisible(state, body.tagId);
}

/** Whether the active style shows hidden geometry (soft and hidden edges drawn dashed). */
export function showHiddenGeometry(state: DocumentState): boolean {
  return state.styles.get(state.activeStyleId)?.modeling.hiddenGeometry === true;
}

/**
 * Whether an edge is concealed: soft or hidden while Hidden Geometry is off. Concealed edges are
 * not drawn, so they are neither picked nor snapped to, and neither are vertices only they reach.
 */
function edgeConcealed(e: { soft: boolean; hidden: boolean }, showHidden: boolean): boolean {
  return !showHidden && (e.soft || e.hidden);
}

// ---------------------------------------------------------------------------------------------
// Transforms

/** Normal transform by the inverse-transpose (correct under non-uniform scale). */
function transformNormal(inverse: MMat4, n: Vec3): Vec3 {
  return v3normalize([
    inverse[0]! * n[0] + inverse[1]! * n[1] + inverse[2]! * n[2],
    inverse[4]! * n[0] + inverse[5]! * n[1] + inverse[6]! * n[2],
    inverse[8]! * n[0] + inverse[9]! * n[1] + inverse[10]! * n[2],
  ]);
}

function transformPlane(matrix: MMat4, inverse: MMat4 | null, pl: Plane): Plane {
  const origin: Vec3 = [-pl.n[0] * pl.d, -pl.n[1] * pl.d, -pl.n[2] * pl.d];
  const n = inverse ? transformNormal(inverse, pl.n) : v3normalize(m4transformDir(matrix, pl.n));
  return planeFromPointNormal(m4transformPoint(matrix, origin), n);
}

function transformMesh(matrix: MMat4, mesh: MeshData): MeshData {
  const src = mesh.verts;
  const verts = new Float64Array(src.length);
  for (let i = 0; i + 2 < src.length; i += 3) {
    const p = m4transformPoint(matrix, [src[i]!, src[i + 1]!, src[i + 2]!]);
    verts[i] = p[0];
    verts[i + 1] = p[1];
    verts[i + 2] = p[2];
  }
  return { verts, tris: mesh.tris, faceId: mesh.faceId };
}

function transformCurve(matrix: MMat4, c: Curve): Curve {
  return { ...c, center: m4transformPoint(matrix, c.center), normal: v3normalize(m4transformDir(matrix, c.normal)) };
}

function transformGuide(matrix: MMat4, g: Guide): Guide {
  switch (g.kind) {
    case 'point':
      return { ...g, origin: m4transformPoint(matrix, g.origin) };
    case 'line':
      return { ...g, origin: m4transformPoint(matrix, g.origin), dir: v3normalize(m4transformDir(matrix, g.dir)) };
    case 'segment':
      return { ...g, origin: m4transformPoint(matrix, g.origin), end: m4transformPoint(matrix, g.end) };
  }
}

// ---------------------------------------------------------------------------------------------
// Builders

function buildBodyIndex(state: DocumentState, body: Body, path: readonly Id[], matrix: MMat4 | null, inverse: MMat4 | null): BodyIndex {
  const xf = matrix ? (p: Vec3): Vec3 => m4transformPoint(matrix, p) : (p: Vec3): Vec3 => p;
  const mesh = matrix ? transformMesh(matrix, body.mesh) : body.mesh;
  const triBVH = buildTriBVH(mesh);

  const faces = new Map<FaceLocalId, WorldFace>();
  for (const f of body.faces.values()) {
    faces.set(f.id, {
      id: f.id,
      record: f,
      plane: matrix ? transformPlane(matrix, inverse, f.plane) : f.plane,
      loops: matrix ? f.loops.map((l) => l.map(xf)) : f.loops,
      visible: !f.hidden && tagVisible(state, f.tagId),
    });
  }

  const showHidden = showHiddenGeometry(state);
  const edges = new Map<EdgeKey, WorldEdge>();
  const segments: IndexedSegment[] = [];
  const endpointHash = new SpatialHash<EdgeKey>(MERGE_TOL);
  for (const e of body.edges.values()) {
    if (!tagVisible(state, e.tagId)) continue;
    const poly = matrix ? e.polyline.map(xf) : e.polyline;
    edges.set(e.key, { key: e.key, record: e, polyline: poly });
    if (edgeConcealed(e, showHidden)) continue;
    const ref: EntityRef = { kind: 'edge', path, id: body.id, edgeKey: e.key };
    for (let i = 0; i + 1 < poly.length; i++) segments.push({ a: poly[i]!, b: poly[i + 1]!, ref });
    const first = poly[0], last = poly[poly.length - 1];
    if (first) endpointHash.insert(first, e.key);
    if (last && last !== first) endpointHash.insert(last, e.key);
  }
  // imprint edges (lines drawn on faces) are pickable and snappable like any other edge
  const imprintVerts: IndexedVertex[] = [];
  const imprintSeen = new SpatialHash<number>(MERGE_TOL);
  for (const e of imprintEdgesWorld(body)) {
    if (edgeConcealed(e, showHidden)) continue;
    const ref: EntityRef = { kind: 'imprintEdge', path, id: body.id, faceId: e.faceId, edgeId: e.edgeId };
    const a = xf(e.a), b = xf(e.b);
    segments.push({ a, b, ref });
    for (const p of [a, b]) {
      if (imprintSeen.find(p, MERGE_TOL) !== undefined) continue;
      imprintSeen.insert(p, imprintVerts.length);
      imprintVerts.push({ p, ref, edgeKeys: [] });
    }
  }
  const segBVH = buildSegBVH(segments);
  // loop corners, deduplicated within MERGE_TOL, each reported through an incident edge
  const corners: IndexedVertex[] = [];
  const seen = new SpatialHash<number>(MERGE_TOL);
  for (const f of faces.values()) {
    for (const loop of f.loops) {
      for (const p of loop) {
        if (seen.find(p, MERGE_TOL) !== undefined) continue;
        seen.insert(p, corners.length);
        const keys = endpointHash.query(p, MERGE_TOL).map((q) => q.item);
        const edgeKey = keys[0];
        if (edgeKey === undefined) continue; // no incident derived edge (degenerate); not pickable as a corner
        const uniqueKeys = [...new Set(keys)];
        corners.push({ p, ref: { kind: 'edge', path, id: body.id, edgeKey }, edgeKeys: uniqueKeys });
      }
    }
  }
  // imprint vertices that do not coincide with a loop corner
  for (const v of imprintVerts) if (seen.find(v.p, MERGE_TOL) === undefined) corners.push(v);

  let curves: ReadonlyMap<CurveId, Curve> = body.curves;
  if (matrix) {
    const m = new Map<CurveId, Curve>();
    for (const c of body.curves.values()) m.set(c.id, transformCurve(matrix, c));
    curves = m;
  }
  return { id: body.id, version: body.version, path, body, matrix, inverse, mesh, faces, edges, curves, triBVH, segments, segBVH, corners };
}

/** Faces of a sketch indexed between two steps of a rebuild. */
const SKETCH_FACES_PER_STEP = 2048;

/** Index one sketch, yielding between batches of faces so that a large sketch spreads over several tasks. */
function* buildSketchIndex(state: DocumentState, sketch: Sketch, path: readonly Id[], matrix: MMat4 | null, inverse: MMat4 | null): Generator<void, SketchIndex, void> {
  const xf = matrix ? (p: Vec3): Vec3 => m4transformPoint(matrix, p) : (p: Vec3): Vec3 => p;
  const showHidden = showHiddenGeometry(state);
  const segments: IndexedSegment[] = [];
  // vertices reached by a shown edge, and vertices reached by any edge (a lone vertex stays pickable)
  const shownEnds = new Set<Id>(), usedEnds = new Set<Id>();
  for (const e of sketch.edges.values()) {
    usedEnds.add(e.a).add(e.b);
    if (!tagVisible(state, e.tagId) || edgeConcealed(e, showHidden)) continue;
    const a = sketch.vertices.get(e.a), b = sketch.vertices.get(e.b);
    if (!a || !b) continue;
    shownEnds.add(e.a).add(e.b);
    segments.push({ a: xf(a.p), b: xf(b.p), ref: { kind: 'sketchEdge', path, id: e.id } });
  }
  const vertices: IndexedVertex[] = [];
  for (const v of sketch.vertices.values()) {
    if (!showHidden && usedEnds.has(v.id) && !shownEnds.has(v.id)) continue;
    vertices.push({ p: xf(v.p), ref: { kind: 'sketchVertex', path, id: v.id }, edgeKeys: [] });
  }
  const faces: SketchFaceIndex[] = [];
  let batch = 0;
  for (const f of sketch.faces.values()) {
    if (++batch % SKETCH_FACES_PER_STEP === 0) yield;
    try {
      const polygonUv = sketchFacePolygonUv(sketch, f);
      const loops = f.loops.map((l) =>
        l.map((r) => {
          const e = sketch.edges.get(r.edgeId)!;
          return xf(sketch.vertices.get(r.forward ? e.a : e.b)!.p);
        }),
      );
      faces.push({
        face: f,
        ref: { kind: 'sketchFace', path, id: f.id },
        polygonUv,
        loops,
        plane: matrix ? transformPlane(matrix, inverse, f.plane) : f.plane,
        inverse,
        visible: !f.hidden && tagVisible(state, f.tagId),
      });
    } catch {
      // a face referencing missing edges is skipped rather than breaking picking
    }
  }
  yield;
  const segBVH = yield* buildSegBVHSteps(segments);
  yield;
  return { sketch, path, segments, segBVH, vertices, faces, faceBVH: faceBoundsBVH(faces) };
}

/**
 * Bounds tree over sketch faces from their world loops, padded by LENGTH_TOL so a hit on a face
 * boundary (or a flat, axis-aligned face) survives the box test; the exact polygon test decides.
 */
function faceBoundsBVH(faces: readonly SketchFaceIndex[]): BVH {
  const boxes = new Float64Array(faces.length * 6);
  faces.forEach((f, i) => {
    let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
    for (const loop of f.loops) {
      for (const p of loop) {
        if (p[0] < minx) minx = p[0];
        if (p[0] > maxx) maxx = p[0];
        if (p[1] < miny) miny = p[1];
        if (p[1] > maxy) maxy = p[1];
        if (p[2] < minz) minz = p[2];
        if (p[2] > maxz) maxz = p[2];
      }
    }
    // a face without loop points can never be hit; give it an empty box at the origin
    if (minx > maxx) minx = miny = minz = maxx = maxy = maxz = 0;
    boxes.set([minx - LENGTH_TOL, miny - LENGTH_TOL, minz - LENGTH_TOL, maxx + LENGTH_TOL, maxy + LENGTH_TOL, maxz + LENGTH_TOL], i * 6);
  });
  return buildBoxBVH(boxes, { maxLeaf: 4 });
}

function centerEntry(curve: Curve, bodyId: Id | null, path: readonly Id[]): IndexedCenter {
  const first = curve.edgeRefs[0];
  let ref: EntityRef | null = null;
  if (first !== undefined) {
    if (bodyId !== null && typeof first === 'string') ref = { kind: 'edge', path, id: bodyId, edgeKey: first };
    else if (bodyId === null && typeof first === 'number') ref = { kind: 'sketchEdge', path, id: first };
  }
  return { p: curve.center, curveId: curve.id, curve, ref };
}

/** True when two points coincide within the vertex-merge tolerance. */
export function samePoint(a: Vec3, b: Vec3, tol = MERGE_TOL): boolean {
  return v3dist(a, b) <= tol;
}
