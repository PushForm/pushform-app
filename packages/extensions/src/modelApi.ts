// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import {
  DEFAULT_BLEND_SEGMENTS, SERVICE_FONTS, checkEdgeBlendResult, Text3DParamsSchema, isHardEdge, libraryMaterial, loadLibraryMaterial, planEdgeBlend, planEdgeProfile, runEdgeBlendKernel, runIntersectKernel,
  runText3DKernel, BUILTIN_LIBRARY, LIBRARY_CATEGORIES, activeTagOpt, applyTransformPlan, arrayMatrices, contextFrame, curvePoints, definitionBounds, hostOf, instanceCount, kernelOf, localPushPullDistance,
  m4rotationAbout, m4scaleAbout, planPushPull, planTransform, runFollowMeKernel, runPushPullKernel, runSolidsKernel, runTransformKernel, sceneRuntimeOf, solidsResultIsEmpty,
  type CameraHost, type CameraState, type CommandRegistry, type DocumentHost, type ExplodeResult, type FollowMeApplyResult, type FollowMeParams,
  type EdgeBlendMode, type EdgeBlendPlan, type MakeResult, type StandardView, type PushPullApplyResult, type PushPullTarget, type SolidsApplyResult, type SolidsKernelWork, type SolidsPairMode, type TransformKernelWork, type TransformPlan,
} from '@pushform/commands';
import {
  LOCAL_REFERENCE, MODEL_API_VERSION, MODEL_LIMITS, MODEL_RENDER_LIMITS, modelRenderSchema, modelRenderViewName, modelRenderViews, type ModelRenderImage, type ModelRenderResult, MODEL_PLANNED_OPERATIONS, MODEL_TOOLS, modelBatchSchema, modelMaterialLibrarySchema, modelOperationSchema, modelOverlapsSchema, modelQuerySchema,
  type ModelLibraryResult, type ModelOverlap, type ModelOverlapsResult,
  modelViewSchema, type ModelApiError, type ModelApiErrorCode, type ModelBatchResult, type ModelBounds, type ModelCameraInput, type ModelCameraSummary,
  type ModelDocumentSnapshot, type ModelEntitySummary, type ModelOperation, type ModelQueryResult, type ModelRef, type ModelRefInput, type ModelSceneSaves,
  type ModelNameEntry, type ModelSkipped, type ModelVec3, type ModelViewResult,
} from '@pushform/extension-protocol';
import {
  basisToLocal, box3Empty, box3Expand, box3IsEmpty, MERGE_TOL, m4invert, m4mul, m4transformPoint, m4translation, meshBounds, planeDistance, PushFormError,
  v3add, v3cross, v3dot, v3len, v3scale, v3sub,
  type Box3, type DefId, type FaceLocalId, type Id, type MMat4, type PlaneBasis, type Plane, type Vec3,
} from '@pushform/core';
import {
  computeRegions, containerAt, contextMatrix, entityCounts, materialOrNull, regionAt, sketchFaceLoops, UV_AUTO, uvInvert, uvToAffine,
  type Body, type DocumentState, type EdgeRecord, type EntityContainer, type EntityRef, type FaceRecord, type Material, type Rgb, type Scene, type SceneFlags, type SketchFace,
  type UndoEntry, type UvMapping,
} from '@pushform/model';
import { summarizeLabels, type ToolCallResult } from './layoutApi';
import { frameCamera } from './modelCamera';

/** A structured API error; the message is safe to show to the user and to a model. */
export class ModelApiFailure extends Error {
  constructor(readonly error: ModelApiError) { super(error.message); this.name = 'ModelApiFailure'; }
}

/**
 * What a drawing operation made: its new sketch edges and faces, the faces of solids it was drawn on, the way it
 * faces (null for loose segments) and a point inside it (null when open), so later operations can find its face.
 */
interface Shape { edges: number[]; faces: number[]; imprinted: { bodyId: number; faceId: number }[]; normal: Vec3 | null; inside: Vec3 | null }
/**
 * What a batch names with `as`: the entity's kind and id (with `faceId` for a face of a solid), for a group or
 * placement its definition, and for a drawn shape everything it made.
 */
interface Named { kind: ModelRef['kind'] | 'tag' | 'material' | 'scene'; id: number; definitionId?: number; faceId?: number; shape?: Shape }
/**
 * A name in the API's table: what it names, the container that holds it, the batch that gave it (a sequence number
 * of this API object), and that batch's undo entry once it committed, so an undone batch's names can be dropped.
 */
interface NameEntry { named: Named; path: readonly number[]; batch: number; undo: UndoEntry | null }
/** Kinds that live in one container; tags, materials and scenes belong to the whole model. */
const DOCUMENT_KINDS = new Set<Named['kind']>(['tag', 'material', 'scene']);
/** How an error names what a name stood for. */
const KIND_WORDS: Partial<Record<Named['kind'], string>> = { body: 'solid', instance: 'group or placement', sketchFace: 'drawn face', sketchEdge: 'drawn edge', face: 'face of solid', sectionPlane: 'section plane' };
const describeNamed = (n: Named): string => `${KIND_WORDS[n.kind] ?? n.kind} ${n.id}${n.faceId !== undefined ? ` face ${n.faceId}` : ''}`;
/** An edge selector of fillet_edges and chamfer_edges, as the schema parses it. */
type EdgeFaceSelector = { facing: Vec3; point?: Vec3 | undefined };
type EdgeSelector = string
  | { face: EdgeFaceSelector; which?: 'all' | 'outer' | 'inner' | 'parallel' | undefined; along?: Vec3 | undefined }
  | { between: [EdgeFaceSelector, EdgeFaceSelector] }
  | { faceFacing: Vec3; facePoint?: Vec3 | undefined }
  | { along: Vec3; through?: Vec3 | undefined };
/** A fillet, chamfer or profile of a batch: its command, its params, and its plan with some params changed (for the largest that fits). */
interface BlendJob {
  kind: EdgeBlendMode;
  command: string;
  params: { edges: string[]; size: number; distance2?: number | undefined; angleDeg?: number | undefined };
  plan: (state: DocumentState, change: { size?: number; distance2?: number }) => EdgeBlendPlan;
}
/** A face to push, pull or sweep, as the commands take it, and the direction a positive API distance moves. */
interface FaceTarget { target: PushPullTarget; plane: Plane; normal: Vec3; shown: string }
type OpResult = Omit<ModelBatchResult['results'][number], 'op'> & { named?: Named };

