// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { Emitter, PushFormError, v3normalize } from '@pushform/core';
import type { Id, SceneId, Vec3 } from '@pushform/core';
import { DEFAULT_SCENE_FLAGS, allocId } from '@pushform/model';
import type { CameraState as ModelCamera, DocumentDraft, DocumentState, Scene, SceneFlags } from '@pushform/model';
import { defineCommand } from '../registry/Command';
import type { AnyCommand, CommandContext } from '../registry/Command';
import type { CameraHost, CameraState } from '../camera/CameraHost';
import type { DocumentHost } from '../host/DocumentHost';
import { hostOf } from '../host/services';
import { fogOf } from './fog';

/**
 * Scenes: a scene stores the camera plus a selection of
 * document properties (hidden geometry/objects, tag visibility, style + fog, shadows, axes).
 * Create/update/delete/rename/move are undoable document edits; activating a scene
 * is a view operation: the camera animates through the `CameraHost` and the saved properties are
 * written to the document without an undo entry.
 */

// ---------------------------------------------------------------------------------------------
// Runtime (which scene is current, animation, play loop)

export const SERVICE_SCENES = 'scenes';

export interface SceneRuntimeEvents extends Record<string, unknown> {
  change: { activeSceneId: number | null; playing: boolean };
}

export interface AnimationSettings {
  /** Camera transition duration in seconds (Model Info › Animation). */
  readonly transitionSeconds: number;
  /** Pause on each scene while playing, in seconds. */
  readonly delaySeconds: number;
}

type Raf = (cb: (t: number) => void) => number;

/** Runtime scene state shared by commands and the UI: current scene, camera tween, slideshow. */
export class SceneRuntime {
  readonly events = new Emitter<SceneRuntimeEvents>();
  private _activeSceneId: number | null = null;
  private _playing = false;
  private animation: AnimationSettings = { transitionSeconds: 1, delaySeconds: 2 };
  private tweenHandle: number | null = null;
  private tweenCancel: (() => void) | null = null;
  private playTimer: ReturnType<typeof setTimeout> | null = null;
  /** `requestAnimationFrame` when available; null runs transitions instantly (node tests). */
  raf: Raf | null = typeof requestAnimationFrame === 'function' ? (cb) => requestAnimationFrame(cb) : null;
  now: () => number = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  get activeSceneId(): number | null {
    return this._activeSceneId;
  }
  get playing(): boolean {
    return this._playing;
  }
  get animationSettings(): AnimationSettings {
    return this.animation;
  }
  setAnimationSettings(s: Partial<AnimationSettings>): void {
    this.animation = { ...this.animation, ...s };
  }

  setActive(id: number | null): void {
    if (this._activeSceneId === id) return;
    this._activeSceneId = id;
    this.emit();
  }

  /** Tween the camera to `target` over `seconds` (instant when 0 or without rAF). */
  animateCamera(camera: CameraHost, target: CameraState, seconds: number): void {
    this.cancelTween();
    const raf = this.raf;
    if (!raf || seconds <= 0) {
      camera.setState(target);
      return;
    }
    const from = camera.getState();
    const start = this.now();
    const ms = seconds * 1000;
    let cancelled = false;
    this.tweenCancel = () => {
      cancelled = true;
    };
    const step = () => {
      if (cancelled) return;
      const t = Math.min(1, (this.now() - start) / ms);
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // ease in-out quad
      if (t >= 1) {
        this.tweenHandle = null;
        this.tweenCancel = null;
        camera.setState(target, true);
        return;
      }
      camera.setState(lerpCamera(from, target, e), false);
      this.tweenHandle = raf(step);
    };
    this.tweenHandle = raf(step);
  }

  cancelTween(): void {
    this.tweenCancel?.();
    this.tweenCancel = null;
    this.tweenHandle = null;
  }

  /** Start the slideshow: `next()` is called after each delay until `stop()`. */
  play(next: () => boolean): void {
    this.stop();
    this._playing = true;
    this.emit();
    const tick = () => {
      if (!this._playing) return;
      if (!next()) {
        this.stop();
        return;
      }
      this.playTimer = setTimeout(tick, (this.animation.delaySeconds + this.animation.transitionSeconds) * 1000);
    };
    this.playTimer = setTimeout(tick, this.animation.delaySeconds * 1000);
  }

  stop(): void {
    if (this.playTimer !== null) clearTimeout(this.playTimer);
    this.playTimer = null;
    if (!this._playing) return;
    this._playing = false;
    this.emit();
  }

  dispose(): void {
    this.stop();
    this.cancelTween();
  }

