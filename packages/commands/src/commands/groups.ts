// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import type { Box3, CurveId, DefId, Id, Mat4, MMat4, MVec3, Vec3 } from '@pushform/core';
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
import { allocId, containerAt, contextMatrix, createEntityContainer, DEFAULT_AXES, DEFAULT_BEHAVIORS, imageEntityCorners, loopKey, SketchGraph, textureTiles, uvRebaseSides } from '@pushform/model';
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
import { hostOf } from '../host/services';
import { contextFrame, currentFrame, draftContainerAt, refsInContext, requireContextPath, sketchGraphAt } from './context';
import { orthonormalAxes } from './axes';
import { glueFaceAt } from './componentBehaviors';
import { EntityRefSchema } from './sketch';
import { mapNormal, mapSectionPlane } from './sectionPlanes';
import { cloneBody, copyBodyRecord, definitionBounds, m4linearDeterminant, toEntityRefs, transformBodyAffineInPlace, transformBodyInPlace } from './transform';

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
 */
export function copySketchInto(
  draft: DocumentDraft,
  src: Sketch,
  edgeIds: ReadonlySet<Id> | 'all',
  faceIds: ReadonlySet<Id> | 'all',
  dst: SketchGraph,
  map: PointMap,
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
    // texture placements keep each mapped point's texture coordinates in the new basis
    const sides = uvRebaseSides(f, f.basis, basis, tiles(f.frontMaterialId), tiles(f.backMaterialId), (p) => map.point(p));
    const id = dst.alloc<Id>();
    const face: SketchFace = {
      id,
      plane,
      basis,
      loops,
      frontMaterialId: f.frontMaterialId,
      backMaterialId: f.backMaterialId,
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
  readonly instances: Id[];
  readonly guides: Id[];
  readonly images: Id[];
  readonly edges: Set<Id>;
  readonly faces: Set<Id>;
  readonly size: number;
}

/**
 * Entities of a container a group/component is made from: bodies (a face/edge ref selects its
 * solid), instances, guides, sketch faces (with their edges) and sketch edges (faces bounded
 * only by selected edges come along).
 */
function collect(container: EntityContainer, refs: readonly EntityRef[]): Collected {
  const bodies = new Set<Id>(), instances = new Set<Id>(), guides = new Set<Id>(), images = new Set<Id>();
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
      case 'instance':
        if (container.instances.has(r.id)) instances.add(r.id);
        break;
      case 'guide':
        if (container.guides.has(r.id)) guides.add(r.id);
        break;
      case 'image':
        if (container.images.has(r.id)) images.add(r.id);
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
    instances: [...instances],
    guides: [...guides],
    images: [...images],
    edges,
    faces,
    size: bodies.size + instances.size + guides.size + images.size + edges.size,
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
  const state = host.doc.state;
  const srcState = containerAt(state, path);
  const collected = collect(srcState, refs);
  if (collected.size === 0) throw new PushFormError('group.empty', 'Select something to make a group or component from');
  const bounds = collectedBounds(state, srcState, collected);
  const origin: Vec3 = opts.origin ?? bounds?.min ?? [0, 0, 0];
  const frame: MMat4 = opts.frame ?? m4translation(origin);
  const toLocal: MMat4 = m4invert(frame) ?? m4translation([-origin[0], -origin[1], -origin[2]]);
  const localMap = pointMapFromMatrix(toLocal);
  const move = opts.replaceSelection;
  let instanceId: number | null = null;
  let definitionId = 0;

  host.edit(opts.isGroup ? 'Make Group' : 'Make Component', (draft) => {
    const src = draftContainerAt(draft, path);
    const def = createDefinition(draft, opts);
    definitionId = def.id;
    const dst = def.entities;
    const removed = new Set<Id>();

    // bodies
    for (const id of collected.bodies) {
      const body = src.bodies.get(id);
      if (!body) continue;
      const target = move ? copyBodyRecord(body, body.id) : cloneBody(draft, dst, body);
      transformBodyInPlace(target, toLocal, textureTiles(draft));
      if (move) {
        src.bodies.delete(id);
        removed.add(id);
        dst.bodies.set(target.id, target);
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
    }
  });
  if (instanceId !== null) host.selection.set([{ kind: 'instance', path, id: instanceId as Id }]);
  return { definitionId, instanceId };
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
// Explode

/**
 * Explode the selected instances of the current context: their definition's entities move into
 * the current container with the instance transform applied (bodies rigidly or affinely, sketch
 * geometry merging with the container's sketch, nested instances and pictures re-parented with composed
 * transforms, guides, section planes and dimensions mapped; the definition's active section plane
 * becomes the container's when the container has none); the instance is deleted, and so is the definition when nothing
 * else uses it. The exploded entities become the selection.
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
        const m = inst.transform;
        const map = pointMapFromMatrix(m);
        const defOrder = def.entities.order.length ? def.entities.order : [...def.entities.bodies.keys(), ...def.entities.instances.keys(), ...def.entities.guides.keys()];

        container.instances.delete(inst.id);
        container.order = container.order.filter((x) => x !== inst.id);
        explodedInstanceIds.push(inst.id);

        for (const id of defOrder) {
          const body = def.entities.bodies.get(id);
          if (body) {
            const copy = copyBodyRecord(body, sole ? body.id : allocId<Id>(draft));
            transformBodyAffineInPlace(copy, m, textureTiles(draft));
            container.bodies.set(copy.id, copy);
            container.order.push(copy.id);
            out.push({ kind: 'body', path, id: copy.id });
            continue;
          }
          const nested = def.entities.instances.get(id);
          if (nested) {
            const copy: ComponentInstance = {
              ...nested,
              id: sole ? nested.id : allocId<Id>(draft),
              transform: m4mul(m, nested.transform) as unknown as Mat4,
              attributes: cloneJson(nested.attributes),
            };
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
          const r2 = copySketchInto(draft, def.entities.sketch, 'all', 'all', g, map);
          const seen = new Set<Id>();
          for (const ids of r2.edgeMap.values()) for (const id of ids) if (!seen.has(id) && seen.add(id)) out.push({ kind: 'sketchEdge', path, id });
          for (const id of r2.faceIds) out.push({ kind: 'sketchFace', path, id });
        }
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
export function cloneDefinition(draft: DocumentDraft, src: ComponentDefinition, name: string): ComponentDefinition {
  const def = createDefinition(draft, { name, isGroup: src.isGroup, description: src.description, behaviors: { ...src.behaviors } });
  def.axes = { origin: mv3(src.axes.origin), x: mv3(src.axes.x), y: mv3(src.axes.y), z: mv3(src.axes.z) };
  const dst = def.entities;
  const identity = pointMapFromMatrix(IDENTITY);
  const order = src.entities.order.length ? src.entities.order : [...src.entities.bodies.keys(), ...src.entities.instances.keys(), ...src.entities.guides.keys()];
  for (const id of order) {
    const body = src.entities.bodies.get(id);
    if (body) {
      cloneBody(draft, dst, body);
      continue;
    }
    const inst = src.entities.instances.get(id);
    if (inst) {
      const copy: ComponentInstance = { ...inst, id: allocId<Id>(draft), transform: [...inst.transform] as unknown as Mat4, attributes: cloneJson(inst.attributes) };
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
        const clone = cloneDefinition(draft, def, uniqueDefinitionName(state, def.name, false));
        created.push(clone.id);
        for (const inst of insts) {
          inst.definitionId = clone.id;
          definitions[inst.id] = clone.id;
        }
      }
    });
    return { definitions, createdDefinitionIds: created };
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

/** Hide or show loose solids; hidden ones leave the selection, as nothing hidden can stay picked. */
export const bodiesSetHidden = defineCommand({
  id: 'bodies.setHidden',
  title: 'Hide',
  category: 'edit',
  params: z.object({ refs: z.array(EntityRefSchema), hidden: z.boolean() }),
  undoable: true,
  run(ctx, p): number {
    const host = hostOf(ctx);
    const refs = toEntityRefs(p.refs).filter((r) => r.kind === 'body');
    let n = 0;
    host.edit(p.hidden ? 'Hide' : 'Unhide', (draft) => {
      for (const r of refs) {
        const body = draftContainerAt(draft, r.path).bodies.get(r.id);
        if (!body) continue;
        body.hidden = p.hidden;
        n++;
      }
    });
    if (p.hidden && n) host.selection.remove(refs);
    return n;
  },
});

/**
 * Cast Shadows / Receive Shadows on solids, groups and components. An instance's setting also governs
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
        if (r.kind !== 'instance' && r.kind !== 'body') continue;
        const container = draftContainerAt(draft, r.path);
        const target = r.kind === 'instance' ? container.instances.get(r.id) : container.bodies.get(r.id);
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
  groupExplode,
  componentMakeUnique,
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

