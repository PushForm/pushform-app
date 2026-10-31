// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { M4_IDENTITY, basisToWorld, m4invert, m4mul, m4transformDir, m4transformPoint, planeBasis, v3cross, v3dot, v3len, v3normalize, v3scale, v3sub } from '@pushform/core';
import type { Box3, Id, Mat4, MMat4, MaterialId, MeshData, PlaneBasis, TagId, Vec3 } from '@pushform/core';
import { DEFAULT_FOG, DEFAULT_SHADOWS } from '@pushform/model';
import { solarPosition, sunDirection } from '@pushform/render';
import type { RenderFog, RenderShadows } from '@pushform/render';
import { containerAt, contentWorldBounds, contextMatrix, dimensionDrawing, dimensionText, imageEntityCorners, imprintEdgesWorld, pathKey, resolveDimension, sketchFaceLoops, tagVisible, walkInstances } from '@pushform/model';
import type { Body, ComponentDefinition, DocumentState, EntityContainer, EntityRef, ImageEntity, ImageStore, Material, MeshPart, MeshPartGeometry, Sketch, Style, UvMapping } from '@pushform/model';
import { DEFAULT_RENDER_BACKGROUND, renderKey } from '@pushform/render';
import type {
  EntityHighlight,
  HighlightState,
  RenderAxes,
  RenderBackground,
  RenderBody,
  RenderText,
  RenderTexts,
  RenderFaceCamera,
  RenderBodyEdge,
  RenderBodySurface,
  RenderDisplay,
  RenderEditContext,
  RenderFaceMaterial,
  RenderDimension,
  RenderDimensions,
  RenderGuides,
  RenderImage,
  RenderMaterial,
  RenderSketch,
} from '@pushform/render';
import { rgbToCss } from './format';

// --- materials (materials agent) ----------------------------------------------------------------

/** Image bytes behind texture URLs (`DocumentHost.images`); set by the bootstrap via `setRenderImageStore`. */
let renderImages: ImageStore | null = null;

/** Point the adapter at the host's image store (texture object URLs). */
export function setRenderImageStore(store: ImageStore | null): void {
  if (renderImages === store) return;
  renderImages = store;
  renderMaterialCache = new WeakMap();
}

/** Run `fn` against another image store (an offscreen document), restoring the host's afterwards. */
export function withRenderImageStore<T>(store: ImageStore, fn: () => T): T {
  const previous = renderImages;
  setRenderImageStore(store);
  try {
    return fn();
  } finally {
    setRenderImageStore(previous);
  }
}

export interface RenderAdapterOptions {
  /** Image store for texture URLs (default: the one given to `setRenderImageStore`). */
  readonly images?: ImageStore | undefined;
  /** Live UV mappings while the Position Texture tool drags (`uvOverrideKey(ref)` → mapping). */
  readonly uvOverrides?: ReadonlyMap<string, UvMapping> | undefined;
}

/** Key of a face / sketch face in `RenderAdapterOptions.uvOverrides`. */
export function uvOverrideKey(ref: EntityRef): string | null {
  if (ref.kind === 'face') return `${renderKey(ref.path, ref.id)}#${ref.faceId}`;
  if (ref.kind === 'sketchFace') return `sketch:${pathKey(ref.path)}/${ref.id}`;
  return null;
}

// RenderMaterial objects are identity-stable per (materials map, image store) so the renderer's
// face material diff only fires when a material really changed.
let renderMaterialCache = new WeakMap<DocumentState['materials'], Map<MaterialId, RenderMaterial>>();

/** A model material → what the renderer needs (CSS color, alpha, texture URL and size). Cached per materials map. */
export function renderMaterial(state: DocumentState, id: MaterialId | null, images: ImageStore | null = renderImages): RenderMaterial | null {
  if (id === null || id === state.defaultMaterialId) return null;
  const m: Material | undefined = state.materials.get(id);
  if (!m) return null;
  let perMap = renderMaterialCache.get(state.materials);
  if (!perMap) renderMaterialCache.set(state.materials, (perMap = new Map()));
  const cached = perMap.get(id);
  if (cached) return cached;
  const out: RenderMaterial = { id: m.id, color: rgbToCss(m.color), alpha: m.alpha };
  if (m.texture) {
    const url = images?.objectUrl(m.texture.imageId);
    Object.assign(out, { widthM: m.texture.widthM, heightM: m.texture.heightM,
      ...(m.texture.colorize ? { colorize: m.texture.colorizeType ?? 'shift' } : {}), ...(url ? { textureUrl: url } : {}) });
  }
  perMap.set(id, out);
  return out;
}

interface FaceMaterialsEntry {
  readonly materials: DocumentState['materials'];
  readonly bodyMaterial: MaterialId | null;
  readonly inherited: RenderMaterial | null;
  readonly images: ImageStore | null;
  readonly out: ReadonlyMap<number, RenderFaceMaterial>;
}
const faceMaterialsCache = new WeakMap<Body['faces'], FaceMaterialsEntry>();

/**
 * Per-face materials of a body: each face's front/back material resolved through the body
 * material and the inherited instance material (`inherited`), with its UV mapping and basis.
 * Cached per faces map while the material map, the body material and the inherited material are
 * unchanged, so the renderer rebuilds a body only when a face material really changed.
 */
export function faceMaterialsToRender(
  state: DocumentState,
  body: Body,
  inherited: RenderMaterial | null,
  opts: RenderAdapterOptions = {},
  path: readonly Id[] = [],
): ReadonlyMap<number, RenderFaceMaterial> {
  const images = opts.images ?? renderImages;
  const overrides = opts.uvOverrides;
  const prefix = `${renderKey(path, body.id)}#`;
  const overridden = overrides && overrides.size > 0 ? [...overrides.keys()].some((k) => k.startsWith(prefix)) : false;
  const cached = faceMaterialsCache.get(body.faces);
  if (!overridden && cached && cached.materials === state.materials && cached.bodyMaterial === body.materialId && cached.inherited === inherited && cached.images === images) {
    return cached.out;
  }
  const bodyMat = renderMaterial(state, body.materialId, images) ?? inherited;
  const out = new Map<number, RenderFaceMaterial>();
  for (const f of body.faces.values()) {
    const front = renderMaterial(state, f.frontMaterialId, images) ?? bodyMat;
    const back = renderMaterial(state, f.backMaterialId, images) ?? bodyMat;
    const uv = (overridden ? overrides!.get(`${prefix}${f.id}`) : undefined) ?? f.uv;
    if (front === null && back === null && uv.kind === 'auto') continue;
    out.set(f.id, { front, back, uv, ...(f.uvBack ? { uvBack: f.uvBack } : {}), basis: f.basis });
  }
  if (!overridden) faceMaterialsCache.set(body.faces, { materials: state.materials, bodyMaterial: body.materialId, inherited, images, out });
  return out;
}

