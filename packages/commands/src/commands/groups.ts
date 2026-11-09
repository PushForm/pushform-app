// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import type { Box3, CurveId, DefId, Id, Mat4, MaterialId, MMat4, MVec3, Vec3 } from '@pushform/core';
import {
  box3Empty,
  box3Expand,
  box3IsEmpty,
  m4fromBasis,
  m4invert,
  m4mul,
  m4transformDir,
  m4transformPoint,
  m4translation,
  meshBounds,
  newGuid,
  planeBasis,
  planeFromPointNormal,
  PushFormError,
  v3len,
  v3normalize,
} from '@pushform/core';
import { copyPluginEntries, movePluginTargets, pluginIdentityMap, reviewPluginTargets, allocId, containerAt, contextMatrix, createEntityContainer, DEFAULT_AXES, DEFAULT_BEHAVIORS, imageEntityCorners, loopKey, meshPartBounds, SketchGraph, textureTiles, uvRebaseSides } from '@pushform/model';
import type {
  ComponentBehaviors,
  ComponentDefinition,
  ComponentInstance,
  ImageEntity,
  DocumentDraft,
  DocumentState,
  EntityContainer,
  EntityRef,
  Dimension,
  Guide,
  LoopRef,
  Sketch,
  SketchFace,
} from '@pushform/model';
import { defineCommand } from '../registry/Command';
import type { AnyCommand } from '../registry/Command';
import type { DocumentHost } from '../host/DocumentHost';
import { hostOf, meshEditableOf } from '../host/services';
import { contextFrame, currentFrame, draftContainerAt, refsInContext, requireContextPath, sketchGraphAt } from './context';
import { orthonormalAxes } from './axes';
import { glueFaceAt } from './componentBehaviors';
import { EntityRefSchema } from './sketch';
import { mapNormal, mapSectionPlane } from './sectionPlanes';
import { cloneBody, cloneMeshPart, copyBodyRecord, copyMeshPartRecord, definitionBounds, m4linearDeterminant, toEntityRefs, transformBodyAffineInPlace, transformBodyInPlace, transformMeshPartGeometry } from './transform';

/**
 * Groups and components: Make Group / Make Component move the
 * selected entities of the current context into a new ComponentDefinition and leave one
 * ComponentInstance in their place; Explode moves an instance's entities back up a level with
 * its transform applied; Make Unique gives selected instances their own copy of the definition.
 * Definitions are document-wide; groups are definitions with `isGroup` and (normally) one instance.
 */

// ---------------------------------------------------------------------------------------------
// Params

const refsSchema = z.array(EntityRefSchema).optional();
const vec3 = z.tuple([z.number(), z.number(), z.number()]);
type RefParam = z.infer<typeof EntityRefSchema>;

export const MakeGroupParamsSchema = z.object({
  /** Entities to group; the current selection when omitted. */
  refs: refsSchema,
});
export type MakeGroupParams = z.infer<typeof MakeGroupParamsSchema>;

export const MakeComponentParamsSchema = z.object({
  refs: refsSchema,
  /** Definition name (made unique with a `#n` suffix). "Component#n" when omitted. */
  name: z.string().optional(),
  description: z.string().optional(),
  glueTo: z.enum(['none', 'any', 'horizontal', 'vertical', 'sloped']).optional(),
  cutOpening: z.boolean().optional(),
  alwaysFaceCamera: z.boolean().optional(),
  shadowsFaceSun: z.boolean().optional(),
  /** Replace the selected entities with an instance (default). When false the entities are copied into the definition and stay loose. */
  replaceSelection: z.boolean().default(true),
  /** Component axes origin (world); the selection's bounding-box minimum corner when omitted. */
  axesOrigin: vec3.optional(),
  /** Picked component axes (world red and green directions); the context's axes when omitted. */
  axesX: vec3.optional(),
  axesY: vec3.optional(),
  axesZ: vec3.optional(),
});
export type MakeComponentParams = z.infer<typeof MakeComponentParamsSchema>;

export interface MakeResult {
  readonly definitionId: number;
  /** The new instance in the current context, or null when the selection was not replaced. */
  readonly instanceId: number | null;
}

export interface ExplodeResult {
  /** Entities now in the current context (per exploded instance, flattened). */
  readonly refs: EntityRef[];
  readonly explodedInstanceIds: number[];
  readonly deletedDefinitionIds: number[];
}

export interface MakeUniqueResult {
  /** Instance id → the definition it now uses (unchanged when it was already unique). */
  readonly definitions: Record<number, number>;
  readonly createdDefinitionIds: number[];
}

// ---------------------------------------------------------------------------------------------
// Definition helpers

/** Number of instances of a definition across the whole document. */
export function instanceCount(state: DocumentState, definitionId: DefId): number {
  let n = 0;
  for (const def of state.definitions.values()) {
    for (const inst of def.entities.instances.values()) if (inst.definitionId === definitionId) n++;
  }
  return n;
}

