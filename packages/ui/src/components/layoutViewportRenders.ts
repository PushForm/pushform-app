// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Box3, Vec3, Guid } from '@pushform/core';
import { applySketchUpImport, openModelFile, readPreservedSketchUpModel, readSketchUpInWorker, type ImportedScene } from '@pushform/io';
import {
  isCloudReference, isCloudSource, isViewport, layoutFrameSize, viewportCacheCurrent, viewportCloudReference, viewportOrthoHeight, viewportSourceKey,
  type CloudModelReference, type LayoutDocumentState, type LayoutEntity, type LayoutViewport, type LayoutViewportCamera, type LayoutViewportDisplay,
} from '@pushform/layout';
import { createDocument, ImageStore, type DocumentState } from '@pushform/model';
import { Viewport, type CameraState, type RenderBody, type RenderDisplay, type RenderImage, type RenderSketch } from '@pushform/render';
import { bodiesToRender, displayToRender, imagesToRender, shadowsToRender, sketchesToRender, withRenderImageStore } from '../engine/renderAdapter';
import { sectionsToRender } from '../engine/sectionAdapter';
import { forgetLayoutImage, layoutImageReady, notifyLayoutImages, setLayoutCanvasPicture } from './layoutImage';
import { layoutEmbeddedModelIdentity } from './layoutEmbeddedModelIdentity';

/**
 * Raster renders of Layout model viewports. Renders are derived data kept outside the
 * document: they are keyed by model, camera, frame size and background, so a result can
 * never be shown for a different configuration, and finishing one adds no undo step.
 */

export interface LayoutViewportModel {
  scenes: ImportedScene[];
  /** World bounds of the drawn geometry, for standard views and zoom extents; null for an empty model. */
  bounds: Box3 | null;
  bodies: RenderBody[];
  sketches: RenderSketch[];
  /** Placed pictures. */
  pictures: RenderImage[];
  display: RenderDisplay;
  images: ImageStore;
  /** The model itself, for drawing it with a scene's tag visibility. */
  state: DocumentState;
}

export type LayoutViewportStatus = 'cached' | 'current' | 'rendering' | 'unavailable';

type Source = LayoutViewport['source'];
const sourceKey = viewportSourceKey;

/** Bytes of a cloud model revision; set by the app when cloud files are available. */
export type LayoutCloudModelLoader = (target: CloudModelReference['target']) => Promise<Uint8Array>;
let cloudLoader: LayoutCloudModelLoader | null = null;
export function setLayoutCloudModelLoader(loader: LayoutCloudModelLoader | null): void {
  cloudLoader = loader;
  // Models that failed because no loader was available can be tried again.
  for (const [key, reason] of failures) if (reason === NO_CLOUD) { failures.delete(key); models.delete(key); }
}
const NO_CLOUD = 'Sign in to render views of cloud models.';