// The renderer diffs `edges` / `surfaces` by identity, so the arrays are cached per immutable
// model Map (immer keeps untouched maps' identity across transactions).
const edgeCache = new WeakMap<Body['edges'], RenderBodyEdge[]>();
const surfaceCache = new WeakMap<Body['surfaces'], RenderBodySurface[]>();
const hiddenFaceCache = new WeakMap<Body['faces'], ReadonlySet<number>>();

function hiddenBodyFaces(body: Body): ReadonlySet<number> {
  const cached = hiddenFaceCache.get(body.faces);
  if (cached) return cached;
  const ids = new Set<number>();
  for (const face of body.faces.values()) if (face.hidden) ids.add(face.id);
  hiddenFaceCache.set(body.faces, ids);
  return ids;
}

/** Body `EdgeRecord`s → renderer edge polylines with flags and the adjacent face pair (cached per map). */
export function bodyEdgesToRender(body: Body): RenderBodyEdge[] {
  let out = edgeCache.get(body.edges);
  if (!out) {
    out = [];
    for (const e of body.edges.values()) {
      out.push({ points: e.polyline, soft: e.soft, smooth: e.smooth, hidden: e.hidden, faceA: e.faceA, faceB: e.faceB });
    }
    edgeCache.set(body.edges, out);
  }
  return out;
}

// --- mesh parts ---------------------------------------------------------------------------------
// A mesh part's packed arrays are drawn as a body mesh is (MOD3820). The derived objects are
// cached per immutable geometry object, so the renderer's identity diffing sees no change until
// the geometry is replaced.
const meshPartMeshCache = new WeakMap<MeshPartGeometry, MeshData>();
const meshPartEdgeCache = new WeakMap<MeshPartGeometry, RenderBodyEdge[]>();
const meshPartSurfaceCache = new WeakMap<MeshPartGeometry, RenderBodySurface[]>();
interface MeshPartMaterialsEntry { materials: DocumentState['materials']; partMaterial: MaterialId | null; inherited: RenderMaterial | null; images: ImageStore | null; out: ReadonlyMap<number, RenderFaceMaterial> }
const meshPartMaterialCache = new WeakMap<MeshPartGeometry, MeshPartMaterialsEntry>();
const UNIT_BASIS: PlaneBasis = { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] };

export function meshPartMeshToRender(g: MeshPartGeometry): MeshData {
  let out = meshPartMeshCache.get(g);
  if (!out) { out = { verts: g.positions, tris: g.triangles, faceId: g.triangleFace }; meshPartMeshCache.set(g, out); }
  return out;
}
/** The part's source edges as renderer polylines; soft and smooth come from the packed flags, and no face pair is known. */
export function meshPartEdgesToRender(g: MeshPartGeometry): RenderBodyEdge[] {
  let out = meshPartEdgeCache.get(g);
  if (!out) {
    out = [];
    const edges = g.edgeOffsets.length ? g.edgeOffsets.length - 1 : 0;
    for (let e = 0; e < edges; e++) {
      const points: Vec3[] = [];
      for (let i = g.edgeOffsets[e]!; i < g.edgeOffsets[e + 1]!; i++) points.push([g.edgePositions[i * 3]!, g.edgePositions[i * 3 + 1]!, g.edgePositions[i * 3 + 2]!]);
      const flags = g.edgeFlags[e]!;
      out.push({ points, soft: !!(flags & 1), smooth: !!(flags & 2), hidden: false, faceA: -1, faceB: -1 });
    }
    meshPartEdgeCache.set(g, out);
  }
  return out;
}
/** Each source face shades smoothly across its own facets (a curved surface's facets average; a flat face is unchanged). */
export function meshPartSurfacesToRender(g: MeshPartGeometry): RenderBodySurface[] {
  let out = meshPartSurfaceCache.get(g);
  if (!out) {
    const counts = new Uint32Array(g.faceCount);
    for (const f of g.triangleFace) counts[f]!++;
    out = [];
    for (let f = 0; f < g.faceCount; f++) if (counts[f]! > 1) out.push({ faceIds: [f] });
    meshPartSurfaceCache.set(g, out);
  }
  return out;
}
/** Per source face materials of a mesh part: faces with a color of their own, both sides alike, with no texture placement. */
export function meshPartFaceMaterialsToRender(state: DocumentState, part: MeshPart, inherited: RenderMaterial | null, opts: RenderAdapterOptions = {}): ReadonlyMap<number, RenderFaceMaterial> {
  const g = part.geometry, images = opts.images ?? renderImages;
  const cached = meshPartMaterialCache.get(g);
  if (cached && cached.materials === state.materials && cached.partMaterial === part.materialId && cached.inherited === inherited && cached.images === images) return cached.out;
  const partMaterial = renderMaterial(state, part.materialId, images) ?? inherited;
  const out = new Map<number, RenderFaceMaterial>();
  for (let f = 0; f < g.faceCount; f++) {
    const id = g.faceMaterials[f]!;
    if (!id) continue;
    const material = renderMaterial(state, id as MaterialId, images) ?? partMaterial;
    if (material) out.set(f, { front: material, back: material, uv: { kind: 'auto' }, basis: UNIT_BASIS });
  }
  meshPartMaterialCache.set(g, { materials: state.materials, partMaterial: part.materialId, inherited, images, out });
  return out;
}

/** Body `SurfaceRecord`s → smooth face groups (cached per map). */
export function bodySurfacesToRender(body: Body): RenderBodySurface[] {
  let out = surfaceCache.get(body.surfaces);
  if (!out) {
    out = [];
    for (const s of body.surfaces.values()) out.push({ faceIds: s.faceIds });
    surfaceCache.set(body.surfaces, out);
  }
  return out;
}

export { tagVisible };

/** CSS color of a material, or undefined for the default material / an unknown id. */
export function materialColor(state: DocumentState, id: MaterialId | null): string | undefined {
  if (id === null) return undefined;
  const m = state.materials.get(id);
  return m ? rgbToCss(m.color) : undefined;
}

