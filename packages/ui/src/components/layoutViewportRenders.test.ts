// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLayoutDocumentState, viewportSourceKey, type LayoutEntity, type LayoutViewportCamera } from '@pushform/layout';
import { openModelFile } from '@pushform/io';
import type * as NativeIO from '@pushform/io';
import type { ImageId } from '@pushform/core';
import { allocId, createDocument, ImageStore, DEFAULT_SHADOWS } from '@pushform/model';

const rendered = vi.hoisted(() => ({ snapshots: [] as [number, number][], previews: [] as [number, number][], ready: new Set<string>(),
  displays: [] as unknown[], shadows: [] as unknown[], fog: [] as unknown[], texturesReady: vi.fn(async () => {}), failure: null as string | null,
  /** Models loaded while this is set have nothing in them. */
  empty: false, sections: { planes: [], cuts: [] } as { planes: { id: string; sheet?: string }[]; cuts: { key: string }[] }, drawnSections: [] as unknown[],
  read: vi.fn(async (_bytes: Uint8Array, _options?: unknown): Promise<unknown> => ({ scenes: [] })) }));

vi.mock('@pushform/io', () => ({
  readPreservedSketchUpModel: (_state: unknown, _archive: string, model: string) => model === 'linked' ? null : new Uint8Array(1),
  readSketchUpInWorker: rendered.read,
  applySketchUpImport: () => undefined,
  openModelFile: vi.fn(async (bytes: Uint8Array) => bytes.length === 7 ? { images: new Map(), state: {
    // A model cut by plane 1, with a plan scene that keeps that cut and a section scene that cuts with plane 2.
    images: new Map(), styles: new Map([[1, { modeling: { sectionCutsVisible: true } }]]), activeStyleId: 1, tags: new Map(), rootDefinitionId: 1, sceneOrder: [1, 2],
    definitions: new Map([[1, { id: 1, entities: { sectionPlanes: new Map([[1, {}], [2, {}]]), activeSectionPlaneId: 1 } }]]),
    scenes: new Map([[1, { name: 'Plan', flags: { useCamera: true, useTags: false, useSectionPlanes: false }, hiddenTags: [], activeSectionPlanes: [], camera: {} }],
      [2, { name: 'Section B', flags: { useCamera: true, useTags: false, useSectionPlanes: true }, hiddenTags: [], activeSectionPlanes: [2], camera: {} }]]) } }
    : { images: new Map(), state: { images: new Map(), styles: new Map(), sceneOrder: [1], tags: new Map(),
    scenes: new Map([[1, { name: `Scene ${bytes.length}`, flags: { useCamera: true, useTags: false }, hiddenTags: [],
      camera: { eye: [1, 2, 3], target: [0, 0, 0], up: [0, 0, 1], perspective: false, fov: 35, height: 4 } }]]) } }),
}));
vi.mock('../engine/renderAdapter', () => ({
  bodiesToRender: () => [], sketchesToRender: () => rendered.empty ? [] : [{}], imagesToRender: () => [], displayToRender: () => ({}),
  shadowsToRender: (state: { shadows: unknown }) => state.shadows,
  fogToRender: () => ({ enabled: true, near: 1, far: 20, color: '#eeece6' }),
  withRenderImageStore: (_images: unknown, run: () => unknown) => run(),
}));
vi.mock('../engine/sectionAdapter', () => ({
  // A model with definitions draws both its planes and cuts with its root's active plane.
  sectionsToRender: (state: { definitions?: Map<number, { entities: { activeSectionPlaneId: number | null } }>; activeStyleId?: number;
    styles: Map<number, { modeling: { sectionCutsVisible: boolean } }> }) => {
    if (!state.definitions) return rendered.sections;
    const active = state.styles.get(state.activeStyleId!)!.modeling.sectionCutsVisible ? state.definitions.get(1)!.entities.activeSectionPlaneId : null;
    return { planes: [{ id: '/1' }, { id: '/2' }], cuts: active === null ? [] : [{ key: `/${active}` }] };
  },
}));
vi.mock('@pushform/render', () => ({
  Viewport: class {
    sceneSync = { textures: { whenReady: rendered.texturesReady }, sections: { ready: Promise.resolve() } };
    mountOffscreen(): boolean { return true; }
    setBodies(): void {}
    setSketches(): void {}
    setImages(): void {}
    setSections(sections: unknown): void { rendered.drawnSections.push(sections); }
    setDisplay(display: unknown): void { rendered.displays.push(display); }
    setShadows(shadows: unknown): void { rendered.shadows.push(shadows); }
    setFog(fog: unknown): void { rendered.fog.push(fog); }
    setEnvironment(): void {}
    environmentReady = Promise.resolve();
    snapshot(width: number, height: number): string {
      if (rendered.failure) throw new Error(rendered.failure);
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
  LAYOUT_VIEW_EMPTY: 'pushform-view:empty',
  LAYOUT_VIEW_FAILED: 'pushform-view:failed',
  notifyLayoutImages: () => undefined,
  setLayoutCanvasPicture: (src: string) => rendered.ready.add(src),
  layoutImageReady: (src: string) => rendered.ready.has(src),
  forgetLayoutImage: (src: string) => rendered.ready.delete(src),
}));

const { layoutViewportPicture, layoutViewportModel, layoutViewportRender, layoutViewportFailure, layoutViewportProblem, layoutViewportStatus,
  layoutViewportWarnings, setLayoutCloudModelLoader,
  retainLayoutViewportModels, peekLayoutViewportModel, settleLayoutViewportRenders, whenLayoutViewportRendersIdle } = await import('./layoutViewportRenders');

const camera: LayoutViewportCamera = { eye: [10, -10, 10], target: [0, 0, 0], up: [0, 0, 1], projection: 'perspective', fov: 35, scale: 1 };
let nextId = 1;
/** A 100 × 50 mm model view with no cached picture. */
function view(): LayoutEntity {
  return { id: nextId++, kind: 'image', layerId: 1, closed: true, points: [[0, 0], [100, 0], [100, 50], [0, 50]],
    image: { src: '', viewport: { source: { archiveId: 'a', modelReferenceId: 'm' }, templateId: 't', originalId: null, camera, scene: null, background: null, cache: null } } };
}
// Wait for the queue's own completion (model loading, identity hashes and rendering happen inside its drain): neither a
// timer tick nor a fixed deadline is a completion boundary under a loaded machine.
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

  it('paints nothing for a view whose model shows nothing, without rendering it, and reports it as such', async () => {
    const entity = { ...view(), points: [[0, 0], [70, 0], [70, 40], [0, 40]] as [number, number][] };
    entity.image!.viewport!.source = { archiveId: 'a', modelReferenceId: 'empty' };
    rendered.empty = true;
    try {
      // Not rendered yet: the loading placeholder.
      expect(layoutViewportPicture(state, entity)).toBe('');
      await settle();
    } finally { rendered.empty = false; }
    // The model is read even though it has nothing in it.
    expect(rendered.read).toHaveBeenLastCalledWith(expect.anything(), { allowEmpty: true });
    expect(rendered.snapshots).toEqual([]);
    expect(layoutViewportPicture(state, entity)).toBe('pushform-view:empty');
    expect(layoutViewportPicture(state, entity, undefined, 300 / 25.4, true)).toBe('pushform-view:empty');
    expect(layoutViewportPicture(state, entity, { ...camera, eye: [5, 5, 5] }, 4)).toBe('pushform-view:empty');
    expect(layoutViewportStatus(state, entity)).toBe('empty');
    await settleLayoutViewportRenders(state, [entity], 5_000, 300);
    expect(rendered.snapshots).toEqual([]);
  });

  it('marks a view that cannot be rendered as failed, unless it has an earlier picture to keep', async () => {
    rendered.read.mockRejectedValueOnce(new Error('The model could not be read.'));
    const entity = view();
    entity.image!.viewport!.source = { archiveId: 'a', modelReferenceId: 'unreadable' };
    expect(layoutViewportPicture(state, entity)).toBe('');
    await settle();
    expect(layoutViewportPicture(state, entity)).toBe('pushform-view:failed');
    expect(layoutViewportStatus(state, entity)).toBe('unavailable');
    const pictured = { ...entity, id: nextId++, image: { ...entity.image!, src: 'saved-picture' } };
    expect(layoutViewportPicture(state, pictured)).toBe('saved-picture');
  });

  it("draws the model's fog", async () => {
    layoutViewportPicture(state, view());
    await settle();
    expect(rendered.fog.at(-1)).toEqual({ enabled: true, near: 1, far: 20, color: '#eeece6' });
  });
});