/** Parsed models by source, most recently used last; a cloud model is fetched again after eviction. */
const models = new Map<string, Promise<LayoutViewportModel>>();
const loadedModels = new Map<string, LayoutViewportModel>();
const retainedModels = new Map<string, number>();
/** Live annotation sources stay available while their document is open, independently of the render LRU. */
export function retainLayoutViewportModels(keys: Iterable<string>): () => void {
  const retained = [...new Set(keys)];
  for (const key of retained) retainedModels.set(key, (retainedModels.get(key) ?? 0) + 1);
  return () => {
    for (const key of retained) {
      const count = retainedModels.get(key) ?? 0;
      if (count <= 1) retainedModels.delete(key); else retainedModels.set(key, count - 1);
    }
    // React replaces effect subscriptions synchronously; let the replacement retain its sources first.
    queueMicrotask(trimModels);
  };
}
/** Synchronous access only to the revision this drawing currently references. */
export function peekLayoutViewportModel(state: LayoutDocumentState, source: Source): LayoutViewportModel | undefined {
  return loadedModels.get(sourceKey(state, source));
}
const MODEL_LIMIT = 6;
function trimModels(): void {
  while (models.size > MODEL_LIMIT) {
    const oldest = [...models.keys()].find(key => !retainedModels.has(key));
    if (oldest === undefined) break;
    models.delete(oldest); loadedModels.delete(oldest);
  }
}
const failures = new Map<string, string>();
/** Finished renders by configuration key, most recent last; '' marks a render that failed. */
const renders = new Map<string, string>();
const RENDER_LIMIT = 48;
/** Committed views render at least at print resolution, up to this many pixels on the longer side. */
const PRINT_PX_PER_MM = 150 / 25.4, RENDER_MAX_PX = 2400;
/** Navigation previews render at the view's on-screen size, up to this many pixels on the longer side. */
const PREVIEW_PX_PER_MM = 72 / 25.4, PREVIEW_MAX_PX = 2048;
/** The last picture each viewport showed, so a stale picture stays up while the next renders. */
const latest = new Map<number, string>();
/**
 * Navigation previews, drawn into one canvas per viewport rather than encoded, so each frame paints
 * at once without a decode; `key` is the configuration the canvas shows.
 */
const previews = new Map<number, { key: string; src: string; canvas: HTMLCanvasElement }>();
let previewSerial = 0;
interface Job {
  key: string; entityId: number; preview: boolean; state: LayoutDocumentState; source: Source; camera: CameraState; shift: readonly [number, number] | undefined;
  width: number; height: number; background: string | null; scene: string | null; display: LayoutViewportDisplay | undefined;
}
const queue: Job[] = [];
let running = false;
let offscreen: Viewport | null | undefined;

/** The model a viewport shows, parsed once per embedded source. Rejects when it is not embedded or cannot be read. */
export function layoutViewportModel(state: LayoutDocumentState, source: Source): Promise<LayoutViewportModel> {
  const key = sourceKey(state, source);
  let model = models.get(key);
  if (model) { models.delete(key); models.set(key, model); return model; }
  model = isCloudSource(source) ? loadCloudModel(state, source) : loadEmbeddedModel(state, source);
  model.catch(error => { failures.set(key, error instanceof Error ? error.message : String(error)); notifyLayoutImages(); });
  models.set(key, model);
  const pending = model;
  void model.then(result => {
    if (models.get(key) !== pending) return;
    loadedModels.set(key, result); notifyLayoutImages();
  }, () => {});
  trimModels();
  return model;
}

async function loadEmbeddedModel(state: LayoutDocumentState, source: { archiveId: string; modelReferenceId: string }): Promise<LayoutViewportModel> {
  const bytes = readPreservedSketchUpModel(state, source.archiveId, source.modelReferenceId);
  if (!bytes) throw new Error('The model is linked to an external file that is not embedded in this document.');
  const scene = await readSketchUpInWorker(bytes);
  const doc = createDocument(), images = new ImageStore();
  doc.transact('Open SketchUp model', draft => {
    applySketchUpImport(draft, scene, { images });
  });
  const identity = await layoutEmbeddedModelIdentity(doc.state, bytes);
  doc.transact('Identify embedded conversion', draft => {
    draft.meta.guid = `embedded:${source.archiveId}:${source.modelReferenceId}:${identity}` as Guid;
  });
  return renderable(doc.state, images, scene.scenes);
}

/** A cloud model is fetched only when a view needs rendering, at the revision its reference names. */
async function loadCloudModel(state: LayoutDocumentState, source: { referenceId: number }): Promise<LayoutViewportModel> {
  const reference = viewportCloudReference(state, source);
  if (!reference) throw new Error('The model reference is missing from this document.');
  if (!cloudLoader) throw new Error(NO_CLOUD);
  const bytes = await cloudLoader(reference.target);
  const { state: modelState, images: blobs } = await openModelFile(bytes);
  const images = new ImageStore();
  for (const [id, blob] of blobs) {
    const asset = modelState.images.get(id);
    if (asset) images.register(asset, blob.bytes, blob.mime);
  }
  return renderable(modelState, images, modelScenes(modelState));
}