// --- instances ----------------------------------------------------------------------------------

/** A visible instance with its world matrix and the color default-material faces inherit. */
export interface RenderInstance {
  readonly path: readonly Id[];
  readonly key: string;
  readonly definition: ComponentDefinition;
  /** local→world matrix of the definition's entities (identity-stable while unchanged). */
  readonly matrix: Mat4;
  /** Inherited instance material color (own material, else the nearest painted ancestor). */
  readonly color: string | undefined;
  /** Inherited instance material (own, else the nearest painted ancestor), for per-face materials. */
  readonly material?: RenderMaterial | null | undefined;
  /** Whether its contents may cast / receive shadows: off when it or any enclosing instance turns them off. */
  readonly castShadows?: boolean | undefined;
  readonly receiveShadows?: boolean | undefined;
  /** The turn of the outermost enclosing placement (itself included) that Always Faces Camera. */
  readonly faceCamera?: RenderFaceCamera | undefined;
}

/** Always Face Camera of a placement with world matrix `m`: about its blue axis through its origin, front along −green. */
function faceCameraOf(m: Mat4, shadowsFaceSun: boolean): RenderFaceCamera {
  const green = m4transformDir(m, [0, 1, 0]);
  return { pivot: m4transformPoint(m, [0, 0, 0]), axis: v3normalize(m4transformDir(m, [0, 0, 1])), front: v3normalize([-green[0], -green[1], -green[2]]), shadowsFaceSun };
}

// World matrices are rebuilt by `walkInstances` on every call; the renderer diffs `transform` by
// identity, so the previous matrix is reused while its values are unchanged.
let matrixCache = new Map<string, Mat4>();
const instanceCache = new WeakMap<DocumentState, RenderInstance[]>();