  private emit(): void {
    this.events.emit('change', { activeSceneId: this._activeSceneId, playing: this._playing });
  }
}

/** The scene runtime service (installed lazily). */
export function sceneRuntimeOf(ctx: CommandContext): SceneRuntime {
  let r = ctx.services.get(SERVICE_SCENES) as SceneRuntime | undefined;
  if (!r) {
    r = new SceneRuntime();
    ctx.services.set(SERVICE_SCENES, r);
  }
  return r;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

export function lerpCamera(a: CameraState, b: CameraState, t: number): CameraState {
  const up = v3normalize(lerp3(a.up, b.up, t));
  return {
    eye: lerp3(a.eye, b.eye, t),
    target: lerp3(a.target, b.target, t),
    up: [up[0], up[1], up[2]],
    fov: lerp(a.fov, b.fov, t),
    projection: t < 0.5 ? a.projection : b.projection,
    orthoHeight: lerp(a.orthoHeight, b.orthoHeight, t),
  };
}

// ---------------------------------------------------------------------------------------------
// Camera conversion (model `CameraState` ↔ `CameraHost` state)

export function cameraToModel(c: CameraState): ModelCamera {
  return { eye: [...c.eye] as Vec3, target: [...c.target] as Vec3, up: [...c.up] as Vec3, perspective: c.projection === 'perspective', fov: c.fov, height: c.orthoHeight };
}

export function cameraFromModel(c: ModelCamera): CameraState {
  return { eye: c.eye, target: c.target, up: c.up, fov: c.fov, projection: c.perspective ? 'perspective' : 'parallel', orthoHeight: c.height };
}

// ---------------------------------------------------------------------------------------------
// Capture / restore

const draftState = (draft: DocumentDraft): DocumentState => draft as unknown as DocumentState;

export function sceneOf(state: DocumentState, id: number): Scene {
  const s = state.scenes.get(id as SceneId);
  if (!s) throw new PushFormError('scene.missing', `Scene ${id} not found`);
  return s;
}

/** "Scene N" with the smallest free N. */
export function nextSceneName(state: DocumentState): string {
  const taken = new Set<string>();
  for (const s of state.scenes.values()) taken.add(s.name);
  for (let n = state.scenes.size + 1; ; n++) if (!taken.has(`Scene ${n}`)) return `Scene ${n}`;
}

/**
 * Hidden entity ids of every container, so items hidden inside groups and components are saved too (ids are unique
 * in the document): bodies, mesh parts, sketch edges/faces and guides are geometry; instances are objects.
 */
export function hiddenEntities(state: DocumentState): { geometry: Id[]; objects: Id[] } {
  const geometry: Id[] = [], objects: Id[] = [];
  for (const def of state.definitions.values()) {
    const c = def.entities;
    for (const b of c.bodies.values()) if (b.hidden) geometry.push(b.id);
    for (const m of c.meshParts.values()) if (m.hidden) geometry.push(m.id);
    for (const e of c.sketch.edges.values()) if (e.hidden) geometry.push(e.id);
    for (const f of c.sketch.faces.values()) if (f.hidden) geometry.push(f.id);
    for (const g of c.guides.values()) if (g.hidden) geometry.push(g.id);
    for (const i of c.instances.values()) if (i.hidden) objects.push(i.id);
  }
  return { geometry, objects };
}

/** Snapshot the current view into scene fields (everything; `flags` decide what is restored). */
export function captureSceneProps(state: DocumentState, camera: CameraState | null): Omit<Scene, 'id' | 'name' | 'description' | 'flags'> {
  const hidden = hiddenEntities(state);
  const style = state.styles.get(state.activeStyleId);
  const fog = fogOf(state);
  return {
    camera: cameraToModel(camera ?? { eye: [4.5, -6.6, 1.9], target: [0, 0, 0.9], up: [0, 0, 1], fov: 35, projection: 'perspective', orthoHeight: 10 }),
    hiddenEntities: [...hidden.geometry, ...hidden.objects],
    hiddenTags: [...state.tags.values()].filter((t) => !t.visible).map((t) => t.id),
    hiddenTagFolders: [...state.tagFolders.values()].filter((f) => !f.visible).map((f) => f.id),
    styleId: state.activeStyleId,
    shadows: { ...state.shadows },
    fog: { ...fog, color: [fog.color[0], fog.color[1], fog.color[2]] },
    // every container's active cut (section plane ids are unique in the document)
    activeSectionPlanes: [...state.definitions.values()].flatMap((d) => (d.entities.activeSectionPlaneId === null ? [] : [d.entities.activeSectionPlaneId])),
    axesVisible: style?.modeling.modelAxesVisible ?? true,
  };
}

/** Write the saved properties of `scene` (per its flags) into the draft. Camera is handled by the caller. */
export function restoreSceneProps(draft: DocumentDraft, scene: Scene): void {
  const state = draftState(draft);
  const f = scene.flags;
  if (f.useHiddenGeometry || f.useHiddenObjects) {
    const hidden = new Set<number>(scene.hiddenEntities);
    for (const def of state.definitions.values()) {
      const c = def.entities;
      if (f.useHiddenGeometry) {
        for (const b of c.bodies.values()) b.hidden = hidden.has(b.id);
        for (const m of c.meshParts.values()) m.hidden = hidden.has(m.id);
        for (const e of c.sketch.edges.values()) e.hidden = hidden.has(e.id);
        for (const fc of c.sketch.faces.values()) fc.hidden = hidden.has(fc.id);
        for (const g of c.guides.values()) g.hidden = hidden.has(g.id);
      }
      if (f.useHiddenObjects) for (const i of c.instances.values()) i.hidden = hidden.has(i.id);
    }
  }
  if (f.useTags) {
    const hiddenTags = new Set<number>(scene.hiddenTags);
    const hiddenFolders = new Set<number>(scene.hiddenTagFolders);
    for (const t of state.tags.values()) t.visible = !hiddenTags.has(t.id);
    for (const fo of state.tagFolders.values()) fo.visible = !hiddenFolders.has(fo.id);
  }
  if (f.useStyle) {
    if (scene.styleId !== null && state.styles.has(scene.styleId)) state.activeStyleId = scene.styleId;
    if (scene.fog) state.fog = { ...scene.fog, color: [scene.fog.color[0], scene.fog.color[1], scene.fog.color[2]] };
  }
  if (f.useShadows && scene.shadows) state.shadows = { ...scene.shadows };
  if (f.useSectionPlanes) {
    // each container's cut is the scene's plane among its own, or none
    const active = new Set<number>(scene.activeSectionPlanes);
    for (const d of state.definitions.values()) {
      const c = d.entities;
      c.activeSectionPlaneId = [...c.sectionPlanes.keys()].find((id) => active.has(id)) ?? null;
    }
  }
  if (f.useAxes) {
    const style = state.styles.get(state.activeStyleId);
    if (style) style.modeling.modelAxesVisible = scene.axesVisible;
  }
}

export interface SceneInfo {
  readonly id: number;
  readonly name: string;
  readonly description: string;
  readonly includeInAnimation: boolean;
  readonly flags: SceneFlags;
  readonly active: boolean;
}

/** Scenes in tab order. */
export function sceneInfos(state: DocumentState, activeSceneId: number | null): SceneInfo[] {
  const out: SceneInfo[] = [];
  for (const id of state.sceneOrder) {
    const s = state.scenes.get(id);
    if (!s) continue;
    out.push({ id: s.id, name: s.name, description: s.description, includeInAnimation: s.includeInAnimation ?? true, flags: s.flags, active: s.id === activeSceneId });
  }
  return out;
}

/** Merge a partial flags param (undefined fields skipped) onto `base`. */
function mergeFlags(base: SceneFlags, patch: Partial<Record<keyof SceneFlags, boolean | undefined>> | undefined): SceneFlags {
  const out = { ...base };
  if (patch) for (const k of Object.keys(patch) as (keyof SceneFlags)[]) if (patch[k] !== undefined) out[k] = patch[k]!;
  return out;
}

const FlagsSchema = z.object({
  useCamera: z.boolean().optional(),
  useHiddenGeometry: z.boolean().optional(),
  useHiddenObjects: z.boolean().optional(),
  useTags: z.boolean().optional(),
  useStyle: z.boolean().optional(),
  useShadows: z.boolean().optional(),
  useSectionPlanes: z.boolean().optional(),
  useAxes: z.boolean().optional(),
});
const idSchema = z.number().int().nonnegative();

function cameraOrNull(ctx: CommandContext): CameraState | null {
  return ctx.camera ? ctx.camera.getState() : null;
}

function activateScene(ctx: CommandContext, host: DocumentHost, scene: Scene, animate: boolean): void {
  const runtime = sceneRuntimeOf(ctx);
  // Document properties first (style/tags), then the camera (animated).
  host.doc.transact('Activate Scene', (draft) => restoreSceneProps(draft, scene));
  if (scene.flags.useCamera && ctx.camera) {
    runtime.animateCamera(ctx.camera, cameraFromModel(scene.camera), animate ? runtime.animationSettings.transitionSeconds : 0);
  }
  runtime.setActive(scene.id);
}

function neighbor(state: DocumentState, current: number | null, dir: 1 | -1, animationOnly: boolean): Scene | null {
  const order = state.sceneOrder.filter((id) => {
    const s = state.scenes.get(id);
    return s && (!animationOnly || (s.includeInAnimation ?? true));
  });
  if (!order.length) return null;
  const i = current === null ? -1 : order.indexOf(current as SceneId);
  const n = order.length;
  const next = i < 0 ? (dir === 1 ? 0 : n - 1) : (((i + dir) % n) + n) % n;
  return state.scenes.get(order[next]!) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Commands

export const sceneAdd = defineCommand({
  id: 'scene.add',
  title: 'Add Scene',
  category: 'view',
  menu: 'View',
  params: z.object({ name: z.string().optional(), description: z.string().optional(), flags: FlagsSchema.optional(), includeInAnimation: z.boolean().optional() }),
  undoable: true,
  run(ctx, p): number {
    const host = hostOf(ctx);
    const camera = cameraOrNull(ctx);
    const id = host.edit('Add Scene', (draft) => {
      const state = draftState(draft);
      const id = allocId<SceneId>(draft);
      const scene: Scene = {
        id,
        name: p.name?.trim() || nextSceneName(state),
        description: p.description ?? '',
        flags: mergeFlags(DEFAULT_SCENE_FLAGS, p.flags),
        includeInAnimation: p.includeInAnimation ?? true,
        ...captureSceneProps(state, camera),
      };
      state.scenes.set(id, scene);
      draft.sceneOrder.push(id);
      return id as number;
    });
    sceneRuntimeOf(ctx).setActive(id);
    return id;
  },
});

/** Re-capture the current view into the scene (optionally changing which properties it saves). */
export const sceneUpdate = defineCommand({
  id: 'scene.update',
  title: 'Update Scene',
  category: 'view',
  params: z.object({
    id: idSchema.optional(),
    flags: FlagsSchema.optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    /** Re-capture the current view (default). False only changes flags/name/description. */
    recapture: z.boolean().default(true),
  }),
  undoable: true,
  run(ctx, p): void {
    const host = hostOf(ctx);
    const runtime = sceneRuntimeOf(ctx);
    const id = p.id ?? runtime.activeSceneId;
    if (id === null) throw new PushFormError('scene.none', 'No scene to update');
    const camera = cameraOrNull(ctx);
    host.edit('Update Scene', (draft) => {
      const state = draftState(draft);
      const scene = sceneOf(state, id);
      if (p.recapture) Object.assign(scene, captureSceneProps(state, camera));
      if (p.flags) scene.flags = mergeFlags(scene.flags, p.flags);
      if (p.name !== undefined) scene.name = p.name.trim() || scene.name;
      if (p.description !== undefined) scene.description = p.description;
    });
  },
});

export const sceneDelete = defineCommand({
  id: 'scene.delete',
  title: 'Delete Scene',
  category: 'view',
  params: z.object({ id: idSchema }),
  undoable: true,
  run(ctx, p): void {
    const host = hostOf(ctx);
    host.edit('Delete Scene', (draft) => {
      sceneOf(draftState(draft), p.id);
      draft.scenes.delete(p.id as SceneId);
      draft.sceneOrder = draft.sceneOrder.filter((id) => id !== p.id);
    });
    const runtime = sceneRuntimeOf(ctx);
    if (runtime.activeSceneId === p.id) runtime.setActive(null);
  },
});

export const sceneRename = defineCommand({
  id: 'scene.rename',
  title: 'Rename Scene',
  category: 'view',
  params: z.object({ id: idSchema, name: z.string().min(1), description: z.string().optional() }),
  undoable: true,
  run(ctx, p): void {
    hostOf(ctx).edit('Rename Scene', (draft) => {
      const scene = sceneOf(draftState(draft), p.id);
      scene.name = p.name.trim() || scene.name;
      if (p.description !== undefined) scene.description = p.description;
    });
  },
});

export const sceneMove = defineCommand({
  id: 'scene.move',
  title: 'Move Scene',
  category: 'view',
  params: z.object({ id: idSchema, toIndex: z.number().int() }),
  undoable: true,
  run(ctx, p): number {
    return hostOf(ctx).edit('Move Scene', (draft) => {
      const order = draft.sceneOrder.filter((id) => id !== p.id);
      if (order.length === draft.sceneOrder.length) throw new PushFormError('scene.missing', `Scene ${p.id} not found`);
      const to = Math.max(0, Math.min(order.length, p.toIndex));
      order.splice(to, 0, p.id as SceneId);
      draft.sceneOrder = order;
      return to;
    });
  },
});

export const sceneSetIncludeInAnimation = defineCommand({
  id: 'scene.setIncludeInAnimation',
  title: 'Include Scene In Animation',
  category: 'view',
  params: z.object({ id: idSchema, value: z.boolean() }),
  undoable: true,
  run(ctx, p): void {
    hostOf(ctx).edit('Include in Animation', (draft) => {
      sceneOf(draftState(draft), p.id).includeInAnimation = p.value;
    });
  },
});

export const sceneActivate = defineCommand({
  id: 'scene.activate',
  title: 'Go To Scene',
  category: 'view',
  params: z.object({ id: idSchema, animate: z.boolean().optional() }),
  undoable: false,
  run(ctx, p): void {
    const host = hostOf(ctx);
    activateScene(ctx, host, sceneOf(host.doc.state, p.id), p.animate ?? true);
  },
});

export const sceneNext = defineCommand({
  id: 'scene.next',
  title: 'Next Scene',
  category: 'view',
  menu: 'View',
  params: z.object({ animate: z.boolean().optional() }),
  undoable: false,
  run(ctx, p): number | null {
    const host = hostOf(ctx);
    const scene = neighbor(host.doc.state, sceneRuntimeOf(ctx).activeSceneId, 1, false);
    if (!scene) return null;
    activateScene(ctx, host, scene, p.animate ?? true);
    return scene.id;
  },
});

export const scenePrevious = defineCommand({
  id: 'scene.previous',
  title: 'Previous Scene',
  category: 'view',
  menu: 'View',
  params: z.object({ animate: z.boolean().optional() }),
  undoable: false,
  run(ctx, p): number | null {
    const host = hostOf(ctx);
    const scene = neighbor(host.doc.state, sceneRuntimeOf(ctx).activeSceneId, -1, false);
    if (!scene) return null;
    activateScene(ctx, host, scene, p.animate ?? true);
    return scene.id;
  },
});

/** Start (or stop with `play: false`) cycling through the scenes included in the animation. */
export const scenePlay = defineCommand({
  id: 'scene.play',
  title: 'Play Animation',
  category: 'view',
  menu: 'View/Animation',
  params: z.object({ play: z.boolean().optional() }),
  undoable: false,
  run(ctx, p): boolean {
    const host = hostOf(ctx);
    const runtime = sceneRuntimeOf(ctx);
    const play = p.play ?? !runtime.playing;
    if (!play) {
      runtime.stop();
      return false;
    }
    const first = neighbor(host.doc.state, runtime.activeSceneId, 1, true);
    if (!first) return false;
    activateScene(ctx, host, first, true);
    runtime.play(() => {
      const next = neighbor(host.doc.state, runtime.activeSceneId, 1, true);
      if (!next) return false;
      activateScene(ctx, host, next, true);
      return true;
    });
    return true;
  },
});

export const sceneStop = defineCommand({
  id: 'scene.stop',
  title: 'Stop Animation',
  category: 'view',
  menu: 'View/Animation',
  params: z.object({}),
  undoable: false,
  run(ctx): void {
    sceneRuntimeOf(ctx).stop();
  },
});

export const sceneAnimationSettings = defineCommand({
  id: 'scene.animationSettings',
  title: 'Animation Settings',
  category: 'view',
  params: z.object({ transitionSeconds: z.number().min(0).max(60).optional(), delaySeconds: z.number().min(0).max(600).optional() }),
  undoable: false,
  run(ctx, p): AnimationSettings {
    const r = sceneRuntimeOf(ctx);
    const cur = r.animationSettings;
    r.setAnimationSettings({ transitionSeconds: p.transitionSeconds ?? cur.transitionSeconds, delaySeconds: p.delaySeconds ?? cur.delaySeconds });
    return r.animationSettings;
  },
});

export const sceneList = defineCommand({
  id: 'scene.list',
  title: 'Scenes',
  category: 'internal',
  params: z.object({}),
  undoable: false,
  run: (ctx): SceneInfo[] => sceneInfos(hostOf(ctx).doc.state, sceneRuntimeOf(ctx).activeSceneId),
});

export const sceneCommands: readonly AnyCommand[] = [
  sceneAdd,
  sceneUpdate,
  sceneDelete,
  sceneRename,
  sceneMove,
  sceneSetIncludeInAnimation,
  sceneActivate,
  sceneNext,
  scenePrevious,
  scenePlay,
  sceneStop,
  sceneAnimationSettings,
  sceneList,
];