const DEFAULT_QUERY_LIMIT = 50;
const FACING_TOLERANCE = Math.cos(Math.PI / 180);
/** Smallest volume a committed solid may have: a cube one merge tolerance on a side. */
const MIN_VOLUME = MERGE_TOL ** 3;
/** Bounds of the overlap read: solids considered, pairs reported, and kernel ids for solids moved into place. */
const OVERLAP_SOLIDS = 500, OVERLAP_PAIRS = 100, OVERLAP_TEMP_BASE = 0x7d000000;
const PLANNED = new Set<string>(MODEL_PLANNED_OPERATIONS);
const round = (value: number): number => Math.round(value * 1e6) / 1e6;
const vec = (p: Vec3): ModelVec3 => [round(p[0]), round(p[1]), round(p[2])];
const hex = (c: Rgb): string => `#${c.map(x => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0')).join('')}`;
const rgb = (color: string): Rgb => [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255) as unknown as Rgb;
const boundsOut = (b: Box3 | null): ModelBounds | null => (b && !box3IsEmpty(b) ? { min: vec(b.min), max: vec(b.max) } : null);
const zodMessage = (error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string => error.issues.slice(0, 5).map(i => `${i.path.map(String).join('.') || 'input'}: ${i.message}`).join('; ');
/** The value at `path` inside `input`, or undefined. */
const valueAt = (input: unknown, path: readonly PropertyKey[]): unknown =>
  path.reduce<unknown>((at, key) => (at !== null && typeof at === 'object' ? (at as Record<PropertyKey, unknown>)[key] : undefined), input);
/**
 * An operation's schema errors, with a plain id where a reference was expected explained: an id alone does not say
 * whether it is a solid, a group or another kind.
 */
const operationMessage = (raw: unknown, error: { issues: readonly { code: string; path: readonly PropertyKey[]; message: string }[] }): string =>
  zodMessage({ issues: error.issues.map(issue => {
    const value = valueAt(raw, issue.path);
    return issue.code === 'invalid_union' && Number.isInteger(value) && (value as number) >= 0
      ? { ...issue, message: `${value} is a bare id; a reference is {kind, id}, such as {kind: "body", id: ${value}} for a solid or {kind: "instance", id: ${value}} for a group or placement, or "$name"` }
      : issue;
  }) });
/** Whether an operation refers to `"$name"` anywhere in its input. */
const readsName = (op: unknown, name: string): boolean => {
  const target = `$${name}`;
  const walk = (value: unknown): boolean => typeof value === 'string' ? value === target
    : Array.isArray(value) ? value.some(walk)
    : value !== null && typeof value === 'object' ? Object.entries(value).some(([key, v]) => key !== 'as' && walk(v)) : false;
  return walk(op);
};
/** Operations that move or copy entities; with `as`, they name the copy. */
const TRANSFORM_OPS = new Set<string>(['move', 'rotate', 'scale', 'mirror']);
const samePath = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Host side of the model document API for one open model and one client. Reads are snapshots of committed state.
 * `apply` runs a batch through the model's commands inside one exclusive undo group: the batch commits as one undo
 * entry labelled `<client>: <label>`, or every change is reverted, and no other edit can interleave with it while
 * kernel work is awaited.
 *
 * `as` names live as long as this object: a later batch through it may use a name an earlier one gave. AI Chat makes
 * one per message the requester sends (`documentToolsFor` runs when the message is sent), so its names last one turn;
 * an extension's names last as long as the host keeps its API object. Names never enter the document. A name keeps
 * the container it was given in; an undone batch's names are dropped, and a later batch may rebind a name.
 *
 * A batch's expected revision guards against other edits: it may be any revision since which only this object's own
 * batches, committed or reverted, changed the model.
 *
 * One object serves one request, so its batches are one undo step: a committed batch that follows this object's
 * previous committed batch, with no other change to the model in between (the requester's edits, undo or redo,
 * another client's batches), joins that batch's undo entry, which is then labelled for all of them. A reverted batch
 * in between changes nothing and does not split them. A host gives each request its own object: AI Chat one per
 * message, an extension's host one per run of the extension.
 */
export class ModelDocumentApi {
  private readonly host: DocumentHost;
  /** Names that committed batches gave, with what they name. */
  private readonly names = new Map<string, NameEntry>();
  /** Names dropped because their batch was undone, so a use of one can say why it fails. */
  private readonly undone = new Set<string>();
  private batches = 0;
  /**
   * Revisions this object's own batches account for: every change from `ownFrom` to `ownTo` was made by a batch
   * through it, committed or reverted. A batch planned against any of them meets no one else's change, so it runs.
   */
  private ownFrom = -1;
  private ownTo = -1;
  /** The undo entry the latest committed batch went into, with the labels of the batches it holds, oldest first. */
  private step: { entry: UndoEntry; labels: string[] } | null = null;
  /** Labels of every committed batch, oldest first, and how many undo entries hold them. */
  private readonly committedLabels: string[] = [];
  private steps = 0;

  constructor(private readonly commands: CommandRegistry, private readonly client: string) {
    this.host = hostOf(commands.ctx);
  }

  get revision(): number { return this.host.doc.version; }

  /**
   * What this object's committed batches changed, for one line about all of them: `label` names them as their undo
   * entries do, without the client's name, and `undoSteps` is how many undo entries hold them (one unless something
   * else changed the model between them). Null until a batch commits.
   */
  get changes(): { label: string; undoSteps: number } | null {
    return this.committedLabels.length ? { label: summarizeLabels(this.committedLabels), undoSteps: this.steps } : null;
  }

  getDocument(): ModelDocumentSnapshot {
    const state = this.host.doc.state, context = this.host.context;
    const root = state.definitions.get(state.rootDefinitionId)!;
    const activeTagId = activeTagOpt(this.commands.ctx).tagId ?? state.defaultTagId;
    return {
      apiVersion: MODEL_API_VERSION,
      revision: this.revision,
      displayUnits: { format: state.meta.units.format, lengthUnit: state.meta.units.lengthUnit, precision: state.meta.units.lengthPrecision },
      editContext: { path: [...context.path], definitionId: context.definitionId, name: state.definitions.get(context.definitionId)?.name ?? '', worldTransform: contextMatrix(state, context.path).map(round) },
      selection: this.host.selection.refs.map(refOut),
      bounds: boundsOut(definitionBounds(state, root.id)),
      definitions: [...state.definitions.values()].filter(def => def.id !== state.rootDefinitionId).map(def => {
        const counts = entityCounts(state, false, def.id);
        return { id: def.id, name: def.name, type: def.isGroup ? 'group' as const : 'component' as const, placements: instanceCount(state, def.id),
          solids: counts.solids, faces: counts.solidFaces + counts.sheetFaces, edges: counts.edges, instances: counts.groups + counts.componentInstances,
          bounds: boundsOut(definitionBounds(state, def.id)) };
      }),
      tags: [...state.tags.values()].map(tag => ({ id: tag.id, name: tag.name, visible: tag.visible, color: hex(tag.color), active: tag.id === activeTagId, untagged: tag.id === state.defaultTagId })),
      materials: [...state.materials.values()].map(m => ({ id: m.id, name: m.name, color: hex(m.color), opacity: m.alpha, textured: m.texture !== null, isDefault: m.id === state.defaultMaterialId,
        grain: m.texture ? m.texture.grain ?? 'width' : null })),
      scenes: state.sceneOrder.flatMap((id, index) => {
        const scene = state.scenes.get(id);
        return scene ? [{ id: scene.id, name: scene.name, description: scene.description, index, active: scene.id === this.runtime.activeSceneId, saves: savesOut(scene.flags), includeInAnimation: scene.includeInAnimation ?? true }] : [];
      }),
      camera: this.camera ? cameraOut(this.camera.getState()) : null,
      playing: this.runtime.playing,
    };
  }

  /** Change what the requester sees: camera, scenes and playback. Makes no undo entry; rejects with `ModelApiFailure`. */
  view(input: unknown): ModelViewResult {
    const parsed = modelViewSchema.safeParse(input);
    if (!parsed.success) throw this.failure('invalid_operation', zodMessage(parsed.error));
    const camera = this.camera;
    if (!camera) throw this.failure('unavailable', 'There is no viewport here, so the view cannot change.');
    const action = parsed.data.action, runtime = this.runtime, path = [...this.host.context.path] as Id[];
    let shown: CameraState | null = null;
    if (action.type !== 'play' && action.type !== 'stop') runtime.stop();
    switch (action.type) {
      case 'set_camera':
        shown = this.cameraFor(action.camera, path, this.resolver(path, this.names, -1).ref);
        runtime.animateCamera(camera, shown, action.animate ?? true ? runtime.animationSettings.transitionSeconds : 0);
        break;
      case 'activate_scene': {
        const scene = this.sceneOf(this.resolveScene(action.scene, this.names));
        this.commands.execute('scene.activate', { id: scene.id, animate: action.animate ?? true });
        if (scene.flags.useCamera) shown = cameraFromScene(scene);
        break;
      }
      case 'next_scene':
      case 'previous_scene': {
        const id = this.commands.execute(action.type === 'next_scene' ? 'scene.next' : 'scene.previous', {}) as number | null;
        if (id === null) throw this.failure('invalid_operation', 'The model has no scenes.');
        const scene = this.sceneOf(id);
        if (scene.flags.useCamera) shown = cameraFromScene(scene);
        break;
      }
      case 'play':
        if (!this.commands.execute('scene.play', { play: true })) throw this.failure('invalid_operation', 'No scene is included in the animation.');
        break;
      case 'stop': this.commands.execute('scene.stop', {}); break;
    }
    const active = runtime.activeSceneId === null ? undefined : this.host.doc.state.scenes.get(runtime.activeSceneId as never);
    return { ok: true, revision: this.revision, camera: cameraOut(shown ?? camera.getState()), activeScene: active ? { id: active.id, name: active.name } : null, playing: runtime.playing };
  }

  private get camera(): CameraHost | null { return this.commands.ctx.camera ?? null; }
  private get runtime() { return sceneRuntimeOf(this.commands.ctx); }

  private sceneOf(id: number): Scene {
    const scene = this.host.doc.state.scenes.get(id as never);
    if (!scene) throw this.failure('invalid_reference', `There is no scene ${id}. Call ${MODEL_TOOLS.getDocument.name} for current scenes.`);
    return scene;
  }

  /** A scene by id, name (any case), "active", or "$name" of a scene added earlier. */
  private resolveScene(input: number | string, names: ReadonlyMap<string, NameEntry>): number {
    if (typeof input === 'number') return this.sceneOf(input).id;
    const local = LOCAL_REFERENCE.exec(input)?.[1];
    if (local !== undefined) {
      const found = names.get(local)?.named;
      if (found?.kind !== 'scene') throw this.failure('invalid_reference', `"${input}" does not name a scene added earlier in this batch or an earlier one.`);
      return this.sceneOf(found.id).id;
    }
    if (input.trim().toLowerCase() === 'active') {
      const id = this.runtime.activeSceneId;
      if (id === null || !this.host.doc.state.scenes.has(id as never)) throw this.failure('invalid_reference', 'No scene is active.');
      return id;
    }
    const state = this.host.doc.state;
    const matches = state.sceneOrder.flatMap((id, index) => {
      const scene = state.scenes.get(id);
      return scene && sameName(scene.name, input) ? [{ id: scene.id, index }] : [];
    });
    if (matches.length === 0) throw this.failure('invalid_reference', `There is no scene named "${input.trim()}". Call ${MODEL_TOOLS.getDocument.name} for current scenes.`);
    if (matches.length > 1) throw this.failure('invalid_reference', `${matches.length} scenes are named "${input.trim()}" (${matches.map(m => `id ${m.id} at position ${m.index}`).join(', ')}); name one by id.`);
    return matches[0]!.id;
  }

  private uniqueSceneName(name: string, except: number | null): void {
    const taken = [...this.host.doc.state.scenes.values()].find(scene => scene.id !== except && sameName(scene.name, name));
    if (taken) throw this.failure('invalid_operation', `A scene named "${taken.name}" already exists (id ${taken.id}); scene names are unique.`);
  }

  /** The camera an exact or framed request describes. Framing fits world bounds in the viewport's proportions. */
  private cameraFor(input: ModelCameraInput, path: Id[], ref: (input: ModelRefInput) => EntityRef): CameraState {
    const host = this.camera;
    if (input.mode === 'exact') {
      const current = host?.getState();
      const fov = input.fovDeg ?? current?.fov ?? 35;
      const distance = Math.hypot(input.eye[0] - input.target[0], input.eye[1] - input.target[1], input.eye[2] - input.target[2]);
      if (distance < 1e-6) throw this.failure('invalid_operation', 'The camera\'s eye and target must differ.');
      return { eye: input.eye, target: input.target, up: input.up ? unit(input.up) : [0, 0, 1], fov, projection: input.projection ?? current?.projection ?? 'perspective',
        orthoHeight: input.viewHeight ?? 2 * distance * Math.tan((fov * Math.PI) / 360) };
    }
    if (!host) throw this.failure('unavailable', 'There is no viewport here, so a framed camera cannot be fitted; give an exact camera.');
    const state = this.host.doc.state, subject = input.subject ?? 'model';
    let box: Box3 | null = null;
    if (subject === 'model') box = host.sceneBounds() ?? definitionBounds(state, state.rootDefinitionId) ?? { min: [-5, -5, 0], max: [5, 5, 2] };
    else if (subject !== 'target') {
      const refs = subject === 'selection' ? this.host.selection.refs : subject.refs.map(ref);
      if (refs.length === 0) throw this.failure('invalid_operation', 'Nothing is selected to frame.');
      const fit = box3Empty();
      for (const r of refs) for (const p of worldPoints(state, r)) box3Expand(fit, p);
      box = fit;
      if (box3IsEmpty(fit)) throw this.failure('invalid_operation', 'The subject has no extent to frame.');
    }
    const { width, height } = host.viewportSize();
    return frameCamera(host.getState(), { view: input.direction && input.direction !== 'current' ? input.direction : null, horizontalDeg: input.orbitDeg?.horizontal ?? 0,
      verticalDeg: input.orbitDeg?.vertical ?? 0, box, margin: input.margin ?? 0.05, aspect: width / Math.max(1, height), projection: input.projection, fovDeg: input.fovDeg });
  }

  /**
   * Pictures of the model from framed cameras, drawn by `renderer` offscreen: the requester's camera, selection and
   * undo history are untouched. Each picture keeps the viewport's proportions, its longer side at most
   * `MODEL_RENDER_LIMITS.maxSide` pixels. Without a viewport or a renderer the call fails with `unavailable`.
   */
  async render(input: unknown, renderer: ModelRenderer | null | undefined, signal?: AbortSignal): Promise<{ result: ModelRenderResult; images: ModelRenderImage[] }> {
    const parsed = modelRenderSchema.safeParse(input ?? {});
    if (!parsed.success) throw this.failure('invalid_operation', zodMessage(parsed.error));
    const host = this.camera;
    if (!host || !renderer) throw this.failure('unavailable', 'There is no viewport here, so the model cannot be pictured.');
    const path = [...this.host.context.path], state = this.host.doc.state;
    const ref = this.resolver(path, this.names, -1).ref;
    const { width: vw, height: vh } = host.viewportSize();
    // The viewport's proportions, kept within 2:1 either way so a narrow window still gives a usable picture.
    const aspect = Math.min(2, Math.max(0.5, vw / Math.max(1, vh)));
    const width = Math.round(aspect >= 1 ? MODEL_RENDER_LIMITS.maxSide : MODEL_RENDER_LIMITS.maxSide * aspect);
    const height = Math.round(aspect >= 1 ? MODEL_RENDER_LIMITS.maxSide / aspect : MODEL_RENDER_LIMITS.maxSide);
    const views = modelRenderViews(parsed.data);
    const cameras = views.map(view => {
      let box: Box3;
      if (view.subject === undefined) box = this.containerBox(path) ?? host.sceneBounds() ?? { min: [-5, -5, 0], max: [5, 5, 2] };
      else if (view.subject === 'model') box = host.sceneBounds() ?? definitionBounds(state, state.rootDefinitionId) ?? { min: [-5, -5, 0], max: [5, 5, 2] };
      else {
        const refs = view.subject === 'selection' ? this.host.selection.refs : view.subject.refs.map(ref);
        if (refs.length === 0) throw this.failure('invalid_operation', 'Nothing is selected to picture.');
        const fit = box3Empty();
        for (const r of refs) for (const p of worldPoints(state, r)) box3Expand(fit, p);
        if (box3IsEmpty(fit)) throw this.failure('invalid_operation', 'The subject has no extent to picture.');
        box = fit;
      }
      return frameCamera(host.getState(), { view: view.direction as StandardView, horizontalDeg: view.orbitDeg?.horizontal ?? 0, verticalDeg: view.orbitDeg?.vertical ?? 0,
        box, margin: 0.05, aspect: width / height });
    });
    const images: ModelRenderImage[] = [];
    for (const camera of cameras) {
      if (signal?.aborted) throw this.failure('cancelled', 'The render was stopped.');
      const image = await renderer(camera, width, height);
      if (!image) throw this.failure('unavailable', 'The model could not be pictured here (no renderer for this tab).');
      images.push(image);
    }
    return { result: { ok: true, revision: this.revision, views: views.map(view => ({ name: modelRenderViewName(view), width, height })) }, images };
  }

  /** World bounds of what the container being edited holds, or null when it is empty. */
  private containerBox(path: Id[]): Box3 | null {
    const state = this.host.doc.state;
    const definitionId = path.length ? this.host.context.definitionId : state.rootDefinitionId;
    const local = definitionBounds(state, definitionId);
    if (!local || box3IsEmpty(local)) return null;
    const matrix = contextMatrix(state, path), box = box3Empty();
    for (const c of corners(local)) box3Expand(box, m4transformPoint(matrix, c));
    return box;
  }

  query(input: unknown): ModelQueryResult {
    const parsed = modelQuerySchema.safeParse(input);
    if (!parsed.success) throw this.failure('invalid_operation', zodMessage(parsed.error));
    const query = parsed.data, state = this.host.doc.state;
    const path = (query.container ?? [...this.host.context.path]) as Id[];
    const container = this.containerOrFail(path);
    const kinds = new Set<string>(query.kinds ?? ['instance', 'body', 'sketchEdge', 'sketchFace', 'guide', 'text', 'dimension', 'sectionPlane']);
    const ids = query.ids ? new Set<number>(query.ids) : null;
    const fields = new Set(query.fields ?? ['bounds', 'geometry', 'appearance']);
    const all: (() => ModelEntitySummary)[] = [];
    const inherited = inheritedMaterial(state, path);
    const keep = (kind: string, id: number): boolean => kinds.has(kind) && (!ids || ids.has(id));
    for (const inst of container.instances.values()) if (keep('instance', inst.id)) all.push(() => summarizeInstance(state, path, inst.id, fields));
    for (const body of container.bodies.values()) {
      if (keep('body', body.id)) all.push(() => summarizeBody(path, container, body.id, fields));
      if ((!kinds.has('face') && !kinds.has('edge')) || (ids && !ids.has(body.id))) continue;
      if (kinds.has('face')) for (const face of body.faces.values()) {
        if (query.facing && v3dot(face.plane.n, unit(query.facing)) < FACING_TOLERANCE) continue;
        if (query.containing && !faceContains(face, query.containing)) continue;
        all.push(() => summarizeFace(path, body.id, face, fields, frontMaterial(state, face, body, inherited)));
      }
      if (kinds.has('edge')) for (const edge of body.edges.values()) {
        if (!edgeMatches(edge.polyline, query.facing, query.containing)) continue;
        all.push(() => summarizeEdge(path, body.id, edge, fields));
      }
    }
    const sketch = container.sketch;
    for (const edge of sketch.edges.values()) if (keep('sketchEdge', edge.id)) all.push(() => {
      const out = base(path, 'sketchEdge', edge.id, edge);
      const a = sketch.vertices.get(edge.a)!.p, b = sketch.vertices.get(edge.b)!.p;
      if (fields.has('geometry')) Object.assign(out, { start: vec(a), end: vec(b), soft: edge.soft, smooth: edge.smooth, curve: edge.curveId !== null });
      if (fields.has('bounds')) out.bounds = boundsOut(boxOf([a, b]));
      return out;
    });
    for (const face of sketch.faces.values()) if (keep('sketchFace', face.id)) all.push(() => {
      const out = base(path, 'sketchFace', face.id, face);
      const loops = sketchFaceLoops(sketch, face);
      if (fields.has('geometry')) Object.assign(out, loopFields(face.plane.n, loops));
      if (fields.has('bounds')) out.bounds = boundsOut(boxOf(loops[0] ?? []));
      if (fields.has('appearance')) Object.assign(out, { frontMaterialId: face.frontMaterialId, backMaterialId: face.backMaterialId }, grainFields(face, frontMaterial(state, face, undefined, inherited)));
      return out;
    });
    for (const guide of container.guides.values()) if (keep('guide', guide.id)) all.push(() => {
      const points = guide.kind === 'segment' ? [guide.origin, guide.end] : guide.kind === 'line' ? [guide.origin, add(guide.origin, guide.dir)] : [guide.origin];
      return { ...base(path, 'guide', guide.id, guide), ...(fields.has('geometry') ? { points: points.map(vec), text: guide.kind } : {}) };
    });
    for (const text of container.texts.values()) if (keep('text', text.id)) all.push(() => ({ ...base(path, 'text', text.id, text), text: text.text.slice(0, 500) }));
    for (const dim of container.dimensions.values()) if (keep('dimension', dim.id)) all.push(() => ({ ...base(path, 'dimension', dim.id, dim), ...(fields.has('geometry') ? { points: [vec(dim.start), vec(dim.end)] } : {}) }));
    for (const plane of container.sectionPlanes.values()) if (keep('sectionPlane', plane.id)) all.push(() => ({
      ...base(path, 'sectionPlane', plane.id, plane), name: plane.name, active: container.activeSectionPlaneId === plane.id,
      ...(fields.has('geometry') ? { points: [vec(plane.origin)], normal: vec(plane.plane.n) } : {}),
    }));
    const offset = query.offset ?? 0, limit = query.limit ?? DEFAULT_QUERY_LIMIT;
    return { revision: this.revision, container: [...path], worldTransform: contextMatrix(state, path).map(round), total: all.length, offset,
      entities: all.slice(offset, offset + limit).map(make => make()), next: offset + limit < all.length ? offset + limit : null };
  }

  /**
   * Pairs of solids that interpenetrate, through nested groups and components, in the container's coordinates. Bounds
   * that overlap pick the candidates; the kernel measures their shared volume. Makes no change.
   */
  async findOverlaps(input: unknown): Promise<ModelOverlapsResult> {
    const parsed = modelOverlapsSchema.safeParse(input);
    if (!parsed.success) throw this.failure('invalid_operation', zodMessage(parsed.error));
    const state = this.host.doc.state, revision = this.revision;
    const path = (parsed.data.container ?? [...this.host.context.path]) as Id[];
    const container = this.containerOrFail(path);
    const minVolume = parsed.data.minVolume ?? 1e-9;
    interface Placed { ref: ModelRef & { name: string }; body: Body; matrix: MMat4 | null; box: Box3 }
    const solids: Placed[] = [];
    const walk = (c: EntityContainer, at: number[], matrix: MMat4 | null, name: string, depth: number): void => {
      for (const body of c.bodies.values()) {
        if (body.hidden || solids.length >= OVERLAP_SOLIDS) continue;
        const local = corners(meshBounds(body.mesh));
        solids.push({ ref: { path: at, kind: 'body', id: body.id, name }, body, matrix, box: boxOf(matrix ? local.map(p => m4transformPoint(matrix, p)) : local) });
      }
      if (depth >= 16) return;
      for (const inst of c.instances.values()) {
        const def = state.definitions.get(inst.definitionId as DefId);
        if (!def || inst.hidden) continue;
        walk(def.entities, [...at, inst.id], matrix ? m4mul(matrix, inst.transform) : [...inst.transform], inst.name || def.name, depth + 1);
      }
    };
    walk(container, [...path], null, '', 0);
    const kernel = kernelOf(this.commands.ctx);
    const overlaps: ModelOverlap[] = [];
    let truncated = solids.length >= OVERLAP_SOLIDS, temp = 0;
    const upload = async (p: Placed): Promise<{ bodyId: number; version: number }> => {
      if (!p.matrix) { await kernel.ensureBody(p.body.id, p.body.version, p.body.mesh); return { bodyId: p.body.id, version: p.body.version }; }
      const verts = new Float64Array(p.body.mesh.verts.length);
      for (let i = 0; i < verts.length; i += 3) verts.set(m4transformPoint(p.matrix, [p.body.mesh.verts[i]!, p.body.mesh.verts[i + 1]!, p.body.mesh.verts[i + 2]!]), i);
      const id = { bodyId: OVERLAP_TEMP_BASE + (temp++ % 0xffff), version: 0 };
      await kernel.ensureBody(id.bodyId, id.version, { verts, tris: p.body.mesh.tris, faceId: p.body.mesh.faceId });
      return id;
    };
    const temps: { bodyId: number; version: number }[] = [];
    try {
      for (let i = 0; i < solids.length && !truncated; i++) for (let j = i + 1; j < solids.length; j++) {
        const a = solids[i]!, b = solids[j]!;
        if (!boxesOverlap(a.box, b.box, -MERGE_TOL)) continue;
        const ia = await upload(a), ib = await upload(b);
        if (a.matrix) temps.push(ia);
        if (b.matrix) temps.push(ib);
        const shared = await kernel.boolean({ op: 'intersect', a: ia, b: ib, nextFaceId: 0 });
        const volume = shared.components.reduce((sum, c) => sum + c.props.volume, 0);
        if (!(volume > minVolume)) continue;
        const box = box3Empty();
        for (const c of shared.components) for (let k = 0; k < c.mesh.verts.length; k += 3) box3Expand(box, [c.mesh.verts[k]!, c.mesh.verts[k + 1]!, c.mesh.verts[k + 2]!]);
        overlaps.push({ a: a.ref, b: b.ref, volume: Math.round(volume * 1e12) / 1e12, bounds: boundsOut(box)! });
        if (overlaps.length >= OVERLAP_PAIRS) { truncated = true; break; }
      }
    } finally {
      for (const t of temps) void kernel.release(t.bodyId, t.version).catch(() => undefined);
    }
    return { revision, container: [...path], solids: solids.length, overlaps, truncated };
  }

  /** The built-in material library: its categories, or one category's materials. */
  materialLibrary(input: unknown): ModelLibraryResult {
    const parsed = modelMaterialLibrarySchema.safeParse(input);
    if (!parsed.success) throw this.failure('invalid_operation', zodMessage(parsed.error));
    const category = parsed.data.category;
    if (category === null) return { categories: LIBRARY_CATEGORIES.map(name => ({ name, count: BUILTIN_LIBRARY.filter(m => m.category === name).length })) };
    const materials = BUILTIN_LIBRARY.filter(m => sameName(m.category, category));
    if (materials.length === 0) throw this.failure('invalid_reference', `There is no library category "${category}"; the categories are ${LIBRARY_CATEGORIES.join(', ')}.`);
    return { materials: materials.map(m => ({ key: m.key, name: m.name, color: hex(m.color), textured: !!m.texture, ...(m.texture ? { grain: m.texture.grain ?? 'width' } : {}) })) };
  }

  /** Validate, check the revision, then run every operation as one undo entry; rejects with `ModelApiFailure`. */
  async apply(input: unknown, signal?: AbortSignal): Promise<ModelBatchResult> {
    const parsed = modelBatchSchema.safeParse(input);
    if (!parsed.success) {
      const index = parsed.error.issues.find(i => i.path[0] === 'operations' && typeof i.path[1] === 'number')?.path[1];
      throw this.failure(parsed.error.issues.some(i => i.code === 'too_big' && i.path.length === 1) ? 'limit_exceeded' : 'invalid_operation', zodMessage(parsed.error), typeof index === 'number' ? index : undefined);
    }
    const batch = parsed.data;
    const operations: ModelOperation[] = batch.operations.map((raw, index) => {
      if (PLANNED.has(raw.op)) throw this.failure('unavailable', `Operation ${index} (${raw.op}) is not available yet in this version. Nothing was changed.`, index);
      const op = modelOperationSchema.safeParse(raw);
      if (!op.success) throw this.failure('invalid_operation', `Operation ${index}: ${operationMessage(raw, op.error)}`, index);
      return op.data;
    });
    const points = operations.reduce((sum, op) => sum + pointCount(op), 0);
    if (points > MODEL_LIMITS.pointsPerBatch) throw this.failure('limit_exceeded', `The batch names ${points} entities and points; the limit is ${MODEL_LIMITS.pointsPerBatch}.`);
    this.checkNames(batch.operations, operations);
    const start = this.revision;
    const own = this.ownTo === start;
    if (batch.expectedRevision !== start && !(own && batch.expectedRevision >= this.ownFrom && batch.expectedRevision < start))
      throw this.failure('stale_revision', `The model changed since revision ${batch.expectedRevision}; it is now at revision ${start}. Read it again before editing.`);
    const host = this.host, undo = host.undoStack;
    const path = (batch.container ?? [...host.context.path]) as Id[];
    this.containerOrFail(path);
    this.runtime.stop();
    const label = `${this.client}: ${batch.label}`;
    const dropped = this.dropUndone();
    // Earlier batches' names, and this batch's as they are given; the table changes only when the batch commits.
    const names = new Map(this.names), batchNo = ++this.batches;
    const created = new Map<string, Named>(), rebound: string[] = [];
    const results: ModelBatchResult['results'] = [];
    // Nothing but this object's own batches changed the model since its last commit, so this batch joins that entry.
    const joins = own && this.step && undo.peek() === this.step.entry ? this.step : null;
    const savedPath = [...host.context.path], savedSelection = host.selection.snapshot();
    const deadline = Date.now() + MODEL_LIMITS.kernelSeconds * 1000;
    let at = 0, failed: ModelApiFailure | null = null, committed: UndoEntry | null = null;
    undo.beginGroup(label);
    try {
      undo.withinGroup(() => { if (!samePath(path, savedPath)) host.setContext(path); });
      for (const [index, op] of operations.entries()) {
        at = index;
        if (signal?.aborted) throw this.failure('cancelled', 'The batch was stopped before it finished. Nothing was changed.', index);
        if (Date.now() > deadline) throw this.failure('limit_exceeded', `The batch ran longer than ${MODEL_LIMITS.kernelSeconds} seconds and was cancelled. Nothing was changed.`, index);
        const { named, ...result } = await this.run(op, path, names, batchNo, label);
        if ('as' in op && op.as) {
          if (named) {
            // checkNames allowed a second use only by an operation that reads the name, so it now names the result.
            if (names.has(op.as) && !created.has(op.as)) rebound.push(op.as);
            names.set(op.as, { named, path: [...path], batch: batchNo, undo: null });
            created.set(op.as, named);
          }
        }
        results.push({ op: op.op, ...result });
      }
      if (signal?.aborted) throw this.failure('cancelled', 'The batch was stopped before it finished. Nothing was changed.', at);
    } catch (cause) {
      failed = cause instanceof ModelApiFailure ? new ModelApiFailure({ ...cause.error, operationIndex: cause.error.operationIndex ?? at })
        : this.failure(errorCode(cause), `Operation ${at} (${operations[at]?.op}) failed: ${cause instanceof Error ? cause.message : String(cause)}. Nothing was changed.`, at);
    } finally {
      undo.withinGroup(() => { if (!samePath(host.context.path, savedPath)) host.setContext(savedPath); });
      if (!samePath(path, savedPath)) host.selection.restore(savedSelection);
      const labels = [...joins?.labels ?? [], batch.label];
      committed = undo.endGroup(failed === null, joins ? { entry: joins.entry, label: `${this.client}: ${summarizeLabels(labels)}` } : undefined);
      if (committed) {
        if (committed === joins?.entry) joins.labels = labels;
        else { this.step = { entry: committed, labels: [batch.label] }; this.steps++; }
        this.committedLabels.push(batch.label);
      }
      // Committed or reverted, the change is this object's own, so it does not make the client's revision stale.
      if (!own) this.ownFrom = start;
      this.ownTo = this.revision;
    }
    // Reverting the batch is itself a change, so a failure reports the revision after it.
    if (failed) throw new ModelApiFailure({ ...failed.error, revision: this.revision });
    const earlier: Record<string, ModelNameEntry> = {};
    for (const [name, entry] of this.names) if (!created.has(name) && this.alive(entry)) earlier[name] = nameOut(entry.named);
    for (const [name, named] of created) {
      this.names.set(name, { named, path: [...path], batch: batchNo, undo: committed });
      this.undone.delete(name);
    }
    return { ok: true, revision: this.revision, label, created: Object.fromEntries([...created].map(([name, value]) => [name, value.id])),
      ...(Object.keys(earlier).length ? { names: earlier } : {}), ...(rebound.length ? { rebound } : {}), ...(dropped.length ? { dropped } : {}), results };
  }

  /**
   * Drop the names of batches that were undone: their undo entry is no longer applied and what they named is gone.
   * A redone batch's entry is applied again, so its names stay; an entry that fell off a full undo history does not
   * drop names that still name something.
   */
  private dropUndone(): string[] {
    const applied = new Set(this.host.undoStack.entries), dropped: string[] = [];
    for (const [name, entry] of this.names) {
      if (!entry.undo || applied.has(entry.undo) || this.alive(entry)) continue;
      this.names.delete(name);
      this.undone.add(name);
      dropped.push(name);
    }
    return dropped;
  }

  /** Whether what a name stands for still exists where it was named. */
  private alive(entry: NameEntry): boolean {
    const state = this.host.doc.state, n = entry.named;
    if (n.kind === 'tag') return state.tags.has(n.id as never);
    if (n.kind === 'material') return state.materials.has(n.id as never);
    if (n.kind === 'scene') return state.scenes.has(n.id as never);
    let c: EntityContainer;
    try { c = containerAt(state, entry.path as Id[]); } catch { return false; }
    if (n.shape) return n.shape.edges.some(id => c.sketch.edges.has(id as Id)) || n.shape.faces.some(id => c.sketch.faces.has(id as Id))
      || n.shape.imprinted.some(f => c.bodies.has(f.bodyId as Id));
    switch (n.kind) {
      case 'instance': return c.instances.has(n.id as Id);
      case 'body': return c.bodies.has(n.id as Id);
      case 'face': return !!c.bodies.get(n.id as Id)?.faces.has(n.faceId as never);
      case 'sketchEdge': return c.sketch.edges.has(n.id as Id);
      case 'sketchFace': return c.sketch.faces.has(n.id as Id);
      case 'guide': return c.guides.has(n.id as Id);
      case 'text': return c.texts.has(n.id as Id);
      case 'dimension': return c.dimensions.has(n.id as Id);
      case 'sectionPlane': return c.sectionPlanes.has(n.id as Id);
      default: return false;
    }
  }

  /**
   * Checks every `as` before anything runs: an operation that names nothing takes none, a transform names only one
   * copy of one entity, and a name given twice in the batch is given again only by an operation that reads it, whose
   * result it then names, as a subtract that keeps cutting `"$side"` and names the result `side`.
   */
  private checkNames(raw: readonly Record<string, unknown>[], operations: readonly ModelOperation[]): void {
    const given = new Set<string>();
    for (const [index, op] of operations.entries()) {
      const as = 'as' in op ? op.as : undefined;
      if (as === undefined) {
        if (raw[index]?.as !== undefined)
          throw this.failure('invalid_operation', `Operation ${index} (${op.op}) does not name a result, so it takes no "as". Name what the operation acts on where it is made. Nothing was changed.`, index);
        continue;
      }
      if (TRANSFORM_OPS.has(op.op) && 'refs' in op) {
        const copies = 'copies' in op ? op.copies : undefined;
        const one = copies === undefined ? 'copy' in op && op.copy === true : copies === 1;
        if (!one || op.refs.length !== 1)
          throw this.failure('invalid_operation', `Operation ${index} (${op.op}): "as" names the copy, so it needs copy: true and one entity in refs; for several copies, read their ids from the result's refs. Nothing was changed.`, index);
      }
      if (given.has(as) && !readsName(op, as))
        throw this.failure('invalid_operation', `The name "${as}" is used twice in this batch. An operation may give a name again only when it reads "$${as}", such as a subtract whose target is "$${as}". Nothing was changed.`, index);
      given.add(as);
    }
  }

  private failure(code: ModelApiErrorCode, message: string, operationIndex?: number): ModelApiFailure {
    return new ModelApiFailure({ code, message, revision: this.revision, ...(operationIndex === undefined ? {} : { operationIndex }) });
  }

  private containerOrFail(path: readonly Id[]): EntityContainer {
    try {
      return containerAt(this.host.doc.state, path);
    } catch {
      throw this.failure('invalid_reference', `No group or component at instance path [${path.join(', ')}]. Call ${MODEL_TOOLS.getDocument.name} for the open container.`);
    }
  }

  /**
   * Resolves `"$name"`s and entity references of the container at `path` for batch number `batch`. A name an earlier
   * batch gave must still name something, in this container unless it is a tag, material or scene; with
   * `definition`, a group or placement named in another container still stands for its definition.
   */
  private resolver(path: Id[], names: ReadonlyMap<string, NameEntry>, batch: number) {
    const host = this.host;
    const named = (value: string, use: 'entity' | 'definition' = 'entity'): Named => {
      const name = LOCAL_REFERENCE.exec(value)?.[1];
      const entry = name === undefined ? undefined : names.get(name);
      if (!entry) {
        if (name !== undefined && this.undone.has(name)) throw this.failure('invalid_reference', `"${value}" was dropped: the batch that named it was undone. Create it again or use {kind, id} from ${MODEL_TOOLS.query.name}.`);
        const live = [...names].filter(([, e]) => e.batch === batch || this.alive(e)).slice(0, 20).map(([n, e]) => `"$${n}" (${describeNamed(e.named)})`);
        throw this.failure('invalid_reference', `"${value}" does not name anything created earlier in this batch or an earlier batch of this message.${live.length ? ` Names you can use: ${live.join(', ')}.` : ''}`);
      }
      if (entry.batch === batch) return entry.named;
      const what = describeNamed(entry.named);
      if (use === 'definition' && entry.named.definitionId !== undefined && host.doc.state.definitions.has(entry.named.definitionId as DefId)) return entry.named;
      if (!DOCUMENT_KINDS.has(entry.named.kind) && !samePath(entry.path, path))
        throw this.failure('invalid_reference', `"${value}" names ${what} in the container at instance path [${entry.path.join(', ')}], but this batch edits [${path.join(', ')}]. Edit that container, or use {kind, id} from ${MODEL_TOOLS.query.name} for this one.`);
      if (!this.alive(entry))
        throw this.failure('invalid_reference', `"${value}" named ${what}, which no longer exists: it was deleted, used up by a later operation (a union, subtract or push/pull of a drawn face), or moved into a group. Call ${MODEL_TOOLS.query.name} for current ids.`);
      return entry.named;
    };
    const ref = (input: ModelRefInput): EntityRef => {
      const state = host.doc.state, container = containerAt(state, path);
      if (typeof input === 'object' && 'body' in input) return this.selectFace(path, input, named).ref;
      const target: { kind: string; id: number; faceId?: number | undefined; edgeKey?: string | undefined } = typeof input === 'string' ? named(input) : input;
      const exists = (() => {
        switch (target.kind) {
          case 'instance': return container.instances.has(target.id as Id);
          case 'body': return container.bodies.has(target.id as Id);
          case 'face': return 'faceId' in target && target.faceId !== undefined && !!container.bodies.get(target.id as Id)?.faces.has(target.faceId as never);
          case 'sketchEdge': return container.sketch.edges.has(target.id as Id);
          case 'sketchFace': return container.sketch.faces.has(target.id as Id);
          case 'guide': return container.guides.has(target.id as Id);
          case 'text': return container.texts.has(target.id as Id);
          case 'dimension': return container.dimensions.has(target.id as Id);
          case 'sectionPlane': return container.sectionPlanes.has(target.id as Id);
          case 'edge': return target.edgeKey !== undefined && !!container.bodies.get(target.id as Id)?.edges.has(target.edgeKey as never);
          default: return false;
        }
      })();
      const shown = typeof input === 'string' ? input : `${input.kind} ${input.id}${'faceId' in input ? ` face ${input.faceId}` : 'edgeKey' in input ? ` edge ${input.edgeKey}` : ''}`;
      if (!exists) throw this.failure('invalid_reference', `There is no ${shown} in the container being edited${typeof input === 'string' ? ' any more' : ''}. Call ${MODEL_TOOLS.query.name} for current ids.`);
      if (target.kind === 'face') return { kind: 'face', path, id: target.id as Id, faceId: target.faceId as never, region: null };
      if (target.kind === 'edge') return { kind: 'edge', path, id: target.id as Id, edgeKey: target.edgeKey as never };
      return { kind: target.kind as 'instance', path, id: target.id as Id };
    };
    /** References, with a drawn shape's "$name" standing for every edge and face it made that still exists. */
    const refsOf = (inputs: readonly ModelRefInput[]): EntityRef[] => inputs.flatMap(input => {
      const shape = typeof input === 'string' ? named(input).shape : undefined;
      if (!shape) return [ref(input)];
      const container = containerAt(host.doc.state, path);
      const out: EntityRef[] = [
        ...shape.edges.filter(id => container.sketch.edges.has(id as Id)).map((id): EntityRef => ({ kind: 'sketchEdge', path, id: id as Id })),
        ...shape.faces.filter(id => container.sketch.faces.has(id as Id)).map((id): EntityRef => ({ kind: 'sketchFace', path, id: id as Id })),
      ];
      if (out.length === 0) throw this.failure('invalid_reference', `"${input}" names loose edges and faces that no longer exist, or a shape drawn on a solid; refer to the solid instead.`);
      return out;
    });
    return { named, ref, refsOf };
  }

  private async run(op: ModelOperation, path: Id[], names: ReadonlyMap<string, NameEntry>, batch: number, label: string): Promise<OpResult> {
    const host = this.host, undo = host.undoStack;
    const exec = <T>(command: string, params: Record<string, unknown>): T => undo.withinGroup(() => this.commands.execute(command, params) as T);
    const { named, ref, refsOf } = this.resolver(path, names, batch);
    const sceneId = (input: number | string): number => this.resolveScene(input, names);
    const capture = (camera: ModelCameraInput | undefined, what: string): CameraState | undefined => {
      if (camera) return this.cameraFor(camera, path, ref);
      if (!this.camera) throw this.failure('unavailable', `There is no viewport here, so ${what} needs an exact camera.`);
      return undefined;
    };
    const only = (refs: EntityRef[], kinds: readonly EntityRef['kind'][], what: string): EntityRef[] => {
      const wrong = refs.find(r => !kinds.includes(r.kind));
      if (wrong) throw this.failure('invalid_operation', `${what}; ${wrong.kind} ${wrong.id} is not one.`);
      return refs;
    };
    const idOf = (value: number | string, kind: 'tag' | 'material'): number => {
      if (typeof value === 'number') return value;
      const found = named(value);
      if (found.kind !== kind) throw this.failure('invalid_reference', `"${value}" names a ${found.kind}, not a ${kind}.`);
      return found.id;
    };
    const definitionOf = (value: number | string): number => {
      if (typeof value === 'number') return value;
      const found = named(value, 'definition');
      // A placement's definition is read when used: Make Unique may have given it a new one since.
      const placed = found.kind === 'instance' ? containerAt(host.doc.state, path).instances.get(found.id as Id) : undefined;
      if (placed) return placed.definitionId;
      if (found.definitionId === undefined) throw this.failure('invalid_reference', `"${value}" names a ${found.kind}, not a group or component.`);
      return found.definitionId;
    };
    const instanceResult = (instanceId: number): OpResult => {
      const definitionId = containerAt(host.doc.state, path).instances.get(instanceId as Id)!.definitionId;
      return { id: instanceId, definitionId, named: { kind: 'instance', id: instanceId, definitionId } };
    };
    const transform = async (refs: EntityRef[], local: MMat4, copy: boolean, copies: number | undefined, named = false): Promise<OpResult> => {
      if (refs.some(r => r.kind === 'face')) throw this.failure('invalid_operation', 'Moving a face of a solid is push/pull: use push_pull.');
      // checkNames let `as` through only for one copy of one reference, but a drawn shape's name stands for its edges.
      if (named && refs.length !== 1) throw this.failure('invalid_operation', `"as" names one copied solid, group or placement; these refs are ${refs.length} entities. Read the copies' ids from the result's refs.`);
      // The API's matrices are local to the container; the transform commands take world matrices.
      const frame = contextMatrix(host.doc.state, path);
      const world = m4mul(frame, m4mul(local, m4invert(frame) ?? frame));
      const matrices = copies ? arrayMatrices(world, copies, 'external') : [world];
      const result = await this.transform(matrices.map(m => planTransform(host.doc.state, refs, m, copy || copies !== undefined, label)));
      const made = result.refs?.length === 1 ? result.refs[0]! : undefined;
      if (!named) return result;
      if (!made) throw this.failure('invalid_operation', `"as" names one copy, but the operation made ${result.refs?.length ?? 0}. Read the copies' ids from the result's refs.`);
      return made.kind === 'instance' ? { ...result, named: instanceResult(made.id).named! } : { ...result, named: { kind: made.kind, id: made.id } };
    };
    const world = (p: Vec3): Vec3 => contextFrame(host.doc.state, path).toWorld(p);
    const bodyOut = (id: number): ModelRef => ({ path: [...path], kind: 'body', id });
    /** Run drawing commands and report what they made; a closed shape must make a face, or divide a solid's face. */
    const draw = (commands: () => void, normal: Vec3 | null, inside: Vec3 | null, closed: boolean, what: string): OpResult => {
      const before = drawingSnapshot(containerAt(host.doc.state, path));
      commands();
      const container = containerAt(host.doc.state, path);
      const shape = drawnShape(container, before, normal, inside);
      if (closed && shape.faces.length === 0 && shape.imprinted.length === 0)
        throw this.failure('invalid_geometry', `The ${what} did not make a face: it crosses itself, or lies along edges already drawn.`);
      if (closed && inside && !shapeFace(container, shape))
        throw this.failure('invalid_geometry', `The ${what} lies partly on a face of a solid, so it made no face of its own. Draw it clear of solids, or wholly on one face.`);
      const face = (inside ? shape.faces.find(id => sketchFaceContains(container, id, inside)) : undefined) ?? shape.faces[0];
      const imprint = shape.imprinted[0];
      const primary: Named = face !== undefined ? { kind: 'sketchFace', id: face, shape }
        : imprint ? { kind: 'face', id: imprint.bodyId, faceId: imprint.faceId, shape }
        : shape.edges[0] !== undefined ? { kind: 'sketchEdge', id: shape.edges[0], shape }
        : (() => { throw this.failure('invalid_geometry', `The ${what} drew nothing new: its edges are already there.`); })();
      const refs: ModelRef[] = [
        ...shape.edges.map(id => ({ path: [...path], kind: 'sketchEdge' as const, id })),
        ...shape.faces.map(id => ({ path: [...path], kind: 'sketchFace' as const, id })),
        ...shape.imprinted.map(f => ({ path: [...path], kind: 'face' as const, id: f.bodyId, faceId: f.faceId })),
      ];
      return { id: primary.id, refs, named: primary };
    };
    const solid = (input: ModelRefInput, role: string): { kind: 'body'; path: number[]; id: number } => {
      const r = ref(input);
      if (r.kind !== 'body') throw this.failure('invalid_operation', `${role} must be a solid of the container being edited; ${r.kind} ${r.id} is not one. Cut and join solids before grouping them, or name the group as the batch's container.`);
      return { kind: 'body', path: [...path], id: r.id };
    };
    /** The kernel step of a Solid Tools command, awaited outside the group's edits, then the command commits it. */
    const boolean = async (mode: SolidsPairMode, a: { kind: 'body'; path: number[]; id: number }, b: { kind: 'body'; path: number[]; id: number }, check?: (work: SolidsKernelWork) => void): Promise<SolidsApplyResult> => {
      const precomputed = await runSolidsKernel(host, kernelOf(this.commands.ctx), mode, { a, b });
      check?.(precomputed);
      return exec<Promise<SolidsApplyResult>>(`solids.${mode}`, { a, b, precomputed });
    };
    const resolver = { named, ref };
    switch (op.op) {
      case 'add_box': {
        const thin = [0, 1, 2].find(axis => !(op.max[axis]! - op.min[axis]! > MERGE_TOL));
        if (thin !== undefined) throw this.failure('invalid_geometry', `A box needs max greater than min on every axis; ${'xyz'[thin]} is ${op.min[thin]} to ${op.max[thin]}.`);
        const id = exec<number>('model.addBox', { min: op.min, max: op.max });
        return { id, named: { kind: 'body', id } };
      }
      case 'add_edges': {
        const at = op.edges.findIndex(([a, b]) => !(dist(a, b) > MERGE_TOL));
        if (at >= 0) throw this.failure('invalid_geometry', `Segment ${at} has no length: its ends must be more than ${MERGE_TOL} m apart.`);
        return draw(() => { for (const [a, b] of op.edges) exec('sketch.addEdge', { a: world(a), b: world(b) }); }, null, null, false, 'edges');
      }
      case 'add_polyline': {
        const closed = op.closed ?? false;
        const points = closed && op.points.length > 3 && dist(op.points[0]!, op.points.at(-1)!) <= MERGE_TOL ? op.points.slice(0, -1) : op.points;
        const short = points.findIndex((p, i) => i > 0 && !(dist(points[i - 1]!, p) > MERGE_TOL));
        if (short >= 0) throw this.failure('invalid_geometry', `Points ${short - 1} and ${short} are the same point; each segment must be longer than ${MERGE_TOL} m.`);
        if (!closed) return draw(() => exec('sketch.addPolyline', { points: points.map(world) }), null, null, false, 'polyline');
        const normal = flatNormal(points);
        if (points.length < 3 || !normal) throw this.failure('invalid_geometry', 'A closed polyline needs at least three points that are not in one line.');
        const off = Math.max(...points.map(p => Math.abs(v3dot(v3sub(p, points[0]!), normal))));
        if (off > MERGE_TOL) throw this.failure('invalid_geometry', `A closed polyline must be flat to make a face; a point is ${round(off)} m off the plane of the others.`);
        return draw(() => exec('sketch.addPolyline', { points: points.map(world), closed: true }), normal, interiorPoint(points, normal), true, 'closed polyline');
      }
      case 'add_rectangle': {
        const l1 = v3len(op.side1), l2 = v3len(op.side2);
        if (!(l1 > MERGE_TOL && l2 > MERGE_TOL)) throw this.failure('invalid_geometry', `Both sides of a rectangle must be longer than ${MERGE_TOL} m; side1 is ${round(l1)} m and side2 ${round(l2)} m.`);
        if (Math.abs(v3dot(op.side1, op.side2)) / l1 > MERGE_TOL) throw this.failure('invalid_geometry', 'side2 must be square to side1.');
        const c = op.corner, b = v3add(c, op.side1), d = v3add(c, op.side2), e = v3add(b, op.side2);
        const normal = unit(v3cross(op.side1, op.side2));
        return draw(() => exec('sketch.rectangle', { a: world(c), b: world(b), c: world(e), d: world(d) }), normal, v3add(c, v3scale(v3add(op.side1, op.side2), 0.5)), true, 'rectangle');
      }
      case 'add_circle':
      case 'add_polygon': {
        const kind = op.op === 'add_circle' ? 'circle' as const : 'polygon' as const;
        const segments = op.op === 'add_circle' ? op.segments ?? 24 : op.sides;
        if (!(2 * op.radius * Math.sin(Math.PI / segments) > MERGE_TOL)) throw this.failure('invalid_geometry', `A ${kind} of radius ${op.radius} m is too small for ${segments} sides.`);
        const normal = unit(op.normal), frame = contextFrame(host.doc.state, path);
        const curve = { kind, center: op.center, normal, radius: op.radius, startAngle: 0, endAngle: 2 * Math.PI, segments };
        const params = { points: curvePoints(curve).map(world), closed: true, curve: { ...curve, center: world(op.center), normal: frame.toWorldNormal(normal) } };
        return draw(() => exec('sketch.addCurve', params), normal, op.center, true, kind);
      }
      case 'push_pull': {
        if (!(Math.abs(op.distance) > MERGE_TOL)) throw this.failure('invalid_geometry', `push_pull needs a distance longer than ${MERGE_TOL} m.`);
        const face = this.faceTarget(path, op.face, resolver, 'push or pull');
        const mode = op.mode === 'new_body' ? 'newBody' as const : 'merge' as const;
        const state = host.doc.state;
        // The API's distance is local and along the face's facing; the command's is in model units along the face normal.
        const along = v3dot(face.normal, face.plane.n) < 0 ? -1 : 1;
        const distance = (op.distance * along) / localPushPullDistance(state, path, face.plane.n, 1);
        const plan = planPushPull(state, face.target, distance, mode);
        const precomputed = await runPushPullKernel(kernelOf(this.commands.ctx), plan);
        const result = await exec<Promise<PushPullApplyResult>>('pushpull.apply', { target: face.target, distance, mode, precomputed });
        if (plan.kind === 'body' && mode === 'merge' && !result.bodyIds.includes(plan.body.id))
          throw this.failure('invalid_geometry', `Pushing ${face.shown} by ${op.distance} m would remove all of solid ${plan.body.id}; delete the solid instead.`);
        if (result.bodyIds.length === 0) throw this.failure('invalid_geometry', `Pulling ${face.shown} by ${op.distance} m makes no solid.`);
        this.checkSolids(path, result.bodyIds, 'push_pull');
        const id = plan.kind === 'body' && mode === 'merge' ? plan.body.id : result.bodyIds[0]!;
        return { id, refs: result.bodyIds.map(bodyOut), named: { kind: 'body', id } };
      }
      case 'union': {
        const [first, ...rest] = op.refs.map((r, i) => solid(r, `Solid ${i}`));
        const deleted: number[] = [];
        const bounds = (id: number) => meshBounds(containerAt(host.doc.state, path).bodies.get(id as Id)!.mesh);
        // Join whichever remaining solid touches the solid joined so far, so the order of refs does not matter:
        // a frame listed as its two stiles and then its rails joins through the rails.
        let pending = rest.map((r, i) => ({ r, index: i + 1 }));
        while (pending.length > 0) {
          let joined: number | undefined;
          for (const [k, { r }] of pending.entries()) {
            if (!boxesOverlap(bounds(first!.id), bounds(r.id))) continue;
            const work = await runSolidsKernel(host, kernelOf(this.commands.ctx), 'union', { a: first!, b: r });
            if (work.mode !== 'union' || work.result.components.length !== 1) continue;
            const result = await exec<Promise<SolidsApplyResult>>('solids.union', { a: first!, b: r, precomputed: work });
            deleted.push(...result.deleted);
            joined = k;
            break;
          }
          if (joined === undefined) {
            const which = pending.map(p => p.index), ids = pending.map(p => p.r.id);
            const list = (xs: number[]) => xs.length === 1 ? `${xs[0]}` : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;
            throw this.failure('invalid_geometry', `${which.length === 1 ? 'Ref' : 'Refs'} ${list(which)} (${ids.length === 1 ? 'solid' : 'solids'} ${list(ids)}) ${ids.length === 1 ? 'does' : 'do'} not touch the other solids, so ${ids.length === 1 ? 'it' : 'they'} cannot join them into one solid; put separate parts in one group with make_group instead.`);
          }
          pending = pending.filter((_, k) => k !== joined);
        }
        this.checkSolids(path, [first!.id], 'union');
        return { id: first!.id, refs: [bodyOut(first!.id)], deleted: deleted.map(bodyOut), named: { kind: 'body', id: first!.id } };
      }
      case 'subtract': {
        const target = solid(op.target, 'The target');
        const cutters = op.cutters.map((r, i) => solid(r, `Cutter ${i}`));
        if (cutters.some(c => c.id === target.id)) throw this.failure('invalid_operation', `Solid ${target.id} cannot cut itself.`);
        if (new Set(cutters.map(c => c.id)).size !== cutters.length) throw this.failure('invalid_operation', 'The same cutter is named twice.');
        let pieces = [target.id];
        const deleted: number[] = [];
        for (const [i, cutter] of cutters.entries()) {
          const container = containerAt(host.doc.state, path);
          const reach = meshBounds(container.bodies.get(cutter.id as Id)!.mesh);
          const touched = pieces.filter(id => boxesOverlap(meshBounds(container.bodies.get(id as Id)!.mesh), reach));
          const volume = (ids: number[]) => ids.reduce((sum, id) => sum + (containerAt(host.doc.state, path).bodies.get(id as Id)?.props.volume ?? 0), 0);
          const before = volume(touched);
          const after: number[] = [];
          for (const [j, piece] of touched.entries()) {
            // The last cut deletes the cutter unless it is kept; earlier pieces are trimmed so it survives them.
            // The command refuses a cut that leaves nothing; say which cutter covers which solid instead.
            const result = await boolean(!op.keepCutters && j === touched.length - 1 ? 'subtract' : 'trim', cutter, { kind: 'body', path, id: piece }, work => {
              if (solidsResultIsEmpty(work)) throw this.failure('invalid_geometry', `Cutter ${i} (solid ${cutter.id}) covers all of solid ${piece}, so nothing would be left; delete the solid instead.`);
            });
            after.push(...result.bodyIds);
            deleted.push(...result.deleted);
          }
          if (touched.length > 0 && after.length === 0) throw this.failure('invalid_geometry', `Cutter ${i} (solid ${cutter.id}) covers all of solid ${target.id}, so nothing would be left; delete the solid instead.`);
          if (!(before - volume(after) > MIN_VOLUME)) throw this.failure('invalid_geometry', `Cutter ${i} (solid ${cutter.id}) does not overlap solid ${target.id}, so it would cut nothing; check where it is.`);
          pieces = [...pieces.filter(id => !touched.includes(id)), ...after];
        }
        this.checkSolids(path, pieces, 'subtract');
        const id = pieces.includes(target.id) ? target.id : pieces[0]!;
        return { id, refs: pieces.map(bodyOut), deleted: deleted.filter(d => d !== target.id).map(bodyOut), named: { kind: 'body', id } };
      }
      case 'intersect': {
        const [first, ...rest] = op.refs.map((r, i) => solid(r, `Solid ${i}`));
        const deleted: number[] = [];
        let pieces = [first!.id];
        for (const other of rest) {
          if (pieces.length > 1) throw this.failure('invalid_geometry', `The shared volume of the first solids is in ${pieces.length} pieces; intersect them with solid ${other.id} one at a time.`);
          const result = await boolean('intersect', first!, other, work => {
            if (solidsResultIsEmpty(work)) throw this.failure('invalid_geometry', `Solids ${first!.id} and ${other.id} do not overlap, so they share no volume.`);
          });
          pieces = result.bodyIds;
          deleted.push(...result.deleted);
        }
        this.checkSolids(path, pieces, 'intersect');
        return { id: first!.id, refs: pieces.map(bodyOut), deleted: deleted.map(bodyOut), named: { kind: 'body', id: first!.id } };
      }
      case 'split': {
        const [a, b] = op.refs.map((r, i) => solid(r, `Solid ${i}`));
        const result = await boolean('split', a!, b!, work => {
          if (work.mode === 'split' && work.split.components.length === 0) throw this.failure('invalid_geometry', `Solids ${a!.id} and ${b!.id} do not overlap, so there is nothing to split.`);
        });
        this.checkSolids(path, result.bodyIds, 'split');
        return { id: result.bodyIds[0]!, refs: result.bodyIds.map(bodyOut), deleted: result.deleted.map(bodyOut) };
      }
      case 'follow_me': {
        const profile = this.faceTarget(path, op.profile, resolver, 'sweep');
        const params: Record<string, unknown> = { profile: profile.target, ...(op.closed !== undefined ? { closed: op.closed } : {}) };
        if (op.pathPoints) {
          const short = op.pathPoints.findIndex((p, i) => i > 0 && !(dist(op.pathPoints![i - 1]!, p) > MERGE_TOL));
          if (short >= 0) throw this.failure('invalid_geometry', `Path points ${short - 1} and ${short} are the same point.`);
          params.pathPoints = op.pathPoints.map(world);
        } else {
          params.pathEdgeIds = (op.pathEdges ?? []).flatMap(input => {
            const shape = typeof input === 'string' ? named(input).shape : undefined;
            if (shape) return shape.edges.filter(id => containerAt(host.doc.state, path).sketch.edges.has(id as Id));
            const r = ref(input);
            if (r.kind !== 'sketchEdge') throw this.failure('invalid_operation', `A path is made of loose edges; ${r.kind} ${r.id} is not one. Give pathPoints to follow the edges of a solid.`);
            return [r.id];
          });
        }
        const precomputed = await runFollowMeKernel(host, kernelOf(this.commands.ctx), params as FollowMeParams);
        const result = await exec<Promise<FollowMeApplyResult>>('followme.apply', { ...params, precomputed });
        if (result.bodyIds.length === 0) throw this.failure('invalid_geometry', `Sweeping ${profile.shown} along the path makes no solid.`);
        this.checkSolids(path, result.bodyIds, 'follow_me');
        return { id: result.bodyIds[0]!, refs: result.bodyIds.map(bodyOut), named: { kind: 'body', id: result.bodyIds[0]! } };
      }
      case 'fillet_edges':
      case 'chamfer_edges':
      case 'profile_edges': {
        const target = solid(op.body, 'The body');
        const body = containerAt(host.doc.state, path).bodies.get(target.id as Id)!;
        // Selectors are resolved against the solid as it is now, so a face or direction never goes stale.
        const selectors = op.edges as readonly EdgeSelector[];
        const edges = this.edgeKeys(body, selectors);
        const reference = op.op === 'fillet_edges' ? undefined : op.reference ? this.edgeFace(body, op.reference, 'reference').id : this.selectorFace(body, selectors);
        let job: BlendJob;
        if (op.op === 'profile_edges') {
          const params = { path: [...path], bodyId: body.id, edges, size: op.size, profile: op.profile, depth: op.depth, angleDeg: op.angleDeg, referenceFace: reference, segments: op.segments ?? DEFAULT_BLEND_SEGMENTS };
          job = { kind: 'profile', command: 'profile.apply', params, plan: (state, p) => planEdgeProfile(state, { ...params, ...p }) };
        } else if (op.op === 'chamfer_edges') {
          const twoDistance = op.distance2 !== undefined || op.angleDeg !== undefined;
          if (twoDistance && reference === undefined) {
            throw this.failure('invalid_operation', `chamfer_edges with ${op.distance2 !== undefined ? 'distance2' : 'angleDeg'} needs reference, the face distance is measured along, beside every picked edge: for a raised panel, the front face, as in reference: {facing: [0, -1, 0]}. It can be left out when the edges come from one face selector, such as {face: {facing: [0, -1, 0]}, which: "outer"}.`);
          }
          const params = { path: [...path], bodyId: body.id, edges, size: op.distance, segments: DEFAULT_BLEND_SEGMENTS, ...(twoDistance ? { distance2: op.distance2, angleDeg: op.angleDeg, referenceFace: reference } : {}) };
          job = { kind: 'chamfer', command: 'chamfer.apply', params, plan: (state, p) => planEdgeBlend(state, 'chamfer', { ...params, ...p }) };
        } else {
          const params = { path: [...path], bodyId: body.id, edges, size: op.radius, segments: op.segments ?? DEFAULT_BLEND_SEGMENTS };
          job = { kind: 'fillet', command: 'fillet.apply', params, plan: (state, p) => planEdgeBlend(state, 'fillet', { ...params, ...p }) };
        }
        let precomputed: Awaited<ReturnType<typeof runEdgeBlendKernel>>;
        let plan: EdgeBlendPlan;
        try {
          plan = job.plan(host.doc.state, {});
          precomputed = await runEdgeBlendKernel(kernelOf(this.commands.ctx), plan);
          checkEdgeBlendResult(plan, precomputed);
        } catch (cause) {
          throw await this.blendFailure(cause, job, body);
        }
        await exec<Promise<unknown>>(job.command, { ...job.params, precomputed });
        this.checkSolids(path, [body.id], op.op);
        const skipped: ModelSkipped[] = plan.skipped.map(edgeKey => ({ ref: { path: [...path], kind: 'edge', id: body.id, edgeKey }, reason: 'inside_edge' }));
        return { id: body.id, refs: [bodyOut(body.id)], count: edges.length - skipped.length, ...(skipped.length ? { skipped } : {}) };
      }
      case 'add_arc': {
        const sweep = op.endDeg - op.startDeg;
        if (!(Math.abs(sweep) > 1e-6 && Math.abs(sweep) <= 360)) throw this.failure('invalid_geometry', 'An arc needs endDeg different from startDeg, within 360 degrees of it.');
        const segments = op.segments ?? 12;
        const radians = Math.PI / 180, normal = unit(op.normal), frame = contextFrame(host.doc.state, path);
        if (!(2 * op.radius * Math.sin(Math.abs(sweep) * radians / (2 * segments)) > MERGE_TOL)) throw this.failure('invalid_geometry', `An arc of radius ${op.radius} m is too small for ${segments} segments.`);
        const curve = { kind: 'arc' as const, center: op.center, normal, radius: op.radius, startAngle: op.startDeg * radians, endAngle: op.endDeg * radians, segments };
        const params = { points: curvePoints(curve).map(world), closed: false, curve: { ...curve, center: world(op.center), normal: frame.toWorldNormal(normal) } };
        return draw(() => exec('sketch.addCurve', params), null, null, false, 'arc');
      }
      case 'offset': {
        if (!(Math.abs(op.distance) > MERGE_TOL)) throw this.failure('invalid_geometry', `offset needs a distance longer than ${MERGE_TOL} m.`);
        if (op.face) {
          const face = this.faceTarget(path, op.face, resolver, 'offset');
          let rings: Vec3[][] = [];
          const result = draw(() => { rings = exec<{ rings: Vec3[][] }>('sketch.offset', { faceRef: face.target, distance: op.distance }).rings; }, face.normal, null, false, 'offset');
          const ring = rings[0];
          // An inward offset names the face inside its new outline.
          if (op.distance < 0 && ring && result.named?.shape) result.named.shape.inside = interiorPoint(ring, face.plane.n);
          return result;
        }
        const ids = (op.edges ?? []).flatMap(input => {
          const shape = typeof input === 'string' ? named(input).shape : undefined;
          if (shape) return shape.edges;
          const r = ref(input);
          if (r.kind !== 'sketchEdge') throw this.failure('invalid_operation', `Only loose edges can be offset this way; ${r.kind} ${r.id} is not one.`);
          return [r.id];
        });
        return draw(() => exec('sketch.offset', { edgeIds: ids, distance: op.distance }), null, null, false, 'offset');
      }
      case 'fillet_corner':
        return draw(() => exec('sketch.fillet', { vertex: world(op.corner), radius: op.radius, segments: op.segments ?? 12 }), null, null, false, 'rounded corner');
      case 'mirror': return transform(refsOf(op.refs), reflection(op.origin, unit(op.normal)), op.copy ?? false, undefined, !!op.as);
      case 'intersect_faces': {
        const faces = only(refsOf(op.refs), ['face', 'sketchFace'], 'Lines are drawn on faces');
        const solids = op.with ? op.with.map((r, i) => solid(r, `Solid ${i}`)) : [];
        const params = { refs: [...faces, ...solids], with: op.with ? 'selection' as const : 'model' as const };
        const precomputed = await runIntersectKernel(host, kernelOf(this.commands.ctx), params as unknown as Parameters<typeof runIntersectKernel>[2]);
        const result = await exec<Promise<{ edgeIds: number[]; faceCount: number }>>('intersect.faces', { ...params, precomputed });
        return { count: result.faceCount };
      }
      case 'soften_edges': {
        const refs = only(refsOf(op.refs), ['body', 'face', 'edge', 'sketchEdge'], 'Only solids, faces and edges can be softened');
        return { count: exec<{ softened: number }>('edges.soften', { refs, ...(op.angleDeg !== undefined ? { angleDeg: op.angleDeg } : {}), ...(op.smooth !== undefined ? { smooth: op.smooth } : {}) }).softened };
      }
      case 'add_guide': {
        if (op.direction && op.end) throw this.failure('invalid_operation', 'Give direction for a guide line or end for a guide segment, not both.');
        if (op.end && !(dist(op.point, op.end) > MERGE_TOL)) throw this.failure('invalid_geometry', 'A guide segment needs two different points.');
        const frame = contextFrame(host.doc.state, path);
        const id = op.direction ? exec<number>('guides.addLine', { point: world(op.point), dir: frame.toWorldDir(unit(op.direction)) })
          : op.end ? exec<number>('guides.addSegment', { a: world(op.point), b: world(op.end) })
          : exec<{ id: number }>('guides.addPoint', { point: world(op.point) }).id;
        return { id, named: { kind: 'guide', id } };
      }
      case 'add_dimension': {
        const along = v3sub(op.end, op.start), normal = v3cross(along, op.offset);
        if (!(v3len(along) > MERGE_TOL)) throw this.failure('invalid_geometry', 'A dimension needs two different points.');
        if (!(v3len(normal) > MERGE_TOL * v3len(along))) throw this.failure('invalid_operation', 'offset must point away from the measured line, not along it.');
        const frame = contextFrame(host.doc.state, path);
        const id = exec<number>('dimension.add', { kind: 'linear', start: world(op.start), end: world(op.end), offset: frame.toWorldDir(op.offset), normal: frame.toWorldNormal(unit(normal)) });
        return { id, named: { kind: 'dimension', id } };
      }
      case 'add_text': {
        const params = op.screen ? { kind: 'screen', screen: op.screen, text: op.text }
          : { kind: 'leader', anchor: world(op.anchor!), label: world(op.label ?? v3add(op.anchor!, [0, 0, 0.15])), text: op.text };
        const id = exec<EntityRef>('text.add', params).id;
        return { id, named: { kind: 'text', id } };
      }
      case 'add_3d_text': {
        const params = Text3DParamsSchema.parse({ text: op.text, point: world(op.position), ...(op.height !== undefined ? { height: op.height } : {}), ...(op.extrude !== undefined ? { extrude: op.extrude } : {}),
          ...(op.font ? { font: op.font } : {}), ...(op.bold !== undefined ? { bold: op.bold } : {}), ...(op.align ? { align: op.align } : {}) });
        if (!this.commands.ctx.services.has(SERVICE_FONTS)) throw this.failure('unavailable', '3D text needs fonts, which are not available here.');
        const precomputed = await runText3DKernel(this.commands.ctx, params);
        const result = await exec<Promise<{ instanceId: number | null }>>('text3d.create', { ...params, precomputed });
        return instanceResult(result.instanceId!);
      }
      case 'add_section_plane': {
        const id = exec<number>('sectionPlane.add', { point: world(op.point), normal: contextFrame(host.doc.state, path).toWorldNormal(unit(op.normal)), ...(op.name ? { name: op.name } : {}) });
        if (op.active ?? true) exec('sectionPlane.setActive', { path: [...path], id, active: true });
        return { id, named: { kind: 'sectionPlane', id } };
      }
      case 'set_section_plane': {
        const id = typeof op.plane === 'number' ? op.plane : (() => {
          const found = named(op.plane);
          if (found.kind !== 'sectionPlane') throw this.failure('invalid_reference', `"${op.plane}" names a ${found.kind}, not a section plane.`);
          return found.id;
        })();
        if (!containerAt(host.doc.state, path).sectionPlanes.has(id as Id)) throw this.failure('invalid_reference', `There is no section plane ${id} in the container being edited.`);
        const plane = { path: [...path], id };
        if (op.active !== undefined) exec('sectionPlane.setActive', { ...plane, active: op.active });
        if (op.hidden !== undefined) exec('sectionPlane.setHidden', { refs: [plane], hidden: op.hidden });
        if (op.reverse) exec('sectionPlane.reverse', { refs: [plane] });
        return { id };
      }
      case 'set_material': {
        const id = idOf(op.materialId, 'material');
        if (!host.doc.state.materials.has(id as never)) throw this.failure('invalid_reference', `There is no material ${id}.`);
        exec('material.update', { id, ...(op.name ? { name: op.name } : {}), ...(op.color ? { color: rgb(op.color) } : {}), ...(op.opacity !== undefined ? { alpha: op.opacity } : {}) });
        return { id };
      }
      case 'set_texture': {
        const container = containerAt(host.doc.state, path);
        const faces = only(refsOf(op.refs), ['face', 'sketchFace', 'body'], 'Only faces and solids have textures').flatMap((r): EntityRef[] => r.kind === 'body'
          ? [...container.bodies.get(r.id)!.faces.keys()].map(faceId => ({ kind: 'face', path, id: r.id, faceId, region: null })) : [r]);
        const inherited = inheritedMaterial(host.doc.state, path);
        const skipped: ModelSkipped[] = [];
        let count = 0;
        for (const r of faces) {
          const body = r.kind === 'face' ? container.bodies.get(r.id) : undefined;
          const face = body && r.kind === 'face' ? body.faces.get(r.faceId) : r.kind === 'sketchFace' ? container.sketch.faces.get(r.id) : undefined;
          if (!face) continue;
          let uv: UvMapping | null = UV_AUTO;
          if (op.grain) {
            const texture = frontMaterial(host.doc.state, face, body, inherited)?.texture;
            const grain = texture ? texture.grain ?? 'width' : null;
            if (grain === null || grain === 'none') { skipped.push({ ref: refOut(r), reason: grain === null ? 'no_texture' : 'no_grain' }); continue; }
            uv = grainMapping(face.basis, face.plane.n, op.grain, grain);
            if (!uv) { skipped.push({ ref: refOut(r), reason: 'end_grain' }); continue; }
          }
          exec('texture.position', { ref: r, uv });
          count++;
        }
        return { count, ...(skipped.length ? { skipped } : {}) };
      }
      case 'make_group': return instanceResult(exec<MakeResult>('group.make', { refs: refsOf(op.refs) }).instanceId!);
      case 'make_component': return instanceResult(exec<MakeResult>('component.make', { refs: refsOf(op.refs), ...(op.name ? { name: op.name } : {}) }).instanceId!);
      case 'explode': {
        const result = exec<ExplodeResult>('group.explode', { refs: only(refsOf(op.refs), ['instance'], 'Only groups and placements can be exploded') });
        return { refs: result.refs.map(refOut), count: result.explodedInstanceIds.length };
      }
      case 'make_unique': {
        exec('component.makeUnique', { refs: only(refsOf(op.refs), ['instance'], 'Only component placements can be made unique') });
        return {};
      }
      case 'place_component': {
        const world = m4transformPoint(contextMatrix(host.doc.state, path), op.position);
        return instanceResult(exec<number>('component.place', { definitionId: definitionOf(op.definitionId), point: world }));
      }
      case 'move': return transform(refsOf(op.refs), m4translation(op.offset), op.copy ?? false, op.copies, !!op.as);
      case 'rotate': return transform(refsOf(op.refs), m4rotationAbout(op.origin, unit(op.axis), (op.angleDeg * Math.PI) / 180), op.copy ?? false, op.copies, !!op.as);
      case 'scale': return transform(refsOf(op.refs), m4scaleAbout(op.origin, op.factors), op.copy ?? false, undefined, !!op.as);
      case 'rename_instance': exec('instance.rename', { ref: only([ref(op.ref)], ['instance'], 'Only groups and placements have instance names')[0], name: op.name }); return {};
      case 'rename_definition': exec('definition.rename', { definitionId: definitionOf(op.definitionId), name: op.name }); return {};
      case 'set_hidden': {
        const refs = refsOf(op.refs);
        const instances = refs.filter(r => r.kind === 'instance'), bodies = refs.filter(r => r.kind === 'body');
        const geometry = only(refs.filter(r => r.kind !== 'instance' && r.kind !== 'body'), ['face', 'sketchEdge', 'sketchFace'], 'Only groups, placements, solids, faces and loose geometry can be hidden');
        if (instances.length) exec('instance.setHidden', { refs: instances, hidden: op.hidden });
        if (bodies.length) exec('bodies.setHidden', { refs: bodies, hidden: op.hidden });
        if (geometry.length) exec('geometry.setHidden', { refs: geometry, hidden: op.hidden });
        return { count: refs.length };
      }
      case 'set_locked': return { count: exec<number>('instance.setLocked', { refs: only(refsOf(op.refs), ['instance'], 'Only groups and placements can be locked'), locked: op.locked }) };
      case 'delete': {
        const refs = refsOf(op.refs);
        if (refs.some(r => r.kind === 'face')) throw this.failure('invalid_geometry', 'Deleting a face would open the solid; delete the solid instead.');
        undo.withinGroup(() => host.selection.set(refs));
        const removed = exec<{ removed: number; message: string | null }>('edit.delete', {});
        if (removed.removed < refs.length && removed.message) throw this.failure('operation_failed', removed.message);
        return { count: removed.removed };
      }
      case 'add_tag': {
        const id = exec<number>('tag.create', { ...(op.name ? { name: op.name } : {}), ...(op.color ? { color: rgb(op.color) } : {}) });
        return { id, named: { kind: 'tag', id } };
      }
      case 'assign_tag': return { count: exec<number>('tag.assign', { refs: refsOf(op.refs), tagId: idOf(op.tagId, 'tag') }) };
      case 'set_tag': {
        const id = idOf(op.tagId, 'tag');
        if (!host.doc.state.tags.has(id as never)) throw this.failure('invalid_reference', `There is no tag ${id}.`);
        if (op.name !== undefined) exec('tag.rename', { id, name: op.name });
        if (op.visible !== undefined) exec('tag.setVisible', { ids: [id], visible: op.visible });
        if (op.color !== undefined) exec('tag.setColor', { id, color: rgb(op.color) });
        return {};
      }
      case 'add_material': {
        if (op.library !== undefined) {
          if (!libraryMaterial(op.library)) throw this.failure('invalid_reference', `There is no library material "${op.library}". Call ${MODEL_TOOLS.materialLibrary.name} for the keys.`);
          const precomputed = await loadLibraryMaterial(host, op.library);
          const id = await exec<Promise<number>>('material.fromLibrary', { key: op.library, activate: false, precomputed });
          if (op.name || op.opacity !== undefined) exec('material.update', { id, ...(op.name ? { name: op.name } : {}), ...(op.opacity !== undefined ? { alpha: op.opacity } : {}) });
          return { id, named: { kind: 'material', id } };
        }
        const id = exec<number>('material.create', { name: op.name ?? 'Material', color: rgb(op.color!), ...(op.opacity !== undefined ? { alpha: op.opacity } : {}), activate: false });
        return { id, named: { kind: 'material', id } };
      }
      case 'paint': {
        const materialId = op.materialId === null ? null : idOf(op.materialId, 'material');
        if (materialId !== null && !host.doc.state.materials.has(materialId as never)) throw this.failure('invalid_reference', `There is no material ${materialId}.`);
        const refs = only(refsOf(op.refs), ['face', 'body', 'sketchFace', 'instance'], 'Only faces, solids, groups and placements can be painted');
        return { count: exec<{ painted: number }>('paint.apply', { refs, materialId, side: op.side ?? 'front', recursive: op.recursive ?? false }).painted };
      }
      case 'add_scene': {
        if (op.name) this.uniqueSceneName(op.name, null);
        const camera = capture(op.camera, 'adding a scene');
        const id = exec<number>('scene.add', { ...(op.name ? { name: op.name } : {}), ...(op.description !== undefined ? { description: op.description } : {}),
          ...(op.saves ? { flags: flagsIn(op.saves) } : {}), ...(op.includeInAnimation !== undefined ? { includeInAnimation: op.includeInAnimation } : {}), ...(camera ? { camera } : {}) });
        return { id, name: this.sceneOf(id).name, named: { kind: 'scene', id } };
      }
      case 'update_scene': {
        const id = sceneId(op.scene), recapture = op.recapture ?? true;
        const camera = recapture ? capture(op.camera, 'updating a scene') : undefined;
        exec('scene.update', { id, recapture, ...(op.saves ? { flags: flagsIn(op.saves) } : {}), ...(camera ? { camera } : {}) });
        return { id, name: this.sceneOf(id).name };
      }
      case 'delete_scene': {
        const id = sceneId(op.scene), name = this.sceneOf(id).name;
        exec('scene.delete', { id });
        return { id, name };
      }
      case 'rename_scene': {
        const id = sceneId(op.scene);
        if (op.name) this.uniqueSceneName(op.name, id);
        exec('scene.rename', { id, name: op.name ?? this.sceneOf(id).name, ...(op.description !== undefined ? { description: op.description } : {}) });
        return { id, name: this.sceneOf(id).name };
      }
      case 'move_scene': {
        const id = sceneId(op.scene);
        exec('scene.move', { id, toIndex: op.index });
        return { id, name: this.sceneOf(id).name };
      }
      case 'set_scene_animation': {
        const id = sceneId(op.scene);
        exec('scene.setIncludeInAnimation', { id, value: op.include });
        return { id, name: this.sceneOf(id).name };
      }
    }
  }

  /** The one face of a solid that a `{body, facing, point?}` selector names; its region is the part holding the point. */
  private selectFace(path: Id[], sel: { body: number | string; facing: Vec3; point?: Vec3 | undefined }, named: (value: string) => Named): { ref: EntityRef; body: Body; face: FaceRecord } {
    const bodyId = typeof sel.body === 'number' ? sel.body : (() => {
      const found = named(sel.body);
      if (found.kind !== 'body') throw this.failure('invalid_reference', `"${sel.body}" names a ${found.kind}, not a solid.`);
      return found.id;
    })();
    const body = containerAt(this.host.doc.state, path).bodies.get(bodyId as Id);
    if (!body) throw this.failure('invalid_reference', `There is no solid ${bodyId} in the container being edited. Call ${MODEL_TOOLS.query.name} for current ids.`);
    const facing = unit(sel.facing), point = sel.point;
    const faces = [...body.faces.values()].filter(f => v3dot(f.plane.n, facing) >= FACING_TOLERANCE && (!point || faceContains(f, point, MERGE_TOL)));
    if (faces.length !== 1) {
      const where = `facing [${sel.facing.join(', ')}]${point ? ` and containing [${point.join(', ')}]` : ''}`;
      throw this.failure('invalid_reference', faces.length === 0 ? `Solid ${bodyId} has no face ${where}. Call ${MODEL_TOOLS.query.name} with kinds ["face"] for its faces.`
        : `${faces.length} faces of solid ${bodyId} are ${where}; add a point on the one you mean.`);
    }
    const face = faces[0]!;
    let region: number | null = null;
    if (point) {
      const [u, v] = basisToLocal(face.basis, point);
      region = regionAt(computeRegions(body, face.id), [u, v]);
      if (region < 0) throw this.failure('invalid_reference', `[${point.join(', ')}] lies on a line drawn on face ${face.id} of solid ${bodyId}; give a point inside one part of the face.`);
    }
    return { ref: { kind: 'face', path, id: body.id, faceId: face.id, region }, body, face };
  }

  /** A face to push, pull or sweep: a drawn shape's face (loose, or a part of a solid's face), a sketch face, or a face of a solid. */
  private faceTarget(path: Id[], input: ModelRefInput, resolver: { named: (value: string) => Named; ref: (input: ModelRefInput) => EntityRef }, what: string): FaceTarget {
    const container = containerAt(this.host.doc.state, path);
    const ofBody = (body: Body, face: FaceRecord, region: number | null, shown: string, normal: Vec3): FaceTarget => {
      const parts = computeRegions(body, face.id).length;
      if (region === null && parts > 1)
        throw this.failure('invalid_reference', `${shown} is divided into ${parts} parts by shapes drawn on it; name one part as {body, facing, point} with a point inside it.`);
      return { target: { kind: 'face', path: [...path], id: body.id, faceId: face.id, region }, plane: face.plane, normal, shown };
    };
    if (typeof input === 'string') {
      const found = resolver.named(input), shape = found.shape;
      if (!shape) throw this.failure('invalid_reference', found.kind === 'body'
        ? `"${input}" names a solid; choose one of its faces as {body: "${input}", facing: [x, y, z]}.` : `"${input}" names a ${found.kind}, not a face.`);
      const made = shapeFace(container, shape);
      if (made?.kind === 'region') return ofBody(made.body, made.face, made.region, input, shape.normal ?? made.face.plane.n);
      if (made?.kind === 'sketch') return { target: { kind: 'sketchFace', path: [...path], id: made.face.id }, plane: made.face.plane, normal: shape.normal ?? made.face.plane.n, shown: input };
      throw this.failure('invalid_reference', `"${input}" has no face to ${what}: it is open, or an earlier operation used its face up.`);
    }
    if ('body' in input) {
      const { ref, body, face } = this.selectFace(path, input, resolver.named);
      return ofBody(body, face, ref.kind === 'face' ? ref.region : null, `face ${face.id} of solid ${body.id}`, face.plane.n);
    }
    const r = resolver.ref(input);
    if (r.kind === 'sketchFace') {
      const face = container.sketch.faces.get(r.id)!;
      return { target: { kind: 'sketchFace', path: [...path], id: r.id }, plane: face.plane, normal: face.plane.n, shown: `sketch face ${r.id}` };
    }
    if (r.kind === 'face') {
      const body = container.bodies.get(r.id)!, face = body.faces.get(r.faceId)!;
      return ofBody(body, face, null, `face ${r.faceId} of solid ${r.id}`, face.plane.n);
    }
    throw this.failure('invalid_operation', `Only a face can be used to ${what}; ${r.kind} ${r.id} is not one.`);
  }

  /**
   * Edge keys of a solid that edge selectors name, resolved against the solid as it is when the operation runs. Every
   * selector must match a sharp edge; one that does not fails with `invalid_reference` and says what it did match.
   */
  private edgeKeys(body: Body, selectors: readonly EdgeSelector[]): string[] {
    const keys = new Set<string>();
    const all = [...body.edges.values()];
    for (const sel of selectors) {
      if (typeof sel === 'string') {
        const edge = body.edges.get(sel as never);
        if (!edge) throw this.failure('invalid_reference', `Solid ${body.id} has no edge ${sel} now; edge keys change when the solid changes. Pick edges by face instead, for example {face: {facing: [0, -1, 0]}}.`);
        if (!isHardEdge(edge)) throw this.failure('invalid_operation', `Edge ${sel} of solid ${body.id} is soft, smooth or hidden; only sharp edges can be rounded or beveled.`);
        keys.add(sel);
        continue;
      }
      let found: EdgeRecord[], shown: string;
      if ('between' in sel) {
        const [a, b] = sel.between.map(f => this.edgeFace(body, f, 'between'));
        if (a!.id === b!.id) throw this.failure('invalid_reference', `Both faces of ${JSON.stringify(sel)} are face ${a!.id} of solid ${body.id}; name two different faces.`);
        found = all.filter(e => (e.faceA === a!.id && e.faceB === b!.id) || (e.faceA === b!.id && e.faceB === a!.id));
        if (found.length === 0) {
          const neighbours = [...new Set(all.filter(e => e.faceA === a!.id || e.faceB === a!.id).map(e => (e.faceA === a!.id ? e.faceB : e.faceA)))]
            .map(id => body.faces.get(id)).filter((f): f is FaceRecord => !!f);
          throw this.failure('invalid_reference', `Faces ${a!.id} and ${b!.id} of solid ${body.id} share no edge. Face ${a!.id} meets ${neighbours.length} faces: ${neighbours.slice(0, 8).map(describeFace).join('; ')}.`
            + (neighbours[0] ? ` For example {between: [${faceSelector(a!)}, ${faceSelector(neighbours[0])}]}.` : ''));
        }
        shown = JSON.stringify(sel);
      } else if ('face' in sel || 'faceFacing' in sel) {
        const which = 'face' in sel ? sel.which ?? 'all' : 'all', along = 'face' in sel ? sel.along : undefined;
        const face = this.edgeFace(body, 'face' in sel ? sel.face : { facing: sel.faceFacing, point: sel.facePoint }, 'face');
        const bounding = all.filter(e => e.faceA === face.id || e.faceB === face.id);
        const onLoop = (e: EdgeRecord, loops: readonly (readonly Vec3[])[]): boolean => loops.some(loop => onRing(midpoint(e.polyline), loop));
        found = bounding.filter(e => which === 'outer' ? onLoop(e, face.loops.slice(0, 1)) : which === 'inner' ? onLoop(e, face.loops.slice(1)) : true)
          .filter(e => !along || edgeMatches(e.polyline, along, null));
        shown = JSON.stringify(sel);
        if (found.length === 0) {
          const why = which === 'inner' && face.loops.length < 2 ? `face ${face.id} has no openings, so it has no inside edges; use which: "outer" or "all"`
            : along ? `none of the ${bounding.length} edges of face ${face.id} runs along [${along.join(', ')}]; they run ${directions(bounding)}` : `face ${face.id} has no such edges`;
          throw this.failure('invalid_reference', `${shown} matched ${describeFace(face)} of solid ${body.id}, but ${why}.`);
        }
      } else {
        found = all.filter(e => edgeMatches(e.polyline, sel.along, sel.through ?? null));
        shown = JSON.stringify(sel);
        if (found.length === 0) throw this.failure('invalid_reference', `No edge of solid ${body.id} matches ${shown}. Its sharp edges run ${directions(all.filter(isHardEdge))}; or pick edges by face, for example {face: {facing: [0, -1, 0]}}.`);
      }
      const hard = found.filter(isHardEdge);
      if (hard.length === 0) throw this.failure('invalid_reference', `The ${found.length} edge${found.length === 1 ? '' : 's'} ${shown} matched on solid ${body.id} ${found.length === 1 ? 'is' : 'are'} soft, smooth or hidden (already rounded?); only sharp edges can be rounded or beveled.`);
      for (const e of hard) keys.add(e.key);
    }
    return [...keys];
  }

  /** The one face of `body` an edge selector's `{facing, point?}` names, or an error listing what it matched and a selector that works. */
  private edgeFace(body: Body, sel: EdgeFaceSelector, role: string): FaceRecord {
    const facing = unit(sel.facing), point = sel.point;
    const toward = [...body.faces.values()].filter(f => v3dot(f.plane.n, facing) >= FACING_TOLERANCE);
    const faces = point ? toward.filter(f => faceContains(f, point, MERGE_TOL)) : toward;
    if (faces.length === 1) return faces[0]!;
    const asked = `{facing: [${sel.facing.join(', ')}]${point ? `, point: [${point.join(', ')}]` : ''}}`;
    const byArea = (list: FaceRecord[]) => [...list].sort((a, b) => faceArea(b) - faceArea(a));
    if (faces.length > 1) {
      const listed = byArea(faces);
      throw this.failure('invalid_reference', `${role === 'between' ? 'A face of between, ' : 'The face '}${asked}, matches ${faces.length} faces of solid ${body.id}: ${listed.slice(0, 8).map(describeFace).join('; ')}. Add a point on the one you mean, for example ${faceSelector(listed[0]!)}.`);
    }
    if (toward.length > 0) {
      const listed = byArea(toward);
      throw this.failure('invalid_reference', `No face of solid ${body.id} facing [${sel.facing.join(', ')}] contains [${point!.join(', ')}]. The faces facing that way are ${listed.slice(0, 8).map(describeFace).join('; ')}; for example ${faceSelector(listed[0]!)}.`);
    }
    const closest = byArea([...body.faces.values()]).sort((a, b) => v3dot(b.plane.n, facing) - v3dot(a.plane.n, facing));
    throw this.failure('invalid_reference', `No face of solid ${body.id} faces [${sel.facing.join(', ')}] (within 1 degree). Its faces: ${closest.slice(0, 8).map(describeFace).join('; ')}${closest.length > 8 ? `; and ${closest.length - 8} more` : ''}.`
      + (closest[0] ? ` The closest is ${faceSelector(closest[0])}.` : ''));
  }

  /** The one face every face selector among `selectors` names, when they are all face selectors of one face. */
  private selectorFace(body: Body, selectors: readonly EdgeSelector[]): number | undefined {
    const ids = new Set<number>();
    for (const sel of selectors) {
      if (typeof sel !== 'object' || !('face' in sel || 'faceFacing' in sel)) return undefined;
      ids.add(this.edgeFace(body, 'face' in sel ? sel.face : { facing: sel.faceFacing, point: sel.facePoint }, 'face').id);
    }
    return ids.size === 1 ? [...ids][0] : undefined;
  }

  /**
   * A fillet, chamfer or profile that the plan or the kernel refused, as an actionable failure: a size too big
   * reports the largest that fits (for a two-distance chamfer, the largest of each distance), and any other refusal
   * names the edges involved.
   */
  private async blendFailure(cause: unknown, job: BlendJob, body: Body): Promise<ModelApiFailure> {
    if (cause instanceof ModelApiFailure) return cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    const what = job.kind === 'fillet' ? 'radius' : job.kind === 'chamfer' ? 'distance' : 'size';
    const code = cause instanceof PushFormError ? cause.code : '';
    const edges = job.params.edges;
    if (code === 'edgeblend.tooLarge' || code === 'edgeblend.tooLarge2') {
      const second = job.params.distance2;
      if (second !== undefined) {
        // two distances: the largest of each that fits with the other as asked
        const first = await this.largestBlend(job, 'size');
        const other = await this.largestBlend(job, 'distance2');
        const say = (n: number | null, name: string, with_: string): string => n === null ? `no ${name} fits with that ${with_}` : `the largest ${name} that fits with that ${with_} is about ${n} m`;
        return this.failure('invalid_geometry', `${message} You asked for distance ${job.params.size} m and distance2 ${second} m; ${say(first, 'distance', 'distance2')}, and ${say(other, 'distance2', 'distance')}. Use those or less, or pick fewer edges.`);
      }
      const largest = await this.largestBlend(job, 'size');
      // When even the smallest size fails, the reason is not the size: report what the plan says there.
      const tiny = (() => { try { job.plan(this.host.doc.state, { size: 4 * MERGE_TOL }); return null; } catch (e) { return e instanceof Error ? e.message : String(e); } })();
      return this.failure('invalid_geometry', largest === null ? `${message} No ${what} fits these edges${tiny ? `, at any size: ${tiny}` : ''}; ${edgeList(body, edges)}.`
        : `${message} You asked for ${job.params.size} m; the largest ${what} that fits these edges${job.params.angleDeg !== undefined ? ' at that angle' : ''} is about ${largest} m. Use that or less, or pick fewer edges.`);
    }
    if (code === 'edgeblend.reference') return this.failure('invalid_reference', `${message} The edges: ${edgeList(body, edges)}. Name as reference a face beside every one of them, or pick the edges of the reference face, such as {face: <the reference face>, which: "outer"}.`);
    const hint = code !== 'edgeblend.corner' ? ''
      : job.kind === 'profile' ? ' Pick the edges of one face at a time, or edges that do not meet at that corner.'
        : ` Pick the edges of one face at a time, or edges that do not meet at that corner; or use profile_edges with profile "${job.kind === 'fillet' ? 'roundover' : 'chamfer'}", which stops where it meets an inside edge.`;
    return this.failure(errorCode(cause), `${message} The edges: ${edgeList(body, edges)}.${hint}`);
  }

  /** The largest value of `key`, rounded down to three significant figures, that the plan and the kernel accept, the rest as asked; or null. */
  private async largestBlend(job: BlendJob, key: 'size' | 'distance2'): Promise<number | null> {
    const state = this.host.doc.state, kernel = kernelOf(this.commands.ctx);
    const asked = job.params[key]!;
    const planFits = (value: number): boolean => { try { job.plan(state, { [key]: value }); return true; } catch { return false; } };
    const kernelFits = async (value: number): Promise<boolean> => {
      try { const plan = job.plan(state, { [key]: value }); checkEdgeBlendResult(plan, await runEdgeBlendKernel(kernel, plan)); return true; } catch { return false; }
    };
    let lo = 0, hi = asked;
    // The plan's checks are cheap and exact, so they bound the search before the kernel is asked.
    for (let i = 0; i < 30 && hi - lo > MERGE_TOL / 4; i++) { const mid = (lo + hi) / 2; if (planFits(mid)) lo = mid; else hi = mid; }
    if (!(lo > MERGE_TOL)) return null;
    const down = (x: number): number => { const scale = 10 ** (2 - Math.floor(Math.log10(x))); return Math.floor(x * scale) / scale; };
    let best = down(lo);
    if (best > MERGE_TOL && await kernelFits(best)) return best;
    let kLo = 0, kHi = lo;
    for (let i = 0; i < 8; i++) { const mid = (kLo + kHi) / 2; if (mid > MERGE_TOL && await kernelFits(mid)) kLo = mid; else kHi = mid; }
    best = kLo > MERGE_TOL ? down(kLo) : 0;
    return best > MERGE_TOL ? best : null;
  }

  /** Every solid an operation leaves must be a closed solid with volume (the kernel's results always are manifold). */
  private checkSolids(path: Id[], ids: readonly number[], what: string): void {
    const container = containerAt(this.host.doc.state, path);
    for (const id of ids) {
      const body = container.bodies.get(id as Id);
      if (!body || !body.valid || !(body.props.volume > MIN_VOLUME))
        throw this.failure('invalid_geometry', `${what} would leave solid ${id} without volume, which is not a valid solid.`);
    }
  }

  /** The kernel step of `transform.apply`, awaited outside the group's edits; the result commits in one edit. */
  private async transform(plans: TransformPlan[]): Promise<OpResult> {
    const host = this.host, kernel = kernelOf(this.commands.ctx);
    const works: TransformKernelWork[] = [];
    for (const plan of plans) works.push(await runTransformKernel(kernel, host.doc.state, plan));
    const refs: EntityRef[] = [];
    host.undoStack.withinGroup(() => {
      host.edit(plans[0]!.label, draft => plans.forEach((plan, i) => refs.push(...applyTransformPlan(draft, plan, works[i]!).refs)));
      if (plans.some(plan => plan.copy)) host.selection.set(refs);
    });
    return { refs: refs.map(refOut) };
  }
}

/** The middle of an edge's polyline: a point on the edge away from its ends. */
function midpoint(polyline: readonly Vec3[]): Vec3 {
  const i = Math.floor((polyline.length - 1) / 2), a = polyline[i]!, b = polyline[Math.min(i + 1, polyline.length - 1)]!;
  return v3scale(v3add(a, b), 0.5);
}
/** Whether a point lies on a closed ring of positions. */
function onRing(p: Vec3, ring: readonly Vec3[]): boolean {
  return ring.some((q, i) => pointOnSegment(p, q, ring[(i + 1) % ring.length]!));
}
function faceArea(face: FaceRecord): number {
  return face.loops.reduce((sum, loop, i) => sum + (i === 0 ? 1 : -1) * Math.abs(v3dot(newell(loop), face.plane.n)) / 2, 0);
}
/** A point inside a face, clear of its holes: the outline's inside point, or a point just inside one of its edges. */
function pointOnFace(face: FaceRecord): Vec3 {
  const outer = face.loops[0] ?? [];
  const first = interiorPoint(outer, face.plane.n);
  if (faceContains(face, first)) return first;
  for (const nudge of [0.01, 0.002, 0.0005]) for (const [i, a] of outer.entries()) {
    const b = outer[(i + 1) % outer.length]!, d = v3sub(b, a), length = v3len(d);
    if (!(length > 2 * nudge)) continue;
    const p = v3add(v3scale(v3add(a, b), 0.5), v3scale(unit(v3cross(face.plane.n, d)), nudge));
    if (faceContains(face, p)) return p;
  }
  return first;
}
/** A face as errors list it: id, facing, size along its two longest directions and a point on it. */
function describeFace(face: FaceRecord): string {
  const outer = face.loops[0] ?? [];
  const u = outer.map(p => v3dot(p, face.basis.u)), v = outer.map(p => v3dot(p, face.basis.v));
  const size = [Math.max(...u) - Math.min(...u), Math.max(...v) - Math.min(...v)].sort((a, b) => b - a).map(x => +x.toPrecision(3));
  return `face ${face.id} facing [${short(face.plane.n).join(', ')}], ${size[0]} × ${size[1]} m${face.loops.length > 1 ? ` with ${face.loops.length - 1} opening${face.loops.length > 2 ? 's' : ''}` : ''}, at [${vec(pointOnFace(face)).join(', ')}]`;
}
/** A selector that names exactly this face. */
function faceSelector(face: FaceRecord): string {
  return `{facing: [${short(face.plane.n).join(', ')}], point: [${vec(pointOnFace(face)).join(', ')}]}`;
}
const short = (v: Vec3): number[] => v.map(x => Math.round(x * 1000) / 1000 + 0);
/** The directions edges run, as errors list them: each direction (either way) with how many edges run it. */
function directions(edges: readonly EdgeRecord[]): string {
  const runs: { d: Vec3; n: number }[] = [];
  for (const e of edges) {
    const a = e.polyline[0], b = e.polyline[e.polyline.length - 1];
    if (!a || !b || !(dist(a, b) > MERGE_TOL)) continue;
    const d = unit(v3sub(b, a)), run = runs.find(r => Math.abs(v3dot(r.d, d)) >= FACING_TOLERANCE);
    if (run) run.n++; else runs.push({ d, n: 1 });
  }
  if (runs.length === 0) return 'in no straight direction';
  return runs.sort((x, y) => y.n - x.n).slice(0, 6).map(r => `[${short(r.d.map(x => (r.d.find(c => Math.abs(c) > 1e-6)! < 0 ? -x : x)) as unknown as Vec3).join(', ')}] (${r.n})`).join(', ');
}
/** The picked edges as errors name them: their ends, for at most six of them. */
function edgeList(body: Body, keys: readonly string[]): string {
  const shown = keys.slice(0, 6).map(key => {
    const e = body.edges.get(key as never);
    return e ? `[${vec(e.polyline[0]!).join(', ')}] to [${vec(e.polyline[e.polyline.length - 1]!).join(', ')}]` : key;
  });
  return `${keys.length} edge${keys.length === 1 ? '' : 's'} of solid ${body.id}: ${shown.join('; ')}${keys.length > 6 ? `; and ${keys.length - 6} more` : ''}`;
}

/** A name's entry in a batch result. */
function nameOut(n: Named): ModelNameEntry {
  return { kind: n.kind, id: n.id, ...(n.definitionId !== undefined ? { definitionId: n.definitionId } : {}) };
}

/** Points and references an operation names, counted toward the batch's point limit. */
function pointCount(op: ModelOperation): number {
  switch (op.op) {
    case 'add_edges': return op.edges.length * 2;
    case 'add_polyline': return op.points.length;
    case 'add_rectangle': return 4;
    case 'add_circle': return op.segments ?? 24;
    case 'add_polygon': return op.sides;
    case 'subtract': return op.cutters.length + 1;
    case 'follow_me': return (op.pathPoints?.length ?? 0) + (op.pathEdges?.length ?? 0) + 1;
    default: return 'refs' in op ? op.refs.length : 1;
  }
}

interface DrawingSnapshot { edges: Set<number>; faces: Set<number>; imprints: Map<string, Set<number>> }
function drawingSnapshot(c: EntityContainer): DrawingSnapshot {
  const imprints = new Map<string, Set<number>>();
  for (const body of c.bodies.values()) for (const [faceId, graph] of body.imprints) imprints.set(`${body.id}:${faceId}`, new Set(graph.edges.keys()));
  return { edges: new Set(c.sketch.edges.keys()), faces: new Set(c.sketch.faces.keys()), imprints };
}
/** What drawing added since `before`: new sketch edges and faces, and the faces of solids that got new lines. */
function drawnShape(c: EntityContainer, before: DrawingSnapshot, normal: Vec3 | null, inside: Vec3 | null): Shape {
  const imprinted: Shape['imprinted'] = [];
  for (const body of c.bodies.values()) for (const [faceId, graph] of body.imprints) {
    const old = before.imprints.get(`${body.id}:${faceId}`);
    if ([...graph.edges.keys()].some(id => !old?.has(id))) imprinted.push({ bodyId: body.id, faceId });
  }
  return { edges: [...c.sketch.edges.keys()].filter(id => !before.edges.has(id)), faces: [...c.sketch.faces.keys()].filter(id => !before.faces.has(id)), imprinted, normal, inside };
}
/** The face a drawn shape made: the region of a solid's face holding its inside point, or its sketch face. */
function shapeFace(c: EntityContainer, shape: Shape): { kind: 'region'; body: Body; face: FaceRecord; region: number } | { kind: 'sketch'; face: SketchFace } | null {
  for (const { bodyId, faceId } of shape.imprinted) {
    const body = c.bodies.get(bodyId as Id), face = body?.faces.get(faceId as FaceLocalId);
    if (!body || !face || !shape.inside) continue;
    const [u, v] = basisToLocal(face.basis, shape.inside);
    const region = regionAt(computeRegions(body, face.id), [u, v]);
    if (region >= 0) return { kind: 'region', body, face, region };
  }
  const faces = shape.faces.filter(id => c.sketch.faces.has(id as Id));
  const inside = shape.inside, normal = shape.normal;
  // A later edit (a rounded corner, an offset) may re-find the face under a new id; its inside point still finds it.
  const id = inside ? faces.find(f => sketchFaceContains(c, f, inside))
      ?? [...c.sketch.faces.values()].find(f => (!normal || Math.abs(v3dot(f.plane.n, normal)) >= FACING_TOLERANCE) && sketchFaceContains(c, f.id, inside))?.id
    : faces.length === 1 ? faces[0] : undefined;
  const face = id === undefined ? undefined : c.sketch.faces.get(id as Id);
  return face ? { kind: 'sketch', face } : null;
}
function sketchFaceContains(c: EntityContainer, id: number, p: Vec3): boolean {
  const face = c.sketch.faces.get(id as Id);
  return !!face && loopsContain(face.plane, face.basis, sketchFaceLoops(c.sketch, face), p, MERGE_TOL);
}

/** Unit normal of a loop by the right-hand rule, or null when its points are in one line. */
function flatNormal(points: readonly Vec3[]): Vec3 | null {
  const n = newell(points), length = v3len(n);
  return length > 1e-12 ? v3scale(n, 1 / length) : null;
}
/** A point strictly inside a flat closed loop: its centroid when inside, otherwise the centroid of a corner triangle. */
function interiorPoint(points: readonly Vec3[], normal: Vec3): Vec3 {
  const u = unit(Math.abs(normal[2]) < 0.9 ? v3cross([0, 0, 1], normal) : v3cross([1, 0, 0], normal)), v = v3cross(normal, u);
  const flat = (p: Vec3): [number, number] => [v3dot(p, u), v3dot(p, v)];
  const loop = points.map(flat);
  const mean = (ps: readonly Vec3[]): Vec3 => v3scale(ps.reduce((a, b) => v3add(a, b), [0, 0, 0] as Vec3), 1 / ps.length);
  const candidates = [mean(points), ...points.map((p, i) => mean([points[(i + points.length - 1) % points.length]!, p, points[(i + 1) % points.length]!]))];
  return candidates.find(c => evenOdd(flat(c), [loop])) ?? candidates[0]!;
}
function evenOdd([x, y]: readonly [number, number], loops: readonly (readonly (readonly [number, number])[])[]): boolean {
  let inside = false;
  for (const loop of loops) {
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const [xi, yi] = loop[i]!, [xj, yj] = loop[j]!;
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}
function loopsContain(plane: Plane, basis: PlaneBasis, loops: readonly (readonly Vec3[])[], p: Vec3, tolerance: number): boolean {
  if (Math.abs(planeDistance(plane, p)) > tolerance) return false;
  const uv = (q: Vec3): [number, number] => [v3dot(q, basis.u), v3dot(q, basis.v)];
  return evenOdd(uv(p), loops.map(loop => loop.map(uv)));
}
const dist = (a: Vec3, b: Vec3): number => v3len(v3sub(a, b));
/** Reflection across the plane through `origin` square to the unit `normal`, as a column-major matrix. */
function reflection(origin: Vec3, n: Vec3): MMat4 {
  const d = 2 * v3dot(origin, n);
  return [
    1 - 2 * n[0] * n[0], -2 * n[1] * n[0], -2 * n[2] * n[0], 0,
    -2 * n[0] * n[1], 1 - 2 * n[1] * n[1], -2 * n[2] * n[1], 0,
    -2 * n[0] * n[2], -2 * n[1] * n[2], 1 - 2 * n[2] * n[2], 0,
    d * n[0], d * n[1], d * n[2], 1,
  ];
}
/**
 * A texture placement whose image grain (its width, or its height for `height`) runs along `grain` projected onto
 * the face, or null when the grain runs square to the face, as on end grain. The placement is a rotation, so the
 * image is never mirrored.
 */
function grainMapping(basis: PlaneBasis, normal: Vec3, grain: Vec3, axis: 'width' | 'height'): UvMapping | null {
  const g = v3sub(grain, v3scale(normal, v3dot(grain, normal)));
  if (!(v3len(g) > 1e-6 * v3len(grain))) return null;
  const angle = Math.atan2(v3dot(g, basis.v), v3dot(g, basis.u)) - (axis === 'height' ? Math.PI / 2 : 0), c = Math.cos(angle), s = Math.sin(angle);
  return { kind: 'sized', matrix: [c, s, 0, -s, c, 0] };
}
/** The material the instances on `path` pass to geometry with the default material: the innermost one that has one. */
function inheritedMaterial(state: DocumentState, path: readonly Id[]): Material | null {
  let def = state.definitions.get(state.rootDefinitionId), material: Material | null = null;
  for (const id of path) {
    const inst = def?.entities.instances.get(id);
    if (!inst) break;
    material = materialOrNull(state, inst.materialId) ?? material;
    def = state.definitions.get(inst.definitionId as DefId);
  }
  return material;
}
/** The material the front of a face shows: its own, else its solid's, else the inherited one. */
function frontMaterial(state: DocumentState, face: FaceRecord | SketchFace, body: Body | undefined, inherited: Material | null): Material | null {
  return materialOrNull(state, face.frontMaterialId) ?? (body ? materialOrNull(state, body.materialId) : null) ?? inherited;
}
/**
 * The grain of the texture the front of a face shows, as `model_query` reports it: the direction the image's grain
 * axis runs on the face, a unit vector in the container's coordinates (its largest component positive), or null
 * for a pattern with no grain. Nothing for an untextured face.
 */
function grainFields(face: FaceRecord | SketchFace, material: Material | null): Pick<ModelEntitySummary, 'grain' | 'defaultPlacement'> {
  const texture = material?.texture;
  if (!texture) return {};
  const defaultPlacement = face.uv.kind === 'auto', axis = texture.grain ?? 'width';
  if (axis === 'none') return { grain: null, defaultPlacement };
  const inverse = uvInvert(uvToAffine(face.uv, texture.widthM, texture.heightM));
  if (!inverse) return { grain: null, defaultPlacement };
  // the face direction along which only the image coordinate of the grain axis changes
  const du = axis === 'width' ? inverse[0] : inverse[1], dv = axis === 'width' ? inverse[3] : inverse[4];
  let d = v3add(v3scale(face.basis.u, du), v3scale(face.basis.v, dv));
  const length = v3len(d);
  if (!(length > 0)) return { grain: null, defaultPlacement };
  d = v3scale(d, 1 / length);
  const largest = d.reduce((best, x, i) => (Math.abs(x) > Math.abs(d[best]!) + 1e-9 ? i : best), 0);
  if (d[largest]! < 0) d = v3scale(d, -1);
  return { grain: vec(d), defaultPlacement };
}
function boxesOverlap(a: Box3, b: Box3, margin = MERGE_TOL): boolean {
  return [0, 1, 2].every(i => a.min[i]! <= b.max[i]! + margin && b.min[i]! <= a.max[i]! + margin);
}

function errorCode(cause: unknown): ModelApiErrorCode {
  if (cause instanceof Error && cause.name === 'KernelError') return 'invalid_geometry';
  const code = cause instanceof PushFormError ? cause.code : '';
  if (code === 'service.missing') return 'unavailable';
  if (/invalidSolid|invalid_geometry|kernel|notSolid|^solids\.empty|degenerate|^path\.|^followme\.(path|empty)|^edgeblend\.(?!target|stale)|^fillet\.|^offset\.|^dimension\.|^text3d\./i.test(code)) return 'invalid_geometry';
  if (/missing|notFound|target/i.test(code)) return 'invalid_reference';
  return 'operation_failed';
}

const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

function cameraOut(c: CameraState): ModelCameraSummary {
  return { eye: vec(c.eye), target: vec(c.target), up: vec(c.up), projection: c.projection, fovDeg: round(c.fov), viewHeight: round(c.orthoHeight) };
}
function cameraFromScene(scene: Scene): CameraState {
  const c = scene.camera;
  return { eye: c.eye, target: c.target, up: c.up, fov: c.fov, projection: c.perspective ? 'perspective' : 'parallel', orthoHeight: c.height };
}

const SAVES: readonly [keyof ModelSceneSaves, keyof SceneFlags][] = [
  ['camera', 'useCamera'], ['hiddenGeometry', 'useHiddenGeometry'], ['hiddenObjects', 'useHiddenObjects'], ['tags', 'useTags'],
  ['style', 'useStyle'], ['shadows', 'useShadows'], ['sectionPlanes', 'useSectionPlanes'], ['axes', 'useAxes'],
];
function savesOut(flags: SceneFlags): ModelSceneSaves {
  return Object.fromEntries(SAVES.map(([out, flag]) => [out, flags[flag]])) as unknown as ModelSceneSaves;
}
function flagsIn(saves: Partial<Record<keyof ModelSceneSaves, boolean | undefined>>): Partial<SceneFlags> {
  return Object.fromEntries(SAVES.flatMap(([out, flag]) => (saves[out] === undefined ? [] : [[flag, saves[out]]])));
}

/** Points that bound an entity, in model coordinates; kinds without extent give none. */
function worldPoints(state: DocumentState, ref: EntityRef): Vec3[] {
  let container: EntityContainer;
  try { container = containerAt(state, ref.path); } catch { return []; }
  const local: Vec3[] = (() => {
    switch (ref.kind) {
      case 'instance': {
        const inst = container.instances.get(ref.id);
        const bounds = inst ? definitionBounds(state, inst.definitionId) : null;
        return inst && bounds ? corners(bounds).map(c => m4transformPoint(inst.transform, c)) : [];
      }
      case 'body': { const body = container.bodies.get(ref.id); return body ? corners(meshBounds(body.mesh)) : []; }
      case 'face': return [...(container.bodies.get(ref.id)?.faces.get(ref.faceId)?.loops[0] ?? [])];
      case 'sketchEdge': {
        const edge = container.sketch.edges.get(ref.id);
        return edge ? [container.sketch.vertices.get(edge.a)!.p, container.sketch.vertices.get(edge.b)!.p] : [];
      }
      case 'sketchFace': { const face = container.sketch.faces.get(ref.id); return face ? [...(sketchFaceLoops(container.sketch, face)[0] ?? [])] : []; }
      case 'guide': {
        const guide = container.guides.get(ref.id);
        return !guide ? [] : guide.kind === 'segment' ? [guide.origin, guide.end] : [guide.origin];
      }
      default: return [];
    }
  })();
  const frame = contextMatrix(state, ref.path);
  return local.map(p => m4transformPoint(frame, p));
}

/** Selections and command results may hold kinds the API does not model yet; they keep their own kind names. */
function refOut(ref: EntityRef): ModelRef {
  const out: ModelRef = { path: [...ref.path], kind: ref.kind as ModelRef['kind'], id: ref.id };
  if (ref.kind === 'face') out.faceId = ref.faceId;
  if (ref.kind === 'edge') out.edgeKey = ref.edgeKey;
  return out;
}

function base(path: readonly Id[], kind: ModelRef['kind'], id: number, attrs: { tagId: number; hidden: boolean; locked?: boolean }): ModelEntitySummary {
  return { ref: { path: [...path], kind, id }, tagId: attrs.tagId, hidden: attrs.hidden, ...(attrs.locked ? { locked: true } : {}) };
}

function summarizeInstance(state: DocumentState, path: readonly Id[], id: Id, fields: ReadonlySet<string>): ModelEntitySummary {
  const inst = containerAt(state, path).instances.get(id)!;
  const def = state.definitions.get(inst.definitionId as DefId);
  const out: ModelEntitySummary = { ...base(path, 'instance', id, inst), definitionId: inst.definitionId, name: inst.name || def?.name || '' };
  if (fields.has('geometry')) out.transform = inst.transform.map(round);
  if (fields.has('appearance')) out.materialId = inst.materialId;
  if (fields.has('bounds')) {
    const local = definitionBounds(state, inst.definitionId);
    out.bounds = local ? boundsOut(boxOf(corners(local).map(c => m4transformPoint(inst.transform, c)))) : null;
  }
  return out;
}

function summarizeBody(path: readonly Id[], container: EntityContainer, id: Id, fields: ReadonlySet<string>): ModelEntitySummary {
  const body = container.bodies.get(id)!;
  const out = base(path, 'body', id, body);
  if (fields.has('geometry')) Object.assign(out, { volume: round(body.props.volume), area: round(body.props.area), faceCount: body.faces.size });
  if (fields.has('appearance')) out.materialId = body.materialId;
  if (fields.has('bounds')) out.bounds = boundsOut(meshBounds(body.mesh));
  return out;
}

/** Edges of solids by direction (either way, within 1 degree) and by a point on them. */
function edgeMatches(polyline: readonly Vec3[], along: Vec3 | null, through: Vec3 | null): boolean {
  const a = polyline[0], b = polyline[polyline.length - 1];
  if (!a || !b) return false;
  if (along && Math.abs(v3dot(unit(v3sub(b, a)), unit(along))) < FACING_TOLERANCE) return false;
  if (through && !polyline.some((p, i) => i > 0 && pointOnSegment(through, polyline[i - 1]!, p))) return false;
  return true;
}
function pointOnSegment(p: Vec3, a: Vec3, b: Vec3): boolean {
  const ab = v3sub(b, a), length = v3len(ab);
  if (length <= MERGE_TOL) return dist(p, a) <= MERGE_TOL;
  const t = Math.min(1, Math.max(0, v3dot(v3sub(p, a), ab) / (length * length)));
  return dist(p, v3add(a, v3scale(ab, t))) <= MERGE_TOL;
}
function summarizeEdge(path: readonly Id[], bodyId: Id, edge: EdgeRecord, fields: ReadonlySet<string>): ModelEntitySummary {
  const out: ModelEntitySummary = { ref: { path: [...path], kind: 'edge', id: bodyId, edgeKey: edge.key }, hidden: edge.hidden };
  const a = edge.polyline[0]!, b = edge.polyline[edge.polyline.length - 1]!;
  if (fields.has('geometry')) Object.assign(out, { start: vec(a), end: vec(b), length: round(edge.polyline.reduce((sum, p, i) => sum + (i ? dist(p, edge.polyline[i - 1]!) : 0), 0)),
    faces: [edge.faceA, edge.faceB], soft: edge.soft, smooth: edge.smooth, curve: edge.curveId !== null });
  if (fields.has('bounds')) out.bounds = boundsOut(boxOf(edge.polyline));
  return out;
}

function summarizeFace(path: readonly Id[], bodyId: Id, face: FaceRecord, fields: ReadonlySet<string>, material: Material | null): ModelEntitySummary {
  const out: ModelEntitySummary = { ref: { path: [...path], kind: 'face', id: bodyId, faceId: face.id }, tagId: face.tagId, hidden: face.hidden };
  if (fields.has('geometry')) Object.assign(out, loopFields(face.plane.n, face.loops));
  if (fields.has('bounds')) out.bounds = boundsOut(boxOf(face.loops[0] ?? []));
  if (fields.has('appearance')) Object.assign(out, { frontMaterialId: face.frontMaterialId, backMaterialId: face.backMaterialId }, grainFields(face, material));
  return out;
}

function loopFields(normal: Vec3, loops: readonly (readonly Vec3[])[]): Partial<ModelEntitySummary> {
  const outer = loops[0] ?? [];
  const area = loops.reduce((sum, loop, i) => sum + (i === 0 ? 1 : -1) * Math.abs(v3dot(newell(loop), normal)) / 2, 0);
  return { normal: vec(normal), area: round(area), outerLoop: outer.slice(0, MODEL_LIMITS.loopPointsPerFace).map(vec), loopPointCount: outer.length, holes: loops.length - 1 };
}

/** Even-odd test in the face basis: on the face's plane, inside the outer loop and outside every hole. */
function faceContains(face: FaceRecord, p: Vec3, tolerance = 1e-6): boolean {
  return loopsContain(face.plane, face.basis, face.loops, p, tolerance);
}

function newell(loop: readonly Vec3[]): Vec3 {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]!, b = loop[(i + 1) % loop.length]!;
    x += (a[1] - b[1]) * (a[2] + b[2]); y += (a[2] - b[2]) * (a[0] + b[0]); z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [x, y, z];
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
function unit(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / length, v[1] / length, v[2] / length];
}
function corners(b: Box3): Vec3[] {
  return Array.from({ length: 8 }, (_, i): Vec3 => [i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]]);
}
function boxOf(points: readonly Vec3[]): Box3 {
  const b = box3Empty();
  for (const p of points) box3Expand(b, p);
  return b;
}

/**
 * Draws the model from `camera` into a `width × height` picture without moving the requester's view; null where it
 * cannot (no renderer for the tab).
 */
export type ModelRenderer = (camera: CameraState, width: number, height: number) => Promise<ModelRenderImage | null>;
/** A tool result; `images` are the pictures of a render, in view order. */
export interface ModelToolCallResult extends ToolCallResult { images?: ModelRenderImage[] }

/** Run one model tool call by name; failures come back as error results, never as exceptions. */
export async function runModelTool(api: ModelDocumentApi, name: string, input: unknown, signal?: AbortSignal, options: { renderer?: ModelRenderer | null | undefined } = {}): Promise<ModelToolCallResult> {
  try {
    switch (name) {
      case MODEL_TOOLS.render.name: {
        const { result, images } = await api.render(input, options.renderer, signal);
        return { content: JSON.stringify(result), isError: false, images };
      }
      case MODEL_TOOLS.getDocument.name: return { content: JSON.stringify(api.getDocument()), isError: false };
      case MODEL_TOOLS.query.name: return { content: JSON.stringify(api.query(input)), isError: false };
      case MODEL_TOOLS.applyOperations.name: return { content: JSON.stringify(await api.apply(input, signal)), isError: false };
      case MODEL_TOOLS.view.name: return { content: JSON.stringify(api.view(input)), isError: false };
      case MODEL_TOOLS.overlaps.name: return { content: JSON.stringify(await api.findOverlaps(input)), isError: false };
      case MODEL_TOOLS.materialLibrary.name: return { content: JSON.stringify(api.materialLibrary(input)), isError: false };
      default: return { content: JSON.stringify({ ok: false, error: { code: 'invalid_operation', message: `Unknown model tool "${name}".`, revision: api.revision } }), isError: true };
    }
  } catch (cause) {
    const error: ModelApiError = cause instanceof ModelApiFailure ? cause.error
      : { code: 'operation_failed', message: cause instanceof Error ? cause.message : String(cause), revision: api.revision };
    return { content: JSON.stringify({ ok: false, error }), isError: true };
  }
}