function sameMatrix(a: Mat4, b: MMat4): boolean {
  for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Every instance to draw, depth first with accumulated transforms. Hidden instances (own flag or
 * tag) are skipped together with everything inside them. Cached per document state.
 */
export function instancesToRender(state: DocumentState): RenderInstance[] {
  const cached = instanceCache.get(state);
  if (cached) return cached;
  const out: RenderInstance[] = [];
  const hidden = new Set<string>();
  const colors = new Map<string, string | undefined>();
  const materials = new Map<string, RenderMaterial | null>();
  const shadows = new Map<string, { cast: boolean; receive: boolean }>();
  const facing = new Map<string, RenderFaceCamera>();
  const next = new Map<string, Mat4>();
  for (const v of walkInstances(state)) {
    const key = pathKey(v.path);
    const parentKey = pathKey(v.path.slice(0, -1));
    if (hidden.has(parentKey) || v.instance.hidden || !tagVisible(state, v.instance.tagId)) {
      hidden.add(key);
      continue;
    }
    const prev = matrixCache.get(key);
    const matrix = prev && sameMatrix(prev, v.matrix) ? prev : (v.matrix as unknown as Mat4);
    next.set(key, matrix);
    const color = (colorByTagOn(state) ? tagColor(state, v.instance.tagId) : undefined) ?? materialColor(state, v.instance.materialId) ?? colors.get(parentKey);
    colors.set(key, color);
    const material = renderMaterial(state, v.instance.materialId) ?? materials.get(parentKey) ?? null;
    materials.set(key, material);
    const parent = shadows.get(parentKey) ?? { cast: true, receive: true };
    const shadow = { cast: parent.cast && v.instance.castShadows !== false, receive: parent.receive && v.instance.receiveShadows !== false };
    shadows.set(key, shadow);
    const behaviors = v.definition.behaviors;
    const faceCamera = facing.get(parentKey) ?? (!v.definition.isGroup && behaviors.alwaysFaceCamera ? faceCameraOf(matrix, behaviors.shadowsFaceSun) : undefined);
    if (faceCamera) facing.set(key, faceCamera);
    out.push({ path: v.path, key, definition: v.definition, matrix, color, material, castShadows: shadow.cast, receiveShadows: shadow.receive, faceCamera });
  }
  matrixCache = next;
  instanceCache.set(state, out);
  return out;
}

function pushBodies(
  out: RenderBody[],
  state: DocumentState,
  path: readonly Id[],
  container: EntityContainer,
  transform: Mat4,
  inherited: string | undefined,
  inheritedMaterial: RenderMaterial | null = null,
  opts: RenderAdapterOptions = {},
  shadows: { cast: boolean; receive: boolean } = { cast: true, receive: true },
  faceCamera?: RenderFaceCamera,
): void {
  for (const body of container.bodies.values()) {
    if (body.hidden || !tagVisible(state, body.tagId)) continue;
    out.push({
      faceMaterials: faceMaterialsToRender(state, body, inheritedMaterial, opts, path),
      hiddenFaces: hiddenBodyFaces(body),
      id: renderKey(path, body.id),
      path,
      entityId: body.id,
      version: body.version,
      mesh: body.mesh,
      transform,
      edges: taggedBodyEdges(state, body),
      surfaces: bodySurfacesToRender(body),
      defaultColor: (colorByTagOn(state) ? tagColor(state, body.tagId) : undefined) ?? materialColor(state, body.materialId) ?? inherited,
      castShadows: shadows.cast && body.castShadows !== false,
      receiveShadows: shadows.receive && body.receiveShadows !== false,
      ...(faceCamera ? { faceCamera } : {}),
    });
  }
  for (const part of container.meshParts.values()) {
    if (part.hidden || !tagVisible(state, part.tagId)) continue;
    out.push({
      faceMaterials: meshPartFaceMaterialsToRender(state, part, inheritedMaterial, opts),
      id: renderKey(path, part.id),
      path,
      entityId: part.id,
      mesh: meshPartMeshToRender(part.geometry),
      transform,
      // Without source edges the renderer draws the boundaries between source faces instead.
      edges: part.geometry.edgeFlags.length ? meshPartEdgesToRender(part.geometry) : undefined,
      surfaces: meshPartSurfacesToRender(part.geometry),
      defaultColor: (colorByTagOn(state) ? tagColor(state, part.tagId) : undefined) ?? materialColor(state, part.materialId) ?? inherited,
      castShadows: shadows.cast && part.castShadows !== false,
      receiveShadows: shadows.receive && part.receiveShadows !== false,
      ...(faceCamera ? { faceCamera } : {}),
    });
  }
}

/**
 * Flatten the root container and every visible instance into what the renderer draws. Bodies in
 * instances carry the instance chain's world matrix; default-material faces take the body's
 * material color, else the instance's. Hidden bodies/instances and tag-hidden ones are skipped.
 */
export function bodiesToRender(state: DocumentState, opts: RenderAdapterOptions = {}): RenderBody[] {
  const root = state.definitions.get(state.rootDefinitionId);
  if (!root) return [];
  if (opts.images) setRenderImageStore(opts.images);
  const out: RenderBody[] = [];
  pushBodies(out, state, [], root.entities, M4_IDENTITY, undefined, null, opts);
  for (const inst of instancesToRender(state)) pushBodies(out, state, inst.path, inst.definition.entities, inst.matrix, inst.color, inst.material ?? null, opts,
    { cast: inst.castShadows !== false, receive: inst.receiveShadows !== false }, inst.faceCamera);
  return out;
}

interface ImageCacheEntry { readonly key: string; readonly matrix: Mat4 | null; readonly url: string | null; readonly cast: boolean; readonly receive: boolean; readonly out: RenderImage }
/** Per image entity, its recent placements (one per instance path, and per document a view draws it in). */
const imageCache = new WeakMap<ImageEntity, ImageCacheEntry[]>();
const IMAGE_CACHE_PLACEMENTS = 32;

/**
 * Placed pictures of the root and of every visible instance, in world coordinates. Hidden pictures, pictures
 * on hidden tags and those inside hidden instances are skipped. A picture whose entity, placement, image URL and shadow
 * flags are unchanged keeps its `RenderImage` object, so the renderer rebuilds only what changed.
 */
export function imagesToRender(state: DocumentState, images: ImageStore | null = renderImages): RenderImage[] {
  const root = state.definitions.get(state.rootDefinitionId);
  if (!root) return [];
  const out: RenderImage[] = [];
  const push = (path: readonly Id[], container: EntityContainer, matrix: Mat4 | null, shadows: { cast: boolean; receive: boolean }) => {
    for (const image of container.images.values()) {
      if (image.hidden || !tagVisible(state, image.tagId)) continue;
      const key = renderKey(path, image.id);
      const url = images?.objectUrl(image.imageId) ?? null;
      const cast = shadows.cast && image.castShadows !== false, receive = shadows.receive && image.receiveShadows !== false;
      let entries = imageCache.get(image);
      if (!entries) imageCache.set(image, entries = []);
      let entry = entries.find(e => e.key === key && e.matrix === matrix && e.url === url && e.cast === cast && e.receive === receive);
      if (!entry) {
        entry = { key, matrix, url, cast, receive,
          out: { key, path, entityId: image.id, transform: matrix ? (m4mul(matrix, image.transform) as unknown as Mat4) : image.transform,
            widthM: image.widthM, heightM: image.heightM, textureUrl: url, castShadows: cast, receiveShadows: receive } };
        entries.push(entry);
        if (entries.length > IMAGE_CACHE_PLACEMENTS) entries.shift();
      }
      out.push(entry.out);
    }
  };
  push([], root.entities, null, { cast: true, receive: true });
  for (const inst of instancesToRender(state)) {
    if (inst.definition.entities.images.size) push(inst.path, inst.definition.entities, inst.matrix, { cast: inst.castShadows !== false, receive: inst.receiveShadows !== false });
  }
  return out;
}

type GuideSource = readonly [EntityContainer['guides'], Mat4 | null];
const guideCache = new WeakMap<object, { tags: DocumentState['tags']; folders: DocumentState['tagFolders']; sources: GuideSource[]; out: RenderGuides }>();

/**
 * Guides of the root context and of every visible instance (in world coordinates) → `RenderGuides`
 * (hidden guides skipped), so every guide the inference index offers is drawn. Cached per root guides
 * Map identity and the instance guide Maps and world matrices, so the renderer's identity diff only
 * rebuilds when a transaction touched guides or moved an instance holding them.
 */
export function guidesToRender(state: DocumentState): RenderGuides {
  const root = state.definitions.get(state.rootDefinitionId);
  const guides = root?.entities.guides;
  if (!guides) return { lines: [], points: [] };
  const sources: GuideSource[] = [[guides, null]];
  for (const inst of instancesToRender(state)) if (inst.definition.entities.guides.size) sources.push([inst.definition.entities.guides, inst.matrix]);
  const cached = guideCache.get(guides);
  if (cached && cached.tags === state.tags && cached.folders === state.tagFolders && cached.sources.length === sources.length &&
    cached.sources.every(([g, m], i) => g === sources[i]![0] && m === sources[i]![1])) return cached.out;
  const lines: { id: number; p: Vec3; dir: Vec3 }[] = [];
  const points: { id: number; p: Vec3 }[] = [];
  const segments: { id: number; a: Vec3; b: Vec3 }[] = [];
  for (const [source, m] of sources) for (const g of source.values()) {
    if (g.hidden || !tagVisible(state, g.tagId)) continue;
    const p = (v: Vec3): Vec3 => (m ? m4transformPoint(m, v) : v);
    switch (g.kind) {
      case 'line':
        lines.push({ id: g.id, p: p(g.origin), dir: m ? v3normalize(m4transformDir(m, g.dir)) : g.dir });
        break;
      case 'point':
        points.push({ id: g.id, p: p(g.origin) });
        break;
      case 'segment':
        segments.push({ id: g.id, a: p(g.origin), b: p(g.end) });
        break;
    }
  }
  const out: RenderGuides = { lines, points, segments };
  guideCache.set(guides, { tags: state.tags, folders: state.tagFolders, sources, out });
  return out;
}

let dimensionCache: { state: DocumentState; selection: readonly EntityRef[]; out: RenderDimensions } | null = null;

/**
 * Every visible dimension at every placement, at the points its attachments give now, with the text
 * in the model's units; selected ones are flagged. The result is reused while the state and selection are.
 */
export function dimensionsToRender(state: DocumentState, selection: readonly EntityRef[] = []): RenderDimensions {
  if (dimensionCache && dimensionCache.state === state && dimensionCache.selection === selection) return dimensionCache.out;
  const root = state.definitions.get(state.rootDefinitionId);
  const items: RenderDimension[] = [];
  if (root) {
    const selected = new Set(selection.filter((r) => r.kind === 'dimension').map((r) => `${pathKey(r.path)}/${r.id}`));
    const sources: [readonly Id[], EntityContainer, Mat4 | null][] = [[[], root.entities, null]];
    for (const inst of instancesToRender(state)) if (inst.definition.entities.dimensions.size) sources.push([inst.path, inst.definition.entities, inst.matrix]);
    for (const [path, container, m] of sources) {
      for (const dim of container.dimensions.values()) {
        if (dim.hidden || !tagVisible(state, dim.tagId)) continue;
        const resolved = resolveDimension(state, container, dim);
        const drawing = dimensionDrawing(dim, resolved);
        const p = (v: Vec3): Vec3 => (m ? m4transformPoint(m, v) : v);
        const d = (v: Vec3): Vec3 => (m ? v3normalize(m4transformDir(m, v)) : v);
        // Text along the dimension line: linear dimensions only, in its plane.
        const along = v3sub(resolved.end, resolved.start);
        const out = v3sub(dim.offset, v3scale(v3normalize(along), v3dot(dim.offset, v3normalize(along))));
        const aligned = dim.kind === 'linear' && dim.align && dim.align !== 'screen' && v3len(along) > 1e-9
          ? { along: v3normalize(d(along)), out: v3normalize(d(v3len(out) > 1e-9 ? out : v3cross(dim.normal, along))), position: dim.align } : undefined;
        items.push({
          id: dim.id,
          lines: drawing.lines.map(([a, b]) => [p(a), p(b)] as const),
          arrows: drawing.arrows.map(({ tip, back }) => ({ tip: p(tip), back: d(back) })),
          text: dimensionText(dim, resolved.value, state.meta.units),
          textAt: p(drawing.textAt),
          fontSizePt: dim.fontSizePt,
          selected: selected.has(`${pathKey(path)}/${dim.id}`),
          ...(dim.arrow && dim.arrow !== 'closed' ? { arrow: dim.arrow } : {}),
          ...(aligned ? { aligned } : {}),
        });
      }
    }
  }
  const out: RenderDimensions = { items };
  dimensionCache = { state, selection, out };
  return out;
}

let textCache: { state: DocumentState; selection: readonly EntityRef[]; out: RenderTexts } | null = null;

/**
 * Every visible text at every placement: leader anchors and pushpin offsets in world coordinates, view
 * offsets and screen positions as stored; selected ones are flagged. Reused while the state and selection are.
 */
export function textsToRender(state: DocumentState, selection: readonly EntityRef[] = []): RenderTexts {
  if (textCache && textCache.state === state && textCache.selection === selection) return textCache.out;
  const root = state.definitions.get(state.rootDefinitionId);
  const items: RenderText[] = [];
  if (root) {
    const selected = new Set(selection.filter((r) => r.kind === 'text').map((r) => renderKey(r.path, r.id)));
    const sources: [readonly Id[], EntityContainer, Mat4 | null][] = [[[], root.entities, null]];
    for (const inst of instancesToRender(state)) if (inst.definition.entities.texts.size) sources.push([inst.path, inst.definition.entities, inst.matrix]);
    for (const [path, container, m] of sources) {
      for (const t of container.texts.values()) {
        if (t.hidden || !tagVisible(state, t.tagId) || !t.text) continue;
        const key = renderKey(path, t.id);
        const leader = t.kind === 'leader';
        items.push({
          id: key,
          text: t.text,
          kind: t.kind,
          position: leader && m ? m4transformPoint(m, t.position) : t.position,
          offset: leader && t.offset && !t.viewOffset ? (m ? m4transformDir(m, t.offset) : t.offset) : null,
          viewOffset: leader && t.viewOffset ? t.viewOffset : null,
          leader: t.leader,
          arrow: t.arrow ?? 'closed',
          color: rgbToCss(t.color),
          fontSizePt: t.fontSizePt,
          selected: selected.has(key),
        });
      }
    }
  }
  const out: RenderTexts = { items };
  textCache = { state, selection, out };
  return out;
}

/** The root definition's drawing axes (model axes), or the identity axes without a root. */
export function axesToRender(state: DocumentState): RenderAxes {
  const root = state.definitions.get(state.rootDefinitionId);
  if (!root) return { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const { origin, x, y, z } = root.axes;
  return { origin, x, y, z };
}

/** The active style's display toggles → the viewport's display settings. */
export function displayToRender(state: DocumentState): RenderDisplay {
  const style: Style | undefined = state.styles.get(state.activeStyleId);
  if (!style) {
    return { hiddenGeometry: false, edges: true, profiles: true, guides: true, axes: true, backEdges: false, xray: false, faceStyle: 'shaded' };
  }
  const mode = style.faces.mode;
  const faceStyle: RenderDisplay['faceStyle'] =
    mode === 'wireframe' ? 'wireframe'
    : mode === 'hiddenLine' ? 'hiddenLine'
    : mode === 'monochrome' ? 'monochrome'
    : mode === 'shadedWithTextures' ? 'shadedTextured'
    : 'shaded';
  return {
    hiddenGeometry: style.modeling.hiddenGeometry,
    edges: style.edges.edges,
    profiles: style.edges.profiles,
    guides: style.modeling.guidesVisible,
    axes: style.modeling.modelAxesVisible,
    backEdges: style.edges.backEdges && mode !== 'xray',
    xray: mode === 'xray',
    faceStyle,
    // The style's edge, face and modeling colors and edge modes. By Material draws edges in the
    // edge color: edges carry no material of their own.
    edgeColor: rgbHex(style.edges.color),
    edgeAxisColors: style.edges.colorMode === 'byAxis',
    profileWidth: style.edges.profileWidth,
    depthCue: style.edges.depthCue ? style.edges.depthCueLevels : 0,
    edgeExtension: style.edges.extension ? style.edges.extensionLength : 0,
    faceFrontColor: rgbHex(style.faces.frontColor),
    faceBackColor: rgbHex(style.faces.backColor),
    xrayOpacity: style.faces.xrayOpacity,
    selectedColor: rgbHex(style.modeling.selected),
    guideColor: rgbHex(style.modeling.guides),
  };
}

/** A 0–1 RGB color as a hex number. */
function rgbHex(rgb: readonly [number, number, number]): number {
  const c = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));
  return (c(rgb[0]) << 16) | (c(rgb[1]) << 8) | c(rgb[2]);
}

