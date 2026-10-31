// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { CurveId, DefId, Id, TagId, Vec3 } from '@pushform/core';
import { v3dist } from '@pushform/core';
import { containerAt, dimensionText, imageEntitySize, instanceAt, meshPartEdgeCount, meshPartTriangleCount, resolveDimension, sketchEdgeLengthEnds, sketchFaceLoops, walkInstances } from '@pushform/model';
import { entityRefKey } from '@pushform/model';
import type { DocumentState, EntityContainer, EntityRef, Material } from '@pushform/model';
import { surfaceRefs } from '@pushform/commands';

/** Pure description of the selection for the Entity Info panel. */
export type EntityInfo =
  | { readonly kind: 'empty'; readonly title: 'Nothing selected' }
  | {
      readonly kind: 'edge';
      readonly title: 'Edge' | 'Sketch Edge';
      readonly length: number;
      readonly soft: boolean;
      readonly smooth: boolean;
      readonly tagId: TagId | null;
      readonly hidden: boolean;
      /** A sketch edge that bounds no face and is not a curve's can change length. */
      readonly lengthEditable: boolean;
      /** The arc, circle or polygon the edge belongs to. */
      readonly curve: CurveInfo | null;
    }
  | {
      readonly kind: 'face';
      /** `Surface`: every face of one smooth surface, described as one. */
      readonly title: 'Face' | 'Sketch Face' | 'Surface';
      readonly area: number;
      readonly front: Material | null;
      readonly back: Material | null;
      readonly tagId: TagId | null;
      readonly hidden: boolean;
    }
  | {
      readonly kind: 'body';
      readonly title: 'Solid Body' | 'Body (not solid)';
      readonly volume: number | null;
      readonly faceCount: number;
      readonly edgeCount: number;
      readonly tagId: TagId | null;
      readonly hidden: boolean;
      readonly castShadows: boolean;
      readonly receiveShadows: boolean;
    }
  /** A mesh part: imported geometry kept whole; `placements` counts the instances of the definition that holds it (1 at the root). */
  | {
      readonly kind: 'meshPart';
      readonly title: 'Mesh Part';
      readonly name: string;
      readonly format: string;
      readonly system: string;
      readonly triangleCount: number;
      readonly faceCount: number;
      readonly edgeCount: number;
      readonly placements: number;
      readonly tagId: TagId | null;
      readonly hidden: boolean;
      readonly castShadows: boolean;
      readonly receiveShadows: boolean;
    }
  | InstanceInfo
  | { readonly kind: 'vertex'; readonly title: 'Sketch Vertex'; readonly position: Vec3 }
  /** A section plane: its name and symbol, and whether it is its container's active cut. */
  | { readonly kind: 'sectionPlane'; readonly title: 'Section Plane'; readonly ref: EntityRef; readonly name: string; readonly symbol: string; readonly active: boolean; readonly tagId: TagId | null; readonly hidden: boolean }
  /** A placed picture: its image's name and pixel size, and its placed width and height. */
  | { readonly kind: 'image'; readonly title: 'Image'; readonly ref: EntityRef; readonly name: string; readonly pixels: readonly [number, number] | null;
      readonly width: number; readonly height: number; readonly tagId: TagId | null; readonly hidden: boolean }
  /** A dimension: its custom text ('' = the measurement), the measurement it shows, and its kind. */
  | { readonly kind: 'dimension'; readonly title: 'Dimension'; readonly ref: EntityRef; readonly text: string; readonly measured: string;
      readonly type: 'linear' | 'radial' | 'diametric'; readonly tagId: TagId | null; readonly hidden: boolean }
  | { readonly kind: 'other'; readonly title: string; readonly tagId: TagId | null; readonly hidden: boolean }
  | {
      readonly kind: 'multi';
      readonly title: `${number} Entities`;
      readonly count: number;
      /** Shared tag, or null when mixed. */
      readonly tagId: TagId | null;
      /** Shared hidden state, or null when mixed. */
      readonly hidden: boolean | null;
    };