function renderable(state: DocumentState, images: ImageStore, scenes: ImportedScene[]): LayoutViewportModel {
  const { bodies, sketches } = withRenderImageStore(images, () => ({ bodies: bodiesToRender(state), sketches: sketchesToRender(state) }));
  return { scenes, bounds: bodyBounds(bodies), bodies, sketches, pictures: imagesToRender(state, images), display: displayToRender(state), images, state };
}

const sceneGeometry = new WeakMap<LayoutViewportModel, Map<string, { bodies: RenderBody[]; sketches: RenderSketch[]; pictures: RenderImage[] }>>();
/**
 * The geometry a view of `scene` shows: with the scene's tag visibility when the scene saves tags, else the model's own.
 */
export function viewGeometry(model: LayoutViewportModel, scene: string | null): { bodies: RenderBody[]; sketches: RenderSketch[]; pictures: RenderImage[] } {
  const saved = scene === null ? undefined : model.scenes.find(candidate => candidate.name === scene);
  if (!saved?.usesTags) return model;
  let byScene = sceneGeometry.get(model);
  if (!byScene) sceneGeometry.set(model, byScene = new Map());
  const cached = byScene.get(saved.name);
  if (cached) return cached;
  const hidden = new Set(saved.hiddenTags);
  const tags = new Map([...model.state.tags].map(([id, tag]) => [id, { ...tag, visible: !hidden.has(tag.name) }]));
  const state = { ...model.state, tags };
  const geometry = { ...withRenderImageStore(model.images, () => ({ bodies: bodiesToRender(state), sketches: sketchesToRender(state) })),
    pictures: imagesToRender(state, model.images) };
  byScene.set(saved.name, geometry);
  return geometry;
}

/** A PushForm model's scenes in the shape the view camera helpers read (same as an imported SketchUp scene). */
function modelScenes(state: DocumentState): ImportedScene[] {
  return state.sceneOrder.flatMap(id => {
    const scene = state.scenes.get(id);
    if (!scene) return [];
    const camera = scene.camera;
    return [{ name: scene.name, usesTags: scene.flags.useTags,
      hiddenTags: scene.hiddenTags.flatMap(tagId => { const tag = state.tags.get(tagId); return tag ? [tag.name] : []; }),
      camera: scene.flags.useCamera ? { eye: camera.eye, target: camera.target, up: camera.up, perspective: camera.perspective, fov: camera.fov, height: camera.height } : null }];
  });
}

export interface LayoutViewportSource { key: string; source: Source; name: string }

/**
 * Models a new view can show: the document's cloud model references, and embedded models
 * with an imported view whose settings a new view keeps.
 */
export function layoutViewportSources(state: LayoutDocumentState): LayoutViewportSource[] {
  const sources: LayoutViewportSource[] = [];
  for (const reference of state.references.values()) {
    if (isCloudReference(reference)) sources.push({ key: `reference:${reference.id}`, source: { referenceId: reference.id }, name: reference.displayName });
  }
  for (const [archiveId, archive] of state.modelArchives ?? []) {
    const viewed = new Set([...archive.viewports.values()].map(record => record.modelReferenceId));
    for (const [modelReferenceId, model] of archive.models) {
      if (!model.internalTarget || !viewed.has(modelReferenceId)) continue;
      const file = (model.externalTarget || model.internalTarget).split(/[\\/]/).pop() ?? modelReferenceId;
      // LayOut stores embedded copies as ref/<hash>_<name>_<id>.skp; an external path names the original.
      const name = model.externalTarget ? file : file.replace(/^\d+_/, '').replace(/_\d+(\.skp)$/i, '$1');
      sources.push({ key: sourceKey(state, { archiveId, modelReferenceId }), source: { archiveId, modelReferenceId }, name: name.replace(/\.skp$/i, '') });
    }
  }
  return sources;
}