/** The root definition's sketch, or null without a root. */
export function rootSketch(state: DocumentState): Sketch | null {
  return state.definitions.get(state.rootDefinitionId)?.entities.sketch ?? null;
}

// --- sketches -----------------------------------------------------------------------------------

// Version tokens of transformed sketches: the renderer compares `version` by identity, so a token
// is reused while the sketch, the bodies' imprints, the matrix and the inherited color are the same.
const sketchVersionCache = new Map<string, { deps: readonly unknown[]; token: object }>();

function sketchVersion(key: string, deps: readonly unknown[]): object {
  const c = sketchVersionCache.get(key);
  if (c && c.deps.length === deps.length && c.deps.every((d, i) => d === deps[i])) return c.token;
  const token = { key, deps };
  sketchVersionCache.set(key, { deps, token });
  return token;
}

/**
 * One container's sketch → `RenderSketch` in world coordinates. For the root (no matrix) the
 * immutable sketch object is the `version` token, so the renderer rebuilds exactly when a
 * transaction touched the sketch; imprint edges of the container's bodies are drawn with it.
 * Face colors come from the material map; faces without one take `defaultColor` (instance
 * material), else the style default. Returns null for an empty non-root sketch.
 */
export function containerSketchToRender(
  state: DocumentState,
  path: readonly Id[],
  container: EntityContainer,
  matrix: Mat4 | null,
  defaultColor?: string | undefined,
  inheritedMaterial: RenderMaterial | null = null,
  opts: RenderAdapterOptions = {},
  /** The container's effective Cast/Receive Shadows: its own and every containing placement's. */
  shadows: { readonly cast: boolean; readonly receive: boolean } = { cast: true, receive: true },
): RenderSketch | null {
  const sketch = container.sketch;
  const tp = (p: Vec3): Vec3 => (matrix ? m4transformPoint(matrix, p) : p);
  const faces: RenderSketch['faces'][number][] = [];
  const byTag = colorByTagOn(state);
  const images = opts.images ?? renderImages;
  const uvPrefix = `sketch:${pathKey(path)}/`;
  let uvToken = '';
  // Texture coordinates stay in definition coordinates: the inverse transpose of the instance's
  // linear part takes a face's (u, v) axes to world covectors with the same dot products.
  const inverse = matrix ? m4invert(matrix) : null;
  const covector = (d: Vec3): Vec3 => inverse
    ? [0, 1, 2].map((r) => inverse[r * 4]! * d[0] + inverse[r * 4 + 1]! * d[1] + inverse[r * 4 + 2]! * d[2]) as unknown as Vec3
    : d;
  for (const face of sketch.faces.values()) {
    if (!tagVisible(state, face.tagId)) continue;
    const front = (byTag ? tagColor(state, face.tagId) : undefined) ?? materialColor(state, face.frontMaterialId) ?? defaultColor;
    const back = (byTag ? tagColor(state, face.tagId) : undefined) ?? materialColor(state, face.backMaterialId) ?? defaultColor;
    const frontMaterial = renderMaterial(state, face.frontMaterialId, images) ?? inheritedMaterial;
    const backMaterial = renderMaterial(state, face.backMaterialId, images) ?? inheritedMaterial;
    const uvOverride = opts.uvOverrides?.get(`${uvPrefix}${face.id}`);
    if (uvOverride) uvToken += `${face.id}:${uvOverride.kind === 'auto' ? 'auto' : `${uvOverride.kind}:${uvOverride.matrix.join(',')}`};`;
    const uv = uvOverride ?? face.uv;
    let loops = sketchFaceLoops(sketch, face);
    let basis = face.basis;
    let uvBasis: PlaneBasis | undefined;
    if (matrix) {
      loops = loops.map((l) => l.map((p) => m4transformPoint(matrix, p)));
      // The transformed loop stays CCW about cross(u', v') (also under mirroring), so the front
      // side of the face is preserved.
      const u = m4transformDir(matrix, basis.u);
      const v = m4transformDir(matrix, basis.v);
      if (inverse) uvBasis = { origin: m4transformPoint(matrix, face.basis.origin), u: covector(face.basis.u), v: covector(face.basis.v), n: face.basis.n };
      basis = planeBasis(m4transformPoint(matrix, basis.origin), v3normalize(v3cross(u, v)));
    }
    faces.push({ id: face.id, loops, basis, frontColor: front, backColor: back, hidden: face.hidden, frontMaterial, backMaterial, uv,
      ...(face.uvBack ? { uvBack: face.uvBack } : {}), ...(uvBasis ? { uvBasis } : {}) });
  }
  const edges: RenderSketch['edges'][number][] = [];
  for (const e of sketch.edges.values()) {
    const a = sketch.vertices.get(e.a), b = sketch.vertices.get(e.b);
    if (!a || !b || !tagVisible(state, e.tagId)) continue;
    edges.push({ id: e.id, a: tp(a.p), b: tp(b.p), soft: e.soft, smooth: e.smooth, hidden: e.hidden, ...tagEdgeStyle(state, e.tagId, byTag) });
  }
  // Imprint edges (lines drawn on body faces) are drawn with the sketch edges. The version token
  // combines the sketch identity with every body's imprint state so a change to either rebuilds.
  const imprintKeys: string[] = [];
  for (const body of container.bodies.values()) {
    if (body.hidden || !tagVisible(state, body.tagId) || body.imprints.size === 0) continue;
    for (const e of imprintEdgesWorld(body)) {
      edges.push({ id: -(body.id * 1_000_000 + e.faceId * 1000 + e.edgeId), a: tp(e.a), b: tp(e.b), soft: e.soft, smooth: e.smooth, hidden: e.hidden });
    }
    for (const [faceId, g] of body.imprints) imprintKeys.push(`${body.id}:${faceId}:${g.version}`);
  }
  if (path.length > 0 && faces.length === 0 && edges.length === 0) return null;
  const imprints = imprintKeys.join('|');
  const id = pathKey(path);
  // Tag visibility, colors and dashes are part of the rebuild key (see `tagStyleToken`).
  const tagToken = tagStyleToken(state);
  // The material map (texture / color edits) and the inherited material are part of the key too.
  const version: unknown = matrix
    ? sketchVersion(id, [sketch, imprints, matrix, defaultColor, tagToken, state.materials, inheritedMaterial, images, uvToken])
    : sketchVersion(id, [sketch, imprints, tagToken, state.materials, images, uvToken]);
  return { id, path, version, faces, edges,
    ...(shadows.cast ? {} : { castShadows: false }), ...(shadows.receive ? {} : { receiveShadows: false }) };
}

