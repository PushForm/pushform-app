// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import type { Box3, DefId, FaceLocalId, Id, ImageId, Mat4, MaterialId, MMat4, TagId, Vec3 } from '@pushform/core';
import {
  basisToWorld,
  box3Empty,
  box3Expand,
  box3IsEmpty,
  m4identity,
  m4invert,
  m4mul,
  m4transformPoint,
  m4translation,
  meshBounds,
  newGuid,
  PushFormError,
} from '@pushform/core';
import {
  allocId,
  containerAt,
  contextMatrix,
  createDocumentState,
  createEntityContainer,
  createSketch,
  definitionAt,
  meshPartBounds,
  SketchGraph,
  textureTiles,
  uniqueMaterialName,
} from '@pushform/model';
import type {
  Body,
  ComponentDefinition,
  ComponentInstance,
  DocumentDraft,
  DocumentState,
  EdgeKey,
  EntityRef,
  ImageBlob,
  ImageStore,
  LoopRef,
  Material,
  Sketch,
  SketchEdge,
} from '@pushform/model';
import type { CameraState } from '../camera/CameraHost';
import { defineCommand } from '../registry/Command';
import type { AnyCommand, CommandContext } from '../registry/Command';
import { DocumentHost } from '../host/DocumentHost';
import { hostOf, SERVICE_DOCUMENT } from '../host/services';
import { draftContainerAt, refsInContext, sketchGraphAt } from './context';
import { cloneDefinition, copySketchInto, mapGuide, pointMapFromMatrix, uniqueDefinitionName } from './groups';
import { deleteSelection, type DeleteResult } from './sketch';
import { copyBodyRecord, copyMeshPartRecord, definitionBounds, transformBodyAffineInPlace, transformMeshPartGeometry } from './transform';

/** Where the copied model is stored, so Layout can show it in a view. */
export interface ModelClipboardSource {
  /** Cloud document id. */
  readonly documentId: string;
  readonly name: string;
}

/** What Copy puts on the clipboard: a small model holding the copied entities in world coordinates. */
export interface ModelClipboard {
  /** Identifies this copy, so a paste can tell its own clipboard data from another window's. */
  readonly id: string;
  /** The root definition holds the copied entities; the other definitions are the ones its groups and components use. */
  readonly state: DocumentState;
  /** Bytes of the textures in `state.images`. */
  readonly images: ReadonlyMap<ImageId, ImageBlob>;
  readonly bounds: Box3;
  /** Where the cursor holds the copy while pasting. */
  readonly insertionPoint: Vec3;
  /** The camera of the view it was copied in, for a Layout view of it. */
  readonly camera: CameraState | null;
  readonly source: ModelClipboardSource | null;
  /** Selected items that were not copied (texts, dimensions, section planes, images). */
  readonly skipped: number;
}

