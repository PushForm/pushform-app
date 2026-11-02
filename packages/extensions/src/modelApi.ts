// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import {
  activeTagOpt, applyTransformPlan, arrayMatrices, contextFrame, curvePoints, definitionBounds, hostOf, instanceCount, kernelOf, localPushPullDistance,
  m4rotationAbout, m4scaleAbout, planPushPull, planTransform, runFollowMeKernel, runPushPullKernel, runSolidsKernel, runTransformKernel, sceneRuntimeOf,
  type CameraHost, type CameraState, type CommandRegistry, type DocumentHost, type ExplodeResult, type FollowMeApplyResult, type FollowMeParams,
  type MakeResult, type PushPullApplyResult, type PushPullTarget, type SolidsApplyResult, type SolidsKernelWork, type SolidsPairMode, type TransformKernelWork, type TransformPlan,
} from '@pushform/commands';
import {
  LOCAL_REFERENCE, MODEL_API_VERSION, MODEL_LIMITS, MODEL_PLANNED_OPERATIONS, MODEL_TOOLS, modelBatchSchema, modelOperationSchema, modelQuerySchema,
  modelViewSchema, type ModelApiError, type ModelApiErrorCode, type ModelBatchResult, type ModelBounds, type ModelCameraInput, type ModelCameraSummary,
  type ModelDocumentSnapshot, type ModelEntitySummary, type ModelOperation, type ModelQueryResult, type ModelRef, type ModelRefInput, type ModelSceneSaves,
  type ModelVec3, type ModelViewResult,
} from '@pushform/extension-protocol';
import {
  basisToLocal, box3Empty, box3Expand, box3IsEmpty, MERGE_TOL, m4invert, m4mul, m4transformPoint, m4translation, meshBounds, planeDistance, PushFormError,
  v3add, v3cross, v3dot, v3len, v3scale, v3sub,
  type Box3, type DefId, type FaceLocalId, type Id, type MMat4, type PlaneBasis, type Plane, type Vec3,
} from '@pushform/core';
import {
  computeRegions, containerAt, contextMatrix, entityCounts, regionAt, sketchFaceLoops,
  type Body, type DocumentState, type EntityContainer, type EntityRef, type FaceRecord, type Rgb, type Scene, type SceneFlags, type SketchFace,
} from '@pushform/model';
import type { ToolCallResult } from './layoutApi';
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
/** A face to push, pull or sweep, as the commands take it, and the direction a positive API distance moves. */
interface FaceTarget { target: PushPullTarget; plane: Plane; normal: Vec3; shown: string }
type OpResult = Omit<ModelBatchResult['results'][number], 'op'> & { named?: Named };

