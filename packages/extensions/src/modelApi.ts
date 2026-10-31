// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import {
  activeTagOpt, applyTransformPlan, arrayMatrices, definitionBounds, hostOf, instanceCount, kernelOf, m4rotationAbout, m4scaleAbout,
  planTransform, runTransformKernel, sceneRuntimeOf, type CameraHost, type CameraState, type CommandRegistry, type DocumentHost, type ExplodeResult,
  type MakeResult, type TransformKernelWork, type TransformPlan,
} from '@pushform/commands';
import {
  LOCAL_REFERENCE, MODEL_API_VERSION, MODEL_LIMITS, MODEL_PLANNED_OPERATIONS, MODEL_TOOLS, modelBatchSchema, modelOperationSchema, modelQuerySchema,
  modelViewSchema, type ModelApiError, type ModelApiErrorCode, type ModelBatchResult, type ModelBounds, type ModelCameraInput, type ModelCameraSummary,
  type ModelDocumentSnapshot, type ModelEntitySummary, type ModelOperation, type ModelQueryResult, type ModelRef, type ModelRefInput, type ModelSceneSaves,
  type ModelVec3, type ModelViewResult,
} from '@pushform/extension-protocol';
import {
  box3Empty, box3Expand, box3IsEmpty, m4invert, m4mul, m4transformPoint, m4translation, meshBounds, planeDistance, PushFormError, v3dot,
  type Box3, type DefId, type Id, type MMat4, type Vec3,
} from '@pushform/core';
import {
  containerAt, contextMatrix, entityCounts, sketchFaceLoops,
  type DocumentState, type EntityContainer, type EntityRef, type FaceRecord, type Rgb, type Scene, type SceneFlags,
} from '@pushform/model';
import type { ToolCallResult } from './layoutApi';
import { frameCamera } from './modelCamera';

/** A structured API error; the message is safe to show to the user and to a model. */
export class ModelApiFailure extends Error {
  constructor(readonly error: ModelApiError) { super(error.message); this.name = 'ModelApiFailure'; }
}

/** What a batch names with `as`: the entity's kind and id, and for a group or placement its definition. */
interface Named { kind: ModelRef['kind'] | 'tag' | 'material' | 'scene'; id: number; definitionId?: number }
type OpResult = Omit<ModelBatchResult['results'][number], 'op'> & { named?: Named };

const DEFAULT_QUERY_LIMIT = 50;
const FACING_TOLERANCE = Math.cos(Math.PI / 180);
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
    const points = operations.reduce((sum, op) => sum + ('refs' in op ? op.refs.length : 1), 0);
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
      const target = typeof input === 'string' ? named(input) : input;
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
      if (!exists) throw this.failure('invalid_reference', `There is no ${shown} in the container being edited. Call ${MODEL_TOOLS.query.name} for current ids.`);
      if (target.kind === 'face') return { kind: 'face', path, id: target.id as Id, faceId: (target as { faceId: number }).faceId as never, region: null };
      return { kind: target.kind as 'instance', path, id: target.id as Id };
    };
    return { named, ref };
  }

  private async run(op: ModelOperation, path: Id[], names: ReadonlyMap<string, Named>, label: string): Promise<OpResult> {
    const host = this.host, undo = host.undoStack;
    const exec = <T>(command: string, params: Record<string, unknown>): T => undo.withinGroup(() => this.commands.execute(command, params) as T);
    const { named, ref } = this.resolver(path, names);
    const sceneId = (input: number | string): number => this.resolveScene(input, names);
    const capture = (camera: ModelCameraInput | undefined, what: string): CameraState | undefined => {
      if (camera) return this.cameraFor(camera, path, ref);
      if (!this.camera) throw this.failure('unavailable', `There is no viewport here, so ${what} needs an exact camera.`);
      return undefined;
    };
    const refsOf = (inputs: readonly ModelRefInput[]): EntityRef[] => inputs.map(ref);
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
      if (refs.some(r => r.kind === 'face')) throw this.failure('unavailable', 'Moving a face of a solid is push/pull, which is not available yet.');
      // The API's matrices are local to the container; the transform commands take world matrices.
      const frame = contextMatrix(host.doc.state, path);
      const world = m4mul(frame, m4mul(local, m4invert(frame) ?? frame));
      const matrices = copies ? arrayMatrices(world, copies, 'external') : [world];
      return this.transform(matrices.map(m => planTransform(host.doc.state, refs, m, copy || copies !== undefined, label)));
    };
    switch (op.op) {
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

function errorCode(cause: unknown): ModelApiErrorCode {
  const code = cause instanceof PushFormError ? cause.code : '';
  if (/invalidSolid|invalid_geometry|kernel/i.test(code)) return 'invalid_geometry';
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

function faceContains(face: FaceRecord, p: Vec3): boolean {
  if (Math.abs(planeDistance(face.plane, p)) > 1e-6) return false;
  // Even-odd test in the face basis: inside the outer loop and outside every hole.
  const uv = (q: Vec3): [number, number] => [v3dot(q, face.basis.u), v3dot(q, face.basis.v)];
  const [x, y] = uv(p);
  let inside = false;
  for (const loop of face.loops) {
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const [xi, yi] = uv(loop[i]!), [xj, yj] = uv(loop[j]!);
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
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