/** Root context sketch → `RenderSketch` (world = local at the root), or null without a root. */
export function sketchToRender(state: DocumentState, opts: RenderAdapterOptions = {}): RenderSketch | null {
  const root = state.definitions.get(state.rootDefinitionId);
  return root ? containerSketchToRender(state, [], root.entities, null, undefined, null, opts) : null;
}

/** The root sketch plus every visible instance's sketch transformed to world coordinates. */
export function sketchesToRender(state: DocumentState, opts: RenderAdapterOptions = {}): RenderSketch[] {
  const out: RenderSketch[] = [];
  if (opts.images) setRenderImageStore(opts.images);
  const root = sketchToRender(state, opts);
  if (root) out.push(root);
  for (const inst of instancesToRender(state)) {
    const s = containerSketchToRender(state, inst.path, inst.definition.entities, inst.matrix, inst.color, inst.material ?? null, opts,
      { cast: inst.castShadows !== false, receive: inst.receiveShadows !== false });
    if (s) out.push(inst.faceCamera ? { ...s, faceCamera: inst.faceCamera } : s);
  }
  return out;
}

// --- bounds / edit context ----------------------------------------------------------------------

/**
 * World-space bounds of the instance at `path` (its definition's bodies and sketch plus nested
 * instances, transformed by `contextMatrix`), or null when empty / the path is stale.
 */