/** Group / component instance. */
export interface InstanceInfo {
  readonly kind: 'instance';
  readonly title: 'Group' | 'Component' | 'Solid Group' | 'Solid Component';
  readonly ref: EntityRef;
  readonly isGroup: boolean;
  readonly definitionId: DefId;
  readonly definitionName: string;
  readonly instanceName: string;
  /** Instances of the definition anywhere in the model. */
  readonly count: number;
  readonly solid: boolean;
  /** Sum of the definition's body volumes (local units) when solid. */
  readonly volume: number | null;
  readonly tagId: TagId | null;
  readonly hidden: boolean;
  readonly locked: boolean;
  readonly castShadows: boolean;
  readonly receiveShadows: boolean;
}

/** An arc, circle or polygon kept as one curve, as Entity Info edits it. */
export interface CurveInfo {
  readonly id: CurveId;
  readonly kind: 'arc' | 'circle' | 'polygon';
  readonly radius: number;
  readonly segments: number;
}

/** Area of a planar polygon from its 3D loops (outer first, holes subtracted). */
export function loopsArea(loops: readonly (readonly Vec3[])[]): number {
  let total = 0;
  loops.forEach((loop, li) => {
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i]!, b = loop[(i + 1) % loop.length]!;
      nx += a[1] * b[2] - a[2] * b[1];
      ny += a[2] * b[0] - a[0] * b[2];
      nz += a[0] * b[1] - a[1] * b[0];
    }
    const a = Math.hypot(nx, ny, nz) / 2;
    total += li === 0 ? a : -a;
  });
  return Math.max(0, total);
}

export function polylineLength(points: readonly Vec3[]): number {
  let l = 0;
  for (let i = 0; i + 1 < points.length; i++) l += v3dist(points[i]!, points[i + 1]!);
  return l;
}

const KIND_TITLES: Partial<Record<EntityRef['kind'], string>> = {
  imprintEdge: 'Edge',
  guide: 'Guide',
  image: 'Image',
  sectionPlane: 'Section Plane',
  text: 'Text',
  dimension: 'Dimension',
};

function material(state: DocumentState, id: Material['id'] | null | undefined): Material | null {
  const m = state.materials.get(id ?? state.defaultMaterialId);
  return m ?? null;
}

function containerOf(state: DocumentState, path: readonly Id[]): EntityContainer | null {
  try {
    return containerAt(state, path);
  } catch {
    return null;
  }
}

/** Number of instances of `definitionId` reachable from the root (cycles guarded by `walkInstances`). */
export function countInstances(state: DocumentState, definitionId: DefId): number {
  let n = 0;
  for (const v of walkInstances(state)) if (v.definition.id === definitionId) n++;
  return n;
}

/**
 * Describe a group/component instance. A definition is "solid" when it holds only valid bodies
 * (no sheet geometry, no nested instances); its volume is the sum of those bodies' volumes.
 */
export function describeInstance(state: DocumentState, ref: EntityRef & { kind: 'instance' }, counts?: Map<DefId, number>): InstanceInfo | null {
  let inst;
  try {
    inst = instanceAt(state, [...ref.path, ref.id]);
  } catch {
    return null;
  }
  const def = inst ? state.definitions.get(inst.definitionId) : undefined;
  if (!inst || !def) return null;
  const ents = def.entities;
  const bodies = [...ents.bodies.values()];
  const solid = bodies.length > 0 && bodies.every((b) => b.valid) && ents.sketch.edges.size === 0 && ents.instances.size === 0;
  const volume = solid ? bodies.reduce((s, b) => s + b.props.volume, 0) : null;
  const base = def.isGroup ? 'Group' : 'Component';
  let count = counts?.get(def.id);
  if (count === undefined) {
    count = countInstances(state, def.id);
    counts?.set(def.id, count);
  }
  return {
    kind: 'instance',
    title: solid ? (`Solid ${base}` as InstanceInfo['title']) : base,
    ref,
    isGroup: def.isGroup,
    definitionId: def.id,
    definitionName: def.name,
    instanceName: inst.name,
    count,
    solid,
    volume,
    tagId: inst.tagId,
    hidden: inst.hidden,
    locked: inst.locked,
    castShadows: inst.castShadows !== false,
    receiveShadows: inst.receiveShadows !== false,
  };
}