/** Why a viewport's model cannot be rendered, or null. */
export function layoutViewportFailure(state: LayoutDocumentState, source: Source): string | null {
  return failures.get(sourceKey(state, source)) ?? null;
}

/** The renderer's camera for a viewport camera across a frame `heightMm` tall. */
export function viewportCameraState(camera: LayoutViewportCamera, heightMm: number): CameraState {
  return { eye: camera.eye, target: camera.target, up: camera.up, fov: camera.fov, projection: camera.projection,
    orthoHeight: camera.projection === 'parallel' ? viewportOrthoHeight(camera, heightMm) : 1 };
}

/**
 * The picture to paint for a viewport now: LayOut's cached render while it still matches, else a
 * render of this configuration (requested if needed), showing the previous picture until it arrives.
 * `camera` previews a camera that is not yet in the document (navigation). `pxPerMm` is
 * the resolution the picture is painted at, so previews match the screen and committed views stay
 * sharp when zoomed in; without it views render for print.
 */
export function layoutViewportPicture(state: LayoutDocumentState, entity: LayoutEntity, camera?: LayoutViewportCamera, pxPerMm?: number, exportResolution = false): string {
  if (!isViewport(entity)) return entity.image?.src ?? '';
  const viewport = entity.image.viewport;
  const view = camera ?? viewport.camera;
  if (!camera && !exportResolution && entity.image.src && viewportCacheCurrent(viewport, entity.points, state)) return entity.image.src;
  const fallback = latest.get(entity.id) ?? entity.image.src;
  if (failures.has(sourceKey(state, viewport.source))) return fallback;
  const { width, height } = layoutFrameSize(entity.points);
  if (width <= 0 || height <= 0) return fallback;
  const scale = camera
    ? Math.min(pxPerMm ?? PREVIEW_PX_PER_MM, PREVIEW_MAX_PX / Math.max(width, height))
    : exportResolution ? Math.min(pxPerMm ?? PRINT_PX_PER_MM, 16384 / Math.max(width, height)) : Math.min(committedPxPerMm(pxPerMm), RENDER_MAX_PX / Math.max(width, height));
  const pixels = [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))] as const;
  const key = JSON.stringify([sourceKey(state, viewport.source), view, pixels, viewport.background, viewport.scene, viewport.display ?? null]);
  const preview = previews.get(entity.id);
  if (camera && preview?.key === key) return preview.src;
  const done = camera ? undefined : renders.get(key);
  if (done !== undefined) {
    if (exportResolution) {
      if (!done) throw new Error('A model view could not be rendered at the chosen PDF resolution.');
      return done;
    }
    // A new picture replaces the previous one only once it can paint, so the view never blanks.
    if (done && layoutImageReady(done)) {
      showPicture(entity.id, done);
      return done;
    }
    if (!done) return fallback;
    return fallback && layoutImageReady(fallback) ? fallback : done;
  }
  enqueue({ key, entityId: entity.id, preview: !!camera, state, source: viewport.source, camera: viewportCameraState(view, height),
    shift: view.shift, width: pixels[0], height: pixels[1], background: viewport.background, scene: viewport.scene, display: viewport.display });
  return fallback;
}

/**
 * The finished print-resolution render of a cloud view for its current camera, frame and model
 * revision, to be stored in the document as its picture; requests it when missing.
 */