export function instanceWorldBounds(state: DocumentState, path: readonly Id[]): Box3 | null {
  return contentWorldBounds(state, path);
}

export interface EditContextDisplayOptions {
  /** Fade the rest of the model while editing (default true). */
  readonly fadeOthers?: boolean | undefined;
  /** Hide the rest of the model while editing (default false). */
  readonly hideOthers?: boolean | undefined;
}

/**
 * The open edit context → what the viewport fades/hides and the dashed bounding box it draws:
 * the world bounds of the context's definition entities (bodies + sketch, nested instances)
 * transformed by `contextMatrix`. The root context fades nothing and has no box.
 */
export function editContextToRender(state: DocumentState, contextPath: readonly Id[], opts: EditContextDisplayOptions = {}): RenderEditContext {
  const fadeOthers = opts.fadeOthers ?? true;
  const hideOthers = opts.hideOthers ?? false;
  if (contextPath.length === 0) return { path: [], bounds: null, fadeOthers, hideOthers };
  return { path: [...contextPath], bounds: instanceWorldBounds(state, contextPath), fadeOthers, hideOthers };
}

// --- highlights ---------------------------------------------------------------------------------

type MatrixCache = Map<string, MMat4 | null>;

function matrixFor(state: DocumentState, path: readonly Id[], cache: MatrixCache): MMat4 | null | undefined {
  const key = pathKey(path);
  if (cache.has(key)) return cache.get(key);
  let m: MMat4 | null;
  try {
    m = path.length ? contextMatrix(state, path) : null;
  } catch {
    return undefined;
  }
  cache.set(key, m);
  return m;
}

function highlightForCached(state: DocumentState, ref: EntityRef, cache: MatrixCache): EntityHighlight | null {
  const matrix = matrixFor(state, ref.path, cache);
  if (matrix === undefined) return null; // stale path
  let container: EntityContainer;
  try {
    container = containerAt(state, ref.path);
  } catch {
    return null;
  }
  const tp = (p: Vec3): Vec3 => (matrix ? m4transformPoint(matrix, p) : p);
  const tpoly = (pts: readonly Vec3[]): readonly Vec3[] => (matrix ? pts.map(tp) : pts);
  const tloops = (loops: readonly (readonly Vec3[])[]): readonly (readonly Vec3[])[] => (matrix ? loops.map(tpoly) : loops);
  switch (ref.kind) {
    case 'instance': {
      if (!container.instances.has(ref.id)) return null;
      const full = [...ref.path, ref.id];
      const bounds = instanceWorldBounds(state, full);
      return bounds ? { kind: 'instance', key: pathKey(full), bounds } : null;
    }
    case 'body':
      return container.bodies.has(ref.id) ? { kind: 'body', key: renderKey(ref.path, ref.id) } : null;
    case 'meshPart':
      // A mesh part highlights whole, as a body does (MOD3830).
      return container.meshParts.has(ref.id) ? { kind: 'body', key: renderKey(ref.path, ref.id) } : null;
    case 'face': {
      const face = container.bodies.get(ref.id)?.faces.get(ref.faceId);
      return face ? { kind: 'face', key: renderKey(ref.path, ref.id), faceId: ref.faceId, loops: tloops(face.loops) } : null;
    }
    case 'edge': {
      const edge = container.bodies.get(ref.id)?.edges.get(ref.edgeKey);
      return edge ? { kind: 'edge', points: tpoly(edge.polyline) } : null;
    }
    case 'imprintEdge': {
      const body = container.bodies.get(ref.id);
      const face = body?.faces.get(ref.faceId);
      const g = body?.imprints.get(ref.faceId);
      const e = g?.edges.get(ref.edgeId);
      const a = e ? g?.vertices.get(e.a) : undefined;
      const b = e ? g?.vertices.get(e.b) : undefined;
      if (!face || !a || !b) return null;
      return { kind: 'edge', points: [tp(basisToWorld(face.basis, a[0], a[1])), tp(basisToWorld(face.basis, b[0], b[1]))] };
    }
    case 'sketchFace': {
      const sketch = container.sketch;
      const face = sketch.faces.get(ref.id);
      return face ? { kind: 'sketchFace', id: ref.id, loops: tloops(sketchFaceLoops(sketch, face)) } : null;
    }
    case 'sketchEdge': {
      const sketch = container.sketch;
      const e = sketch.edges.get(ref.id);
      const a = e ? sketch.vertices.get(e.a) : undefined;
      const b = e ? sketch.vertices.get(e.b) : undefined;
      return a && b ? { kind: 'sketchEdge', id: ref.id, a: tp(a.p), b: tp(b.p) } : null;
    }
    case 'sketchVertex': {
      const v = container.sketch.vertices.get(ref.id);
      return v ? { kind: 'sketchVertex', p: tp(v.p as Vec3) } : null;
    }
    case 'image': {
      const image = container.images.get(ref.id);
      return image ? { kind: 'image', key: renderKey(ref.path, ref.id), corners: tpoly(imageEntityCorners(image)) } : null;
    }
    case 'guide': {
      const g = container.guides.get(ref.id);
      if (!g) return null;
      if (g.kind === 'point') return { kind: 'guide', id: ref.id, p: tp(g.origin), dir: null };
      if (g.kind === 'segment') {
        const a = tp(g.origin), b = tp(g.end);
        const dir: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        return { kind: 'guide', id: ref.id, p: a, dir, end: b };
      }
      return { kind: 'guide', id: ref.id, p: tp(g.origin), dir: matrix ? m4transformDir(matrix, g.dir) : g.dir };
    }
    default:
      return null;
  }
}

