// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLayoutDocumentState, viewportSourceKey, type LayoutEntity, type LayoutViewportCamera } from '@pushform/layout';
import { openModelFile } from '@pushform/io';
import type * as NativeIO from '@pushform/io';
import type { ImageId } from '@pushform/core';
import { allocId, createDocument, ImageStore, DEFAULT_SHADOWS } from '@pushform/model';

const rendered = vi.hoisted(() => ({ snapshots: [] as [number, number][], previews: [] as [number, number][], ready: new Set<string>(),
  displays: [] as unknown[], shadows: [] as unknown[], texturesReady: vi.fn(async () => {}) }));

vi.mock('@pushform/io', () => ({
  readPreservedSketchUpModel: () => new Uint8Array(1),
  readSketchUpInWorker: async () => ({ scenes: [] }),
  applySketchUpImport: () => undefined,
  openModelFile: vi.fn(async (bytes: Uint8Array) => ({ images: new Map(), state: { images: new Map(), sceneOrder: [1], tags: new Map(),
    scenes: new Map([[1, { name: `Scene ${bytes.length}`, flags: { useCamera: true, useTags: false }, hiddenTags: [],
      camera: { eye: [1, 2, 3], target: [0, 0, 0], up: [0, 0, 1], perspective: false, fov: 35, height: 4 } }]]) } })),
}));
vi.mock('../engine/renderAdapter', () => ({
  bodiesToRender: () => [], sketchesToRender: () => [], imagesToRender: () => [], displayToRender: () => ({}),
  shadowsToRender: (state: { shadows: unknown }) => state.shadows,
  withRenderImageStore: (_images: unknown, run: () => unknown) => run(),
}));
vi.mock('../engine/sectionAdapter', () => ({ sectionsToRender: () => null }));
vi.mock('@pushform/render', () => ({
  Viewport: class {
    sceneSync = { textures: { whenReady: rendered.texturesReady } };
    mountOffscreen(): boolean { return true; }
    setBodies(): void {}
    setSketches(): void {}
    setImages(): void {}
    setSections(): void {}
    setDisplay(display: unknown): void { rendered.displays.push(display); }
    setShadows(shadows: unknown): void { rendered.shadows.push(shadows); }
    snapshot(width: number, height: number): string {
      rendered.snapshots.push([width, height]);
      return `data:image/png;base64,${rendered.snapshots.length}`;
    }
    snapshotInto(_target: HTMLCanvasElement, width: number, height: number): boolean {
      rendered.previews.push([width, height]);
      return true;
    }
  },
}));
vi.mock('./layoutImage', () => ({
  notifyLayoutImages: () => undefined,
  setLayoutCanvasPicture: (src: string) => rendered.ready.add(src),
  layoutImageReady: (src: string) => rendered.ready.has(src),
  forgetLayoutImage: (src: string) => rendered.ready.delete(src),
}));

const { layoutViewportPicture, layoutViewportModel, layoutViewportRender, layoutViewportFailure, setLayoutCloudModelLoader,
  retainLayoutViewportModels, peekLayoutViewportModel, settleLayoutViewportRenders, whenLayoutViewportRendersIdle } = await import('./layoutViewportRenders');

const camera: LayoutViewportCamera = { eye: [10, -10, 10], target: [0, 0, 0], up: [0, 0, 1], projection: 'perspective', fov: 35, scale: 1 };
let nextId = 1;
/** A 100 × 50 mm model view with no cached picture. */
function view(): LayoutEntity {
  return { id: nextId++, kind: 'image', layerId: 1, closed: true, points: [[0, 0], [100, 0], [100, 50], [0, 50]],
    image: { src: '', viewport: { source: { archiveId: 'a', modelReferenceId: 'm' }, templateId: 't', originalId: null, camera, scene: null, background: null, cache: null } } };
}
// Wait for the queue's own completion (model loading, identity hashes and rendering happen inside its drain): neither a
// timer tick nor a fixed deadline is a completion boundary under a loaded machine (PF-289).
const settle = () => whenLayoutViewportRendersIdle();
const state = createLayoutDocumentState();

it('keeps more than six live annotation sources across effect replacement and releases them after closing', async () => {
  const sources = Array.from({ length: 8 }, (_, index) => ({ archiveId: 'annotations', modelReferenceId: `model-${index}` }));
  const keys = sources.map(source => viewportSourceKey(state, source));
  const release = retainLayoutViewportModels(keys);
  const loaded = await Promise.all(sources.map(source => layoutViewportModel(state, source)));
  expect(sources.map(source => peekLayoutViewportModel(state, source))).toEqual(loaded);
  release();
  const releaseReplacement = retainLayoutViewportModels(keys);
  await Promise.resolve();
  expect(sources.map(source => peekLayoutViewportModel(state, source))).toEqual(loaded);
  const releaseOtherDocument = retainLayoutViewportModels(keys);
  releaseReplacement();
  await Promise.resolve();
  expect(sources.map(source => peekLayoutViewportModel(state, source))).toEqual(loaded);
  releaseOtherDocument();
  await Promise.resolve();
  expect(sources.filter(source => peekLayoutViewportModel(state, source))).toHaveLength(6);
});