export function layoutViewportRender(state: LayoutDocumentState, entity: LayoutEntity): { src: string; cache: NonNullable<LayoutViewport['cache']> } | null {
  if (!isViewport(entity)) return null;
  const viewport = entity.image.viewport;
  const reference = viewportCloudReference(state, viewport.source);
  if (!reference || failures.has(sourceKey(state, viewport.source))) return null;
  const { width, height } = layoutFrameSize(entity.points);
  if (width <= 0 || height <= 0) return null;
  const scale = Math.min(PRINT_PX_PER_MM, RENDER_MAX_PX / Math.max(width, height));
  const pixels = [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))] as const;
  const key = JSON.stringify([sourceKey(state, viewport.source), viewport.camera, pixels, viewport.background, viewport.scene, viewport.display ?? null]);
  const done = renders.get(key);
  if (done) return { src: done, cache: { camera: viewport.camera, widthMm: width, heightMm: height, sha256: reference.target.sha256 } };
  if (done === undefined) enqueue({ key, entityId: entity.id, preview: false, state, source: viewport.source, camera: viewportCameraState(viewport.camera, height),
    shift: viewport.camera.shift, width: pixels[0], height: pixels[1], background: viewport.background, scene: viewport.scene, display: viewport.display });
  return null;
}

/** Print resolution, or the next doubling of it that keeps up with the screen (few distinct renders while zooming). */
function committedPxPerMm(pxPerMm: number | undefined): number {
  if (!pxPerMm || pxPerMm <= PRINT_PX_PER_MM) return PRINT_PX_PER_MM;
  return PRINT_PX_PER_MM * 2 ** Math.ceil(Math.log2(pxPerMm / PRINT_PX_PER_MM));
}

/** Records the picture a viewport now shows; a committed picture frees that viewport's preview canvas. */
function showPicture(entityId: number, src: string): void {
  latest.set(entityId, src);
  const preview = previews.get(entityId);
  if (preview && preview.src !== src) {
    previews.delete(entityId);
    forgetLayoutImage(preview.src);
  }
}

/** Resolves when the queue has drained: the rendering's own completion, not a timer (settled by `drain`). */
let idle: Promise<void> = Promise.resolve();
let settleIdle: (() => void) | null = null;

/**
 * Resolves once no render is running and none is queued, including the model loading a render waits for. Already
 * resolved while nothing is queued; a request made after that gets a new promise. For print, export and tests.
 */
export function whenLayoutViewportRendersIdle(): Promise<void> { return idle; }

/** Resolves once the renders these viewports need have finished, so print shows current views. */
export async function settleLayoutViewportRenders(state: LayoutDocumentState, entities: readonly LayoutEntity[], timeoutMs = 60_000, exportDpi?: number): Promise<void> {
  for (const entity of entities) if (isViewport(entity)) layoutViewportPicture(state, entity, undefined, exportDpi === undefined ? undefined : exportDpi / 25.4, exportDpi !== undefined);
  const deadline = Date.now() + timeoutMs;
  // Wake on the queue's own completion; the deadline only bounds a render that never finishes.
  while ((running || queue.length) && Date.now() < deadline) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([idle, new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now())); })]);
    clearTimeout(timer);
  }
  if (exportDpi !== undefined) {
    if (running || queue.length) throw new Error('Model views are still rendering. Try exporting again.');
    for (const entity of entities) if (isViewport(entity)) {
      const failure = layoutViewportFailure(state, entity.image.viewport.source);
      if (failure) throw new Error(`A model view could not be rendered for PDF export: ${failure}`);
    }
  }
}

/** What the viewport currently shows, for its status in the selection panel. */
export function layoutViewportStatus(state: LayoutDocumentState, entity: LayoutEntity): LayoutViewportStatus {
  if (!isViewport(entity)) return 'current';
  const viewport = entity.image.viewport;
  if (failures.has(sourceKey(state, viewport.source))) return 'unavailable';
  if (entity.image.src && viewportCacheCurrent(viewport, entity.points, state)) return 'cached';
  return queue.some(job => job.entityId === entity.id) || running && current?.entityId === entity.id ? 'rendering' : 'current';
}

let current: Job | null = null;