/** The current copy; every model tab of a window shares one. */
export class ModelClipboardStore {
  private value: ModelClipboard | null = null;
  private readonly listeners = new Set<() => void>();
  get current(): ModelClipboard | null {
    return this.value;
  }
  set(clip: ModelClipboard | null): void {
    this.value = clip;
    for (const l of this.listeners) l();
  }
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const modelClipboard = new ModelClipboardStore();
/** Service key for a `ModelClipboardStore` (tests); the shared `modelClipboard` otherwise. */
export const SERVICE_MODEL_CLIPBOARD = 'modelClipboard';
/** Service key for a `() => ModelClipboardSource | null` the UI installs for its model tab. */
export const SERVICE_MODEL_SOURCE = 'modelSource';

export function clipboardOf(ctx: CommandContext): ModelClipboardStore {
  const store = ctx.services.get(SERVICE_MODEL_CLIPBOARD);
  return store instanceof ModelClipboardStore ? store : modelClipboard;
}

const cloneJson = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const isIdentity = (m: MMat4 | Mat4): boolean => m.every((v, i) => v === (i % 5 === 0 ? 1 : 0));

// ---------------------------------------------------------------------------------------------
// Id rewriting

interface IdMaps {
  tag(id: TagId): TagId;
  material(id: MaterialId | null): MaterialId | null;
  definition(id: DefId): DefId;
}

/** Rewrite every tag, material and definition id the entities of `state` refer to. */
function rewriteIds(state: DocumentState, maps: IdMaps): void {
  for (const def of state.definitions.values()) {
    const c = def.entities;
    for (const b of c.bodies.values()) {
      b.tagId = maps.tag(b.tagId);
      b.materialId = maps.material(b.materialId);
      for (const f of b.faces.values()) {
        f.tagId = maps.tag(f.tagId);
        f.frontMaterialId = maps.material(f.frontMaterialId);
        f.backMaterialId = maps.material(f.backMaterialId);
      }
      for (const e of b.edges.values()) e.tagId = maps.tag(e.tagId);
    }
    for (const part of c.meshParts.values()) {
      part.tagId = maps.tag(part.tagId);
      part.materialId = maps.material(part.materialId);
    }
    for (const i of c.instances.values()) {
      i.tagId = maps.tag(i.tagId);
      i.materialId = maps.material(i.materialId);
      i.definitionId = maps.definition(i.definitionId);
    }
    for (const e of c.sketch.edges.values()) e.tagId = maps.tag(e.tagId);
    for (const f of c.sketch.faces.values()) {
      f.tagId = maps.tag(f.tagId);
      f.frontMaterialId = maps.material(f.frontMaterialId);
      f.backMaterialId = maps.material(f.backMaterialId);
    }
    for (const g of c.guides.values()) g.tagId = maps.tag(g.tagId);
    for (const s of c.sectionPlanes.values()) s.tagId = maps.tag(s.tagId);
    for (const d of c.dimensions.values()) d.tagId = maps.tag(d.tagId);
    for (const t of c.texts.values()) t.tagId = maps.tag(t.tagId);
    for (const im of c.images.values()) im.tagId = maps.tag(im.tagId);
  }
}

// ---------------------------------------------------------------------------------------------
// Copy

interface BodyParts {
  readonly faces: Set<FaceLocalId>;
  readonly edges: Set<EdgeKey>;
  readonly imprints: [FaceLocalId, number][];
}

const pointKey = (p: Vec3): string => `${p[0]},${p[1]},${p[2]}`;

/**
 * Selected faces and edges of a solid as a standalone sketch in the body's coordinates:
 * each face with its loops, edges with their flags, and edges drawn on faces.
 */
function bodyPartsSketch(body: Body, parts: BodyParts, defaultTagId: TagId): Sketch {
  const sketch = createSketch();
  let next = 1;
  const vertices = new Map<string, Id>();
  const vertex = (p: Vec3): Id => {
    const k = pointKey(p);
    let id = vertices.get(k);
    if (id === undefined) {
      id = next++ as Id;
      vertices.set(k, id);
      sketch.vertices.set(id, { id, p: [p[0], p[1], p[2]] });
    }
    return id;
  };
  // flags of the solid's edges by segment, so copied face boundaries stay soft or hidden
  const flags = new Map<string, { soft: boolean; smooth: boolean; hidden: boolean; tagId: TagId }>();
  const segmentKey = (a: Vec3, b: Vec3): string => [pointKey(a), pointKey(b)].sort().join('|');
  for (const e of body.edges.values()) {
    for (let i = 0; i + 1 < e.polyline.length; i++) flags.set(segmentKey(e.polyline[i]!, e.polyline[i + 1]!), e);
  }
  const edges = new Map<string, Id>();
  const edge = (p: Vec3, q: Vec3, attrs?: { soft: boolean; smooth: boolean; hidden: boolean; tagId: TagId }): LoopRef | null => {
    const a = vertex(p), b = vertex(q);
    if (a === b) return null;
    const k = a < b ? `${a}:${b}` : `${b}:${a}`;
    let id = edges.get(k);
    if (id === undefined) {
      id = next++ as Id;
      edges.set(k, id);
      const f = attrs ?? flags.get(segmentKey(p, q));
      const e: SketchEdge = {
        id, a, b, soft: f?.soft ?? false, smooth: f?.smooth ?? false, curveId: null,
        tagId: f?.tagId ?? defaultTagId, hidden: f?.hidden ?? false, locked: false, castShadows: true, receiveShadows: true, attributes: {},
      };
      sketch.edges.set(id, e);
    }
    return { edgeId: id, forward: sketch.edges.get(id)!.a === a };
  };
  for (const fid of parts.faces) {
    const f = body.faces.get(fid);
    if (!f) continue;
    const loops: LoopRef[][] = [];
    for (const loop of f.loops) {
      const refs: LoopRef[] = [];
      for (let i = 0; i < loop.length; i++) {
        const r = edge(loop[i]!, loop[(i + 1) % loop.length]!);
        if (r) refs.push(r);
      }
      if (refs.length >= 3) loops.push(refs);
    }
    if (!loops.length) continue;
    const id = next++ as Id;
    sketch.faces.set(id, {
      id, plane: f.plane, basis: f.basis, loops,
      frontMaterialId: f.frontMaterialId ?? body.materialId, backMaterialId: f.backMaterialId,
      uv: cloneJson(f.uv), ...(f.uvBack ? { uvBack: cloneJson(f.uvBack) } : {}),
      tagId: f.tagId, hidden: f.hidden, locked: false, castShadows: true, receiveShadows: true, attributes: {},
    });
  }
  for (const key of parts.edges) {
    const e = body.edges.get(key);
    if (!e) continue;
    for (let i = 0; i + 1 < e.polyline.length; i++) edge(e.polyline[i]!, e.polyline[i + 1]!, e);
  }
  for (const [fid, eid] of parts.imprints) {
    const f = body.faces.get(fid), g = body.imprints.get(fid), e = g?.edges.get(eid);
    const a = e && g?.vertices.get(e.a), b = e && g?.vertices.get(e.b);
    if (!f || !e || !a || !b) continue;
    edge(basisToWorld(f.basis, a[0], a[1]), basisToWorld(f.basis, b[0], b[1]), { soft: e.soft, smooth: e.smooth, hidden: e.hidden, tagId: f.tagId });
  }
  return sketch;
}

/** Root-container refs of a clipboard model (its copied entities). */
export function clipboardRefs(clip: ModelClipboard): EntityRef[] {
  const c = containerAt(clip.state, []);
  return [
    ...[...c.bodies.keys()].map((id): EntityRef => ({ kind: 'body', path: [], id })),
    ...[...c.meshParts.keys()].map((id): EntityRef => ({ kind: 'meshPart', path: [], id })),
    ...[...c.instances.keys()].map((id): EntityRef => ({ kind: 'instance', path: [], id })),
    ...[...c.sketch.edges.keys()].map((id): EntityRef => ({ kind: 'sketchEdge', path: [], id })),
    ...[...c.guides.keys()].map((id): EntityRef => ({ kind: 'guide', path: [], id })),
  ];
}

/** Bounding-box corners of each copied entity, in world coordinates: what a Layout view of the copy frames. */
export function clipboardExtentPoints(clip: ModelClipboard): Vec3[] {
  const state = clip.state;
  const c = containerAt(state, []);
  const out: Vec3[] = [];
  const corners = (b: Box3, m?: Mat4): void => {
    for (let i = 0; i < 8; i++) {
      const p: Vec3 = [i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]];
      out.push(m ? m4transformPoint(m, p) : p);
    }
  };
  for (const b of c.bodies.values()) {
    const mb = meshBounds(b.mesh);
    if (!box3IsEmpty(mb)) corners(mb);
  }
  for (const part of c.meshParts.values()) {
    const pb = meshPartBounds(part.geometry);
    if (pb) corners(pb);
  }
  for (const inst of c.instances.values()) {
    const lb = definitionBounds(state, inst.definitionId);
    if (lb) corners(lb, inst.transform);
  }
  for (const v of c.sketch.vertices.values()) out.push(v.p);
  for (const g of c.guides.values()) {
    out.push(g.origin);
    if (g.kind === 'segment') out.push(g.end);
  }
  return out;
}