/** Describe one ref; null when it no longer resolves in the document. */
export function describeRef(state: DocumentState, ref: EntityRef, counts?: Map<DefId, number>): EntityInfo | null {
  if (ref.kind === 'instance') return describeInstance(state, ref, counts);
  const container = containerOf(state, ref.path);
  if (!container) return null;
  const bodies = container.bodies;
  const sketch = container.sketch;
  switch (ref.kind) {
    case 'body': {
      const b = bodies.get(ref.id);
      if (!b) return null;
      return {
        kind: 'body',
        title: b.valid ? 'Solid Body' : 'Body (not solid)',
        volume: b.valid ? b.props.volume : null,
        faceCount: b.faces.size,
        edgeCount: b.edges.size,
        tagId: b.tagId,
        hidden: b.hidden,
        castShadows: b.castShadows !== false,
        receiveShadows: b.receiveShadows !== false,
      };
    }
    case 'meshPart': {
      const part = container.meshParts.get(ref.id);
      if (!part) return null;
      let placements = 1;
      if (ref.path.length) {
        const definitionId = instanceAt(state, ref.path)!.definitionId;
        placements = counts?.get(definitionId) ?? countInstances(state, definitionId);
        counts?.set(definitionId, placements);
      }
      return {
        kind: 'meshPart',
        title: 'Mesh Part',
        name: part.name,
        format: part.source.format,
        system: part.source.system,
        triangleCount: meshPartTriangleCount(part.geometry),
        faceCount: part.geometry.faceCount,
        edgeCount: meshPartEdgeCount(part.geometry),
        placements,
        tagId: part.tagId,
        hidden: part.hidden,
        castShadows: part.castShadows !== false,
        receiveShadows: part.receiveShadows !== false,
      };
    }
    case 'face': {
      const b = bodies.get(ref.id);
      const f = b?.faces.get(ref.faceId);
      if (!b || !f) return null;
      return {
        kind: 'face',
        title: 'Face',
        area: loopsArea(f.loops),
        front: material(state, f.frontMaterialId ?? b.materialId),
        back: material(state, f.backMaterialId ?? b.materialId),
        tagId: f.tagId,
        hidden: f.hidden,
      };
    }
    case 'edge': {
      const e = bodies.get(ref.id)?.edges.get(ref.edgeKey);
      if (!e) return null;
      return { kind: 'edge', title: 'Edge', length: polylineLength(e.polyline), soft: e.soft, smooth: e.smooth, tagId: e.tagId, hidden: e.hidden,
        lengthEditable: false, curve: null };
    }
    case 'sketchFace': {
      const f = sketch.faces.get(ref.id);
      if (!f) return null;
      return {
        kind: 'face',
        title: 'Sketch Face',
        area: loopsArea(sketchFaceLoops(sketch, f)),
        front: material(state, f.frontMaterialId),
        back: material(state, f.backMaterialId),
        tagId: f.tagId,
        hidden: f.hidden,
      };
    }
    case 'sketchEdge': {
      const e = sketch.edges.get(ref.id);
      const a = e ? sketch.vertices.get(e.a) : undefined;
      const b = e ? sketch.vertices.get(e.b) : undefined;
      if (!e || !a || !b) return null;
      const curve = e.curveId === null ? undefined : sketch.curves.get(e.curveId);
      return { kind: 'edge', title: 'Sketch Edge', length: v3dist(a.p, b.p), soft: e.soft, smooth: e.smooth, tagId: e.tagId, hidden: e.hidden,
        lengthEditable: sketchEdgeLengthEnds(sketch, e.id) !== null,
        curve: curve && curve.kind !== 'freehand' ? { id: curve.id, kind: curve.kind, radius: curve.radius, segments: curve.segments } : null };
    }
    case 'sketchVertex': {
      const v = sketch.vertices.get(ref.id);
      return v ? { kind: 'vertex', title: 'Sketch Vertex', position: v.p } : null;
    }
    case 'image': {
      const image = container.images.get(ref.id);
      if (!image) return null;
      const asset = state.images.get(image.imageId);
      const { width, height } = imageEntitySize(image);
      return { kind: 'image', title: 'Image', ref, name: asset?.name ?? 'Image', pixels: asset && asset.width > 0 ? [asset.width, asset.height] : null,
        width, height, tagId: image.tagId, hidden: image.hidden };
    }
    case 'dimension': {
      const dim = container.dimensions.get(ref.id);
      if (!dim) return null;
      const measured = dimensionText({ ...dim, text: null }, resolveDimension(state, container, dim).value, state.meta.units);
      return { kind: 'dimension', title: 'Dimension', ref, text: dim.text ?? '', measured, type: dim.kind, tagId: dim.tagId, hidden: dim.hidden };
    }
    case 'sectionPlane': {
      const sp = container.sectionPlanes.get(ref.id);
      return sp ? { kind: 'sectionPlane', title: 'Section Plane', ref, name: sp.name, symbol: sp.symbol, active: container.activeSectionPlaneId === sp.id, tagId: sp.tagId, hidden: sp.hidden } : null;
    }
    default:
      return { kind: 'other', title: KIND_TITLES[ref.kind] ?? 'Entity', tagId: null, hidden: false };
  }
}