const DEFAULT_QUERY_LIMIT = 50;
const FACING_TOLERANCE = Math.cos(Math.PI / 180);
/** Smallest volume a committed solid may have: a cube one merge tolerance on a side. */
const MIN_VOLUME = MERGE_TOL ** 3;
const PLANNED = new Set<string>(MODEL_PLANNED_OPERATIONS);
const round = (value: number): number => Math.round(value * 1e6) / 1e6;
const vec = (p: Vec3): ModelVec3 => [round(p[0]), round(p[1]), round(p[2])];
const hex = (c: Rgb): string => `#${c.map(x => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0')).join('')}`;
const rgb = (color: string): Rgb => [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255) as unknown as Rgb;
const boundsOut = (b: Box3 | null): ModelBounds | null => (b && !box3IsEmpty(b) ? { min: vec(b.min), max: vec(b.max) } : null);
const zodMessage = (error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string => error.issues.slice(0, 5).map(i => `${i.path.map(String).join('.') || 'input'}: ${i.message}`).join('; ');
const samePath = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Host side of the model document API for one open model and one client. Reads are snapshots of committed state.
 * `apply` runs a batch through the model's commands inside one exclusive undo group: the batch commits as one undo
 * entry labelled `<client>: <label>`, or every change is reverted, and no other edit can interleave with it while
 * kernel work is awaited.
 */
export class ModelDocumentApi {
  private readonly host: DocumentHost;

  constructor(private readonly commands: CommandRegistry, private readonly client: string) {
    this.host = hostOf(commands.ctx);
  }

  get revision(): number { return this.host.doc.version; }

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
      materials: [...state.materials.values()].map(m => ({ id: m.id, name: m.name, color: hex(m.color), opacity: m.alpha, textured: m.texture !== null, isDefault: m.id === state.defaultMaterialId })),
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
        shown = this.cameraFor(action.camera, path, this.resolver(path, new Map()).ref);
        runtime.animateCamera(camera, shown, action.animate ?? true ? runtime.animationSettings.transitionSeconds : 0);
        break;
      case 'activate_scene': {
        const scene = this.sceneOf(this.resolveScene(action.scene, new Map()));
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

  /** A scene by id, name (any case), "active", or "$name" of a scene added earlier in the batch. */
  private resolveScene(input: number | string, names: ReadonlyMap<string, Named>): number {
    if (typeof input === 'number') return this.sceneOf(input).id;
    const local = LOCAL_REFERENCE.exec(input)?.[1];
    if (local !== undefined) {
      const found = names.get(local);
      if (found?.kind !== 'scene') throw this.failure('invalid_reference', `"${input}" does not name a scene added earlier in this batch.`);
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

  query(input: unknown): ModelQueryResult {
    const parsed = modelQuerySchema.safeParse(input);
    if (!parsed.success) throw this.failure('invalid_operation', zodMessage(parsed.error));
    const query = parsed.data, state = this.host.doc.state;
    const path = (query.container ?? [...this.host.context.path]) as Id[];
    const container = this.containerOrFail(path);
    const kinds = new Set<string>(query.kinds ?? ['instance', 'body', 'sketchEdge', 'sketchFace', 'guide', 'text', 'dimension']);
    const ids = query.ids ? new Set<number>(query.ids) : null;
    const fields = new Set(query.fields ?? ['bounds', 'geometry', 'appearance']);
    const all: (() => ModelEntitySummary)[] = [];
    const keep = (kind: string, id: number): boolean => kinds.has(kind) && (!ids || ids.has(id));
    for (const inst of container.instances.values()) if (keep('instance', inst.id)) all.push(() => summarizeInstance(state, path, inst.id, fields));
    for (const body of container.bodies.values()) {
      if (keep('body', body.id)) all.push(() => summarizeBody(path, container, body.id, fields));
      if (!kinds.has('face') || (ids && !ids.has(body.id))) continue;
      for (const face of body.faces.values()) {
        if (query.facing && v3dot(face.plane.n, unit(query.facing)) < FACING_TOLERANCE) continue;
        if (query.containing && !faceContains(face, query.containing)) continue;
        all.push(() => summarizeFace(path, body.id, face, fields));
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
      if (fields.has('appearance')) Object.assign(out, { frontMaterialId: face.frontMaterialId, backMaterialId: face.backMaterialId });
      return out;
    });
    for (const guide of container.guides.values()) if (keep('guide', guide.id)) all.push(() => {
      const points = guide.kind === 'segment' ? [guide.origin, guide.end] : guide.kind === 'line' ? [guide.origin, add(guide.origin, guide.dir)] : [guide.origin];
      return { ...base(path, 'guide', guide.id, guide), ...(fields.has('geometry') ? { points: points.map(vec), text: guide.kind } : {}) };
    });
    for (const text of container.texts.values()) if (keep('text', text.id)) all.push(() => ({ ...base(path, 'text', text.id, text), text: text.text.slice(0, 500) }));
    for (const dim of container.dimensions.values()) if (keep('dimension', dim.id)) all.push(() => base(path, 'dimension', dim.id, dim));
    const offset = query.offset ?? 0, limit = query.limit ?? DEFAULT_QUERY_LIMIT;
    return { revision: this.revision, container: [...path], worldTransform: contextMatrix(state, path).map(round), total: all.length, offset,
      entities: all.slice(offset, offset + limit).map(make => make()), next: offset + limit < all.length ? offset + limit : null };
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
      if (!op.success) throw this.failure('invalid_operation', `Operation ${index}: ${zodMessage(op.error)}`, index);
      return op.data;
    });
    const points = operations.reduce((sum, op) => sum + pointCount(op), 0);
    if (points > MODEL_LIMITS.pointsPerBatch) throw this.failure('limit_exceeded', `The batch names ${points} entities and points; the limit is ${MODEL_LIMITS.pointsPerBatch}.`);
    if (batch.expectedRevision !== this.revision)
      throw this.failure('stale_revision', `The model changed since revision ${batch.expectedRevision}; it is now at revision ${this.revision}. Read it again before editing.`);
    const host = this.host, undo = host.undoStack;
    const path = (batch.container ?? [...host.context.path]) as Id[];
    this.containerOrFail(path);
    this.runtime.stop();
    const label = `${this.client}: ${batch.label}`;
    const names = new Map<string, Named>();
    const results: ModelBatchResult['results'] = [];
    const savedPath = [...host.context.path], savedSelection = host.selection.snapshot();
    const deadline = Date.now() + MODEL_LIMITS.kernelSeconds * 1000;
    let at = 0, failed: ModelApiFailure | null = null;
    undo.beginGroup(label);
    try {
      undo.withinGroup(() => { if (!samePath(path, savedPath)) host.setContext(path); });
      for (const [index, op] of operations.entries()) {
        at = index;
        if (signal?.aborted) throw this.failure('cancelled', 'The batch was stopped before it finished. Nothing was changed.', index);
        if (Date.now() > deadline) throw this.failure('limit_exceeded', `The batch ran longer than ${MODEL_LIMITS.kernelSeconds} seconds and was cancelled. Nothing was changed.`, index);
        const { named, ...result } = await this.run(op, path, names, label);
        if ('as' in op && op.as) {
          if (names.has(op.as)) throw this.failure('invalid_operation', `The name "${op.as}" is used twice in this batch.`, index);
          if (named) names.set(op.as, named);
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
      undo.endGroup(failed === null);
    }
    // Reverting the batch is itself a change, so a failure reports the revision after it.
    if (failed) throw new ModelApiFailure({ ...failed.error, revision: this.revision });
    return { ok: true, revision: this.revision, label, created: Object.fromEntries([...names].map(([name, value]) => [name, value.id])), results };
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

  /** Resolves `"$name"`s and entity references of the container at `path`. */
  private resolver(path: Id[], names: ReadonlyMap<string, Named>) {
    const host = this.host;
    const named = (value: string): Named => {
      const name = LOCAL_REFERENCE.exec(value)?.[1];
      const found = name === undefined ? undefined : names.get(name);
      if (!found) throw this.failure('invalid_reference', `"${value}" does not name anything created earlier in this batch.`);
      return found;
    };
    const ref = (input: ModelRefInput): EntityRef => {
      const state = host.doc.state, container = containerAt(state, path);
      if (typeof input === 'object' && 'body' in input) return this.selectFace(path, input, named).ref;
      const target: { kind: string; id: number; faceId?: number | undefined } = typeof input === 'string' ? named(input) : input;
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
          default: return false;
        }
      })();
      const shown = typeof input === 'string' ? input : `${input.kind} ${input.id}${'faceId' in input ? ` face ${input.faceId}` : ''}`;
      if (!exists) throw this.failure('invalid_reference', `There is no ${shown} in the container being edited${typeof input === 'string' ? ' any more' : ''}. Call ${MODEL_TOOLS.query.name} for current ids.`);
      if (target.kind === 'face') return { kind: 'face', path, id: target.id as Id, faceId: target.faceId as never, region: null };
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

  private async run(op: ModelOperation, path: Id[], names: ReadonlyMap<string, Named>, label: string): Promise<OpResult> {
    const host = this.host, undo = host.undoStack;
    const exec = <T>(command: string, params: Record<string, unknown>): T => undo.withinGroup(() => this.commands.execute(command, params) as T);
    const { named, ref, refsOf } = this.resolver(path, names);
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
      const found = named(value);
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
    const transform = (refs: EntityRef[], local: MMat4, copy: boolean, copies: number | undefined): Promise<OpResult> => {
      if (refs.some(r => r.kind === 'face')) throw this.failure('invalid_operation', 'Moving a face of a solid is push/pull: use push_pull.');
      // The API's matrices are local to the container; the transform commands take world matrices.
      const frame = contextMatrix(host.doc.state, path);
      const world = m4mul(frame, m4mul(local, m4invert(frame) ?? frame));
      const matrices = copies ? arrayMatrices(world, copies, 'external') : [world];
      return this.transform(matrices.map(m => planTransform(host.doc.state, refs, m, copy || copies !== undefined, label)));
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
        for (const other of rest) {
          const result = await boolean('union', first!, other);
          if (result.bodyIds.length !== 1) throw this.failure('invalid_geometry', `Solids ${first!.id} and ${other.id} do not touch, so they cannot become one solid; group them instead.`);
          deleted.push(...result.deleted);
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
            const result = await boolean(!op.keepCutters && j === touched.length - 1 ? 'subtract' : 'trim', cutter, { kind: 'body', path, id: piece });
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
          const result = await boolean('intersect', first!, other);
          if (result.bodyIds.length === 0) throw this.failure('invalid_geometry', `Solids ${first!.id} and ${other.id} do not overlap, so they share no volume.`);
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
      case 'move': return transform(refsOf(op.refs), m4translation(op.offset), op.copy ?? false, op.copies);
      case 'rotate': return transform(refsOf(op.refs), m4rotationAbout(op.origin, unit(op.axis), (op.angleDeg * Math.PI) / 180), op.copy ?? false, op.copies);
      case 'scale': return transform(refsOf(op.refs), m4scaleAbout(op.origin, op.factors), op.copy ?? false, undefined);
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
        const id = exec<number>('material.create', { name: op.name ?? 'Material', color: rgb(op.color), ...(op.opacity !== undefined ? { alpha: op.opacity } : {}), activate: false });
        return { id, named: { kind: 'material', id } };
      }
      case 'paint': {
        const materialId = op.materialId === null ? null : idOf(op.materialId, 'material');
        if (materialId !== null && !host.doc.state.materials.has(materialId as never)) throw this.failure('invalid_reference', `There is no material ${materialId}.`);
        const refs = only(refsOf(op.refs), ['face', 'body', 'sketchFace', 'instance'], 'Only faces, solids, groups and placements can be painted');
        return { count: exec<{ painted: number }>('paint.apply', { refs, materialId, side: op.side ?? 'front' }).painted };
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
  const id = shape.inside ? faces.find(f => sketchFaceContains(c, f, shape.inside!)) : faces.length === 1 ? faces[0] : undefined;
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
function boxesOverlap(a: Box3, b: Box3): boolean {
  return [0, 1, 2].every(i => a.min[i]! <= b.max[i]! + MERGE_TOL && b.min[i]! <= a.max[i]! + MERGE_TOL);
}

function errorCode(cause: unknown): ModelApiErrorCode {
  if (cause instanceof Error && cause.name === 'KernelError') return 'invalid_geometry';
  const code = cause instanceof PushFormError ? cause.code : '';
  if (/invalidSolid|invalid_geometry|kernel|notSolid|degenerate|^path\.|^followme\.(path|empty)/i.test(code)) return 'invalid_geometry';
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

function summarizeFace(path: readonly Id[], bodyId: Id, face: FaceRecord, fields: ReadonlySet<string>): ModelEntitySummary {
  const out: ModelEntitySummary = { ref: { path: [...path], kind: 'face', id: bodyId, faceId: face.id }, tagId: face.tagId, hidden: face.hidden };
  if (fields.has('geometry')) Object.assign(out, loopFields(face.plane.n, face.loops));
  if (fields.has('bounds')) out.bounds = boundsOut(boxOf(face.loops[0] ?? []));
  if (fields.has('appearance')) Object.assign(out, { frontMaterialId: face.frontMaterialId, backMaterialId: face.backMaterialId });
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

/** Run one model tool call by name; failures come back as error results, never as exceptions. */
export async function runModelTool(api: ModelDocumentApi, name: string, input: unknown, signal?: AbortSignal): Promise<ToolCallResult> {
  try {
    switch (name) {
      case MODEL_TOOLS.getDocument.name: return { content: JSON.stringify(api.getDocument()), isError: false };
      case MODEL_TOOLS.query.name: return { content: JSON.stringify(api.query(input)), isError: false };
      case MODEL_TOOLS.applyOperations.name: return { content: JSON.stringify(await api.apply(input, signal)), isError: false };
      case MODEL_TOOLS.view.name: return { content: JSON.stringify(api.view(input)), isError: false };
      default: return { content: JSON.stringify({ ok: false, error: { code: 'invalid_operation', message: `Unknown model tool "${name}".`, revision: api.revision } }), isError: true };
    }
  } catch (cause) {
    const error: ModelApiError = cause instanceof ModelApiFailure ? cause.error
      : { code: 'operation_failed', message: cause instanceof Error ? cause.message : String(cause), revision: api.revision };
    return { content: JSON.stringify({ ok: false, error }), isError: true };
  }
}