beforeEach(() => { rendered.snapshots.length = 0; rendered.previews.length = 0; });

describe('Layout model view renders', () => {
  it('renders navigation previews at the on-screen resolution and paints each one without decoding', async () => {
    const entity = view(), orbit = { ...camera, eye: [12, -8, 10] as [number, number, number] };
    expect(layoutViewportPicture(state, entity, orbit, 9)).toBe('');
    await settle();
    expect(rendered.previews).toEqual([[900, 450]]);
    const preview = layoutViewportPicture(state, entity, orbit, 9);
    expect(preview).toMatch(/^pushform-viewport-preview:/);
    expect(rendered.ready.has(preview)).toBe(true);
  });

  it('keeps the previous picture until a committed render can paint', async () => {
    const entity = view(), orbit = { ...camera, eye: [12, -8, 10] as [number, number, number] };
    layoutViewportPicture(state, entity, orbit, 4);
    await settle();
    const preview = layoutViewportPicture(state, entity, orbit, 4);
    const committed = { ...entity, image: { ...entity.image!, viewport: { ...entity.image!.viewport!, camera: orbit } } };
    expect(layoutViewportPicture(state, committed, undefined, 4)).toBe(preview);
    await settle();
    expect(layoutViewportPicture(state, committed, undefined, 4)).toBe(preview);
    const picture = `data:image/png;base64,${rendered.snapshots.length}`;
    rendered.ready.add(picture);
    expect(layoutViewportPicture(state, committed, undefined, 4)).toBe(picture);
    // The committed picture frees the preview canvas.
    expect(rendered.ready.has(preview)).toBe(false);
  });

  it('settles the renders print needs as soon as the queue drains, within its deadline', async () => {
    // An 80 × 40 mm frame: a configuration of its own, so the later once-per-configuration test still renders its 100 mm views.
    const entity = { ...view(), points: [[0, 0], [80, 0], [80, 40], [0, 40]] as [number, number][] };
    const started = Date.now();
    await settleLayoutViewportRenders(state, [entity], 5_000);
    expect(rendered.snapshots).toEqual([[472, 236]]);
    // The wait ends with the render, not with the deadline.
    expect(Date.now() - started).toBeLessThan(5_000);
    await expect(whenLayoutViewportRendersIdle()).resolves.toBeUndefined();
  });

  it('renders committed views at 150 ppi, doubling it to keep up with a zoomed-in page, once per configuration', async () => {
    layoutViewportPicture(state, view());
    layoutViewportPicture(state, view(), undefined, 3);
    layoutViewportPicture(state, view(), undefined, 9);
    await settle();
    expect(rendered.snapshots.map(([width]) => width).sort((a, b) => a - b)).toEqual([591, 1181]);
  });

  it("draws a view with its own sun and shadows, else the model's", async () => {
    const shadows = { ...DEFAULT_SHADOWS, enabled: true, time: 10 * 60 + 42 };
    const display = { faceStyle: 'shaded' as const, edges: true, profiles: true, backEdges: false, xray: false, hiddenGeometry: false };
    const shadowed = view();
    shadowed.image!.viewport!.display = { ...display, shadows };
    layoutViewportPicture(state, shadowed);
    await settle();
    expect(rendered.shadows.at(-1)).toEqual(shadows);
    expect(rendered.displays.at(-1)).toEqual(display);
    layoutViewportPicture(state, { ...view(), points: [[0, 0], [90, 0], [90, 50], [0, 50]] });
    await settle();
    expect(rendered.shadows.at(-1)).toEqual(DEFAULT_SHADOWS);
  });
});