/** Header + fields for the whole selection. */
export function describeSelection(state: DocumentState, refs: readonly EntityRef[]): EntityInfo {
  // Local to this read: repeated component selections share one model traversal,
  // without retaining document graphs or risking stale counts after edits/undo.
  const counts = new Map<DefId, number>();
  const infos = refs.map((r) => describeRef(state, r, counts)).filter((i): i is EntityInfo => i !== null);
  if (infos.length === 0) return { kind: 'empty', title: 'Nothing selected' };
  if (infos.length === 1) return infos[0]!;
  const surface = describeSurface(refs, infos, state);
  if (surface) return surface;
  let tagId: TagId | null | undefined;
  let hidden: boolean | null | undefined;
  for (const i of infos) {
    const t = 'tagId' in i ? i.tagId : null;
    const h = 'hidden' in i ? i.hidden : null;
    tagId = tagId === undefined ? t : tagId === t ? tagId : null;
    hidden = hidden === undefined ? h : hidden === h ? hidden : null;
  }
  return { kind: 'multi', title: `${infos.length} Entities`, count: infos.length, tagId: tagId ?? null, hidden: hidden ?? null };
}

/** The selection as one smooth surface when it is exactly every face of one, else null. */
function describeSurface(refs: readonly EntityRef[], infos: readonly EntityInfo[], state: DocumentState): EntityInfo | null {
  const first = refs[0];
  if (!first || (first.kind !== 'face' && first.kind !== 'sketchFace') || infos.length !== refs.length) return null;
  const key = (r: EntityRef): string => entityRefKey(r.kind === 'face' ? { ...r, region: null } : r);
  const whole = new Set(surfaceRefs(state, first).map(key));
  const picked = new Set(refs.map(key));
  if (whole.size < 2 || whole.size !== picked.size || ![...picked].every((k) => whole.has(k))) return null;
  const faces = infos.filter((i): i is EntityInfo & { kind: 'face' } => i.kind === 'face');
  const one = faces[0]!;
  const same = <T,>(get: (i: EntityInfo & { kind: 'face' }) => T): T | null => (faces.every((i) => get(i) === get(one)) ? get(one) : null);
  return {
    kind: 'face',
    title: 'Surface',
    area: faces.reduce((sum, i) => sum + i.area, 0),
    front: same((i) => i.front),
    back: same((i) => i.back),
    tagId: same((i) => i.tagId),
    hidden: faces.every((i) => i.hidden),
  };
}