const stripSuffix = (name: string): string => name.replace(/#\d+$/, '');

/** `base#n` with the smallest n ≥ 1 not used by another definition (or `base` itself when free and `allowBare`). */
export function uniqueDefinitionName(state: DocumentState, name: string, allowBare = true): string {
  const taken = new Set<string>();
  for (const def of state.definitions.values()) taken.add(def.name);
  if (allowBare && !taken.has(name)) return name;
  const base = stripSuffix(name) || 'Component';
  for (let n = 1; ; n++) {
    const candidate = `${base}#${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

interface NewDefinitionOptions {
  readonly name: string;
  readonly isGroup: boolean;
  readonly description?: string | undefined;
  readonly behaviors?: Partial<ComponentBehaviors> | undefined;
}

export function createDefinition(draft: DocumentDraft, opts: NewDefinitionOptions): ComponentDefinition {
  const id = allocId<DefId>(draft);
  const def: ComponentDefinition = {
    id,
    guid: newGuid(),
    name: opts.name,
    description: opts.description ?? '',
    isGroup: opts.isGroup,
    axes: { origin: [...DEFAULT_AXES.origin], x: [...DEFAULT_AXES.x], y: [...DEFAULT_AXES.y], z: [...DEFAULT_AXES.z] },
    behaviors: { ...DEFAULT_BEHAVIORS, ...opts.behaviors },
    entities: createEntityContainer(),
    bounds: null,
  };
  (draft.definitions as unknown as Map<DefId, ComponentDefinition>).set(id, def);
  // read back the draft proxy so later mutations are recorded
  return draftContainerOwner(draft, id);
}

function draftContainerOwner(draft: DocumentDraft, id: DefId): ComponentDefinition {
  const def = (draft as unknown as DocumentState).definitions.get(id);
  if (!def) throw new PushFormError('definition.missing', `Definition ${id} not found`);
  return def;
}

export function newInstance(draft: DocumentDraft, definitionId: DefId, transform: MMat4, name = ''): ComponentInstance {
  return {
    id: allocId<Id>(draft),
    definitionId,
    transform: transform as unknown as Mat4,
    name,
    materialId: null,
    tagId: draft.defaultTagId,
    hidden: false,
    locked: false,
    castShadows: true,
    receiveShadows: true,
    attributes: {},
  };
}

const cloneJson = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const mv3 = (p: Vec3): MVec3 => [p[0], p[1], p[2]];

function removeFromOrder(container: EntityContainer, ids: ReadonlySet<Id>): void {
  if (ids.size) container.order = container.order.filter((x) => !ids.has(x));
}

// ---------------------------------------------------------------------------------------------
// Sketch copy (shared by group/component make, explode and make unique)

export interface PointMap {
  point(p: Vec3): MVec3;
  /** Unit normals / directions. */
  dir(d: Vec3): MVec3;
  /** Length scale factor (curve radii). */
  readonly scale: number;
}

export function pointMapFromMatrix(m: Mat4 | MMat4): PointMap {
  const scale = Math.cbrt(Math.abs(m4linearDeterminant(m))) || 1;
  return {
    point: (p) => m4transformPoint(m, p),
    dir: (d) => {
      const v = m4transformDir(m, d);
      return v3len(v) > 0 ? v3normalize(v) : mv3(d);
    },
    scale,
  };
}

export interface SketchCopyResult {
  /** Source edge id → ids along the copied edge (a→b order; several when it merged with existing geometry). */
  readonly edgeMap: Map<Id, Id[]>;
  readonly faceIds: Id[];
  readonly curveMap: Map<CurveId, CurveId>;
}

function newellNormal(pts: readonly Vec3[]): MVec3 {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
    x += (a[1] - b[1]) * (a[2] + b[2]);
    y += (a[2] - b[2]) * (a[0] + b[0]);
    z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [x, y, z];
}

/**
 * Copy sketch edges (with their curves) and faces from `src` into `dst`, mapping positions with
 * `map`. Edges merge with existing geometry in `dst` (vertices within MERGE_TOL, crossings split);
 * faces are recreated from the mapped loops (no face finding, so loose loops stay loose). `edgeIds` / `faceIds` select what to copy ('all' = the whole sketch).
 * Face sides without a material of their own take `inherited` (the material they showed in their instance).
 */
export function copySketchInto(
  draft: DocumentDraft,
  src: Sketch,
  edgeIds: ReadonlySet<Id> | 'all',
  faceIds: ReadonlySet<Id> | 'all',
  dst: SketchGraph,
  map: PointMap,
  inherited: MaterialId | null = null,
): SketchCopyResult {
  const edgeMap = new Map<Id, Id[]>();
  const curveMap = new Map<CurveId, CurveId>();
  const edges = edgeIds === 'all' ? [...src.edges.values()] : [...edgeIds].map((id) => src.edges.get(id)).filter((e) => e !== undefined);
  for (const e of edges) {
    if (e.curveId !== null && src.curves.has(e.curveId) && !curveMap.has(e.curveId)) curveMap.set(e.curveId, allocId<CurveId>(draft));
  }
  for (const e of edges) {
    const a = src.vertices.get(e.a), b = src.vertices.get(e.b);
    if (!a || !b) continue;
    const curveId = e.curveId !== null ? (curveMap.get(e.curveId) ?? null) : null;
    const ids = dst.addEdge(map.point(a.p), map.point(b.p), { soft: e.soft, smooth: e.smooth, hidden: e.hidden, tagId: e.tagId, curveId, findFaces: false });
    edgeMap.set(e.id, ids);
  }
  for (const [oldId, newId] of curveMap) {
    const c = src.curves.get(oldId);
    if (!c) continue;
    const edgeRefs: Id[] = [];
    for (const r of c.edgeRefs) if (typeof r === 'number') edgeRefs.push(...(edgeMap.get(r) ?? []));
    if (!edgeRefs.length) continue;
    dst.sketch.curves.set(newId, {
      id: newId,
      kind: c.kind,
      center: map.point(c.center),
      normal: map.dir(c.normal),
      radius: c.radius * map.scale,
      startAngle: c.startAngle,
      endAngle: c.endAngle,
      segments: c.segments,
      edgeRefs,
    });
  }
  const outFaces: Id[] = [];
  const tiles = textureTiles(draft);
  const existingKeys = new Set([...dst.sketch.faces.values()].map((f) => loopKey(f.loops[0] ?? [])));
  const faces = faceIds === 'all' ? [...src.faces.values()] : [...faceIds].map((id) => src.faces.get(id)).filter((f) => f !== undefined);
  for (const f of faces) {
    const loops: LoopRef[][] = [];
    for (const loop of f.loops) {
      const mapped = mapLoop(src, dst, edgeMap, map, loop);
      if (mapped.length >= 3) loops.push(mapped);
      else if (loops.length === 0) break;
    }
    const outer = loops[0];
    if (!outer) continue;
    const key = loopKey(outer);
    if (existingKeys.has(key)) continue;
    const pts = outer.map((r) => {
      const e = dst.edge(r.edgeId);
      return dst.pos(r.forward ? e.a : e.b);
    });
    const n = newellNormal(pts);
    if (v3len(n) === 0) continue;
    const un = v3normalize(n);
    const centroid = pts.reduce<MVec3>((acc, p) => [acc[0] + p[0], acc[1] + p[1], acc[2] + p[2]], [0, 0, 0]);
    const plane = planeFromPointNormal([centroid[0] / pts.length, centroid[1] / pts.length, centroid[2] / pts.length], un);
    // basis at the plane's point nearest the origin, as the face finder and importer build it
    const basis = planeBasis([-plane.n[0] * plane.d, -plane.n[1] * plane.d, -plane.n[2] * plane.d], plane.n);
    const front = f.frontMaterialId ?? inherited, back = f.backMaterialId ?? inherited;
    // texture placements keep each mapped point's texture coordinates in the new basis
    const sides = uvRebaseSides(f, f.basis, basis, tiles(front), tiles(back), (p) => map.point(p));
    const id = dst.alloc<Id>();
    const face: SketchFace = {
      id,
      plane,
      basis,
      loops,
      frontMaterialId: front,
      backMaterialId: back,
      uv: cloneJson(sides.uv),
      ...(sides.uvBack ? { uvBack: cloneJson(sides.uvBack) } : {}),
      tagId: f.tagId,
      hidden: f.hidden,
      locked: f.locked,
      castShadows: f.castShadows,
      receiveShadows: f.receiveShadows,
      attributes: cloneJson(f.attributes),
    };
    dst.sketch.faces.set(id, face);
    existingKeys.add(key);
    outFaces.push(id);
  }
  return { edgeMap, faceIds: outFaces, curveMap };
}

/** Map a source loop onto the copied edges, keeping the traversal direction. */
function mapLoop(src: Sketch, dst: SketchGraph, edgeMap: Map<Id, Id[]>, map: PointMap, loop: readonly LoopRef[]): LoopRef[] {
  const out: LoopRef[] = [];
  for (const r of loop) {
    const e = src.edges.get(r.edgeId);
    const ids = edgeMap.get(r.edgeId);
    if (!e || !ids?.length) continue;
    const startVertex = src.vertices.get(r.forward ? e.a : e.b);
    let cur = startVertex ? dst.findVertex(map.point(startVertex.p)) : undefined;
    const ordered = r.forward ? ids : [...ids].reverse();
    for (const nid of ordered) {
      const ne = dst.sketch.edges.get(nid);
      if (!ne) continue;
      if (cur !== undefined && ne.b === cur) {
        out.push({ edgeId: nid, forward: false });
        cur = ne.a;
      } else {
        out.push({ edgeId: nid, forward: true });
        cur = ne.b;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Selection collection

interface Collected {
  readonly bodies: Id[];
  readonly meshParts: Id[];
  readonly instances: Id[];
  readonly guides: Id[];
  readonly images: Id[];
  readonly sectionPlanes: Id[];
  readonly edges: Set<Id>;
  readonly faces: Set<Id>;
  readonly size: number;
}

/**
 * Entities of a container a group/component is made from: bodies (a face/edge ref selects its
 * solid), instances, guides, section planes, sketch faces (with their edges) and sketch edges (faces bounded
 * only by selected edges come along).
 */
function collect(container: EntityContainer, refs: readonly EntityRef[]): Collected {
  const bodies = new Set<Id>(), meshParts = new Set<Id>(), instances = new Set<Id>(), guides = new Set<Id>(), images = new Set<Id>();
  const planes = new Set<Id>();
  const edges = new Set<Id>(), faces = new Set<Id>();
  const sketch = container.sketch;
  for (const r of refs) {
    switch (r.kind) {
      case 'body':
      case 'face':
      case 'edge':
      case 'imprintEdge':
        if (container.bodies.has(r.id)) bodies.add(r.id);
        break;
      case 'meshPart':
        if (container.meshParts.has(r.id)) meshParts.add(r.id);
        break;
      case 'instance':
        if (container.instances.has(r.id)) instances.add(r.id);
        break;
      case 'guide':
        if (container.guides.has(r.id)) guides.add(r.id);
        break;
      case 'image':
        if (container.images.has(r.id)) images.add(r.id);
        break;
      case 'sectionPlane':
        if (container.sectionPlanes.has(r.id)) planes.add(r.id);
        break;
      case 'sketchEdge':
        if (sketch.edges.has(r.id)) edges.add(r.id);
        break;
      case 'sketchFace': {
        const f = sketch.faces.get(r.id);
        if (!f) break;
        faces.add(r.id);
        for (const loop of f.loops) for (const ref of loop) edges.add(ref.edgeId);
        break;
      }
      default:
        break;
    }
  }
  for (const f of sketch.faces.values()) {
    if (faces.has(f.id)) continue;
    let all = f.loops.length > 0;
    for (const loop of f.loops) for (const ref of loop) if (!edges.has(ref.edgeId)) all = false;
    if (all) faces.add(f.id);
  }
  return {
    bodies: [...bodies],
    meshParts: [...meshParts],
    instances: [...instances],
    guides: [...guides],
    images: [...images],
    sectionPlanes: [...planes],
    edges,
    faces,
    size: bodies.size + meshParts.size + instances.size + guides.size + images.size + planes.size + edges.size,
  };
}

function collectedBounds(state: DocumentState, container: EntityContainer, c: Collected): Box3 | null {
  const b = box3Empty();
  for (const id of c.bodies) {
    const body = container.bodies.get(id);
    if (!body) continue;
    const mb = meshBounds(body.mesh);
    if (!box3IsEmpty(mb)) {
      box3Expand(b, mb.min);
      box3Expand(b, mb.max);
    }
  }
  for (const id of c.meshParts) {
    const part = container.meshParts.get(id);
    const pb = part && meshPartBounds(part.geometry);
    if (!pb) continue;
    box3Expand(b, pb.min);
    box3Expand(b, pb.max);
  }
  for (const id of c.edges) {
    const e = container.sketch.edges.get(id);
    if (!e) continue;
    const a = container.sketch.vertices.get(e.a), q = container.sketch.vertices.get(e.b);
    if (a) box3Expand(b, a.p);
    if (q) box3Expand(b, q.p);
  }
  for (const id of c.instances) {
    const inst = container.instances.get(id);
    const lb = inst && definitionBounds(state, inst.definitionId);
    if (!inst || !lb) continue;
    for (let i = 0; i < 8; i++) {
      const corner: Vec3 = [i & 1 ? lb.max[0] : lb.min[0], i & 2 ? lb.max[1] : lb.min[1], i & 4 ? lb.max[2] : lb.min[2]];
      box3Expand(b, m4transformPoint(inst.transform, corner));
    }
  }
  for (const id of c.guides) {
    const g = container.guides.get(id);
    if (!g) continue;
    box3Expand(b, g.origin);
    if (g.kind === 'segment') box3Expand(b, g.end);
  }
  for (const id of c.images) {
    const image = container.images.get(id);
    if (image) for (const p of imageEntityCorners(image)) box3Expand(b, p);
  }
  return box3IsEmpty(b) ? null : b;
}

// ---------------------------------------------------------------------------------------------
// Make group / component

interface MakeOptions extends NewDefinitionOptions {
  readonly replaceSelection: boolean;
  /** Definition origin in the coordinates of the current container. */
  readonly origin: Vec3 | null;
  /** Definition axes (an orthonormal frame in the current container's coordinates, origin included); overrides `origin`. */
  readonly frame?: MMat4 | undefined;
}

function refsOrSelection(host: DocumentHost, refs: readonly RefParam[] | undefined): EntityRef[] {
  const list = refs ? toEntityRefs(refs) : host.selection.refs;
  for (const r of list) requireContextPath(host, r.path, 'Entity');
  return refsInContext(host, list);
}

/** Move (or copy) the collected entities into a fresh definition and insert an instance for it. */
function makeDefinition(host: DocumentHost, refs: readonly EntityRef[], opts: MakeOptions): MakeResult {
  const path = host.context.path;
  const result = host.edit(opts.isGroup ? 'Make Group' : 'Make Component', (draft) => makeDefinitionInDraft(draft, path, refs, opts));
  if (result.instanceId !== null) host.selection.set([{ kind: 'instance', path, id: result.instanceId as Id }]);
  return result;
}

/**
 * The draft half of `makeDefinition`: reads the container at `path` from the open draft (so entities
 * created earlier in the same transaction count) and moves or copies the collected entities into a
 * new definition. Throws when nothing was collected.
 */
function makeDefinitionInDraft(draft: DocumentDraft, path: readonly Id[], refs: readonly EntityRef[], opts: MakeOptions): MakeResult {
  const state = draft as unknown as DocumentState;
  const src = draftContainerAt(draft, path);
  const collected = collect(src, refs);
  if (collected.size === 0) throw new PushFormError('group.empty', 'Select something to make a group or component from');
  const bounds = collectedBounds(state, src, collected);
  const origin: Vec3 = opts.origin ?? bounds?.min ?? [0, 0, 0];
  const frame: MMat4 = opts.frame ?? m4translation(origin);
  const toLocal: MMat4 = m4invert(frame) ?? m4translation([-origin[0], -origin[1], -origin[2]]);
  const localMap = pointMapFromMatrix(toLocal);
  const move = opts.replaceSelection;
  let instanceId: number | null = null;
  let definitionId = 0;
  const copiedIds = new Map<number, number>();

  const def = createDefinition(draft, opts);
  definitionId = def.id;
  const dst = def.entities;
  const removed = new Set<Id>();


  // bodies
  for (const id of collected.bodies) {
    const body = src.bodies.get(id);
    if (!body) continue;
    const target = move ? copyBodyRecord(body, body.id) : cloneBody(draft, dst, body);
    if (!move) copiedIds.set(body.id, target.id);
    transformBodyInPlace(target, toLocal, textureTiles(draft));
    if (move) {
      src.bodies.delete(id);
      removed.add(id);
      dst.bodies.set(target.id, target);
      dst.order.push(target.id);
    }
  }
  // mesh parts
  for (const id of collected.meshParts) {
    const part = src.meshParts.get(id);
    if (!part) continue;
    const target = move ? copyMeshPartRecord(part, part.id) : cloneMeshPart(draft, dst, part);
    target.geometry = transformMeshPartGeometry(part.geometry, toLocal);
    if (move) {
      src.meshParts.delete(id);
      removed.add(id);
      dst.meshParts.set(target.id, target);
      dst.order.push(target.id);
    }
  }
  // instances
  for (const id of collected.instances) {
    const inst = src.instances.get(id);
    if (!inst) continue;
    const copy: ComponentInstance = {
      ...inst,
      id: move ? inst.id : allocId<Id>(draft),
      transform: m4mul(toLocal, inst.transform) as unknown as Mat4,
      attributes: cloneJson(inst.attributes),
    };
    if (move) {
      src.instances.delete(id);
      removed.add(id);
    }
    dst.instances.set(copy.id, copy);
    dst.order.push(copy.id);
    if (!move) copiedIds.set(inst.id, copy.id);
  }
  // guides
  for (const id of collected.guides) {
    const g = src.guides.get(id);
    if (!g) continue;
    const copy = mapGuide(g, move ? g.id : allocId<Id>(draft), localMap);
    if (move) {
      src.guides.delete(id);
      removed.add(id);
    }
    dst.guides.set(copy.id, copy);
    dst.order.push(copy.id);
  }
  // placed pictures
  for (const id of collected.images) {
    const image = src.images.get(id);
    if (!image) continue;
    const copy: ImageEntity = { ...image, id: move ? image.id : allocId<Id>(draft), transform: m4mul(toLocal, image.transform) as unknown as Mat4,
      attributes: cloneJson(image.attributes) };
    if (move) {
      src.images.delete(id);
      removed.add(id);
    }
    dst.images.set(copy.id, copy);
    dst.order.push(copy.id);
  }
  // section planes: a moved plane that was its container's cut becomes the new definition's cut
  for (const id of collected.sectionPlanes) {
    const plane = src.sectionPlanes.get(id);
    if (!plane) continue;
    const copy = mapSectionPlane(plane, move ? plane.id : allocId<Id>(draft), toLocal);
    if (move) {
      src.sectionPlanes.delete(id);
      removed.add(id);
      if (src.activeSectionPlaneId === id) {
        src.activeSectionPlaneId = null;
        dst.activeSectionPlaneId = copy.id;
      }
    }
    dst.sectionPlanes.set(copy.id, copy);
    dst.order.push(copy.id);
  }
  // sketch
  if (collected.edges.size) {
    const srcGraph = sketchGraphAt(draft, path);
    const dstGraph = SketchGraph.for(draft, def.id);
    copySketchInto(draft, srcGraph.sketch, collected.edges, collected.faces, dstGraph, localMap);
    if (move) {
      for (const id of collected.faces) srcGraph.removeFace(id);
      for (const id of collected.edges) srcGraph.removeEdge(id);
    }
  }
  removeFromOrder(src, removed);

  if (move) {
    const inst = newInstance(draft, def.id, frame);
    // Glue To: glue to the face holding the component's origin across its blue axis
    const frameOf = contextFrame(state, path);
    const plane = glueFaceAt(src, def.behaviors.glueTo, m4transformPoint(frame, [0, 0, 0]), m4transformDir(frame, [0, 0, 1]), frameOf.toWorldNormal);
    if (plane) inst.gluedPlane = plane;
    src.instances.set(inst.id, inst);
    src.order.push(inst.id);
    instanceId = inst.id;
    movePluginTargets(draft, target => {
      if (target.kind !== 'bodyOccurrence') return undefined;
      if (collected.bodies.includes(target.id as Id)) return { ...target, path: [...target.path, inst.id] };
      const index = target.path.findIndex(id => collected.instances.includes(id as Id));
      return index < 0 ? undefined : { ...target, path: [...target.path.slice(0, index), inst.id, ...target.path.slice(index)] };
    });
  } else {
    const map = pluginIdentityMap(copiedIds);
    copyPluginEntries(draft, target => target.kind === 'bodyOccurrence' ? undefined : map(target));
  }
  return { definitionId, instanceId };
}

/** Wrap one freshly created part without changing the live selection or editing context. */
export function componentizePart(draft:DocumentDraft,ref:EntityRef&{kind:'body'},name:string):EntityRef&{kind:'body'} {
  if(!draftContainerAt(draft,ref.path).bodies.has(ref.id))throw new PushFormError('part.target','The created part is missing.');
  const made=makeDefinitionInDraft(draft,ref.path,[ref],{name:uniqueDefinitionName(draft as unknown as DocumentState,name.trim()),isGroup:false,replaceSelection:true,origin:null});
  if(made.instanceId===null)throw new PushFormError('part.target','The part component could not be created.');
  return{kind:'body',id:ref.id,path:[...ref.path,made.instanceId as Id]};
}

export function mapGuide(g: Guide, id: Id, map: PointMap): Guide {
  const attrs = { tagId: g.tagId, hidden: g.hidden, locked: g.locked, castShadows: g.castShadows, receiveShadows: g.receiveShadows, attributes: cloneJson(g.attributes) };
  switch (g.kind) {
    case 'point':
      return { ...attrs, id, kind: 'point', origin: map.point(g.origin) };
    case 'line':
      return { ...attrs, id, kind: 'line', origin: map.point(g.origin), dir: map.dir(g.dir) };
    case 'segment':
      return { ...attrs, id, kind: 'segment', origin: map.point(g.origin), end: map.point(g.end) };
  }
}

export function mapDimension(d: Dimension, id: Id, m: Mat4 | MMat4): Dimension {
  return { ...d, id, attributes: cloneJson(d.attributes), start: m4transformPoint(m, d.start), end: m4transformPoint(m, d.end),
    offset: m4transformDir(m, d.offset), normal: mapNormal(m, d.normal) };
}

/** Make Group (Ctrl+G): the selection becomes a group instance; its entities move into the new definition. */
export const groupMake = defineCommand({
  id: 'group.make',
  title: 'Make Group',
  category: 'edit',
  menu: 'Edit',
  keybinding: 'Mod+G',
  params: MakeGroupParamsSchema,
  undoable: true,
  run(ctx, p): MakeResult {
    const host = hostOf(ctx);
    const refs = refsOrSelection(host, p.refs);
    return makeDefinition(host, refs, { name: 'Group', isGroup: true, replaceSelection: true, origin: null });
  },
});

/** Make Component (G): like Make Group with a named definition and component behaviors. */
export const componentMake = defineCommand({
  id: 'component.make',
  title: 'Make Component',
  category: 'edit',
  menu: 'Edit',
  keybinding: 'G',
  params: MakeComponentParamsSchema,
  undoable: true,
  run(ctx, p): MakeResult {
    const host = hostOf(ctx);
    const refs = refsOrSelection(host, p.refs);
    const state = host.doc.state;
    const name = p.name !== undefined && p.name.trim() ? uniqueDefinitionName(state, p.name.trim()) : uniqueDefinitionName(state, 'Component#1', false);
    const behaviors: Partial<ComponentBehaviors> = {};
    if (p.glueTo !== undefined) behaviors.glueTo = p.glueTo;
    if (p.cutOpening !== undefined) behaviors.cutsOpening = p.cutOpening;
    if (p.alwaysFaceCamera !== undefined) behaviors.alwaysFaceCamera = p.alwaysFaceCamera;
    if (p.shadowsFaceSun !== undefined) behaviors.shadowsFaceSun = p.shadowsFaceSun;
    const frame = currentFrame(host);
    const axes =
      p.axesOrigin && p.axesX && p.axesY
        ? orthonormalAxes(frame.toLocal(p.axesOrigin), frame.toLocalDir(p.axesX), frame.toLocalDir(p.axesY), p.axesZ ? frame.toLocalDir(p.axesZ) : undefined)
        : null;
    return makeDefinition(host, refs, {
      name,
      isGroup: false,
      description: p.description,
      behaviors,
      replaceSelection: p.replaceSelection,
      origin: p.axesOrigin ? frame.toLocal(p.axesOrigin) : null,
      frame: axes ? m4fromBasis(axes.origin, axes.x, axes.y, axes.z) : undefined,
    });
  },
});

// ---------------------------------------------------------------------------------------------
// Make Components (one per object)

/** Group instances, loose solids and mesh parts: the objects Make Components wraps one by one. */
const GROUP_DEFAULT_NAME = /^Group(?:#\d+)?$/;

/** Objects of the current context that Make Components turns into components, in selection order without repeats. */
export function makeEachTargets(state: DocumentState, container: EntityContainer, refs: readonly EntityRef[]): EntityRef[] {
  const out: EntityRef[] = [];
  const seen = new Set<string>();
  for (const r of refs) {
    const key = `${r.kind}:${r.id}`;
    if (seen.has(key)) continue;
    let eligible = false;
    if (r.kind === 'body') eligible = container.bodies.has(r.id);
    else if (r.kind === 'meshPart') eligible = container.meshParts.has(r.id);
    else if (r.kind === 'instance') {
      const inst = container.instances.get(r.id);
      eligible = inst !== undefined && state.definitions.get(inst.definitionId)?.isGroup === true;
    }
    if (!eligible) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/** Definition name for a new per-object component: the object's own name, or the next `Component#n`. */
function makeEachName(state: DocumentState, container: EntityContainer, r: EntityRef): string {
  let own = '';
  if (r.kind === 'meshPart') own = container.meshParts.get(r.id)?.name ?? '';
  else if (r.kind === 'instance') {
    const inst = container.instances.get(r.id);
    const def = inst && state.definitions.get(inst.definitionId);
    own = inst?.name || (def && !GROUP_DEFAULT_NAME.test(def.name) ? def.name : '');
  }
  own = own.trim();
  return own || uniqueDefinitionName(state, 'Component#1', false);
}

/** Entity refs of `container` at `path` that were not in the `before` snapshot. */
function newEntityRefs(container: EntityContainer, path: readonly Id[], before: ContainerIds): EntityRef[] {
  const out: EntityRef[] = [];
  for (const id of container.bodies.keys()) if (!before.bodies.has(id)) out.push({ kind: 'body', path, id });
  for (const id of container.instances.keys()) if (!before.instances.has(id)) out.push({ kind: 'instance', path, id });
  for (const id of container.sketch.faces.keys()) if (!before.faces.has(id)) out.push({ kind: 'sketchFace', path, id });
  for (const id of container.sketch.edges.keys()) if (!before.edges.has(id)) out.push({ kind: 'sketchEdge', path, id });
  return out;
}

interface ContainerIds {
  readonly bodies: ReadonlySet<Id>;
  readonly instances: ReadonlySet<Id>;
  readonly faces: ReadonlySet<Id>;
  readonly edges: ReadonlySet<Id>;
}

const containerIds = (c: EntityContainer): ContainerIds => ({
  bodies: new Set(c.bodies.keys()),
  instances: new Set(c.instances.keys()),
  faces: new Set(c.sketch.faces.keys()),
  edges: new Set(c.sketch.edges.keys()),
});

export const MakeEachParamsSchema = z.object({
  /** Objects to wrap; the current selection when omitted. */
  refs: refsSchema,
});
export type MakeEachParams = z.infer<typeof MakeEachParamsSchema>;

export interface MakeEachResult {
  readonly definitionIds: number[];
  readonly instanceIds: number[];
  /** Status-bar text: "Made N components". */
  readonly message: string;
}

/**
 * Make Components: one component per selected object. Each loose solid, group instance and mesh
 * part of the current context becomes its own component in the same container, keeping its world
 * placement; the definition is named after the object when it has a name. Components already in
 * the selection are left alone; faces, edges and other kinds are ignored. A mesh part is first made
 * editable, and the solids and sheet faces that come out of it form the component. One undo entry.
 */
export const componentMakeEach = defineCommand({
  id: 'component.makeEach',
  title: 'Make Components',
  description: 'One component per selected object, named after it',
  category: 'edit',
  menu: 'Edit',
  params: MakeEachParamsSchema,
  undoable: true,
  run(ctx, p): MakeEachResult {
    const host = hostOf(ctx);
    const refs = refsOrSelection(host, p.refs);
    const path = host.context.path;
    const targets = makeEachTargets(host.doc.state, containerAt(host.doc.state, path), refs);
    if (targets.length === 0) throw new PushFormError('group.empty', 'Select solids, groups or mesh parts to make components from');
    const definitionIds: number[] = [], instanceIds: number[] = [];
    const meshEditable = targets.some((r) => r.kind === 'meshPart') ? meshEditableOf(ctx) : null;
    host.edit('Make Components', (draft) => {
      const state = draft as unknown as DocumentState;
      for (const target of targets) {
        // Re-read the container each time: the mesh converter may replace its sketch or entity maps.
        const container = draftContainerAt(draft, path);
        const name = makeEachName(state, container, target);
        let refsOf: EntityRef[] = [target];
        if (target.kind === 'meshPart') {
          const before = containerIds(container);
          meshEditable!.makeEditable(draft, path, target.id);
          refsOf = newEntityRefs(draftContainerAt(draft, path), path, before);
          if (refsOf.length === 0) continue;
        }
        const made = makeDefinitionInDraft(draft, path, refsOf, { name, isGroup: false, replaceSelection: true, origin: null });
        definitionIds.push(made.definitionId);
        if (made.instanceId !== null) instanceIds.push(made.instanceId);
      }
    });
    host.selection.set(instanceIds.map((id) => ({ kind: 'instance', path, id: id as Id })));
    const n = instanceIds.length;
    return { definitionIds, instanceIds, message: `Made ${n} component${n === 1 ? '' : 's'}` };
  },
});

// ---------------------------------------------------------------------------------------------
// Explode

/**
 * Explode the selected instances of the current context: their definition's entities move into
 * the current container with the instance transform applied (bodies rigidly or affinely, sketch
 * geometry merging with the container's sketch, nested instances and pictures re-parented with composed
 * transforms, guides, section planes and dimensions mapped; the definition's active section plane
 * becomes the container's when the container has none); the instance is deleted, and so is the definition when nothing
 * else uses it. A painted instance's material moves onto what showed it (face sides, mesh parts and nested instances
 * without a material of their own), so nothing changes color. The exploded entities become the selection.
 */
export const groupExplode = defineCommand({
  id: 'group.explode',
  title: 'Explode',
  category: 'edit',
  params: MakeGroupParamsSchema,
  undoable: true,
  run(ctx, p): ExplodeResult {
    const host = hostOf(ctx);
    const path = host.context.path;
    const refs = refsOrSelection(host, p.refs).filter((r) => r.kind === 'instance');
    const out: EntityRef[] = [];
    const explodedInstanceIds: number[] = [];
    const deletedDefinitionIds: number[] = [];
    if (!refs.length) throw new PushFormError('explode.target', 'Select a group or component to explode');
    host.edit('Explode', (draft) => {
      const state = draft as unknown as DocumentState;
      const container = draftContainerAt(draft, path);
      for (const r of refs) {
        const inst = container.instances.get(r.id);
        if (!inst) continue;
        if (inst.locked) throw new PushFormError('instance.locked', 'A locked group/component cannot be exploded');
        const def = state.definitions.get(inst.definitionId);
        if (!def) continue;
        const sole = instanceCount(state, def.id) === 1;
        const copiedIds = new Map<number, number>();
        const m = inst.transform;
        const map = pointMapFromMatrix(m);
        const inherited = inst.materialId ?? null;
        const defOrder = def.entities.order.length ? def.entities.order : [...def.entities.bodies.keys(), ...def.entities.meshParts.keys(), ...def.entities.instances.keys(), ...def.entities.guides.keys()];

        container.instances.delete(inst.id);
        container.order = container.order.filter((x) => x !== inst.id);
        explodedInstanceIds.push(inst.id);

        for (const id of defOrder) {
          const body = def.entities.bodies.get(id);
          if (body) {
            const copy = copyBodyRecord(body, sole ? body.id : allocId<Id>(draft));
            // before the transform, so texture placements are re-expressed for the material the faces show
            if (inherited !== null && copy.materialId === null) {
              for (const face of copy.faces.values()) {
                face.frontMaterialId ??= inherited;
                face.backMaterialId ??= inherited;
              }
            }
            copiedIds.set(body.id, copy.id);

            transformBodyAffineInPlace(copy, m, textureTiles(draft));
            container.bodies.set(copy.id, copy);
            container.order.push(copy.id);
            out.push({ kind: 'body', path, id: copy.id });
            continue;
          }
          const part = def.entities.meshParts.get(id);
          if (part) {
            const copy = copyMeshPartRecord(part, sole ? part.id : allocId<Id>(draft));
            copy.materialId ??= inherited;
            copy.geometry = transformMeshPartGeometry(part.geometry, m);
            container.meshParts.set(copy.id, copy);
            container.order.push(copy.id);
            out.push({ kind: 'meshPart', path, id: copy.id });
            continue;
          }
          const nested = def.entities.instances.get(id);
          if (nested) {
            const copy: ComponentInstance = {
              ...nested,
              id: sole ? nested.id : allocId<Id>(draft),
              materialId: nested.materialId ?? inherited,
              transform: m4mul(m, nested.transform) as unknown as Mat4,
              attributes: cloneJson(nested.attributes),
            };
            copiedIds.set(nested.id, copy.id);
            container.instances.set(copy.id, copy);
            container.order.push(copy.id);
            out.push({ kind: 'instance', path, id: copy.id });
            continue;
          }
          const guide = def.entities.guides.get(id);
          if (guide) {
            const copy = mapGuide(guide, sole ? guide.id : allocId<Id>(draft), map);
            container.guides.set(copy.id, copy);
            container.order.push(copy.id);
            out.push({ kind: 'guide', path, id: copy.id });
            continue;
          }
          const plane = def.entities.sectionPlanes.get(id);
          if (plane) {
            const copy = mapSectionPlane(plane, sole ? plane.id : allocId<Id>(draft), m);
            container.sectionPlanes.set(copy.id, copy);
            container.order.push(copy.id);
            if (def.entities.activeSectionPlaneId === plane.id && container.activeSectionPlaneId === null) container.activeSectionPlaneId = copy.id;
            out.push({ kind: 'sectionPlane', path, id: copy.id });
            continue;
          }
          const dimension = def.entities.dimensions.get(id);
          if (dimension) {
            const copy = mapDimension(dimension, sole ? dimension.id : allocId<Id>(draft), m);
            container.dimensions.set(copy.id, copy);
            container.order.push(copy.id);
            out.push({ kind: 'dimension', path, id: copy.id });
            continue;
          }
          const image = def.entities.images.get(id);
          if (image) {
            const copy: ImageEntity = { ...image, id: sole ? image.id : allocId<Id>(draft), transform: m4mul(m, image.transform) as unknown as Mat4,
              attributes: cloneJson(image.attributes) };
            container.images.set(copy.id, copy);
            container.order.push(copy.id);
            out.push({ kind: 'image', path, id: copy.id });
          }
        }
        if (def.entities.sketch.edges.size) {
          const g = sketchGraphAt(draft, path);
          const r2 = copySketchInto(draft, def.entities.sketch, 'all', 'all', g, map, inherited);
          const seen = new Set<Id>();
          for (const ids of r2.edgeMap.values()) for (const id of ids) if (!seen.has(id) && seen.add(id)) out.push({ kind: 'sketchEdge', path, id });
          for (const id of r2.faceIds) out.push({ kind: 'sketchFace', path, id });
        }
        const mapIds = pluginIdentityMap(copiedIds);
        const copiedEntries = sole ? new Map() : copyPluginEntries(draft, target => target.kind === 'bodyOccurrence' ? undefined : mapIds(target));
        movePluginTargets(draft, target => {
          if (target.kind !== 'bodyOccurrence') return undefined;
          const index = target.path.indexOf(inst.id);
          if (index < 0) return undefined;
          return { ...target, id: copiedIds.get(target.id) ?? target.id,
            path: [...target.path.slice(0, index), ...target.path.slice(index + 1).map(id => copiedIds.get(id) ?? id)] };
        }, { referencesForMoved: mapIds, copiedEntries });
        reviewPluginTargets(draft, target => (target.kind === 'instance' || target.kind === 'group') && target.id === inst.id || sole && target.kind === 'definition' && target.id === def.id);
        if (sole && def.id !== state.rootDefinitionId) {
          draft.definitions.delete(def.id);
          deletedDefinitionIds.push(def.id);
        }
      }
    });
    host.selection.set(out);
    return { refs: out, explodedInstanceIds, deletedDefinitionIds };
  },
});

// ---------------------------------------------------------------------------------------------
// Make unique

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Deep copy of a definition under a new id, guid and name; nested instances keep their definitions. */
export function cloneDefinition(draft: DocumentDraft, src: ComponentDefinition, name: string, ids = new Map<number, number>()): ComponentDefinition {
  const def = createDefinition(draft, { name, isGroup: src.isGroup, description: src.description, behaviors: { ...src.behaviors } });
  if (src.nativeUnknownFields) def.nativeUnknownFields = { ...src.nativeUnknownFields,
    ...(src.nativeUnknownFields.envelopeUnknown ? { envelopeUnknown: src.nativeUnknownFields.envelopeUnknown.map(bytes => new Uint8Array(bytes)) } : {}),
    ...(src.nativeUnknownFields.extensions ? { extensions: new Map([...src.nativeUnknownFields.extensions].map(([name, fields]) => [name, fields.map(bytes => new Uint8Array(bytes))])) } : {}) };
  ids.set(src.id, def.id);
  def.axes = { origin: mv3(src.axes.origin), x: mv3(src.axes.x), y: mv3(src.axes.y), z: mv3(src.axes.z) };
  const dst = def.entities;
  const identity = pointMapFromMatrix(IDENTITY);
  const order = src.entities.order.length ? src.entities.order : [...src.entities.bodies.keys(), ...src.entities.meshParts.keys(), ...src.entities.instances.keys(), ...src.entities.guides.keys()];
  for (const id of order) {
    const body = src.entities.bodies.get(id);
    if (body) {
      ids.set(body.id, cloneBody(draft, dst, body, ids).id);
      continue;
    }
    const part = src.entities.meshParts.get(id);
    if (part) {
      cloneMeshPart(draft, dst, part);
      continue;
    }
    const inst = src.entities.instances.get(id);
    if (inst) {
      const copy: ComponentInstance = { ...inst, id: allocId<Id>(draft), transform: [...inst.transform] as unknown as Mat4, attributes: cloneJson(inst.attributes) };
      ids.set(inst.id, copy.id);
      dst.instances.set(copy.id, copy);
      dst.order.push(copy.id);
      continue;
    }
    const guide = src.entities.guides.get(id);
    if (guide) {
      const copy = mapGuide(guide, allocId<Id>(draft), identity);
      dst.guides.set(copy.id, copy);
      dst.order.push(copy.id);
      continue;
    }
    const plane = src.entities.sectionPlanes.get(id);
    if (plane) {
      const copy = mapSectionPlane(plane, allocId<Id>(draft), IDENTITY);
      dst.sectionPlanes.set(copy.id, copy);
      dst.order.push(copy.id);
      if (src.entities.activeSectionPlaneId === plane.id) dst.activeSectionPlaneId = copy.id;
      continue;
    }
    const dimension = src.entities.dimensions.get(id);
    if (dimension) {
      const copy = mapDimension(dimension, allocId<Id>(draft), IDENTITY);
      dst.dimensions.set(copy.id, copy);
      dst.order.push(copy.id);
    }
  }
  if (src.entities.sketch.edges.size) copySketchInto(draft, src.entities.sketch, 'all', 'all', SketchGraph.for(draft, def.id), identity);
  return def;
}

/**
 * Make Unique: the selected instances get their own copy of their definition ("Name#n"), so
 * editing them no longer changes the other instances. Instances that already own their
 * definition exclusively are left alone.
 */
export const componentMakeUnique = defineCommand({
  id: 'component.makeUnique',
  title: 'Make Unique',
  category: 'edit',
  params: MakeGroupParamsSchema,
  undoable: true,
  run(ctx, p): MakeUniqueResult {
    const host = hostOf(ctx);
    const path = host.context.path;
    const refs = refsOrSelection(host, p.refs).filter((r) => r.kind === 'instance');
    if (!refs.length) throw new PushFormError('makeUnique.target', 'Select a component instance to make unique');
    const definitions: Record<number, number> = {};
    const created: number[] = [];
    host.edit('Make Unique', (draft) => {
      const state = draft as unknown as DocumentState;
      const container = draftContainerAt(draft, path);
      const byDef = new Map<DefId, ComponentInstance[]>();
      for (const r of refs) {
        const inst = container.instances.get(r.id);
        if (!inst) continue;
        (byDef.get(inst.definitionId) ?? byDef.set(inst.definitionId, []).get(inst.definitionId)!).push(inst);
      }
      for (const [defId, insts] of byDef) {
        const def = state.definitions.get(defId);
        if (!def) continue;
        if (instanceCount(state, defId) <= insts.length) {
          for (const inst of insts) definitions[inst.id] = defId;
          continue;
        }
        const ids = new Map<number, number>();
        const clone = cloneDefinition(draft, def, uniqueDefinitionName(state, def.name, false), ids);
        created.push(clone.id);
        for (const inst of insts) {
          inst.definitionId = clone.id;
          definitions[inst.id] = clone.id;
        }
        const selected = new Set(insts.map(inst => inst.id));
        const map = pluginIdentityMap(ids);
        const copiedEntries = copyPluginEntries(draft, target => target.kind === 'bodyOccurrence' ? undefined : map(target));
        movePluginTargets(draft, target => target.kind === 'bodyOccurrence' && target.path.some(id => selected.has(id as Id)) ? map(target) : undefined, { referencesForMoved: map, copiedEntries });
      }
    });
    return { definitions, createdDefinitionIds: created };
  },
});

/** Validate one captured assembly path without changing the live editing context. */
export function captureContainerOccurrence(host: DocumentHost, path: readonly number[], isolate: boolean): void {
  const state = host.doc.state;
  if (!host.context.path.every((id, index) => path[index] === id)) throw new PushFormError('context.mismatch', 'Choose an assembly inside the current editing context.');
  const prefix: Id[] = [];
  for (const value of path) {
    const id = value as Id, instance = containerAt(state, prefix).instances.get(id);
    if (!instance) throw new PushFormError('part.target', 'The captured assembly no longer exists.');
    if (instance.locked) throw new PushFormError('part.locked', 'Unlock the assembly before editing its parts.');
    if (isolate && prefix.length < host.context.path.length && instanceCount(state, instance.definitionId) > 1)
      throw new PushFormError('context.mismatch', 'Leave this shared assembly before editing only one physical placement.');
    prefix.push(id);
  }
}
/** Validate an explicit physical body without widening it to an enclosing placement. */
export function capturePartOccurrence(host: DocumentHost, ref: EntityRef, isolate: boolean): asserts ref is EntityRef & { kind: 'body' } {
  if (ref.kind !== 'body') throw new PushFormError('part.target', 'Choose one solid part.');
  captureContainerOccurrence(host, ref.path, isolate);
  const body = containerAt(host.doc.state, ref.path).bodies.get(ref.id);
  if (!body) throw new PushFormError('part.target', 'The captured solid no longer exists.');
  if (body.locked) throw new PushFormError('part.locked', 'Unlock the solid before editing it.');
}
export interface ContainerIdentityChange { prefix: Id[]; ids: Map<number, number> }
/** Identity continuation for one physical assembly; return the complete composed ID map for later batch edits. */
export function isolateContainerOccurrence(draft: DocumentDraft, sourcePath: readonly number[], fromDepth = 0): { path: Id[]; ids: Map<number, number>; changes: ContainerIdentityChange[]; isolated: boolean } {
  if (!Number.isInteger(fromDepth) || fromDepth < 0 || fromDepth > sourcePath.length) throw new PushFormError('part.target', 'Invalid physical isolation boundary.');
  const changes: ContainerIdentityChange[] = [];
  const path = sourcePath.map(id => id as Id), continued = new Map<number, number>(); let isolated = false;
  for (let depth = fromDepth; depth < path.length; depth++) {
    const current = draft as unknown as DocumentState, into = path.slice(0, depth);
    const instance = draftContainerAt(draft, into).instances.get(path[depth]!)!;
    if (instanceCount(current, instance.definitionId) <= 1) continue;
    const source = current.definitions.get(instance.definitionId)!, ids = new Map<number, number>();
    const clone = cloneDefinition(draft, source, uniqueDefinitionName(current, source.name, false), ids);
    instance.definitionId = clone.id; isolated = true;
    const selectedPath = path.slice(0, depth + 1), map = pluginIdentityMap(ids);
    changes.push({ prefix: [...selectedPath], ids: new Map(ids) });
    const copiedEntries = copyPluginEntries(draft, target => target.kind === 'bodyOccurrence' ? undefined : map(target));
    movePluginTargets(draft, target => target.kind === 'bodyOccurrence' && selectedPath.every((id, index) => target.path[index] === id) ? map(target) : undefined,
      { referencesForMoved: map, copiedEntries });
    for (const [original, prior] of continued) continued.set(original, ids.get(prior) ?? prior);
    for (const [original, next] of ids) if (!continued.has(original)) continued.set(original, next);
    for (let index = depth + 1; index < path.length; index++) path[index] = (ids.get(path[index]!) ?? path[index]!) as Id;
  }
  return { path, ids: continued, changes, isolated };
}
/** Native identity lifecycle shared by physical-part operations. No payload strings are interpreted. */
export function isolatePartOccurrence(draft: DocumentDraft, ref: EntityRef & { kind: 'body' }): { ref: EntityRef & { kind: 'body' }; isolated: boolean; changes: ContainerIdentityChange[] } {
  const result = isolateContainerOccurrence(draft, ref.path);
  return { ref: { kind: 'body', id: (result.ids.get(ref.id) ?? ref.id) as Id, path: result.path }, isolated: result.isolated, changes:result.changes };
}
export const partIsolate = defineCommand({
  id: 'part.isolate', title: 'Make Part Independent', category: 'internal', undoable: true,
  params: z.object({ ref: EntityRefSchema }),
  run(ctx, p): { ref: EntityRef & { kind: 'body' }; isolated: boolean; changes: ContainerIdentityChange[] } {
    const host = hostOf(ctx), ref = toEntityRefs([p.ref])[0]!; capturePartOccurrence(host, ref, true);
    return host.edit('Make Part Independent', draft => isolatePartOccurrence(draft, ref));
  },
});

// ---------------------------------------------------------------------------------------------
// Rename / lock / hide

const idSchema = z.number().int().nonnegative();

function instanceAtRef(draft: DocumentDraft, r: EntityRef, what: string): ComponentInstance {
  if (r.kind !== 'instance') throw new PushFormError('instance.target', `${what}: not an instance`);
  const inst = draftContainerAt(draft, r.path).instances.get(r.id);
  if (!inst) throw new PushFormError('instance.target', `${what}: instance ${r.id} not found`);
  return inst;
}

export const instanceRename = defineCommand({
  id: 'instance.rename',
  title: 'Rename Instance',
  category: 'edit',
  params: z.object({ ref: EntityRefSchema, name: z.string() }),
  undoable: true,
  run(ctx, p): void {
    const host = hostOf(ctx);
    const [ref] = toEntityRefs([p.ref]);
    host.edit('Rename', (draft) => {
      instanceAtRef(draft, ref!, 'Rename').name = p.name;
    });
  },
});

/** Rename a definition; names are unique across the document (`definition.nameTaken`). */
export const definitionRename = defineCommand({
  id: 'definition.rename',
  title: 'Rename Definition',
  category: 'edit',
  params: z.object({ definitionId: idSchema, name: z.string().min(1) }),
  undoable: true,
  run(ctx, p): void {
    const host = hostOf(ctx);
    host.edit('Rename', (draft) => {
      const state = draft as unknown as DocumentState;
      const def = state.definitions.get(p.definitionId as DefId);
      if (!def) throw new PushFormError('definition.missing', `Definition ${p.definitionId} not found`);
      for (const other of state.definitions.values()) {
        if (other.id !== def.id && other.name === p.name) throw new PushFormError('definition.nameTaken', `A definition named "${p.name}" already exists`);
      }
      def.name = p.name;
    });
  },
});

export const instanceSetLocked = defineCommand({
  id: 'instance.setLocked',
  title: 'Lock',
  category: 'edit',
  params: z.object({ refs: z.array(EntityRefSchema), locked: z.boolean() }),
  undoable: true,
  run(ctx, p): number {
    const host = hostOf(ctx);
    let n = 0;
    host.edit(p.locked ? 'Lock' : 'Unlock', (draft) => {
      for (const r of toEntityRefs(p.refs)) {
        if (r.kind !== 'instance') continue;
        const inst = draftContainerAt(draft, r.path).instances.get(r.id);
        if (!inst) continue;
        inst.locked = p.locked;
        n++;
      }
    });
    return n;
  },
});

export const instanceSetHidden = defineCommand({
  id: 'instance.setHidden',
  title: 'Hide',
  category: 'edit',
  params: z.object({ refs: z.array(EntityRefSchema), hidden: z.boolean() }),
  undoable: true,
  run(ctx, p): number {
    const host = hostOf(ctx);
    let n = 0;
    host.edit(p.hidden ? 'Hide' : 'Unhide', (draft) => {
      for (const r of toEntityRefs(p.refs)) {
        if (r.kind !== 'instance') continue;
        const inst = draftContainerAt(draft, r.path).instances.get(r.id);
        if (!inst) continue;
        inst.hidden = p.hidden;
        n++;
      }
    });
    return n;
  },
});

/** Hide or show loose solids and mesh parts; hidden ones leave the selection, as nothing hidden can stay picked. */
export const bodiesSetHidden = defineCommand({
  id: 'bodies.setHidden',
  title: 'Hide',
  category: 'edit',
  params: z.object({ refs: z.array(EntityRefSchema), hidden: z.boolean() }),
  undoable: true,
  run(ctx, p): number {
    const host = hostOf(ctx);
    const refs = toEntityRefs(p.refs).filter((r) => r.kind === 'body' || r.kind === 'meshPart');
    let n = 0;
    host.edit(p.hidden ? 'Hide' : 'Unhide', (draft) => {
      for (const r of refs) {
        const container = draftContainerAt(draft, r.path);
        const target = r.kind === 'body' ? container.bodies.get(r.id) : container.meshParts.get(r.id);
        if (!target) continue;
        target.hidden = p.hidden;
        n++;
      }
    });
    if (p.hidden && n) host.selection.remove(refs);
    return n;
  },
});

/**
 * Cast Shadows / Receive Shadows on solids, mesh parts, groups and components. An instance's setting also governs
 * everything inside it.
 */
export const entitySetShadows = defineCommand({
  id: 'entity.setShadows',
  title: 'Shadows',
  category: 'edit',
  params: z.object({ refs: z.array(EntityRefSchema), cast: z.boolean().optional(), receive: z.boolean().optional() }),
  undoable: true,
  run(ctx, p): number {
    const host = hostOf(ctx);
    let n = 0;
    host.edit(p.cast === false || p.receive === false ? 'Turn Off Shadows' : 'Turn On Shadows', (draft) => {
      for (const r of toEntityRefs(p.refs)) {
        if (r.kind !== 'instance' && r.kind !== 'body' && r.kind !== 'meshPart') continue;
        const container = draftContainerAt(draft, r.path);
        const target = r.kind === 'instance' ? container.instances.get(r.id) : r.kind === 'body' ? container.bodies.get(r.id) : container.meshParts.get(r.id);
        if (!target) continue;
        if (p.cast !== undefined) target.castShadows = p.cast;
        if (p.receive !== undefined) target.receiveShadows = p.receive;
        n++;
      }
    });
    return n;
  },
});

export const groupCommands: readonly AnyCommand[] = [
  groupMake,
  componentMake,
  componentMakeEach,
  groupExplode,
  componentMakeUnique,
  partIsolate,
  instanceRename,
  definitionRename,
  instanceSetLocked,
  instanceSetHidden,
  bodiesSetHidden,
  entitySetShadows,
];

// ---------------------------------------------------------------------------------------------
// Entity Info

export interface InstanceInfo {
  readonly instanceId: number;
  readonly definitionId: number;
  readonly definitionName: string;
  readonly instanceName: string;
  readonly isGroup: boolean;
  /** Instances of the definition in the whole document. */
  readonly instanceCount: number;
  readonly locked: boolean;
  readonly hidden: boolean;
  /** World axis-aligned bounds of the instance, or null when empty. */
  readonly bounds: Box3 | null;
  readonly bodyCount: number;
  /** True when the definition holds at least one body and every body is a valid solid. */
  readonly solid: boolean;
  /** Sum of the body volumes in world units (scaled by the instance and context transforms), or null when not solid. */
  readonly volume: number | null;
}

/** Entity Info for a group/component instance (any context path). Throws when the ref is not an instance. */
export function instanceInfo(state: DocumentState, ref: EntityRef): InstanceInfo {
  if (ref.kind !== 'instance') throw new PushFormError('instance.target', 'Not an instance');
  const inst = containerAt(state, ref.path).instances.get(ref.id);
  if (!inst) throw new PushFormError('instance.target', `Instance ${ref.id} not found`);
  const def = state.definitions.get(inst.definitionId);
  if (!def) throw new PushFormError('definition.missing', `Definition ${inst.definitionId} not found`);
  const world = m4mul(contextMatrix(state, ref.path), inst.transform);
  const lb = definitionBounds(state, def.id);
  let bounds: Box3 | null = null;
  if (lb) {
    const b = box3Empty();
    for (let i = 0; i < 8; i++) {
      const corner: Vec3 = [i & 1 ? lb.max[0] : lb.min[0], i & 2 ? lb.max[1] : lb.min[1], i & 4 ? lb.max[2] : lb.min[2]];
      box3Expand(b, m4transformPoint(world, corner));
    }
    bounds = b;
  }
  const bodies = [...def.entities.bodies.values()];
  const solid = bodies.length > 0 && bodies.every((b) => b.valid);
  const scale = Math.abs(m4linearDeterminant(world));
  const volume = solid ? bodies.reduce((sum, b) => sum + b.props.volume, 0) * scale : null;
  return {
    instanceId: inst.id,
    definitionId: def.id,
    definitionName: def.name,
    instanceName: inst.name,
    isGroup: def.isGroup,
    instanceCount: instanceCount(state, def.id),
    locked: inst.locked,
    hidden: inst.hidden,
    bounds,
    bodyCount: bodies.length,
    solid,
    volume,
  };
}

/** World bounds of an instance's definition (helper for tools). */
export function instanceWorldBounds(state: DocumentState, path: readonly Id[], instanceId: Id): Box3 | null {
  try {
    return instanceInfo(state, { kind: 'instance', path, id: instanceId }).bounds;
  } catch {
    return null;
  }
}