describe('Cloud model views', () => {
  const sha = 'a'.repeat(64), newer = 'b'.repeat(64);
  function cloudState() {
    const state = createLayoutDocumentState();
    state.references.set(5, { id: 5, displayName: 'House', target: { kind: 'cloud', documentId: 'doc-1', revisionId: 'rev-1', revisionNumber: 1, sha256: sha, pinned: false } });
    return state;
  }
  const cloudView = (): LayoutEntity => ({ id: nextId++, kind: 'image', layerId: 1, closed: true, points: [[0, 0], [100, 0], [100, 50], [0, 50]],
    image: { src: '', viewport: { source: { referenceId: 5 }, templateId: null, originalId: null, camera, scene: null, background: null, cache: null } } });

  it('loads actual native binary cloud revisions with their image bytes', async () => {
    const io = await vi.importActual<typeof NativeIO>('@pushform/io');
    const doc = createDocument(), images = new ImageStore();
    const pixels = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const asset = doc.transact('image', draft => {
      const id = allocId<ImageId>(draft);
      const asset = { id, name: 'tile.png', mime: 'image/png', width: 1, height: 1, sha256: 'fixture' };
      draft.images.set(id, asset); return asset;
    }).value;
    images.register(asset, pixels);
    const bytes = await io.encodeModelSnapshot(doc.state, io.modelArchiveImages(doc.state, images));
    expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe('PUSHFRM2');
    vi.mocked(openModelFile).mockImplementationOnce(io.openModelFile);
    const loader = vi.fn(async () => bytes);
    setLayoutCloudModelLoader(loader);
    const state = cloudState();
    state.references.get(5)!.target = { kind: 'cloud', documentId: 'binary-model', revisionId: 'binary-revision', revisionNumber: 1, sha256: 'd'.repeat(64), pinned: false };
    try {
      const model = await layoutViewportModel(state, { referenceId: 5 });
      expect(io.modelContentIdentity(model.state)).toBe(io.modelContentIdentity(doc.state));
      expect(model.images.get(asset.id)!.bytes).toEqual(pixels);
      expect(await layoutViewportModel(state, { referenceId: 5 })).toBe(model);
      expect(loader).toHaveBeenCalledTimes(1);
    } finally { setLayoutCloudModelLoader(null); }
  });

  it('fetches a cloud model only when a view needs it, at its referenced revision, and again after the reference moves on', async () => {
    const loader = vi.fn(async (target: { revisionId: string }) => new Uint8Array(target.revisionId === 'rev-1' ? 1 : 2));
    setLayoutCloudModelLoader(loader);
    const state = cloudState();
    const model = await layoutViewportModel(state, { referenceId: 5 });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader.mock.calls[0]![0]).toMatchObject({ revisionId: 'rev-1', sha256: sha });
    expect(model.scenes).toEqual([{ name: 'Scene 1', usesTags: false, hiddenTags: [], camera: { eye: [1, 2, 3], target: [0, 0, 0], up: [0, 0, 1], perspective: false, fov: 35, height: 4 } }]);
    await layoutViewportModel(state, { referenceId: 5 });
    expect(loader).toHaveBeenCalledTimes(1);
    state.references.get(5)!.target = { kind: 'cloud', documentId: 'doc-1', revisionId: 'rev-2', revisionNumber: 2, sha256: newer, pinned: false };
    expect((await layoutViewportModel(state, { referenceId: 5 })).scenes[0]!.name).toBe('Scene 2');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('reports a missing loader or reference instead of rendering, and recovers once cloud access returns', async () => {
    setLayoutCloudModelLoader(null);
    const state = cloudState();
    state.references.get(5)!.target = { kind: 'cloud', documentId: 'doc-2', revisionId: 'rev-9', revisionNumber: 9, sha256: 'c'.repeat(64), pinned: false };
    await expect(layoutViewportModel(state, { referenceId: 5 })).rejects.toThrow('Sign in');
    expect(layoutViewportFailure(state, { referenceId: 5 })).toMatch(/Sign in/);
    await expect(layoutViewportModel(state, { referenceId: 6 })).rejects.toThrow('reference is missing');
    setLayoutCloudModelLoader(async () => new Uint8Array(3));
    expect(layoutViewportFailure(state, { referenceId: 5 })).toBeNull();
    expect((await layoutViewportModel(state, { referenceId: 5 })).scenes[0]!.name).toBe('Scene 3');
  });

  it('provides a print-resolution render for the document stamped with the revision it shows', async () => {
    setLayoutCloudModelLoader(async () => new Uint8Array(1));
    const state = cloudState(), entity = cloudView();
    expect(layoutViewportRender(state, entity)).toBeNull();
    await settle();
    const render = layoutViewportRender(state, entity);
    expect(render).toMatchObject({ src: expect.stringMatching(/^data:image\/png/), cache: { camera, widthMm: 100, heightMm: 50, sha256: sha } });
    expect(rendered.snapshots.at(-1)).toEqual([591, 295]);
  });
});


it('PDF export renders at the requested dpi and returns that picture before browser decoding', async () => {
  const entity = view();
  entity.points = [[0, 0], [253, 0], [253, 50], [0, 50]];
  entity.image!.src = 'old-picture';
  layoutViewportPicture(state, entity, undefined, 300 / 25.4, true);
  await settle();
  expect(rendered.snapshots).toEqual([[2988, 591]]);
  expect(layoutViewportPicture(state, entity, undefined, 300 / 25.4, true)).toMatch(/^data:image\/png/);
});


it('waits for model textures before producing a committed page picture', async () => {
  let resolve!: () => void;
  rendered.texturesReady.mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
  const before = rendered.snapshots.length;
  const entity = view(); entity.points = [[0, 0], [177, 0], [177, 50], [0, 50]];
  layoutViewportPicture(state, entity);
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  expect(rendered.snapshots).toHaveLength(before);
  resolve(); await settle(); expect(rendered.snapshots).toHaveLength(before + 1);
});