describe('Model views that cannot be rendered', () => {
  it('reports a view whose model is not embedded, once per reason', async () => {
    const linked = (): LayoutEntity => { const entity = view(); entity.image!.viewport!.source = { archiveId: 'a', modelReferenceId: 'linked' }; return entity; };
    const views = [linked(), linked(), view()];
    await settleLayoutViewportRenders(state, views);
    expect(layoutViewportStatus(state, views[0]!)).toBe('unavailable');
    expect(layoutViewportProblem(state, views[2]!)).toBeNull();
    expect(layoutViewportWarnings(state, views)).toEqual([
      '2 model views could not be rendered: The model is linked to an external file that is not embedded in this document.']);
    expect(layoutViewportPicture(state, views[0]!)).toBe('pushform-view:failed');
    // PDF export goes ahead without their pictures (reporting them) instead of refusing.
    await expect(settleLayoutViewportRenders(state, views, 5_000, 150)).resolves.toBeUndefined();
    expect(layoutViewportPicture(state, views[0]!, undefined, 150 / 25.4, true)).toBe('pushform-view:failed');
  });

  it('reports a failed render until a render of the view succeeds', async () => {
    // A frame size no other test renders, so the render is not already finished.
    const entity = { ...view(), points: [[0, 0], [91, 0], [91, 47], [0, 47]] as [number, number][] };
    rendered.failure = 'Out of graphics memory';
    try {
      await settleLayoutViewportRenders(state, [entity]);
    } finally {
      rendered.failure = null;
    }
    expect(layoutViewportStatus(state, entity)).toBe('unavailable');
    expect(layoutViewportWarnings(state, [entity])).toEqual(['A model view could not be rendered: Out of graphics memory']);
    expect(layoutViewportPicture(state, entity)).toBe('pushform-view:failed');
    entity.points = [[0, 0], [93, 0], [93, 47], [0, 47]];
    await settleLayoutViewportRenders(state, [entity]);
    expect(layoutViewportProblem(state, entity)).toBeNull();
    expect(layoutViewportStatus(state, entity)).toBe('current');
  });

  it('does not report a view showing its current saved render', () => {
    const entity = view();
    entity.image!.src = 'data:image/png;base64,saved';
    entity.image!.viewport!.source = { archiveId: 'a', modelReferenceId: 'linked' };
    entity.image!.viewport!.cache = { camera, widthMm: 100, heightMm: 50 };
    expect(layoutViewportProblem(state, entity)).toBeNull();
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

  it('numbers section markers with the first page showing the model, and stamps the picture with that sheet', async () => {
    setLayoutCloudModelLoader(async () => new Uint8Array(6));
    const state = cloudState(), entity = cloudView();
    state.references.get(5)!.target = { kind: 'cloud', documentId: 'sections', revisionId: 'rev-6', revisionNumber: 6, sha256: '6'.repeat(64), pinned: false };
    const page = state.pages.get(state.pageOrder[0]!)!;
    page.entities.set(entity.id, entity); page.entityOrder.push(entity.id);
    rendered.sections = { planes: [{ id: '/1' }, { id: '/2' }], cuts: [{ key: '/1' }] };
    try {
      // The model is loaded by the first render; the next one knows its section planes and draws the sheet.
      expect(layoutViewportRender(state, entity)).toBeNull();
      await settle();
      expect(layoutViewportRender(state, entity)).toBeNull();
      await settle();
      // only the plane that cuts is drawn on the sheet
      expect(rendered.drawnSections.at(-1)).toEqual({ planes: [{ id: '/1', sheet: '1' }, { id: '/2' }], cuts: [{ key: '/1' }] });
      expect(layoutViewportRender(state, entity)).toMatchObject({ cache: { sha256: '6'.repeat(64), sheet: '[[null,null,"1"]]' } });
    } finally { rendered.sections = { planes: [], cuts: [] }; }
  });

  it('records no sheet for a picture of a model whose planes cut no view', async () => {
    setLayoutCloudModelLoader(async () => new Uint8Array(8));
    const state = cloudState(), entity = cloudView();
    state.references.get(5)!.target = { kind: 'cloud', documentId: 'uncut', revisionId: 'rev-8', revisionNumber: 8, sha256: '8'.repeat(64), pinned: false };
    const page = state.pages.get(state.pageOrder[0]!)!;
    page.entities.set(entity.id, entity); page.entityOrder.push(entity.id);
    rendered.sections = { planes: [{ id: '/2' }], cuts: [] };
    try {
      layoutViewportRender(state, entity);
      await settle();
      expect(rendered.drawnSections.at(-1)).toEqual({ planes: [{ id: '/2' }], cuts: [] });
      expect(layoutViewportRender(state, entity)!.cache).not.toHaveProperty('sheet');
    } finally { rendered.sections = { planes: [], cuts: [] }; }
  });

  it("numbers every plane's markers with the first page whose view cuts with it", async () => {
    setLayoutCloudModelLoader(async () => new Uint8Array(7));
    const state = cloudState();
    state.references.get(5)!.target = { kind: 'cloud', documentId: 'scenes', revisionId: 'rev-7', revisionNumber: 7, sha256: '7'.repeat(64), pinned: false };
    const plan = cloudView(), section = cloudView();
    plan.image!.viewport!.scene = 'Plan';
    section.image!.viewport!.scene = 'Section B';
    const second = 9;
    state.pages.set(second, { ...state.pages.get(state.pageOrder[0]!)!, id: second, name: 'Sections', entities: new Map(), entityOrder: [] });
    state.pageOrder.push(second);
    for (const [pageId, entity] of [[state.pageOrder[0]!, plan], [second, section]] as const) {
      const page = state.pages.get(pageId)!;
      page.entities.set(entity.id, entity); page.entityOrder.push(entity.id);
    }
    const drawn = async (entity: LayoutEntity) => {
      layoutViewportRender(state, entity);
      await settle();
      layoutViewportRender(state, entity);
      await settle();
      return rendered.drawnSections.at(-1);
    };
    // The plan keeps the model's cut, plane 1; its markers name page 1 for plane 1 and page 2, where the section view
    // cuts with it, for plane 2. The section view's markers name the same pages.
    expect(await drawn(plan)).toEqual({ planes: [{ id: '/1', sheet: '1' }, { id: '/2', sheet: '2' }], cuts: [{ key: '/1' }] });
    expect(await drawn(section)).toEqual({ planes: [{ id: '/1', sheet: '1' }, { id: '/2', sheet: '2' }], cuts: [{ key: '/2' }] });
    expect(layoutViewportRender(state, plan)!.cache.sheet).toBe('[["Plan",null,"1"],["Section B",null,"2"]]');
    // turning cuts off in the section view leaves plane 2 drawn on no sheet
    section.image!.viewport!.display = { faceStyle: 'shaded', edges: true, profiles: true, backEdges: false, xray: false, hiddenGeometry: false, sections: { planes: true, cuts: false } };
    expect(await drawn(plan)).toEqual({ planes: [{ id: '/1', sheet: '1' }, { id: '/2' }], cuts: [{ key: '/1' }] });
  });

  it('stores a transparent picture for a view of a cloud model that shows nothing', async () => {
    setLayoutCloudModelLoader(async () => new Uint8Array(4));
    const state = cloudState(), entity = cloudView();
    state.references.get(5)!.target = { kind: 'cloud', documentId: 'empty-model', revisionId: 'rev-4', revisionNumber: 4, sha256: 'e'.repeat(64), pinned: false };
    rendered.empty = true;
    try {
      expect(layoutViewportRender(state, entity)).toBeNull();
      await settle();
    } finally { rendered.empty = false; }
    expect(rendered.snapshots).toEqual([]);
    expect(layoutViewportRender(state, entity)).toMatchObject({ src: expect.stringMatching(/^data:image\/png;base64,/), cache: { sha256: 'e'.repeat(64) } });
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