function boundsOf(points: readonly Vec3[]): Box3 | null {
  const b = box3Empty();
  for (const p of points) box3Expand(b, p);
  return box3IsEmpty(b) ? null : b;
}

/**
 * Copy the entities `refs` of the container at `path` into a clipboard model in world
 * coordinates, or null when nothing among them can be copied.
 */
export function copyModelSelection(
  state: DocumentState,
  path: readonly Id[],
  refs: readonly EntityRef[],
  opts: { images?: ImageStore | null; camera?: CameraState | null; source?: ModelClipboardSource | null } = {},
): ModelClipboard | null {
  const container = containerAt(state, path);
  const world = contextMatrix(state, path);
  const identity = isIdentity(world);
  const map = pointMapFromMatrix(world);
  const tiles = textureTiles(state);

  // The clipboard model keeps the source's ids; ids it allocates start past them.
  const base = createDocumentState();
  const baseRoot = base.definitions.get(base.rootDefinitionId)!;
  const root: ComponentDefinition = { ...baseRoot, id: state.rootDefinitionId, entities: createEntityContainer() };
  const out: DocumentState = {
    ...base,
    meta: { ...base.meta, nextId: state.meta.nextId, units: { ...state.meta.units } },
    definitions: new Map([[root.id, root]]),
    rootDefinitionId: root.id,
    tags: structuredClone(state.tags),
    tagFolders: new Map(),
    defaultTagId: state.defaultTagId,
    materials: structuredClone(state.materials),
    defaultMaterialId: state.defaultMaterialId,
    images: new Map(),
  };
  const draft = out as unknown as DocumentDraft;
  const dst = root.entities;
  const graph = new SketchGraph(dst.sketch, <T extends number = Id>() => allocId<T>(out), out.defaultTagId);

  let skipped = 0;
  const bodies = new Set<Id>(), meshParts = new Set<Id>(), instances = new Set<Id>(), guides = new Set<Id>();
  const edges = new Set<Id>(), faces = new Set<Id>();
  const parts = new Map<Id, BodyParts>();
  const partsOf = (id: Id): BodyParts => parts.get(id) ?? parts.set(id, { faces: new Set(), edges: new Set(), imprints: [] }).get(id)!;
  for (const r of refs) {
    switch (r.kind) {
      case 'body':
        if (container.bodies.has(r.id)) bodies.add(r.id);
        break;
      case 'meshPart':
        if (container.meshParts.has(r.id)) meshParts.add(r.id);
        break;
      case 'face':
        if (container.bodies.has(r.id)) partsOf(r.id).faces.add(r.faceId);
        break;
      case 'edge':
        if (container.bodies.has(r.id)) partsOf(r.id).edges.add(r.edgeKey);
        break;
      case 'imprintEdge':
        if (container.bodies.has(r.id)) partsOf(r.id).imprints.push([r.faceId, r.edgeId]);
        break;
      case 'instance':
        if (container.instances.has(r.id)) instances.add(r.id);
        break;
      case 'guide':
        if (container.guides.has(r.id)) guides.add(r.id);
        break;
      case 'sketchEdge':
        if (container.sketch.edges.has(r.id)) edges.add(r.id);
        break;
      case 'sketchFace': {
        const f = container.sketch.faces.get(r.id);
        if (!f) break;
        faces.add(r.id);
        for (const loop of f.loops) for (const ref of loop) edges.add(ref.edgeId);
        break;
      }
      case 'sketchVertex':
        break;
      default:
        skipped++;
    }
  }
  for (const f of container.sketch.faces.values()) {
    if (faces.has(f.id) || !f.loops.length) continue;
    if (f.loops.every((loop) => loop.every((ref) => edges.has(ref.edgeId)))) faces.add(f.id);
  }
  for (const id of bodies) parts.delete(id);

  const copyDefinition = (id: DefId): void => {
    if (out.definitions.has(id)) return;
    const def = state.definitions.get(id);
    if (!def) return;
    out.definitions.set(id, structuredClone(def));
    for (const inst of def.entities.instances.values()) copyDefinition(inst.definitionId);
  };
  const order = container.order.length ? container.order : [...container.bodies.keys(), ...container.meshParts.keys(), ...container.instances.keys(), ...container.guides.keys()];
  for (const id of order) {
    if (bodies.has(id)) {
      const copy = copyBodyRecord(container.bodies.get(id)!, id);
      if (!identity) transformBodyAffineInPlace(copy, world, tiles);
      dst.bodies.set(id, copy);
      dst.order.push(id);
    } else if (meshParts.has(id)) {
      const copy = copyMeshPartRecord(container.meshParts.get(id)!, id);
      if (!identity) copy.geometry = transformMeshPartGeometry(copy.geometry, world);
      dst.meshParts.set(id, copy);
      dst.order.push(id);
    } else if (instances.has(id)) {
      const inst = container.instances.get(id)!;
      const copy: ComponentInstance = { ...inst, transform: m4mul(world, inst.transform) as unknown as Mat4, attributes: cloneJson(inst.attributes) };
      dst.instances.set(id, copy);
      dst.order.push(id);
      copyDefinition(inst.definitionId);
    } else if (guides.has(id)) {
      dst.guides.set(id, mapGuide(container.guides.get(id)!, id, map));
      dst.order.push(id);
    }
  }
  if (edges.size) copySketchInto(draft, container.sketch, edges, faces, graph, map);
  for (const [id, p] of parts) {
    const body = container.bodies.get(id)!;
    copySketchInto(draft, bodyPartsSketch(body, p, state.defaultTagId), 'all', 'all', graph, map);
  }

  // keep only the tags, materials and textures the copy uses
  const usedTags = new Set<TagId>([out.defaultTagId]), usedMaterials = new Set<MaterialId>([out.defaultMaterialId]);
  rewriteIds(out, {
    tag: (t) => (usedTags.add(t), t),
    material: (m) => (m !== null && usedMaterials.add(m), m),
    definition: (d) => d,
  });
  for (const id of [...out.tags.keys()]) if (!usedTags.has(id)) out.tags.delete(id);
  for (const id of [...out.materials.keys()]) if (!usedMaterials.has(id)) out.materials.delete(id);
  for (const tag of out.tags.values()) tag.folderId = null;
  const blobs = new Map<ImageId, ImageBlob>();
  for (const m of out.materials.values()) {
    const imageId = m.texture?.imageId;
    const asset = imageId === undefined ? undefined : state.images.get(imageId);
    if (!asset) continue;
    out.images.set(asset.id, { ...asset });
    const blob = opts.images?.get(asset.id);
    if (blob) blobs.set(asset.id, blob);
  }

  const clip: ModelClipboard = {
    id: newGuid(),
    state: out,
    images: blobs,
    bounds: { min: [0, 0, 0], max: [0, 0, 0] },
    insertionPoint: [0, 0, 0],
    camera: opts.camera ?? null,
    source: opts.source ?? null,
    skipped,
  };
  const bounds = boundsOf(clipboardExtentPoints(clip));
  if (!bounds) return null;
  const lone = dst.instances.size === 1 && !dst.bodies.size && !dst.meshParts.size && !dst.sketch.edges.size && !dst.guides.size ? [...dst.instances.values()][0] : undefined;
  const insertionPoint: Vec3 = lone ? [lone.transform[12]!, lone.transform[13]!, lone.transform[14]!] : [bounds.min[0], bounds.min[1], bounds.min[2]];
  return { ...clip, bounds, insertionPoint };
}