function enqueue(job: Job): void {
  const same = (other: Job | null | undefined) => other?.key === job.key && other.preview === job.preview;
  if (queue.some(same) || same(current)) return;
  // Only the newest preview of a viewport matters, and none once its camera is committed.
  for (let index = queue.length - 1; index >= 0; index--) {
    if (queue[index]!.entityId === job.entityId && queue[index]!.preview) queue.splice(index, 1);
  }
  queue.push(job);
  if (!running) {
    idle = new Promise(resolve => { settleIdle = resolve; });
    void drain();
  }
}

async function drain(): Promise<void> {
  running = true;
  try {
    while (queue.length) {
      const job = queue.pop()!;
      current = job;
      let picture = '';
      try {
        const model = await layoutViewportModel(job.state, job.source);
        const view = renderer();
        if (view) {
          const geometry = viewGeometry(model, job.scene);
          withRenderImageStore(model.images, () => { view.setBodies(geometry.bodies); view.setSketches(geometry.sketches); });
          view.setImages(geometry.pictures);
          view.setSections(sectionsToRender(model.state));
          const { shadows, ...display }: Partial<LayoutViewportDisplay> = job.display ?? {};
          view.setDisplay({ ...model.display, ...display });
          // The view's own sun and shadows, else the model's.
          view.setShadows(shadowsToRender(shadows ? { ...model.state, shadows } : model.state));
          if (!job.preview) {
            const urls = [...model.images.entries()].map(([id]) => model.images.objectUrl(id)).filter((url): url is string => !!url);
            await view.sceneSync.textures.whenReady(30_000, urls);
          }
          const opts = { shift: job.shift, background: job.background };
          if (job.preview) {
            const preview = previews.get(job.entityId) ?? previewCanvas(job.entityId);
            if (view.snapshotInto(preview.canvas, job.width, job.height, job.camera, opts)) {
              preview.key = job.key;
              picture = preview.src;
            }
          } else picture = view.snapshot(job.width, job.height, job.camera, opts);
        }
      } catch { /* The failure is recorded per model; the viewport keeps its previous picture. */ }
      if (!job.preview) remember(job.key, picture);
      // A committed render takes over once decoded (layoutViewportPicture); a preview paints at once.
      if (picture && (job.preview || layoutImageReady(picture))) showPicture(job.entityId, picture);
      current = null;
      notifyLayoutImages();
    }
  } finally {
    running = false;
    current = null;
    settleIdle?.();
    settleIdle = null;
  }
}

function previewCanvas(entityId: number): { key: string; src: string; canvas: HTMLCanvasElement } {
  const preview = { key: '', src: `pushform-viewport-preview:${entityId}:${++previewSerial}`, canvas: document.createElement('canvas') };
  setLayoutCanvasPicture(preview.src, preview.canvas);
  previews.set(entityId, preview);
  return preview;
}

function remember(key: string, picture: string): void {
  renders.delete(key);
  renders.set(key, picture);
  while (renders.size > RENDER_LIMIT) {
    const [evicted, src] = renders.entries().next().value!;
    renders.delete(evicted);
    if (src && ![...latest.values()].includes(src)) forgetLayoutImage(src);
  }
}

function renderer(): Viewport | null {
  if (offscreen === undefined) {
    const view = new Viewport({ grid: false });
    offscreen = view.mountOffscreen() ? view : null;
    // A texture that finishes loading after a render makes that model's renders stale.
    if (offscreen) offscreen.sceneSync.textures.onLoad = () => { renders.clear(); notifyLayoutImages(); };
  }
  return offscreen;
}

function bodyBounds(bodies: readonly RenderBody[]): Box3 | null {
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const body of bodies) {
    const m = body.transform, v = body.mesh.verts;
    for (let i = 0; i < v.length; i += 3) {
      const x = v[i]!, y = v[i + 1]!, z = v[i + 2]!;
      const p: Vec3 = [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!];
      for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k]!, p[k]!); max[k] = Math.max(max[k]!, p[k]!); }
    }
  }
  return Number.isFinite(min[0]) ? { min, max } : null;
}