/**
 * One `EntityRef` → what the renderer should highlight (in world coordinates: entities inside
 * instances are transformed by `contextMatrix(ref.path)`), or null when the entity is gone / unsupported.
 */
export function highlightFor(state: DocumentState, ref: EntityRef): EntityHighlight | null {
  return highlightForCached(state, ref, new Map());
}

/** Hover ref + selection → the viewport's `HighlightState`. */
export function highlightsFor(state: DocumentState, hoverRef: EntityRef | null, selection: Iterable<EntityRef>): HighlightState {
  const cache: MatrixCache = new Map();
  const selected: EntityHighlight[] = [];
  for (const ref of selection) {
    const h = highlightForCached(state, ref, cache);
    if (h) selected.push(h);
  }
  return { hover: hoverRef ? highlightForCached(state, hoverRef, cache) : null, selected };
}

/** Active style's background → sky/ground gradient settings. */
export function backgroundToRender(state: DocumentState): RenderBackground {
  const style = state.styles.get(state.activeStyleId);
  const b = style?.background;
  if (!b) return DEFAULT_RENDER_BACKGROUND;
  return {
    color: rgbToCss(b.color),
    sky: b.sky,
    skyColor: rgbToCss(b.skyColor),
    ground: b.ground,
    groundColor: rgbToCss(b.groundColor),
    groundTransparency: b.groundTransparency,
  };
}

// --- tags: visibility tokens, colors, dash patterns ---------------------------------------------

/** Styles › Modeling "Color by Tag" of the active style. */
export function colorByTagOn(state: DocumentState): boolean {
  return state.styles.get(state.activeStyleId)?.modeling.colorByTag === true;
}

/** CSS color of a tag, or undefined for unknown tags. */
export function tagColor(state: DocumentState, tagId: TagId): string | undefined {
  const t = state.tags.get(tagId);
  return t ? rgbToCss(t.color) : undefined;
}

/** Per-edge render style of a tag: color (Color by Tag) and dash pattern. */
export function tagEdgeStyle(state: DocumentState, tagId: TagId, byTag: boolean): { color?: string | undefined; dashes?: string | null | undefined } {
  const t = state.tags.get(tagId);
  if (!t) return {};
  const out: { color?: string | undefined; dashes?: string | null | undefined } = {};
  if (byTag) out.color = rgbToCss(t.color);
  if (t.dashes) out.dashes = t.dashes;
  return out;
}

// A token that changes whenever tag visibility/colors/dashes/folders or Color by Tag change.
const tagTokenCache = new WeakMap<DocumentState['tags'], { folders: DocumentState['tagFolders']; byTag: boolean; token: object }>();

/** Identity token of the tag state relevant to rendering (stable while unchanged). */
export function tagStyleToken(state: DocumentState): object {
  const byTag = colorByTagOn(state);
  const c = tagTokenCache.get(state.tags);
  if (c && c.folders === state.tagFolders && c.byTag === byTag) return c.token;
  const token = {};
  tagTokenCache.set(state.tags, { folders: state.tagFolders, byTag, token });
  return token;
}

// Tagged edge arrays are cached per (edges map, tag token): the renderer diffs `edges` by identity.
const taggedEdgeCache = new WeakMap<Body['edges'], { token: object; out: RenderBodyEdge[] }>();

/**
 * Body edges with tag styling: edges whose tag is hidden are flagged `hidden` (so they drop out
 * unless hidden geometry is shown), Color by Tag sets `color`, and tag dash patterns set `dashes`.
 * Falls back to the plain cached array when no tag affects the body.
 */
export function taggedBodyEdges(state: DocumentState, body: Body): RenderBodyEdge[] {
  const token = tagStyleToken(state);
  const cached = taggedEdgeCache.get(body.edges);
  if (cached && cached.token === token) return cached.out;
  const byTag = colorByTagOn(state);
  let styled = false;
  for (const e of body.edges.values()) {
    const t = state.tags.get(e.tagId);
    if (t && (byTag || t.dashes || !tagVisible(state, e.tagId))) {
      styled = true;
      break;
    }
  }
  let out: RenderBodyEdge[];
  if (!styled) out = bodyEdgesToRender(body);
  else {
    out = [];
    for (const e of body.edges.values()) {
      out.push({
        points: e.polyline,
        soft: e.soft,
        smooth: e.smooth,
        hidden: e.hidden || !tagVisible(state, e.tagId),
        faceA: e.faceA,
        faceB: e.faceB,
        ...tagEdgeStyle(state, e.tagId, byTag),
      });
    }
  }
  taggedEdgeCache.set(body.edges, { token, out });
  return out;
}

// --- shadows / fog ------------------------------------------------------------------------------

/** Document shadow settings → sun direction (NOAA) and viewport shadow settings. */
export function shadowsToRender(state: DocumentState): RenderShadows {
  const s = state.shadows ?? DEFAULT_SHADOWS;
  const pos = solarPosition({ month: s.month, day: s.day, minutes: s.time, utcOffsetHours: s.utcOffsetHours, latitude: s.latitude, longitude: s.longitude });
  const dir = sunDirection(pos.azimuth, pos.elevation, s.northAngle);
  return {
    enabled: s.enabled,
    sunDirection: dir,
    sunUp: pos.elevation > 0,
    light: s.light,
    dark: s.dark,
    useSunForShading: s.useSunForShading,
    onFaces: s.onFaces,
    onGround: s.onGround,
    fromEdges: s.fromEdges,
  };
}

/** Document fog → viewport fog (background color when "use background" is on). */
export function fogToRender(state: DocumentState): RenderFog {
  const f = state.fog ?? DEFAULT_FOG;
  const bg = state.styles.get(state.activeStyleId)?.background.color;
  return { enabled: f.enabled, near: f.near, far: f.far, color: rgbToCss(f.useBackground && bg ? bg : f.color) };
}