// ---------------------------------------------------------------------------------------------
// Paste

const sameColor = (a: Material, b: Material): boolean => a.color.every((v, i) => v === b.color[i]) && a.alpha === b.alpha;
/** Whether existing material `a` stands for pasted `b`: same color, opacity and texture, and `b`'s name or that name as `Name#n` from an earlier paste. */
function sameMaterial(a: Material, b: Material): boolean {
  if ((a.name !== b.name && a.name.replace(/#\d+$/, '') !== b.name) || !sameColor(a, b)) return false;
  if (!a.texture || !b.texture) return a.texture === b.texture;
  return a.texture.imageId === b.texture.imageId && a.texture.widthM === b.texture.widthM && a.texture.heightM === b.texture.heightM && a.texture.colorize === b.texture.colorize &&
    (a.texture.colorizeType ?? 'shift') === (b.texture.colorizeType ?? 'shift');
}

/**
 * Insert a clipboard model into the container at `path`, moved by `placement`
 * (a world-space transform; identity pastes in place). Returns the pasted entities.
 */
export function pasteModelClipboard(draft: DocumentDraft, clip: ModelClipboard, path: readonly Id[], placement: MMat4 | Mat4, images?: ImageStore | null): EntityRef[] {
  const target = draft as unknown as DocumentState;
  const src = structuredClone(clip.state);

  const tagMap = new Map<TagId, TagId>([[src.defaultTagId, target.defaultTagId]]);
  for (const tag of src.tags.values()) {
    if (tagMap.has(tag.id)) continue;
    const same = [...target.tags.values()].find((t) => t.name === tag.name);
    if (same) {
      tagMap.set(tag.id, same.id);
      continue;
    }
    const id = allocId<TagId>(draft);
    target.tags.set(id, { ...tag, id, folderId: null });
    tagMap.set(tag.id, id);
  }

  const imageMap = new Map<ImageId, ImageId>();
  for (const asset of src.images.values()) {
    const blob = clip.images.get(asset.id);
    const same = asset.sha256 ? [...target.images.values()].find((a) => a.sha256 === asset.sha256) : undefined;
    if (same) {
      imageMap.set(asset.id, same.id);
      if (blob && images && !images.has(same.id)) images.register(same, blob.bytes, blob.mime);
      continue;
    }
    const id = allocId<ImageId>(draft);
    const copy = { ...asset, id };
    target.images.set(id, copy);
    imageMap.set(asset.id, id);
    if (blob && images) images.register(copy, blob.bytes, blob.mime);
  }

  const materialMap = new Map<MaterialId, MaterialId>([[src.defaultMaterialId, target.defaultMaterialId]]);
  for (const m of src.materials.values()) {
    if (materialMap.has(m.id)) continue;
    const candidate: Material = { ...m, texture: m.texture ? { ...m.texture, imageId: imageMap.get(m.texture.imageId) ?? m.texture.imageId } : null };
    const same = [...target.materials.values()].find((t) => sameMaterial(t, candidate));
    if (same) {
      materialMap.set(m.id, same.id);
      continue;
    }
    const id = allocId<MaterialId>(draft);
    target.materials.set(id, { ...candidate, id, name: uniqueMaterialName(target, m.name) });
    materialMap.set(m.id, id);
  }

  rewriteIds(src, {
    tag: (t) => tagMap.get(t) ?? target.defaultTagId,
    material: (m) => (m === null ? null : (materialMap.get(m) ?? null)),
    definition: (d) => d,
  });

  // definitions: an existing copy of the same definition is reused, others are added
  const defMap = new Map<DefId, DefId>();
  const created: DefId[] = [];
  for (const def of src.definitions.values()) {
    if (def.id === src.rootDefinitionId) continue;
    const same = [...target.definitions.values()].find((d) => d.guid === def.guid && d.id !== target.rootDefinitionId);
    if (same) {
      defMap.set(def.id, same.id);
      continue;
    }
    const copy = cloneDefinition(draft, def, uniqueDefinitionName(target, def.name));
    copy.guid = def.guid;
    defMap.set(def.id, copy.id);
    created.push(copy.id);
  }
  for (const id of created) {
    for (const inst of target.definitions.get(id)!.entities.instances.values()) inst.definitionId = defMap.get(inst.definitionId) ?? inst.definitionId;
  }

  const srcRoot = src.definitions.get(src.rootDefinitionId)!.entities;
  // A group or component cannot end up inside itself.
  const enclosing = new Set<DefId>(path.map((_, i) => definitionAt(target, path.slice(0, i + 1)).id));
  const seen = new Set<DefId>();
  const reaches = (id: DefId): boolean => {
    if (enclosing.has(id)) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    const def = target.definitions.get(id);
    return !!def && [...def.entities.instances.values()].some((i) => reaches(i.definitionId));
  };
  for (const inst of srcRoot.instances.values()) {
    if (reaches(defMap.get(inst.definitionId) ?? inst.definitionId)) {
      throw new PushFormError('paste.recursive', 'A group or component cannot be pasted inside itself');
    }
  }

  const contextInverse = m4invert(contextMatrix(target, path));
  if (!contextInverse) throw new PushFormError('context.singular', 'The open group or component cannot be pasted into');
  const m = m4mul(contextInverse, placement);
  const identity = isIdentity(m);
  const map = pointMapFromMatrix(m);
  const tiles = textureTiles(target);
  const container = draftContainerAt(draft, path);
  const pasted: EntityRef[] = [];
  const order = srcRoot.order.length ? srcRoot.order : [...srcRoot.bodies.keys(), ...srcRoot.meshParts.keys(), ...srcRoot.instances.keys(), ...srcRoot.guides.keys()];
  for (const sid of order) {
    const body = srcRoot.bodies.get(sid);
    if (body) {
      const copy = copyBodyRecord(body, allocId<Id>(draft));
      copy.version = 0;
      if (!identity) transformBodyAffineInPlace(copy, m, tiles);
      container.bodies.set(copy.id, copy);
      container.order.push(copy.id);
      pasted.push({ kind: 'body', path, id: copy.id });
      continue;
    }
    const part = srcRoot.meshParts.get(sid);
    if (part) {
      const copy = copyMeshPartRecord(part, allocId<Id>(draft));
      copy.locked = false;
      // the clone above copied the arrays; the pasted part shares the clipboard's immutable geometry instead
      const geometry = containerAt(clip.state, []).meshParts.get(sid)!.geometry;
      copy.geometry = identity ? geometry : transformMeshPartGeometry(geometry, m);
      container.meshParts.set(copy.id, copy);
      container.order.push(copy.id);
      pasted.push({ kind: 'meshPart', path, id: copy.id });
      continue;
    }
    const inst = srcRoot.instances.get(sid);
    if (inst) {
      const copy: ComponentInstance = {
        ...inst,
        id: allocId<Id>(draft),
        definitionId: defMap.get(inst.definitionId) ?? inst.definitionId,
        transform: m4mul(m, inst.transform) as unknown as Mat4,
        locked: false,
      };
      container.instances.set(copy.id, copy);
      container.order.push(copy.id);
      pasted.push({ kind: 'instance', path, id: copy.id });
      continue;
    }
    const guide = srcRoot.guides.get(sid);
    if (guide) {
      const copy = mapGuide(guide, allocId<Id>(draft), map);
      container.guides.set(copy.id, copy);
      container.order.push(copy.id);
      pasted.push({ kind: 'guide', path, id: copy.id });
    }
  }
  if (srcRoot.sketch.edges.size) {
    const r = copySketchInto(draft, srcRoot.sketch, 'all', 'all', sketchGraphAt(draft, path), map);
    const seenEdges = new Set<Id>();
    for (const ids of r.edgeMap.values()) for (const id of ids) if (!seenEdges.has(id) && seenEdges.add(id)) pasted.push({ kind: 'sketchEdge', path, id });
    for (const id of r.faceIds) pasted.push({ kind: 'sketchFace', path, id });
  }
  return pasted;
}

// ---------------------------------------------------------------------------------------------
// Commands

function hasSelection(ctx: CommandContext): boolean {
  const h = ctx.services.get(SERVICE_DOCUMENT);
  return h instanceof DocumentHost && !h.selection.isEmpty;
}
const hasClipboard = (ctx: CommandContext): boolean => clipboardOf(ctx).current !== null;

export interface CopyResult {
  readonly skipped: number;
  readonly message: string | null;
}

function copySelection(ctx: CommandContext): CopyResult {
  const host = hostOf(ctx);
  const sourceOf = ctx.services.get(SERVICE_MODEL_SOURCE);
  const source = typeof sourceOf === 'function' ? ((sourceOf as () => ModelClipboardSource | null)() ?? null) : null;
  const clip = copyModelSelection(host.doc.state, host.context.path, refsInContext(host, host.selection.refs), {
    images: host.images,
    camera: ctx.camera?.getState() ?? null,
    source,
  });
  if (!clip) throw new PushFormError('copy.empty', 'Nothing in the selection can be copied');
  clipboardOf(ctx).set(clip);
  const n = clip.skipped;
  return { skipped: n, message: n ? `${n} item${n === 1 ? '' : 's'} not copied: texts, dimensions, section planes and images cannot be copied yet.` : null };
}

function pasteWith(ctx: CommandContext, label: string, placement: (clip: ModelClipboard) => MMat4): EntityRef[] {
  const host = hostOf(ctx);
  const clip = clipboardOf(ctx).current;
  if (!clip) throw new PushFormError('paste.empty', 'Nothing to paste');
  const path = host.context.path;
  let refs: EntityRef[] = [];
  host.edit(label, (draft) => {
    refs = pasteModelClipboard(draft, clip, path, placement(clip), host.images);
  });
  host.selection.set(refs);
  return refs;
}

/** Copy the selection to the clipboard every model tab shares. */
export const editCopy = defineCommand({
  id: 'edit.copy',
  title: 'Copy',
  category: 'edit',
  icon: 'copy',
  menu: 'Edit',
  keybinding: 'Mod+C',
  params: z.object({}),
  undoable: false,
  when: hasSelection,
  run: (ctx): CopyResult => copySelection(ctx),
});

/** Copy, then erase what Delete erases, as one undoable action. */
export const editCut = defineCommand({
  id: 'edit.cut',
  title: 'Cut',
  category: 'edit',
  icon: 'cut',
  menu: 'Edit',
  keybinding: 'Mod+X',
  params: z.object({}),
  undoable: true,
  when: hasSelection,
  run(ctx): CopyResult & { deleted: DeleteResult } {
    const copied = copySelection(ctx);
    const deleted = deleteSelection.run(ctx, {}) as DeleteResult;
    return { ...copied, message: [copied.message, deleted.message].filter(Boolean).join(' ') || null, deleted };
  },
});

/** Attach the copy to the cursor; the Paste tool places it with a click. */
export const editPaste = defineCommand({
  id: 'edit.paste',
  title: 'Paste',
  category: 'edit',
  icon: 'paste',
  menu: 'Edit',
  keybinding: 'Mod+V',
  params: z.object({}),
  undoable: false,
  when: hasClipboard,
  run(ctx) {
    if (!clipboardOf(ctx).current) throw new PushFormError('paste.empty', 'Nothing to paste');
    ctx.tools?.activate('paste');
  },
});

/** Place the copy so its insertion point lands on `point` (the Paste tool's click). */
export const editPasteAt = defineCommand({
  id: 'edit.pasteAt',
  title: 'Paste',
  category: 'internal',
  params: z.object({ point: z.tuple([z.number(), z.number(), z.number()]) }),
  undoable: true,
  when: hasClipboard,
  run: (ctx, p): EntityRef[] =>
    pasteWith(ctx, 'Paste', (clip) => m4translation([p.point[0] - clip.insertionPoint[0], p.point[1] - clip.insertionPoint[1], p.point[2] - clip.insertionPoint[2]])),
});

/** Paste where the copy came from. */
export const editPasteInPlace = defineCommand({
  id: 'edit.pasteInPlace',
  title: 'Paste In Place',
  category: 'edit',
  icon: 'paste',
  menu: 'Edit',
  params: z.object({}),
  undoable: true,
  when: hasClipboard,
  run: (ctx): EntityRef[] => pasteWith(ctx, 'Paste In Place', () => m4identity()),
});

export const clipboardCommands: readonly AnyCommand[] = [editCopy, editCut, editPaste, editPasteAt, editPasteInPlace];
