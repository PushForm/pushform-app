// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import { meshBox, newGuid, type CurveId, type FaceLocalId, type Id, type DefId, type ImageId, type TagId, type TagFolderId, type MaterialId, type SceneId, type StyleId } from '@pushform/core';
import { createLayoutDocument, LayoutDocument, formatLayoutTextRange, createLayoutTable, editTableAxis, createLinearDimension, createAngularDimension, moveLayoutLabel, copyLayoutImage } from '@pushform/layout';
import { allocId, bodyFromMesh, createDocument, createEntityContainer, createDefaultStyle, DEFAULT_SCENE_FLAGS, DEFAULT_SHADOWS, ImageStore, type ImageAsset, type Draft, type Style, type ComponentDefinition, type Body } from '@pushform/model';
import { decodeLayoutDocument, layoutJson } from './layoutFile';
import { decodeModelFile, modelArchiveImages, modelJson } from './modelFile';
import { layoutContentIdentity } from './native/layoutIdentity';
import { readNativeModel } from './native/modelReader';
import { modelContentIdentity } from './native/modelIdentity';
import { SketchGraph } from '@pushform/model';
import { encodeLayoutArchive, encodeModelArchive, nativeFileTransferables, openLayoutFile, openModelFile,
  encodeModelSnapshot, encodeLayoutSnapshot, runNativeFileRequestAsync,
  type NativeFileRequest } from './nativeFileClient';

function modelWithImage() {
  const doc = createDocument(), images = new ImageStore();
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  doc.transact('Fixture', (draft) => {
    bodyFromMesh(draft, meshBox([0, 0, 0], [1, 2, 3]), { container: draft.definitions.get(draft.rootDefinitionId)!.entities });
    const id = allocId<ImageId>(draft);
    const asset: ImageAsset = { id, name: 'tile.png', mime: 'image/png', width: 1, height: 1, sha256: 'hash' };
    (draft.images as unknown as Map<ImageId, ImageAsset>).set(id, asset);
    images.register(asset, png);
  });
  return { doc, images, png };
}

/** A stand-in `Worker` that runs requests through a structured clone, as a real worker would. */
class FakeWorker {
  static instances = 0;
  static fail: 'none' | 'load' | 'message' = 'none';
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  constructor() { FakeWorker.instances++; }
  postMessage(request: NativeFileRequest, transfer: ArrayBuffer[]): void {
    const received = structuredClone(request, { transfer });
    queueMicrotask(async () => {
      if (FakeWorker.fail === 'load') { this.onerror?.({ message: 'failed to load' }); return; }
      if (FakeWorker.fail === 'message') { this.onmessage?.({ data: { type: 'error', message: 'worker said no' } }); return; }
      try {
        const result = await runNativeFileRequestAsync(received);
        this.onmessage?.({ data: { type: 'result', result: structuredClone(result, { transfer: nativeFileTransferables(result) }) } });
      } catch (cause) {
        this.onmessage?.({ data: { type: 'error', message: (cause as Error).message } });
      }
    });
  }
  terminate(): void { this.terminated = true; }
}

describe('native file client', () => {
  afterEach(() => { vi.unstubAllGlobals(); FakeWorker.fail = 'none'; FakeWorker.instances = 0; });

  it.each(['none', 'worker', 'fallback'])('saves captured binary Layout state through %s', async mode => {
    if (mode !== 'none') vi.stubGlobal('Worker', FakeWorker);
    if (mode === 'fallback') FakeWorker.fail = 'load';
    const doc = createLayoutDocument(), captured = doc.state;
    const encoding = encodeLayoutSnapshot(captured);
    doc.transact('later edit', draft => { draft.pages.get(draft.pageOrder[0]!)!.name = 'Later'; });
    const bytes = await encoding;
    expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe('PUSHFRM2');
    const opened = await openLayoutFile(bytes);
    expect(opened.state).toEqual(captured);
    expect(opened.contentIdentity).toBe(layoutContentIdentity(opened.state));
    expect(bytes.byteLength).toBeGreaterThan(0);
    await expect(openModelFile(bytes)).rejects.toThrow();
  });

  it('saves Protobuf snapshots through the worker and reopens editable solids and exact image bytes', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const { doc, images, png } = modelWithImage(), captured = doc.state;
    const encoding = encodeModelSnapshot(captured, modelArchiveImages(captured, images));
    doc.transact('later edit', d => { d.definitions.get(d.rootDefinitionId)!.name = 'Changed during save'; });
    const bytes = await encoding;
    expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe('PUSHFRM2');
    const opened = await openModelFile(bytes);
    expect(opened.state).toEqual(captured);
    expect([...opened.images.values()][0]!.bytes).toEqual(png);
    expect([...captured.definitions.values()][0]!.entities.bodies.values().next().value!.mesh.verts.byteLength).toBeGreaterThan(0);
    const restored = createDocument(); restored.replaceState(opened.state);
    restored.transact('edit reopened', d => { d.definitions.get(d.rootDefinitionId)!.name = 'Editable'; });
    expect(restored.rootDefinition.name).toBe('Editable');
  });

  it('encodes a captured snapshot inline when Worker is unavailable', async () => {
    expect(typeof Worker).toBe('undefined');
    const { doc, images, png } = modelWithImage();
    const content = modelJson(doc.state);
    const bytes = await encodeModelArchive(content, modelArchiveImages(doc.state, images));
    const file = decodeModelFile(bytes);
    expect(modelJson(file.state)).toBe(content);
    expect([...file.images.values()][0]!.bytes).toEqual(png);
    const layout = createLayoutDocument();
    expect(layoutJson(decodeLayoutDocument(await encodeLayoutArchive(layoutJson(layout.state))).state)).toBe(layoutJson(layout.state));
  });

  it('opens files inline and returns a compact semantic model baseline', async () => {
    const { doc, images } = modelWithImage();
    const opened = await openModelFile(await encodeModelSnapshot(doc.state, modelArchiveImages(doc.state, images)));
    expect(opened.contentIdentity).toBe(modelContentIdentity(doc.state));
    expect(modelContentIdentity(opened.state)).toBe(opened.contentIdentity);
    expect(opened.images.size).toBe(1);
    const layout = createLayoutDocument();
    const openedLayout = await openLayoutFile(await encodeLayoutArchive(layoutJson(layout.state)));
    expect(openedLayout.contentIdentity).toBe(layoutContentIdentity(layout.state));
    expect(openedLayout.state.pageOrder).toEqual(layout.state.pageOrder);
    await expect(openModelFile(new Uint8Array([1, 2, 3]))).rejects.toThrow('Invalid .pf archive');
    await expect(openLayoutFile(new Uint8Array([1, 2, 3]))).rejects.toThrow('Invalid .pfl archive');
  });

  it("runs through a worker when one exists, leaving the caller's buffers intact", async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const { doc, images, png } = modelWithImage();
    const entries = modelArchiveImages(doc.state, images);
    const bytes = await encodeModelSnapshot(doc.state, entries);
    expect(FakeWorker.instances).toBe(1);
    expect(entries[0]!.blob.bytes.byteLength).toBe(png.byteLength);
    const opened = await openModelFile(bytes);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(FakeWorker.instances).toBe(2);
    expect(opened.contentIdentity).toBe(modelContentIdentity(doc.state));
    expect(opened.state).toEqual(doc.state);
    const body = [...opened.state.definitions.get(opened.state.rootDefinitionId)!.entities.bodies.values()][0]!;
    expect(body.mesh.verts).toBeInstanceOf(Float64Array);
    expect(opened.images.get(entries[0]!.id)!.bytes).toEqual(png);
    const layout = createLayoutDocument();
    const openedLayout = await openLayoutFile(await encodeLayoutArchive(layoutJson(layout.state)));
    expect(openedLayout.state.pages).toBeInstanceOf(Map);
    expect(openedLayout.contentIdentity).toBe(layoutContentIdentity(layout.state));
  });

  it.each(['absent', 'constructor-failure', 'worker', 'load-failure'])(
    'allocates transfer copies only for created workers: %s', async mode => {
      const { doc, images } = modelWithImage();
      const model = await encodeModelSnapshot(doc.state, modelArchiveImages(doc.state, images));
      const layout = await encodeLayoutSnapshot(createLayoutDocument().state);
      const originals = [model.slice(), layout.slice()];
      const transferred: number[] = [];
      const Bytes = Uint8Array;
      vi.stubGlobal('Uint8Array', new Proxy(Bytes, {
        construct(target, args) {
          if (args[0] === model || args[0] === layout) transferred.push(args[0].byteLength);
          return Reflect.construct(target, args);
        },
      }));
      if (mode === 'constructor-failure') vi.stubGlobal('Worker', class { constructor() { throw new Error('unavailable'); } });
      else if (mode !== 'absent') vi.stubGlobal('Worker', FakeWorker);
      if (mode === 'load-failure') FakeWorker.fail = 'load';
      expect((await openModelFile(model)).contentIdentity).toBe(modelContentIdentity(doc.state));
      expect((await openLayoutFile(layout)).state.pageOrder).toHaveLength(1);
      expect([model, layout]).toEqual(originals);
      expect(transferred).toEqual(mode === 'worker' || mode === 'load-failure' ? [model.byteLength, layout.byteLength] : []);
    },
  );

  it.each(['inline', 'worker'])('preserves unknown root fields through editing and saving: %s', async mode => {
    if (mode === 'worker') vi.stubGlobal('Worker', FakeWorker);
    // Unknown field 100, length-delimited, with bytes that are not interpreted as text.
    const fields = [new Uint8Array([0xa2, 0x06, 0x03, 0xff, 0, 0x80])];
    const model = createDocument();
    model.transact('future metadata', draft => { draft.nativeRootUnknownFields = fields; });
    const first = await encodeModelSnapshot(model.state, []);
    const opened = await openModelFile(first);
    first.fill(0); // Decoded unknown fields own their bytes rather than retaining file slices.
    expect(opened.state.nativeRootUnknownFields).toEqual(fields);
    const editable = createDocument(); editable.replaceState(opened.state);
    const baseline = modelContentIdentity(editable.state);
    const edit = editable.transact('rename', draft => { draft.definitions.get(draft.rootDefinitionId)!.name = 'Changed'; });
    const saved = await openModelFile(await encodeModelSnapshot(editable.state, []));
    expect(saved.state.nativeRootUnknownFields).toEqual(fields);
    expect(saved.state.definitions.get(saved.state.rootDefinitionId)!.name).toBe('Changed');
    editable.applyPatches(edit.inversePatches, edit.patches, 'undo', 'rename');
    expect(modelContentIdentity(editable.state)).toBe(baseline);
    const clean = { ...editable.state }; delete clean.nativeRootUnknownFields;
    expect(modelContentIdentity(clean)).not.toBe(baseline);

    const layout = createLayoutDocument();
    layout.transact('future metadata', draft => { draft.nativeRootUnknownFields = fields; });
    const layoutBytes = await encodeLayoutSnapshot(layout.state);
    const layoutOpened = await openLayoutFile(layoutBytes);
    layoutBytes.fill(0);
    const drawing = new LayoutDocument(layoutOpened.state), pageId = drawing.state.pageOrder[0]!;
    const layoutBaseline = layoutContentIdentity(drawing.state);
    const change = drawing.transact('rename', draft => { draft.pages.get(pageId)!.name = 'Changed'; });
    const reopened = await openLayoutFile(await encodeLayoutSnapshot(drawing.state));
    expect(reopened.state.nativeRootUnknownFields).toEqual(fields);
    expect(reopened.state.pages.get(pageId)!.name).toBe('Changed');
    drawing.applyPatches(change.inversePatches, change.patches, 'undo', 'rename');
    expect(layoutContentIdentity(drawing.state)).toBe(layoutBaseline);
    const without = { ...drawing.state }; delete without.nativeRootUnknownFields;
    expect(layoutContentIdentity(without)).not.toBe(layoutBaseline);
  });

  it.each(['inline', 'worker'])('preserves nested settings fields and removes deleted owners atomically: %s', async mode => {
    if (mode === 'worker') vi.stubGlobal('Worker', FakeWorker);
    const fields = [new Uint8Array([0xa2, 0x06, 0x03, 0xff, 0, 0x80])];
    const model = createDocument();
    model.transact('future settings', draft => {
      draft.meta.dimensions = { fontSizePt: 12, arrow: 'closed', align: 'screen' };
      draft.meta.units.lengthSnap = null;
      draft.fog = { enabled: true, near: 1, far: 10, color: [0.1, 0.2, 0.3], useBackground: false };
      draft.nativeSettingsUnknownFields = {
        records: new Map([['', fields], ['fog', fields]]),
        meta: new Map([['', fields], ['units', fields], ['units.lengthSnap', fields], ['units.lengthSnap.null', fields], ['dimensions', fields], ['dimensions.value', fields]]),
        shadows: new Map([['', fields]]), fog: new Map([['', fields], ['color', fields]]),
      };
    });
    const opened = await openModelFile(await encodeModelSnapshot(model.state, []));
    const editable = createDocument(); editable.replaceState(opened.state);
    expect(editable.state.nativeSettingsUnknownFields).toEqual(model.state.nativeSettingsUnknownFields);
    editable.transact('known edits', draft => {
      draft.meta.units.lengthPrecision = 2; draft.meta.dimensions!.fontSizePt = 14;
      draft.shadows.enabled = true; draft.fog!.color = [0.4, 0.5, 0.6];
    });
    const saved = await openModelFile(await encodeModelSnapshot(editable.state, []));
    expect(saved.state.nativeSettingsUnknownFields).toEqual(model.state.nativeSettingsUnknownFields);
    expect(saved.state.meta.dimensions!.fontSizePt).toBe(14);
    expect(saved.state.fog!.color).toEqual([0.4, 0.5, 0.6]);
    const baseline = modelContentIdentity(editable.state);
    const deletion = editable.transact('remove owners', draft => {
      delete draft.fog; delete draft.meta.dimensions; draft.meta.units.lengthSnap = 0.01;
    });
    const ext = editable.state.nativeSettingsUnknownFields!;
    expect(ext.fog).toBeUndefined(); expect(ext.records.has('fog')).toBe(false);
    expect(ext.meta.has('dimensions')).toBe(false); expect(ext.meta.has('dimensions.value')).toBe(false);
    expect(ext.meta.has('units.lengthSnap.null')).toBe(false);
    expect((await openModelFile(await encodeModelSnapshot(editable.state, []))).state.nativeSettingsUnknownFields).toEqual(ext);
    editable.applyPatches(deletion.inversePatches, deletion.patches, 'undo', 'remove owners');
    expect(modelContentIdentity(editable.state)).toBe(baseline);
    expect(editable.state.nativeSettingsUnknownFields).toEqual(saved.state.nativeSettingsUnknownFields);
  });

  it.each(['inline', 'worker'])('preserves tag metadata through edits, deletion and undo: %s', async mode => {
    if (mode === 'worker') vi.stubGlobal('Worker', FakeWorker);
    const fields = [new Uint8Array([0xa2, 0x06, 0x03, 0xff, 0, 0x80])];
    const doc = createDocument();
    const { tag, folder } = doc.transact('future tags', draft => {
      const tag = allocId<TagId>(draft), folder = allocId<TagFolderId>(draft);
      draft.tags.set(tag, { id: tag, name: 'Imported tag', visible: true, color: [0.1, 0.2, 0.3], dashes: null, folderId: null });
      draft.tagFolders.set(folder, { id: folder, name: 'Imported folder', visible: true, parentId: null });
      draft.nativeTagUnknownFields = {
        tags: new Map([[tag, { required: false, envelopeUnknown: fields, extensions: new Map([['', fields], ['color', fields], ['folderId', fields], ['folderId.null', fields], ['dashes.null', fields]]) }]]),
        folders: new Map([[folder, { envelopeUnknown: fields, extensions: new Map([['', fields], ['parentId', fields], ['parentId.null', fields]]) }]]),
      };
      return { tag, folder };
    }).value;
    const editable = createDocument(); editable.replaceState((await openModelFile(await encodeModelSnapshot(doc.state, []))).state);
    expect(editable.state.nativeTagUnknownFields).toEqual(doc.state.nativeTagUnknownFields);
    editable.transact('rename and move', draft => {
      draft.tags.get(tag)!.name = 'Changed tag'; draft.tags.get(tag)!.folderId = folder;
      draft.tags.get(tag)!.dashes = 'dash'; draft.tagFolders.get(folder)!.name = 'Changed folder';
    });
    const ext = editable.state.nativeTagUnknownFields!;
    expect(ext.tags.get(tag)!.extensions!.has('folderId.null')).toBe(false);
    expect(ext.tags.get(tag)!.extensions!.has('dashes.null')).toBe(false);
    const reopened = await openModelFile(await encodeModelSnapshot(editable.state, []));
    expect(reopened.state.nativeTagUnknownFields).toEqual(ext);
    expect(reopened.state.tags.get(tag)).toMatchObject({ name: 'Changed tag', folderId: folder });
    expect(reopened.state.tagFolders.get(folder)!.name).toBe('Changed folder');
    const baseline = modelContentIdentity(editable.state);
    const edit = editable.transact('delete owners', draft => { draft.tags.delete(tag); draft.tagFolders.delete(folder); });
    expect(editable.state.nativeTagUnknownFields).toBeUndefined();
    expect((await openModelFile(await encodeModelSnapshot(editable.state, []))).state.nativeTagUnknownFields).toBeUndefined();
    editable.applyPatches(edit.inversePatches, edit.patches, 'undo', 'delete owners');
    expect(modelContentIdentity(editable.state)).toBe(baseline);
    expect((await openModelFile(await encodeModelSnapshot(editable.state, []))).state.nativeTagUnknownFields).toEqual(ext);
  });

  it.each(['inline', 'worker'])('preserves material fields through texture edits, deletion and undo: %s', async mode => {
    if (mode === 'worker') vi.stubGlobal('Worker', FakeWorker);
    const { doc, images } = modelWithImage(), imageId = [...doc.state.images.keys()][0]!;
    const fields = [new Uint8Array([0xa2, 0x06, 0x03, 0xff, 0, 0x80])];
    const id = doc.transact('future material', draft => {
      const id = allocId<MaterialId>(draft);
      draft.materials.set(id, { id, name: 'Imported material', color: [0.2, 0.3, 0.4], alpha: 1,
        texture: { imageId, widthM: 1, heightM: 2, colorize: true, colorizeType: undefined } });
      draft.nativeMaterialUnknownFields = new Map([[id, { required: false, envelopeUnknown: fields,
        extensions: new Map([['', fields], ['color', fields], ['texture', fields], ['texture.value', fields], ['texture.colorizeType', fields], ['texture.colorizeType.undefined', fields]]) }]]);
      return id;
    }).value;
    const editable = createDocument();
    const entries = modelArchiveImages(doc.state, images);
    editable.replaceState((await openModelFile(await encodeModelSnapshot(doc.state, entries))).state);
    expect(editable.state.nativeMaterialUnknownFields).toEqual(doc.state.nativeMaterialUnknownFields);
    editable.transact('known edits', draft => {
      const material = draft.materials.get(id)!;
      material.name = 'Changed'; material.color = [0.5, 0.6, 0.7];
      material.texture!.widthM = 3; material.texture!.colorizeType = 'tint';
    });
    const ext = editable.state.nativeMaterialUnknownFields!;
    expect(ext.get(id)!.extensions!.has('texture.colorizeType.undefined')).toBe(false);
    const reopened = await openModelFile(await encodeModelSnapshot(editable.state, entries));
    expect(reopened.state.nativeMaterialUnknownFields).toEqual(ext);
    expect(reopened.state.materials.get(id)).toMatchObject({ name: 'Changed', texture: { widthM: 3, colorizeType: 'tint' } });
    const baseline = modelContentIdentity(editable.state);
    const removal = editable.transact('remove texture', draft => { draft.materials.get(id)!.texture = null; });
    expect([...editable.state.nativeMaterialUnknownFields!.get(id)!.extensions!.keys()].sort()).toEqual(['', 'color', 'texture']);
    const withoutTexture = await openModelFile(await encodeModelSnapshot(editable.state, entries));
    expect(withoutTexture.state.nativeMaterialUnknownFields).toEqual(editable.state.nativeMaterialUnknownFields);
    editable.applyPatches(removal.inversePatches, removal.patches, 'undo', 'remove texture');
    expect(modelContentIdentity(editable.state)).toBe(baseline);
    const deletion = editable.transact('delete material', draft => { draft.materials.delete(id); });
    expect(editable.state.nativeMaterialUnknownFields).toBeUndefined();
    expect((await openModelFile(await encodeModelSnapshot(editable.state, entries))).state.nativeMaterialUnknownFields).toBeUndefined();
    editable.applyPatches(deletion.inversePatches, deletion.patches, 'undo', 'delete material');
    expect(modelContentIdentity(editable.state)).toBe(baseline);
  });

  it.each(['inline', 'worker'])('preserves image metadata while assigning fresh payload references: %s', async mode => {
    if (mode === 'worker') vi.stubGlobal('Worker', FakeWorker);
    const { doc, images, png } = modelWithImage(), id = [...doc.state.images.keys()][0]!;
    const fields = [new Uint8Array([0xa2, 0x06, 0x03, 0xff, 0, 0x80])];
    doc.transact('future image', draft => {
      draft.nativeImageUnknownFields = new Map([[id, { required: false, envelopeUnknown: fields, unknownFields: fields }]]);
    });
    const firstBytes = await encodeModelSnapshot(doc.state, modelArchiveImages(doc.state, images));
    const source = (bytes: Uint8Array) => ({ size: bytes.length, read: async (offset: number, length: number) => bytes.subarray(offset, offset + length) });
    const firstChunks = (await readNativeModel(source(firstBytes))).catalogs.imageRecord(id).payload!.chunks;
    const first = await openModelFile(firstBytes), editable = createDocument(); editable.replaceState(first.state);
    expect(editable.state.nativeImageUnknownFields).toEqual(doc.state.nativeImageUnknownFields);
    expect(Object.keys(editable.state.nativeImageUnknownFields!.get(id)!).sort()).toEqual(['envelopeUnknown', 'required', 'unknownFields']);
    const extra = editable.transact('insert preceding asset', draft => {
      const next = allocId<ImageId>(draft);
      const asset = { id: next, name: 'preceding.png', mime: 'image/png', width: 1, height: 1, sha256: 'preceding' };
      draft.images = new Map([[next, asset], ...draft.images]);
      draft.images.get(id)!.name = 'Renamed.png';
      return asset;
    }).value;
    images.register(extra, new Uint8Array([137, 80, 78, 71, 8, 9]));
    const nextBytes = await encodeModelSnapshot(editable.state, modelArchiveImages(editable.state, images));
    const nextChunks = (await readNativeModel(source(nextBytes))).catalogs.imageRecord(id).payload!.chunks;
    expect(nextChunks).not.toEqual(firstChunks);
    const next = await openModelFile(nextBytes);
    expect(next.state.nativeImageUnknownFields).toEqual(doc.state.nativeImageUnknownFields);
    expect(next.state.images.get(id)!.name).toBe('Renamed.png');
    expect(next.images.get(id)!.bytes).toEqual(png);
    expect(next.images.get(extra.id)!.bytes).toEqual(images.get(extra.id)!.bytes);
    const baseline = modelContentIdentity(editable.state);
    const deletion = editable.transact('remove asset', draft => { draft.images.delete(id); });
    expect(editable.state.nativeImageUnknownFields).toBeUndefined();
    const removed = await openModelFile(await encodeModelSnapshot(editable.state, modelArchiveImages(editable.state, images)));
    expect(removed.images.has(id)).toBe(false); expect(removed.state.nativeImageUnknownFields).toBeUndefined();
    editable.applyPatches(deletion.inversePatches, deletion.patches, 'undo', 'remove asset');
    expect(modelContentIdentity(editable.state)).toBe(baseline);
    expect((await openModelFile(await encodeModelSnapshot(editable.state, modelArchiveImages(editable.state, images)))).images.get(id)!.bytes).toEqual(png);
  });

  it.each(['inline', 'worker'])('preserves scene camera and override metadata through edits and undo: %s', async mode => {
    if (mode === 'worker') vi.stubGlobal('Worker', FakeWorker);
    const doc = createDocument(), fields = [new Uint8Array([0xa2, 0x06, 0x03, 0xff, 0, 0x80])];
    const id = doc.transact('future scene', draft => {
      const id = allocId<SceneId>(draft);
      draft.scenes.set(id, { id, name: 'Imported', description: '', camera: { eye: [1, 2, 3], target: [0, 0, 0], up: [0, 0, 1], perspective: true, fov: 35, height: 1 },
        flags: { ...DEFAULT_SCENE_FLAGS }, hiddenEntities: [], hiddenTags: [], hiddenTagFolders: [], styleId: null,
        shadows: { ...DEFAULT_SHADOWS }, fog: { enabled: true, near: 1, far: 10, useBackground: false, color: [0.1, 0.2, 0.3] },
        activeSectionPlanes: [], axesVisible: true, includeInAnimation: undefined });
      draft.sceneOrder.push(id);
      draft.nativeSceneUnknownFields = new Map([[id, { required: false, envelopeUnknown: fields, extensions: {
        records: new Map([['', fields], ['flags', fields], ['styleId', fields], ['styleId.null', fields], ['shadows', fields], ['fog', fields], ['animation', fields], ['animation.undefined', fields]]),
        camera: new Map([['', fields], ['eye', fields], ['target', fields], ['up', fields]]), shadows: new Map([['', fields]]), fog: new Map([['', fields], ['color', fields]]),
      } }]]);
      return id;
    }).value;
    const editable = createDocument(); editable.replaceState((await openModelFile(await encodeModelSnapshot(doc.state, []))).state);
    expect(editable.state.nativeSceneUnknownFields).toEqual(doc.state.nativeSceneUnknownFields);
    editable.transact('edit scene', draft => {
      const scene = draft.scenes.get(id)!;
      scene.name = 'Changed'; scene.camera.eye = [4, 5, 6]; scene.flags.useTags = false; scene.hiddenTags = [draft.defaultTagId];
    });
    const next = await openModelFile(await encodeModelSnapshot(editable.state, []));
    expect(next.state.nativeSceneUnknownFields).toEqual(doc.state.nativeSceneUnknownFields);
    expect(next.state.scenes.get(id)).toMatchObject({ name: 'Changed', camera: { eye: [4, 5, 6] }, flags: { useTags: false }, hiddenTags: [doc.state.defaultTagId] });
    const baseline = modelContentIdentity(editable.state);
    const change = editable.transact('remove overrides', draft => {
      const scene = draft.scenes.get(id)!;
      delete scene.fog; scene.shadows = null; scene.styleId = draft.activeStyleId; scene.includeInAnimation = false;
    });
    const ext = editable.state.nativeSceneUnknownFields!.get(id)!.extensions!;
    expect(ext.fog).toBeUndefined(); expect(ext.shadows).toBeUndefined();
    for (const key of ['fog', 'styleId.null', 'animation.undefined']) expect(ext.records.has(key)).toBe(false);
    expect((await openModelFile(await encodeModelSnapshot(editable.state, []))).state.nativeSceneUnknownFields).toEqual(editable.state.nativeSceneUnknownFields);
    editable.applyPatches(change.inversePatches, change.patches, 'undo', 'remove overrides');
    expect(modelContentIdentity(editable.state)).toBe(baseline);
    const deletion = editable.transact('delete scene', draft => { draft.scenes.delete(id); draft.sceneOrder = []; });
    expect(editable.state.nativeSceneUnknownFields).toBeUndefined();
    expect((await openModelFile(await encodeModelSnapshot(editable.state, []))).state.scenes.size).toBe(0);
    editable.applyPatches(deletion.inversePatches, deletion.patches, 'undo', 'delete scene');
    expect(modelContentIdentity(editable.state)).toBe(baseline);
  });

  it.each(['inline', 'worker'])('keeps unknown style fields with their watermark owners after reorder: %s', async mode => {
    if (mode === 'worker') vi.stubGlobal('Worker', FakeWorker);
    const { doc, images } = modelWithImage(), imageId = [...doc.state.images.keys()][0]!;
    const a = [new Uint8Array([0xa0, 6, 1])], b = [new Uint8Array([0xa0, 6, 2])];
    const id = doc.transact('future style', draft => {
      const id = allocId<StyleId>(draft), style = createDefaultStyle(id);
      style.faces.transparencyQuality = undefined; style.modeling.colorByTag = undefined;
      // Duplicate images deliberately cannot serve as watermark identity.
      style.watermarks = [{ imageId, position: 'overlay', opacity: 0.3, nativeUnknownFields: a }, { imageId, position: 'background', opacity: 0.7, nativeUnknownFields: b }];
      draft.styles.set(id, style as Draft<Style>);
      draft.nativeStyleUnknownFields = new Map([[id, { required: false, envelopeUnknown: a, extensions: new Map([
        ['', a], ['edges', a], ['edges.color', a], ['faces', a], ['background.skyColor', a], ['modeling.selected', a],
        ['faces.transparencyQuality', a], ['faces.transparencyQuality.undefined', a], ['modeling.colorByTag', a], ['modeling.colorByTag.undefined', a],
      ]) }]]);
      return id;
    }).value;
    const entries = modelArchiveImages(doc.state, images), editable = createDocument();
    editable.replaceState((await openModelFile(await encodeModelSnapshot(doc.state, entries))).state);
    expect(editable.state.styles.get(id)!.watermarks).toEqual(doc.state.styles.get(id)!.watermarks);
    expect(editable.state.nativeStyleUnknownFields).toEqual(doc.state.nativeStyleUnknownFields);
    editable.transact('edit and reorder', draft => {
      const style = draft.styles.get(id)!;
      style.name = 'Changed'; style.edges.profileWidth = 4; style.watermarks.reverse(); style.watermarks[0]!.opacity = 0.9;
      style.faces.transparencyQuality = 'nicer'; delete style.modeling.colorByTag;
    });
    const saved = await openModelFile(await encodeModelSnapshot(editable.state, entries));
    expect(saved.state.styles.get(id)!.watermarks.map(w => w.nativeUnknownFields)).toEqual([b, a]);
    expect(saved.state.styles.get(id)!.watermarks[0]!.opacity).toBe(0.9);
    expect(saved.state.styles.get(id)!.edges.profileWidth).toBe(4);
    expect(saved.state.nativeStyleUnknownFields).toEqual(editable.state.nativeStyleUnknownFields);
    const baseline = modelContentIdentity(editable.state);
    const remove = editable.transact('remove watermark', draft => { draft.styles.get(id)!.watermarks.splice(0, 1); });
    expect((await openModelFile(await encodeModelSnapshot(editable.state, entries))).state.styles.get(id)!.watermarks.map(w => w.nativeUnknownFields)).toEqual([a]);
    editable.applyPatches(remove.inversePatches, remove.patches, 'undo', 'remove watermark');
    expect(modelContentIdentity(editable.state)).toBe(baseline);
    const deletion = editable.transact('delete style', draft => { draft.styles.delete(id); });
    expect(editable.state.nativeStyleUnknownFields).toBeUndefined();
    expect((await openModelFile(await encodeModelSnapshot(editable.state, entries))).state.styles.has(id)).toBe(false);
    editable.applyPatches(deletion.inversePatches, deletion.patches, 'undo', 'delete style');
    expect(modelContentIdentity(editable.state)).toBe(baseline);
  });

  it.each(['inline', 'worker'])('keeps definition metadata with copied owners and regenerated entity order: %s', async mode => {
    if (mode === 'worker') vi.stubGlobal('Worker', FakeWorker);
    const doc = createDocument(), fields = [new Uint8Array([0xa0, 6, 1])];
    const id = doc.transact('future definition', draft => {
      const id = allocId<DefId>(draft);
      const definitions = draft.definitions as unknown as Map<DefId, ComponentDefinition>;
      definitions.set(id, { ...doc.rootDefinition, id, guid: newGuid(), name: 'Imported definition',
        entities: createEntityContainer(), nativeUnknownFields: { required: false, envelopeUnknown: fields,
          extensions: new Map([['', fields], ['behaviors', fields], ['entityOrder', fields]]) } });
      return id;
    }).value;
    const editable = createDocument(); editable.replaceState((await openModelFile(await encodeModelSnapshot(doc.state, []))).state);
    expect(editable.state.definitions.get(id)!.nativeUnknownFields).toEqual(doc.state.definitions.get(id)!.nativeUnknownFields);
    const copiedId = editable.transact('copy definition', draft => {
      const copiedId = allocId<DefId>(draft);
      draft.definitions.set(copiedId, { ...draft.definitions.get(id)!, id: copiedId, guid: newGuid(), name: 'Copy' });
      return copiedId;
    }).value;
    editable.transact('edit definition', draft => {
      const definition = draft.definitions.get(id)!;
      definition.name = 'Changed'; definition.behaviors.alwaysFaceCamera = true;
      bodyFromMesh(draft, meshBox([0, 0, 0], [1, 2, 3]), { container: definition.entities });
    });
    const saved = await openModelFile(await encodeModelSnapshot(editable.state, []));
    expect(saved.state.definitions.get(id)!.nativeUnknownFields).toEqual(doc.state.definitions.get(id)!.nativeUnknownFields);
    expect(saved.state.definitions.get(id)!.entities.order).toEqual(editable.state.definitions.get(id)!.entities.order);
    expect(saved.state.definitions.get(id)!.entities.bodies.size).toBe(1);
    expect(saved.state.definitions.get(copiedId)!.entities.bodies.size).toBe(0);
    expect(saved.state.definitions.get(copiedId)!.nativeUnknownFields).toEqual(doc.state.definitions.get(id)!.nativeUnknownFields);
    const baseline = modelContentIdentity(editable.state);
    const deletion = editable.transact('delete definition', draft => { draft.definitions.delete(id); });
    const removed = await openModelFile(await encodeModelSnapshot(editable.state, []));
    expect(removed.state.definitions.has(id)).toBe(false);
    expect(removed.state.definitions.get(copiedId)!.nativeUnknownFields).toEqual(doc.state.definitions.get(id)!.nativeUnknownFields);
    editable.applyPatches(deletion.inversePatches, deletion.patches, 'undo', 'delete definition');
    expect(modelContentIdentity(editable.state)).toBe(baseline);
  });

  it.each(['inline', 'worker'])('keeps instance metadata through copies and atomic glued-plane cleanup: %s', async mode => {
    if (mode === 'worker') vi.stubGlobal('Worker', FakeWorker);
    const doc = createDocument(), fields = [new Uint8Array([0xa0, 6, 1])];
    const id = doc.transact('future instance', draft => {
      const child = allocId<DefId>(draft), id = allocId<Id>(draft);
      const definitions = draft.definitions as unknown as Map<DefId, ComponentDefinition>;
      definitions.set(child, { ...doc.rootDefinition, id: child, guid: newGuid(), entities: createEntityContainer() });
      const root = draft.definitions.get(draft.rootDefinitionId)!;
      root.entities.instances.set(id, { id, definitionId: child, name: 'Imported', materialId: null, gluedPlane: undefined,
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], tagId: draft.defaultTagId,
        hidden: false, locked: false, castShadows: true, receiveShadows: true, attributes: {},
        nativeUnknownFields: { required: false, envelopeUnknown: fields, extensions: new Map([['', fields], ['gluedPlane', fields], ['gluedPlane.undefined', fields]]) } });
      root.entities.order.push(id); return id;
    }).value;
    const editable = createDocument(); editable.replaceState((await openModelFile(await encodeModelSnapshot(doc.state, []))).state);
    const original = doc.rootDefinition.entities.instances.get(id)!;
    expect(editable.rootDefinition.entities.instances.get(id)!.nativeUnknownFields).toEqual(original.nativeUnknownFields);
    const copyId = editable.transact('copy', draft => {
      const copyId = allocId<Id>(draft), entities = draft.definitions.get(draft.rootDefinitionId)!.entities;
      entities.instances.set(copyId, { ...entities.instances.get(id)!, id: copyId }); entities.order.push(copyId); return copyId;
    }).value;
    const baseline = modelContentIdentity(editable.state);
    const changes: string[] = []; editable.events.on('change', event => { changes.push(event.label); });
    const edit = editable.transact('glue and move', draft => {
      const instance = draft.definitions.get(draft.rootDefinitionId)!.entities.instances.get(id)!;
      instance.name = 'Changed'; instance.transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 5, 6, 1];
      instance.gluedPlane = { n: [0, 0, 1], d: -6 };
    });
    expect(changes).toEqual(['glue and move']);
    const saved = await openModelFile(await encodeModelSnapshot(editable.state, []));
    const instances = saved.state.definitions.get(saved.state.rootDefinitionId)!.entities.instances;
    expect(instances.get(id)!.nativeUnknownFields!.extensions!.has('gluedPlane.undefined')).toBe(false);
    expect(instances.get(id)!.transform.slice(12, 15)).toEqual([4, 5, 6]);
    expect(instances.get(copyId)!.nativeUnknownFields).toEqual(original.nativeUnknownFields);
    editable.applyPatches(edit.inversePatches, edit.patches, 'undo', 'glue and move');
    expect(modelContentIdentity(editable.state)).toBe(baseline);
    editable.applyPatches(edit.patches, edit.inversePatches, 'redo', 'glue and move');
    editable.transact('unglue', draft => { delete draft.definitions.get(draft.rootDefinitionId)!.entities.instances.get(id)!.gluedPlane; });
    expect(editable.rootDefinition.entities.instances.get(id)!.nativeUnknownFields!.extensions!.has('gluedPlane')).toBe(false);
    const deletion = editable.transact('delete instance', draft => {
      const entities = draft.definitions.get(draft.rootDefinitionId)!.entities; entities.instances.delete(id); entities.order = entities.order.filter(value => value !== id);
    });
    expect((await openModelFile(await encodeModelSnapshot(editable.state, []))).state.definitions.get(editable.state.rootDefinitionId)!.entities.instances.has(id)).toBe(false);
    editable.applyPatches(deletion.inversePatches, deletion.patches, 'undo', 'delete instance');
    expect(editable.rootDefinition.entities.instances.has(id)).toBe(true);
  });

  it.each(['inline', 'worker'])('preserves guide, image placement, section and text metadata with their owners: %s', async mode => {
    if (mode === 'worker') vi.stubGlobal('Worker', FakeWorker);
    const { doc, images, png } = modelWithImage(), imageId = [...doc.state.images.keys()][0]!;
    const fields = [new Uint8Array([0xa0, 6, 1])];
    const ids = doc.transact('future placements', draft => {
      const entities = draft.definitions.get(draft.rootDefinitionId)!.entities;
      const attrs = { tagId: draft.defaultTagId, hidden: false, locked: false, castShadows: true, receiveShadows: true, attributes: {},
        nativeUnknownFields: { required: false, envelopeUnknown: fields, unknownFields: fields } };
      const guide = allocId<Id>(draft), picture = allocId<Id>(draft), section = allocId<Id>(draft), text = allocId<Id>(draft);
      entities.guides.set(guide, { ...attrs, id: guide, kind: 'line', origin: [0, 0, 0], dir: [1, 0, 0] });
      entities.images.set(picture, { ...attrs, id: picture, imageId, widthM: 2, heightM: 3, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] });
      entities.sectionPlanes.set(section, { ...attrs, id: section, name: 'Section', symbol: 'A', plane: { n: [0, 0, 1], d: 0 }, origin: [0, 0, 0] });
      entities.texts.set(text, { ...attrs, id: text, text: 'Label', kind: 'leader', position: [0, 0, 0], offset: null, leader: 'none', fontFamily: 'Arial', fontSizePt: 12, color: [0, 0, 0] });
      entities.order.push(guide, picture, section, text); entities.activeSectionPlaneId = section;
      return { guide, picture, section, text };
    }).value;
    const editable = createDocument();
    const entries = modelArchiveImages(doc.state, images);
    editable.replaceState((await openModelFile(await encodeModelSnapshot(doc.state, entries))).state);
    const copyId = editable.transact('copy and edit placements', draft => {
      const e = draft.definitions.get(draft.rootDefinitionId)!.entities, copyId = allocId<Id>(draft);
      e.images.set(copyId, { ...e.images.get(ids.picture)!, id: copyId }); e.order.push(copyId);
      e.images.get(ids.picture)!.widthM = 4; e.guides.get(ids.guide)!.origin = [2, 3, 4];
      e.sectionPlanes.get(ids.section)!.plane.d = -5; e.texts.get(ids.text)!.text = 'Changed';
      return copyId;
    }).value;
    const saved = await openModelFile(await encodeModelSnapshot(editable.state, entries));
    const e = saved.state.definitions.get(saved.state.rootDefinitionId)!.entities;
    for (const value of [e.guides.get(ids.guide), e.images.get(ids.picture), e.images.get(copyId), e.sectionPlanes.get(ids.section), e.texts.get(ids.text)]) {
      expect(value!.nativeUnknownFields).toEqual({ required: false, envelopeUnknown: fields, unknownFields: fields });
    }
    expect(e.guides.get(ids.guide)!.origin).toEqual([2, 3, 4]); expect(e.images.get(ids.picture)!.widthM).toBe(4);
    expect(e.images.get(copyId)!.widthM).toBe(2); expect(e.sectionPlanes.get(ids.section)!.plane.d).toBe(-5);
    expect(e.texts.get(ids.text)!.text).toBe('Changed'); expect(saved.images.get(imageId)!.bytes).toEqual(png);
    const baseline = modelContentIdentity(editable.state);
    const deletion = editable.transact('delete placements', draft => {
      const e = draft.definitions.get(draft.rootDefinitionId)!.entities;
      e.guides.delete(ids.guide); e.images.delete(ids.picture); e.sectionPlanes.delete(ids.section); e.texts.delete(ids.text);
      e.activeSectionPlaneId = null; e.order = e.order.filter(id => !Object.values(ids).includes(id));
    });
    const removed = await openModelFile(await encodeModelSnapshot(editable.state, entries));
    expect(removed.state.definitions.get(removed.state.rootDefinitionId)!.entities.images.has(copyId)).toBe(true);
    expect(removed.state.definitions.get(removed.state.rootDefinitionId)!.entities.texts.size).toBe(0);
    editable.applyPatches(deletion.inversePatches, deletion.patches, 'undo', 'delete placements');
    expect(modelContentIdentity(editable.state)).toBe(baseline);
  });

  it.each(['inline', 'worker'])('keeps dimension metadata with swapped attachments and restores removed records on undo: %s', async mode => {
    if (mode === 'worker') vi.stubGlobal('Worker', FakeWorker);
    const doc = createDocument(), a = [new Uint8Array([0xa0, 6, 1])], b = [new Uint8Array([0xa0, 6, 2])];
    const id = doc.transact('future dimension', draft => {
      const id = allocId<Id>(draft), e = draft.definitions.get(draft.rootDefinitionId)!.entities;
      e.dimensions.set(id, { id, kind: 'linear', start: [0, 0, 0], end: [1, 0, 0], offset: [0, 1, 0], normal: [0, 0, 1], text: null, fontSizePt: 12,
        tagId: draft.defaultTagId, hidden: false, locked: false, castShadows: true, receiveShadows: true, attributes: {},
        anchors: [{ kind: 'sketchVertex', path: [], id: 100 as Id, nativeUnknownFields: a }, { kind: 'sketchVertex', path: [], id: 101 as Id, nativeUnknownFields: b }], curve: undefined,
        nativeUnknownFields: { required: false, envelopeUnknown: a, extensions: new Map([['', a], ['anchors', a], ['curve', a]]) } });
      e.order.push(id); return id;
    }).value;
    const editable = createDocument(); editable.replaceState((await openModelFile(await encodeModelSnapshot(doc.state, []))).state);
    const get = () => editable.rootDefinition.entities.dimensions.get(id)!;
    expect(get()).toEqual(doc.rootDefinition.entities.dimensions.get(id));
    const baseline = modelContentIdentity(editable.state);
    const edit = editable.transact('swap and attach', draft => {
      const d = draft.definitions.get(draft.rootDefinitionId)!.entities.dimensions.get(id)!;
      d.anchors = [d.anchors![1], d.anchors![0]]; d.text = 'Changed';
      d.curve = { path: [], bodyId: null, curveId: 102 as CurveId, nativeUnknownFields: b };
    });
    expect(get().nativeUnknownFields!.extensions!.has('curve')).toBe(false);
    const saved = await openModelFile(await encodeModelSnapshot(editable.state, []));
    const restored = saved.state.definitions.get(saved.state.rootDefinitionId)!.entities.dimensions.get(id)!;
    expect(restored.anchors!.map(anchor => anchor?.nativeUnknownFields)).toEqual([b, a]);
    expect(restored.curve!.nativeUnknownFields).toEqual(b); expect(restored.text).toBe('Changed');
    editable.applyPatches(edit.inversePatches, edit.patches, 'undo', 'swap and attach');
    expect(modelContentIdentity(editable.state)).toBe(baseline);
    editable.transact('null endpoint', draft => {
      const d = draft.definitions.get(draft.rootDefinitionId)!.entities.dimensions.get(id)!;
      d.anchors = [null, d.anchors![1]]; d.nativeUnknownFields!.extensions!.set('anchors.start', a);
    });
    expect((await openModelFile(await encodeModelSnapshot(editable.state, []))).state.definitions.get(editable.state.rootDefinitionId)!.entities.dimensions.get(id)).toEqual(get());
    const removal = editable.transact('remove attachments', draft => {
      const d = draft.definitions.get(draft.rootDefinitionId)!.entities.dimensions.get(id)!; delete d.anchors; delete d.curve;
    });
    expect([...get().nativeUnknownFields!.extensions!.keys()]).toEqual(['']);
    editable.applyPatches(removal.inversePatches, removal.patches, 'undo', 'remove attachments');
    expect(get().nativeUnknownFields!.extensions!.has('anchors.start')).toBe(true);
    const deletion = editable.transact('delete dimension', draft => {
      const e = draft.definitions.get(draft.rootDefinitionId)!.entities; e.dimensions.delete(id); e.order = [];
    });
    expect((await openModelFile(await encodeModelSnapshot(editable.state, []))).state.definitions.get(editable.state.rootDefinitionId)!.entities.dimensions.size).toBe(0);
    editable.applyPatches(deletion.inversePatches, deletion.patches, 'undo', 'delete dimension');
    expect(get().anchors![0]).toBeNull();
  });

  it.each(['inline', 'worker'])('retains geometry metadata with body, sketch and imprint owners: %s', async mode => {
    if (mode === 'worker') vi.stubGlobal('Worker', FakeWorker);
    const { doc, images } = modelWithImage(), bytes = [new Uint8Array([0xa0, 6, 7])];
    const id = [...doc.rootDefinition.entities.bodies.keys()][0]!;
    const faceIds = [...doc.rootDefinition.entities.bodies.get(id)!.faces.keys()];
    doc.transact('future geometry', draft => {
      const e = draft.definitions.get(draft.rootDefinitionId)!.entities, body = e.bodies.get(id)!;
      body.nativeUnknownFields = { required: false, envelopeUnknown: bytes, extensions: new Map(
        ['', 'mesh', 'faces', 'faces.uv', 'edges', 'curves', 'surfaces'].map(scope => [scope, bytes])) };
      e.sketch.nativeUnknownFields = { required: false, envelopeUnknown: bytes, extensions: new Map(
        ['', 'vertices', 'edges', 'faces', 'faces.uv', 'curves'].map(scope => [scope, bytes])) };
      for (const faceId of faceIds.slice(0, 2)) body.imprints.set(faceId, {
        nextId: 1, version: 0, vertices: new Map(), edges: new Map(), nativeUnknownFields: [new Uint8Array([0xa0, 6, faceId])],
      });
    });
    const opened = await openModelFile(await encodeModelSnapshot(doc.state, modelArchiveImages(doc.state, images)));
    const editable = createDocument(); editable.replaceState(opened.state);
    const entities = () => editable.rootDefinition.entities;
    expect(entities().bodies.get(id)!.nativeUnknownFields).toEqual(doc.rootDefinition.entities.bodies.get(id)!.nativeUnknownFields);
    expect(entities().sketch.nativeUnknownFields).toEqual(doc.rootDefinition.entities.sketch.nativeUnknownFields);
    const baseline = modelContentIdentity(editable.state);
    const change = editable.transact('edit geometry owners', draft => {
      const e = draft.definitions.get(draft.rootDefinitionId)!.entities, body = e.bodies.get(id)!;
      body.hidden = true;
      const copyId = allocId<Id>(draft);
      e.bodies.set(copyId, { ...body, id: copyId }); e.order.push(copyId);
      const graph = body.imprints.get(faceIds[0]!)!;
      body.imprints.delete(faceIds[0]!); body.imprints.set(faceIds[0]!, graph);
      body.imprints.delete(faceIds[1]!);
      const vertexId = allocId<Id>(draft); e.sketch.vertices.set(vertexId, { id: vertexId, p: [3, 4, 5] });
    });
    const result = await openModelFile(await encodeModelSnapshot(editable.state, modelArchiveImages(editable.state, images)));
    expect(modelContentIdentity(result.state)).toBe(modelContentIdentity(editable.state));
    const saved = result.state.definitions.get(result.state.rootDefinitionId)!.entities;
    expect(saved.bodies.get(id)!.imprints.size).toBe(1);
    expect(saved.bodies.get(id)!.imprints.get(faceIds[0]!)!.nativeUnknownFields).toEqual([new Uint8Array([0xa0, 6, faceIds[0]!])]);
    editable.applyPatches(change.inversePatches, change.patches, 'undo', 'edit geometry owners');
    expect(modelContentIdentity(editable.state)).toBe(baseline);
    const deletion = editable.transact('delete body', draft => {
      const e = draft.definitions.get(draft.rootDefinitionId)!.entities; e.bodies.delete(id); e.order = e.order.filter(key => key !== id);
    });
    expect((await openModelFile(await encodeModelSnapshot(editable.state, modelArchiveImages(editable.state, images)))).state.definitions.get(editable.state.rootDefinitionId)!.entities.bodies.size).toBe(0);
    editable.applyPatches(deletion.inversePatches, deletion.patches, 'undo', 'delete body');
    expect(modelContentIdentity(editable.state)).toBe(baseline);
  });

  it.each(['inline', 'worker'])('shares property metadata without coupling entity edits: %s', async mode => {
    if (mode === 'worker') vi.stubGlobal('Worker', FakeWorker);
    const { doc, images } = modelWithImage(), fields = [new Uint8Array([0xa0, 6, 7])];
    const firstId = [...doc.rootDefinition.entities.bodies.keys()][0]!;
    const secondId = doc.transact('shared property fixture', draft => {
      const e = draft.definitions.get(draft.rootDefinitionId)!.entities, body = e.bodies.get(firstId)!;
      body.nativePropertyUnknownFields = { required: false, envelopeUnknown: fields, unknownFields: fields, fields };
      const id = allocId<Id>(draft); e.bodies.set(id, { ...body, id }); e.order.push(id); return id;
    }).value;
    const file = await encodeModelSnapshot(doc.state, modelArchiveImages(doc.state, images));
    const staged = await readNativeModel({ size: file.length, read: async (offset, length) => file.subarray(offset, offset + length) });
    expect(staged.properties.size).toBe(1);
    const opened = await openModelFile(file), editable = createDocument(); editable.replaceState(opened.state);
    const bodies = () => editable.rootDefinition.entities.bodies;
    expect(bodies().get(firstId)!.nativePropertyUnknownFields).toBe(bodies().get(secondId)!.nativePropertyUnknownFields);
    expect(bodies().get(firstId)!.nativePropertyUnknownFields).toEqual(doc.rootDefinition.entities.bodies.get(firstId)!.nativePropertyUnknownFields);
    const baseline = modelContentIdentity(editable.state);
    const edit = editable.transact('edit one shared owner', draft => {
      const body = draft.definitions.get(draft.rootDefinitionId)!.entities.bodies.get(firstId)!;
      body.hidden = true; body.nativePropertyUnknownFields!.fields = [new Uint8Array([0xa0, 6, 8])];
    });
    expect(bodies().get(secondId)!.hidden).toBe(false);
    expect(bodies().get(secondId)!.nativePropertyUnknownFields!.fields).toEqual(fields);
    const result = await openModelFile(await encodeModelSnapshot(editable.state, modelArchiveImages(editable.state, images)));
    expect(modelContentIdentity(result.state)).toBe(modelContentIdentity(editable.state));
    editable.applyPatches(edit.inversePatches, edit.patches, 'undo', 'edit one shared owner');
    expect(modelContentIdentity(editable.state)).toBe(baseline);
    const deletion = editable.transact('delete property owners', draft => {
      const e = draft.definitions.get(draft.rootDefinitionId)!.entities; e.bodies.clear(); e.order = [];
    });
    const empty = await encodeModelSnapshot(editable.state, modelArchiveImages(editable.state, images));
    expect((await readNativeModel({ size: empty.length, read: async (offset, length) => empty.subarray(offset, offset + length) })).properties.size).toBe(0);
    editable.applyPatches(deletion.inversePatches, deletion.patches, 'undo', 'delete property owners');
    expect(modelContentIdentity(editable.state)).toBe(baseline);
  });

  it.each(['inline', 'worker'])('borrows native proximity columns until vertex edits and restores them on undo: %s', async mode => {
    if (mode === 'worker') vi.stubGlobal('Worker', FakeWorker);
    const { doc, images } = modelWithImage();
    doc.transact('sheet edge', draft => SketchGraph.for(draft).addEdge([0, 0, 0], [1, 0, 0]));
    const opened = await openModelFile(await encodeModelSnapshot(doc.state, modelArchiveImages(doc.state, images)));
    const editable = createDocument(); editable.replaceState(opened.state);
    const sketch = () => editable.rootDefinition.entities.sketch;
    expect(sketch().vertexHash.size).toBe(0);
    expect(sketch().packedVertexIndex!.ids.length).toBe(2);
    const baseline = modelContentIdentity(editable.state), original = sketch().packedVertexIndex;
    let found: Id | undefined;
    editable.transact('lookup', draft => { found = SketchGraph.for(draft).findVertex([1, 0, 0]); });
    expect(found).toBeDefined(); expect(sketch().packedVertexIndex).toBe(original);
    const add = editable.transact('extend sheet', draft => SketchGraph.for(draft).addEdge([1, 0, 0], [2, 0, 0]));
    expect(sketch().vertices.size).toBe(3); expect(sketch().packedVertexIndex).toBeUndefined();
    expect(sketch().vertexHash.size).toBe(3);
    editable.applyPatches(add.inversePatches, add.patches, 'undo', 'extend sheet');
    expect(sketch().packedVertexIndex).toEqual(original); expect(sketch().vertexHash.size).toBe(0);
    expect(modelContentIdentity(editable.state)).toBe(baseline);
    const move = editable.transact('move vertex directly', draft => {
      draft.definitions.get(draft.rootDefinitionId)!.entities.sketch.vertices.get(found!)!.p = [3, 0, 0];
    });
    expect(sketch().packedVertexIndex).toBeUndefined();
    editable.transact('lookup moved vertex', draft => { expect(SketchGraph.for(draft).findVertex([3, 0, 0])).toBe(found); });
    const reopened = await openModelFile(await encodeModelSnapshot(editable.state, modelArchiveImages(editable.state, images)));
    expect(modelContentIdentity(reopened.state)).toBe(modelContentIdentity(editable.state));
    editable.applyPatches(move.inversePatches, move.patches, 'undo', 'move vertex');
    expect(modelContentIdentity(editable.state)).toBe(baseline);
    editable.applyPatches(move.patches, move.inversePatches, 'redo', 'move vertex');
    editable.transact('lookup after redo', draft => { expect(SketchGraph.for(draft).findVertex([3, 0, 0])).toBe(found); });
  });

  it.each(['inline', 'worker'])('preserves named attribute scopes and prunes removed owners atomically: %s', async mode => {
    if (mode === 'worker') vi.stubGlobal('Worker', FakeWorker);
    const { doc, images } = modelWithImage(), fields = [new Uint8Array([0xa0, 6, 7])];
    const id = [...doc.rootDefinition.entities.bodies.keys()][0]!;
    const dictionary = 'plugin/"data', root = `/${JSON.stringify(dictionary)}`, leaf = `${root}/object/"value"`;
    const paths = ['', `${root}/entry`, `${root}/object`, leaf, `${leaf}/entry`, `${leaf}/object`, `${leaf}/object/"child"/null`, `${root}/object/"list"/list`];
    doc.transact('future attributes', draft => {
      const body = draft.definitions.get(draft.rootDefinitionId)!.entities.bodies.get(id)! as unknown as Body;
      body.attributes = { [dictionary]: { value: { child: null }, list: [1, 2] } };
      body.nativePropertyUnknownFields = { attributes: new Map(paths.map(path => [path, fields])) };
    });
    const file = await encodeModelSnapshot(doc.state, modelArchiveImages(doc.state, images));
    const opened = await openModelFile(file), editable = createDocument(); editable.replaceState(opened.state);
    const body = () => editable.rootDefinition.entities.bodies.get(id)!;
    expect([...body().nativePropertyUnknownFields!.attributes!.keys()].sort()).toEqual([...paths].sort());
    const baseline = modelContentIdentity(editable.state), changes = vi.fn(); editable.events.on('change', changes);
    const edit = editable.transact('replace attribute value', draft => {
      const value = draft.definitions.get(draft.rootDefinitionId)!.entities.bodies.get(id)! as unknown as Body;
      value.attributes[dictionary]!.value = 'changed';
      (value.attributes[dictionary]!.list as number[]).reverse();
    });
    expect(changes).toHaveBeenCalledTimes(1);
    expect(body().nativePropertyUnknownFields!.attributes!.has(leaf)).toBe(true);
    expect(body().nativePropertyUnknownFields!.attributes!.has(`${leaf}/object`)).toBe(false);
    expect(body().nativePropertyUnknownFields!.attributes!.has(`${leaf}/object/"child"/null`)).toBe(false);
    const rewritten = await openModelFile(await encodeModelSnapshot(editable.state, modelArchiveImages(editable.state, images)));
    expect(modelContentIdentity(rewritten.state)).toBe(modelContentIdentity(editable.state));
    editable.applyPatches(edit.inversePatches, edit.patches, 'undo', 'attribute edit');
    expect(modelContentIdentity(editable.state)).toBe(baseline);
    const deletion = editable.transact('remove dictionary', draft => {
      const value = draft.definitions.get(draft.rootDefinitionId)!.entities.bodies.get(id)! as unknown as Body;
      delete value.attributes[dictionary];
    });
    expect([...body().nativePropertyUnknownFields!.attributes!.keys()]).toEqual(['']);
    const removed = await openModelFile(await encodeModelSnapshot(editable.state, modelArchiveImages(editable.state, images)));
    expect(modelContentIdentity(removed.state)).toBe(modelContentIdentity(editable.state));
    editable.applyPatches(deletion.inversePatches, deletion.patches, 'undo', 'dictionary removal');
    expect(modelContentIdentity(editable.state)).toBe(baseline);
  });

  it('rejects indexed attribute extensions until list-element ownership can be preserved', async () => {
    const { doc, images } = modelWithImage();
    doc.transact('indexed extension', draft => {
      const body = [...draft.definitions.get(draft.rootDefinitionId)!.entities.bodies.values()][0]! as unknown as Body;
      body.attributes = { data: { list: [1] } };
      body.nativePropertyUnknownFields = { attributes: new Map([['/"data"/object/"list"/list/0', [new Uint8Array([0xa0, 6, 7])]]]) };
    });
    await expect(openModelFile(await encodeModelSnapshot(doc.state, modelArchiveImages(doc.state, images)))).rejects.toThrow('cannot preserve');
  });

  it.each(['inline', 'worker'])('preserves Layout layer and reference metadata through copies, target changes and undo: %s', async mode => {
    if (mode === 'worker') vi.stubGlobal('Worker', FakeWorker);
    const doc = createLayoutDocument(), fields = [new Uint8Array([0xa0, 6, 7])];
    const { layerId, referenceId } = doc.transact('future Layout catalogs', draft => {
      const layerId = draft.meta.nextId++, referenceId = draft.meta.nextId++;
      draft.layers.set(layerId, { id: layerId, name: 'Future', visible: true, locked: false, shared: false,
        nativeUnknownFields: { envelopeUnknown: fields, unknownFields: fields } }); draft.layerOrder.push(layerId);
      draft.references.set(referenceId, { id: referenceId, displayName: 'Model', nativeUnknownFields: { envelopeUnknown: fields, unknownFields: fields },
        target: { kind: 'path', path: 'model.pf', contentHash: null, nativeUnknownFields: fields } });
      return { layerId, referenceId };
    }).value;
    const opened = await openLayoutFile(await encodeLayoutSnapshot(doc.state)), editable = new LayoutDocument(opened.state);
    expect(opened.state).toEqual(doc.state);
    const baseline = layoutContentIdentity(editable.state);
    const edit = editable.transact('copy and change targets', draft => {
      const layer = draft.layers.get(layerId)!, reference = draft.references.get(referenceId)!;
      const copyLayer = draft.meta.nextId++, copyReference = draft.meta.nextId++;
      draft.layers.set(copyLayer, { ...layer, id: copyLayer }); draft.layerOrder.unshift(copyLayer);
      draft.references.set(copyReference, { ...reference, id: copyReference });
      layer.name = 'Renamed'; layer.visible = false;
      reference.displayName = 'Cloud model';
      reference.target = { kind: 'cloud', documentId: 'document', revisionId: 'revision', revisionNumber: 1, sha256: 'a'.repeat(64), pinned: true };
      return { copyLayer, copyReference };
    });
    const saved = await openLayoutFile(await encodeLayoutSnapshot(editable.state));
    expect(layoutContentIdentity(saved.state)).toBe(layoutContentIdentity(editable.state));
    expect(saved.state.references.get(referenceId)!.target.nativeUnknownFields).toBeUndefined();
    expect(saved.state.references.get(edit.value.copyReference)!.target.nativeUnknownFields).toEqual(fields);
    expect(saved.state.layers.get(edit.value.copyLayer)!.nativeUnknownFields).toEqual({ envelopeUnknown: fields, unknownFields: fields });
    editable.applyPatches(edit.inversePatches, edit.patches, 'undo', 'copy and change targets');
    expect(layoutContentIdentity(editable.state)).toBe(baseline);
    const removal = editable.transact('delete catalog owners', draft => {
      draft.layers.delete(layerId); draft.layerOrder = draft.layerOrder.filter(id => id !== layerId); draft.references.delete(referenceId);
    });
    const deleted = await openLayoutFile(await encodeLayoutSnapshot(editable.state));
    expect(deleted.state.layers.has(layerId)).toBe(false); expect(deleted.state.references.has(referenceId)).toBe(false);
    editable.applyPatches(removal.inversePatches, removal.patches, 'undo', 'delete catalog owners');
    expect(layoutContentIdentity(editable.state)).toBe(baseline);
  });

  it.each(['inline', 'worker'])('retains Layout settings and moves default-arrow metadata with its owner: %s', async mode => {
    if (mode === 'worker') vi.stubGlobal('Worker', FakeWorker);
    const doc = createLayoutDocument(), a = [new Uint8Array([0xa0, 6, 7])], b = [new Uint8Array([0xa0, 6, 8])];
    doc.transact('future document metadata', draft => {
      draft.nativeDocumentUnknownFields = { records: new Map(['', 'pageOrder', 'layerOrder', 'sharedEntityOrder'].map(key => [key, a])),
        metadata: { records: new Map([['', a], ['meta', a]]), settings: new Map([['', a], ['grid', a]]), style: new Map([['', a]]) } };
      draft.defaultStyle.startArrow = { type: 'filled-circle', sizePt: 4, nativeUnknownFields: a };
      draft.defaultStyle.endArrow = { type: 'open-circle', sizePt: 8, nativeUnknownFields: b };
    });
    const editable = new LayoutDocument((await openLayoutFile(await encodeLayoutSnapshot(doc.state))).state);
    expect(editable.state).toEqual(doc.state);
    const baseline = layoutContentIdentity(editable.state);
    const edit = editable.transact('edit settings and swap arrows', draft => {
      draft.settings.grid.spacingMm = 20; draft.settings.grid.snap = false; draft.defaultStyle.strokeWeightPt = 2;
      const start = draft.defaultStyle.startArrow!; draft.defaultStyle.startArrow = draft.defaultStyle.endArrow!; draft.defaultStyle.endArrow = start;
    });
    const saved = await openLayoutFile(await encodeLayoutSnapshot(editable.state));
    expect(layoutContentIdentity(saved.state)).toBe(layoutContentIdentity(editable.state));
    expect(saved.state.defaultStyle.startArrow!.nativeUnknownFields).toEqual(b);
    expect(saved.state.defaultStyle.endArrow!.nativeUnknownFields).toEqual(a);
    editable.applyPatches(edit.inversePatches, edit.patches, 'undo', 'edit settings and swap arrows');
    expect(layoutContentIdentity(editable.state)).toBe(baseline);
    editable.transact('undefined arrow wrapper', draft => {
      Reflect.set(draft.defaultStyle, 'startArrow', undefined);
      draft.nativeDocumentUnknownFields!.metadata.style.set('startArrow', b);
    });
    expect((await openLayoutFile(await encodeLayoutSnapshot(editable.state))).state).toEqual(editable.state);
    const removal = editable.transact('remove arrow wrapper', draft => { delete draft.defaultStyle.startArrow; });
    expect(editable.state.nativeDocumentUnknownFields!.metadata.style.has('startArrow')).toBe(false);
    editable.applyPatches(removal.inversePatches, removal.patches, 'undo', 'remove arrow wrapper');
    expect(editable.state.nativeDocumentUnknownFields!.metadata.style.get('startArrow')).toEqual(b);
  });

  it.each(['inline', 'worker'])('retains Layout page fields and removes deleted visibility owners atomically: %s', async mode => {
    if (mode === 'worker') vi.stubGlobal('Worker', FakeWorker);
    const doc = createLayoutDocument(), fields = [new Uint8Array([0xa0, 6, 7])], pageId = doc.state.pageOrder[0]!, layerId = doc.state.activeLayerId;
    doc.transact('future page', draft => {
      const page = draft.pages.get(pageId)!;
      page.layerVisibility = new Map([[layerId, false]]);
      page.nativeUnknownFields = { envelopeUnknown: fields, extensions: new Map(
        ['', 'margin', 'entityOrder', 'layerVisibility', `visibility/${layerId}`].map(key => [key, fields])) };
    });
    const editable = new LayoutDocument((await openLayoutFile(await encodeLayoutSnapshot(doc.state))).state);
    expect(editable.state).toEqual(doc.state);
    const baseline = layoutContentIdentity(editable.state);
    let events = 0; const off = editable.events.on('change', () => { events++; });
    const copy = structuredClone(editable.state.pages.get(pageId)!);
    const edit = editable.transact('copy and edit page', draft => {
      const page = draft.pages.get(pageId)!, id = draft.meta.nextId++;
      draft.pages.set(id, { ...copy, id }); draft.pageOrder.unshift(id);
      page.name = 'Changed'; page.margin.left = 12; page.layerVisibility!.delete(layerId);
      return id;
    });
    expect(events).toBe(1); off();
    expect(editable.state.pages.get(pageId)!.nativeUnknownFields!.extensions!.has(`visibility/${layerId}`)).toBe(false);
    expect(editable.state.pages.get(edit.value)!.nativeUnknownFields!.extensions!.has(`visibility/${layerId}`)).toBe(true);
    expect((await openLayoutFile(await encodeLayoutSnapshot(editable.state))).state).toEqual(editable.state);
    editable.applyPatches(edit.inversePatches, edit.patches, 'undo', 'copy and edit page');
    expect(layoutContentIdentity(editable.state)).toBe(baseline);
    const remove = editable.transact('remove visibility', draft => { delete draft.pages.get(pageId)!.layerVisibility; });
    expect([...editable.state.pages.get(pageId)!.nativeUnknownFields!.extensions!.keys()]).toEqual(['', 'margin', 'entityOrder']);
    editable.applyPatches(remove.inversePatches, remove.patches, 'undo', 'remove visibility');
    expect(layoutContentIdentity(editable.state)).toBe(baseline);
  });

  it.each(['inline', 'worker'])('retains Layout custom and numbering fields through replacement and deletion: %s', async mode => {
    if (mode === 'worker') vi.stubGlobal('Worker', FakeWorker);
    const doc = createLayoutDocument(), fields = [new Uint8Array([0xa0, 6, 7])];
    doc.transact('future named fields', draft => {
      draft.customFields.set('ProjectName', 'Garage');
      draft.pageNumberFields = new Map([['PageNumber', { startPageId: null, startNumber: 1, style: 'arabic' }]]);
      draft.nativeFieldUnknownFields = { custom: new Map([['ProjectName', { envelopeUnknown: fields, unknownFields: fields }]]),
        numbering: new Map([['PageNumber', { envelopeUnknown: fields, unknownFields: fields }]]) };
    });
    const editable = new LayoutDocument((await openLayoutFile(await encodeLayoutSnapshot(doc.state))).state);
    expect(editable.state).toEqual(doc.state);
    const baseline = layoutContentIdentity(editable.state);
    const edit = editable.transact('replace named values', draft => {
      draft.customFields.set('ProjectName', 'Garage V3');
      draft.pageNumberFields!.set('PageNumber', { startPageId: draft.pageOrder[0]!, startNumber: 3, style: 'upper-roman' });
    });
    const reopened = await openLayoutFile(await encodeLayoutSnapshot(editable.state));
    expect(reopened.state).toEqual(editable.state);
    expect(reopened.state.nativeFieldUnknownFields).toEqual(doc.state.nativeFieldUnknownFields);
    editable.applyPatches(edit.inversePatches, edit.patches, 'undo', 'replace named values');
    expect(layoutContentIdentity(editable.state)).toBe(baseline);
    let events = 0; const off = editable.events.on('change', () => { events++; });
    const deletion = editable.transact('delete named fields', draft => { draft.customFields.delete('ProjectName'); delete draft.pageNumberFields; });
    expect(events).toBe(1); off();
    expect(editable.state.nativeFieldUnknownFields).toBeUndefined();
    expect((await openLayoutFile(await encodeLayoutSnapshot(editable.state))).state.nativeFieldUnknownFields).toBeUndefined();
    editable.applyPatches(deletion.inversePatches, deletion.patches, 'undo', 'delete named fields');
    expect(layoutContentIdentity(editable.state)).toBe(baseline);
  });

  it.each(['inline', 'worker'])('retains Layout archive metadata with source mappings and exact bytes: %s', async mode => {
    if (mode === 'worker') vi.stubGlobal('Worker', FakeWorker);
    const doc = createLayoutDocument(), fields = [new Uint8Array([0xa0, 6, 7])], extra = { envelopeUnknown: fields, unknownFields: fields };
    doc.transact('future archive', draft => {
      draft.modelArchives = new Map([['archive', { format: 'sketchup-layout', archiveBase64: 'AAEC', annotationConnectionsVersion: 1, nativeUnknownFields: extra, nativeAssetFields: extra,
        models: new Map([['model', { internalTarget: 'model.skp', externalTarget: null, nativeUnknownFields: extra }]]),
        viewports: new Map([['viewport', { modelReferenceId: 'model', entityIds: [99, 99, 3], nativeUnknownFields: extra }]]) }]]);
    });
    const editable = new LayoutDocument((await openLayoutFile(await encodeLayoutSnapshot(doc.state))).state);
    expect(editable.state).toEqual(doc.state);
    const baseline = layoutContentIdentity(editable.state), copy = structuredClone(editable.state.modelArchives!.get('archive')!);
    const edit = editable.transact('copy and update archive mapping', draft => {
      const archive = draft.modelArchives!.get('archive')!;
      draft.modelArchives!.set('copy', copy);
      archive.models.get('model')!.externalTarget = 'relocated.skp';
      archive.viewports.get('viewport')!.entityIds = [3, 99];
    });
    const reopened = await openLayoutFile(await encodeLayoutSnapshot(editable.state));
    expect(reopened.state).toEqual(editable.state);
    expect(reopened.state.modelArchives!.get('archive')!.archiveBase64).toBe('AAEC');
    expect(reopened.state.modelArchives!.get('copy')!.viewports.get('viewport')!.entityIds).toEqual([99, 99, 3]);
    editable.applyPatches(edit.inversePatches, edit.patches, 'undo', 'copy and update archive mapping');
    expect(layoutContentIdentity(editable.state)).toBe(baseline);
    const deletion = editable.transact('delete archive mappings', draft => {
      const archive = draft.modelArchives!.get('archive')!; archive.models.delete('model'); archive.viewports.delete('viewport');
    });
    const deleted = await openLayoutFile(await encodeLayoutSnapshot(editable.state));
    expect(deleted.state.modelArchives!.get('archive')!.models.size).toBe(0);
    expect(deleted.state.modelArchives!.get('archive')!.viewports.size).toBe(0);
    editable.applyPatches(deletion.inversePatches, deletion.patches, 'undo', 'delete archive mappings');
    expect(layoutContentIdentity(editable.state)).toBe(baseline);
    const removal = editable.transact('remove archives', draft => { delete draft.modelArchives; });
    expect((await openLayoutFile(await encodeLayoutSnapshot(editable.state))).state.modelArchives).toBeUndefined();
    editable.applyPatches(removal.inversePatches, removal.patches, 'undo', 'remove archives');
    expect(layoutContentIdentity(editable.state)).toBe(baseline);
  });

  it.each(['inline', 'worker'])('retains Layout geometry metadata for page and shared entities: %s', async mode => {
    if (mode === 'worker') vi.stubGlobal('Worker', FakeWorker);
    const doc = createLayoutDocument(), fields = [new Uint8Array([0xa0, 6, 7])], pageId = doc.state.pageOrder[0]!;
    const ids = doc.transact('future geometry fields', draft => {
      const layerId = draft.meta.nextId++;
      draft.layers.set(layerId, { id: layerId, name: 'Shared', visible: true, locked: false, shared: true }); draft.layerOrder.push(layerId);
      return [false, true].map(shared => {
        const id = draft.meta.nextId++, page = draft.pages.get(pageId)!;
        (shared ? draft.sharedEntities : page.entities).set(id, { id, layerId: shared ? layerId : draft.activeLayerId, kind: 'path', closed: true,
          points: [[0, 0], [10, 0], [10, 10], [20, 0], [20, 10]], handles: [{}, {}, {}, {}, {}], contourStarts: [0, 3], openContours: [1],
          nativeUnknownFields: { outerHeader: fields, headerEnvelope: fields, header: fields,
            geometry: new Map(['', 'points', 'handleFlags', 'handleValues', 'contourStarts', 'openContours'].map(key => [key, fields])) } });
        (shared ? draft.sharedEntityOrder : page.entityOrder).push(id); return id;
      });
    }).value;
    const editable = new LayoutDocument((await openLayoutFile(await encodeLayoutSnapshot(doc.state))).state);
    expect(editable.state).toEqual(doc.state);
    const baseline = layoutContentIdentity(editable.state);
    let events = 0; const off = editable.events.on('change', () => { events++; });
    const edit = editable.transact('edit native geometry', draft => {
      for (const entity of [draft.pages.get(pageId)!.entities.get(ids[0]!)!, draft.sharedEntities.get(ids[1]!)!]) {
        entity.points[1] = [20, 15]; delete entity.handles; delete entity.contourStarts; delete entity.openContours;
      }
    });
    expect(events).toBe(1); off();
    for (const entity of [editable.state.pages.get(pageId)!.entities.get(ids[0]!)!, editable.state.sharedEntities.get(ids[1]!)!]) {
      expect([...entity.nativeUnknownFields!.geometry!.keys()]).toEqual(['', 'points']);
    }
    expect((await openLayoutFile(await encodeLayoutSnapshot(editable.state))).state).toEqual(editable.state);
    editable.applyPatches(edit.inversePatches, edit.patches, 'undo', 'edit native geometry');
    expect(layoutContentIdentity(editable.state)).toBe(baseline);
    const deletion = editable.transact('delete geometry owners', draft => {
      const page = draft.pages.get(pageId)!; page.entities.clear(); page.entityOrder = []; draft.sharedEntities.clear(); draft.sharedEntityOrder = [];
    });
    expect((await openLayoutFile(await encodeLayoutSnapshot(editable.state))).state).toEqual(editable.state);
    editable.applyPatches(deletion.inversePatches, deletion.patches, 'undo', 'delete geometry owners');
    expect(layoutContentIdentity(editable.state)).toBe(baseline);
  });

  it.each(['inline', 'worker'])('preserves Layout descriptive fields and copied style ownership: %s', async mode => {
    if (mode === 'worker') vi.stubGlobal('Worker', FakeWorker);
    const doc = createLayoutDocument(), a = [new Uint8Array([0xa0, 6, 7])], b = [new Uint8Array([0xa0, 6, 8])], pageId = doc.state.pageOrder[0]!;
    const id = doc.transact('future entity metadata', draft => {
      const id = draft.meta.nextId++, groupId = draft.meta.nextId++, outerGroup = draft.meta.nextId++, page = draft.pages.get(pageId)!;
      page.entities.set(id, { id, kind: 'path', layerId: draft.activeLayerId, points: [[0, 0], [1, 1]], closed: false,
        name: 'Named path', groupId, nestedGroupIds: [outerGroup],
        nativeUnknownFields: { metadata: new Map(['', 'name', 'nestedGroupIds', 'style'].map(key => [key, a])) },
        style: { strokeColor: '#000000', strokeWeightPt: 1, fillColor: null, strokeDashMm: [1, 1],
          startArrow: { type: 'filled-circle', sizePt: 4, nativeUnknownFields: a }, endArrow: { type: 'open-circle', sizePt: 6, nativeUnknownFields: b },
          nativeUnknownFields: { records: new Map([['style/value', a], ['style/dash', a]]), style: new Map([['', a]]) } } });
      page.entityOrder.push(id); return id;
    }).value;
    const editable = new LayoutDocument((await openLayoutFile(await encodeLayoutSnapshot(doc.state))).state);
    expect(editable.state).toEqual(doc.state);
    const get = () => editable.state.pages.get(pageId)!.entities.get(id)!;
    const baseline = layoutContentIdentity(editable.state), copiedStyle = structuredClone(get().style!);
    const edit = editable.transact('edit and copy style', draft => {
      const page = draft.pages.get(pageId)!, entity = page.entities.get(id)!, copyId = draft.meta.nextId++;
      page.entities.set(copyId, { id: copyId, layerId: draft.activeLayerId, kind: 'path', points: [[2, 0], [3, 1]], closed: false, style: copiedStyle }); page.entityOrder.push(copyId);
      entity.name = 'Renamed'; entity.hidden = true;
      const style = entity.style!, start = style.startArrow!; style.startArrow = style.endArrow!; style.endArrow = start; delete style.strokeDashMm;
      return copyId;
    });
    expect(get().style!.nativeUnknownFields!.records.has('style/dash')).toBe(false);
    const saved = await openLayoutFile(await encodeLayoutSnapshot(editable.state));
    expect(saved.state).toEqual(editable.state);
    expect(saved.state.pages.get(pageId)!.entities.get(edit.value)!.style).toEqual(copiedStyle);
    expect(get().style!.startArrow!.nativeUnknownFields).toEqual(b);
    editable.applyPatches(edit.inversePatches, edit.patches, 'undo', 'edit and copy style');
    expect(layoutContentIdentity(editable.state)).toBe(baseline);
    const removal = editable.transact('remove optional records', draft => {
      const entity = draft.pages.get(pageId)!.entities.get(id)!; delete entity.name; delete entity.style; delete entity.nestedGroupIds; delete entity.groupId;
    });
    expect([...get().nativeUnknownFields!.metadata!.keys()]).toEqual(['']);
    expect((await openLayoutFile(await encodeLayoutSnapshot(editable.state))).state).toEqual(editable.state);
    editable.applyPatches(removal.inversePatches, removal.patches, 'undo', 'remove optional records');
    expect(layoutContentIdentity(editable.state)).toBe(baseline);
  });

  it.each(['inline', 'worker'])('retains Layout text fields with reordered rich spans and removed formatting: %s', async mode => {
    if (mode === 'worker') vi.stubGlobal('Worker', FakeWorker);
    const doc = createLayoutDocument(), a = [new Uint8Array([0xa0, 6, 7])], b = [new Uint8Array([0xa0, 6, 8])], pageId = doc.state.pageOrder[0]!;
    const id = doc.transact('future text', draft => {
      const id = draft.meta.nextId++, page = draft.pages.get(pageId)!;
      page.entities.set(id, { id, kind: 'text', layerId: draft.activeLayerId, points: [[0, 0], [20, 10]], closed: false,
        text: { content: 'Text', fontFamily: 'Arial', fontSizePt: 12, color: '#000000', bold: false, italic: false, underline: false,
          align: 'left', vertical: 'top', bounded: true, leader: 'none', endpoint: 'none', rotationDeg: 0, tabStopsPt: [10],
          lineSpacing: { mode: 'multiple', value: 1.2, nativeUnknownFields: a },
          nativeUnknownFields: { outerEnvelope: a, envelope: b, extensions: new Map(['', 'spans', 'lineSpacing', 'tabStopsPt', 'rotationDeg'].map(key => [key, a])) },
          spans: [{ start: 0, end: 2, bold: true, italic: false, underline: false, fontFamily: 'Arial', nativeUnknownFields: new Map([['', a], ['fontFamily', a]]) },
            { start: 2, end: 4, bold: false, italic: true, underline: false, nativeUnknownFields: new Map([['', b]]) }] } });
      page.entityOrder.push(id); return id;
    }).value;
    const editable = new LayoutDocument((await openLayoutFile(await encodeLayoutSnapshot(doc.state))).state);
    expect(editable.state).toEqual(doc.state);
    const baseline = layoutContentIdentity(editable.state);
    const formatting = editable.transact('format reopened native text', draft => {
      const text = draft.pages.get(pageId)!.entities.get(id)!.text!;
      Object.assign(text, formatLayoutTextRange(text, { start: 1, end: 3 }, { bold: true, fontFamily: 'Arial' }));
    });
    expect((await openLayoutFile(await encodeLayoutSnapshot(editable.state))).state).toEqual(editable.state);
    editable.applyPatches(formatting.inversePatches, formatting.patches, 'undo', 'format reopened native text');
    expect(layoutContentIdentity(editable.state)).toBe(baseline);
    const edit = editable.transact('reorder spans and remove formatting', draft => {
      const text = draft.pages.get(pageId)!.entities.get(id)!.text!;
      text.content = 'Edited text'; text.spans = [text.spans![1]!, text.spans![0]!]; delete text.spans[1]!.fontFamily;
      delete text.rotationDeg; delete text.tabStopsPt; delete text.lineSpacing;
    });
    const saved = await openLayoutFile(await encodeLayoutSnapshot(editable.state)), text = saved.state.pages.get(pageId)!.entities.get(id)!.text!;
    expect(saved.state).toEqual(editable.state);
    expect(text.spans!.map(span => span.nativeUnknownFields!.get(''))).toEqual([b, a]);
    expect(text.spans![1]!.nativeUnknownFields!.has('fontFamily')).toBe(false);
    expect([...text.nativeUnknownFields!.extensions!.keys()]).toEqual(['', 'spans']);
    editable.applyPatches(edit.inversePatches, edit.patches, 'undo', 'reorder spans and remove formatting');
    expect(layoutContentIdentity(editable.state)).toBe(baseline);
    const deletion = editable.transact('delete text', draft => { const page = draft.pages.get(pageId)!; page.entities.delete(id); page.entityOrder = []; });
    expect((await openLayoutFile(await encodeLayoutSnapshot(editable.state))).state).toEqual(editable.state);
    editable.applyPatches(deletion.inversePatches, deletion.patches, 'undo', 'delete text');
    expect(layoutContentIdentity(editable.state)).toBe(baseline);
  });

  it.each(['inline', 'worker'])('retains native table owners through row insertion, formatting and undo: %s', async mode => {
    if (mode === 'worker') vi.stubGlobal('Worker', FakeWorker);
    const doc = createLayoutDocument(), a = [new Uint8Array([0xa0, 6, 7])], b = [new Uint8Array([0xa0, 6, 8])], pageId = doc.state.pageOrder[0]!;
    const id = doc.transact('future table', draft => {
      const id = draft.meta.nextId++, page = draft.pages.get(pageId)!, table = createLayoutTable(2, 2);
      table.nativeUnknownFields = { envelope: a, outerEnvelope: b, extensions: new Map([['', a], ['rowEdges', b]]) };
      table.merges = [{ row: 0, column: 0, rowSpan: 1, columnSpan: 2, nativeUnknownFields: b }];
      table.rowEdges = [{ strokeColor: '#000000', strokeWeightPt: 1, nativeUnknownFields: a }];
      table.columnEdges = [{ strokeColor: '#123456', strokeWeightPt: 2, nativeUnknownFields: b }];
      const cell = table.cells[0]!;
      cell.fillColor = '#ffffff'; cell.nativeUnknownFields = { envelope: b, outerEnvelope: a, extensions: new Map([['', a], ['fillColor', b]]) };
      cell.text.content = 'Table'; cell.text.nativeUnknownFields = { extensions: new Map([['', a], ['spans', b]]) };
      cell.text.spans = [{ start: 0, end: 5, bold: true, italic: false, underline: false, nativeUnknownFields: new Map([['', b]]) }];
      page.entities.set(id, { id, kind: 'table', layerId: draft.activeLayerId, points: [[0, 0], [20, 0], [20, 10], [0, 10]], closed: true, table });
      page.entityOrder.push(id); return id;
    }).value;
    const editable = new LayoutDocument((await openLayoutFile(await encodeLayoutSnapshot(doc.state))).state);
    expect(editable.state).toEqual(doc.state);
    const baseline = layoutContentIdentity(editable.state), get = () => editable.state.pages.get(pageId)!.entities.get(id)!.table!;
    const edit = editable.transact('insert row and edit cell', draft => {
      const entity = draft.pages.get(pageId)!.entities.get(id)!;
      entity.table = editTableAxis(entity.table!, 'row', 0, false);
      const cell = entity.table.cells[2]!;
      Object.assign(cell.text, formatLayoutTextRange(cell.text, { start: 1, end: 4 }, { italic: true }));
      delete cell.fillColor; delete entity.table.rowEdges;
    });
    expect(get().merges[0]!.row).toBe(1);
    expect(get().merges[0]!.nativeUnknownFields).toEqual(b);
    expect(get().columnEdges![0]!.nativeUnknownFields).toEqual(b);
    expect(get().cells[0]!.nativeUnknownFields).toBeUndefined();
    expect(get().cells[2]!.nativeUnknownFields!.extensions!.has('fillColor')).toBe(false);
    expect(get().nativeUnknownFields!.extensions!.has('rowEdges')).toBe(false);
    expect((await openLayoutFile(await encodeLayoutSnapshot(editable.state))).state).toEqual(editable.state);
    editable.applyPatches(edit.inversePatches, edit.patches, 'undo', 'insert row and edit cell');
    expect(layoutContentIdentity(editable.state)).toBe(baseline);
    const deletion = editable.transact('delete table', draft => { const page = draft.pages.get(pageId)!; page.entities.delete(id); page.entityOrder = []; });
    expect((await openLayoutFile(await encodeLayoutSnapshot(editable.state))).state).toEqual(editable.state);
    editable.applyPatches(deletion.inversePatches, deletion.patches, 'undo', 'delete table');
    expect(layoutContentIdentity(editable.state)).toBe(baseline);
  });

  it.each(['inline', 'worker'])('retains dimension metadata with moved anchors, ray definitions and undo: %s', async mode => {
    if (mode === 'worker') vi.stubGlobal('Worker', FakeWorker);
    const doc = createLayoutDocument(), a = [new Uint8Array([0xa0, 6, 7])], b = [new Uint8Array([0xa0, 6, 8])], pageId = doc.state.pageOrder[0]!;
    const ids = doc.transact('future dimensions', draft => {
      const page = draft.pages.get(pageId)!, ids: number[] = [];
      const anchor = () => ({ entityId: 999, pointIndex: 0, pointCount: 2, t: 0.5,
        nativeUnknownFields: { wrapper: a, extensions: new Map([['', b], ['t', a]]) } });
      for (const kind of ['linear', 'edges', 'rays']) {
        const id = draft.meta.nextId++; ids.push(id);
        if (kind === 'linear') {
          const dimension = createLinearDimension(); dimension.anchors = [anchor(), null]; dimension.scale = 0.02;
          dimension.nativeUnknownFields = { envelope: a, outerEnvelope: b, extensions: new Map(['', 'anchors', 'anchors/1', 'scale'].map(key => [key, a])) };
          page.entities.set(id, { id, kind: 'dimension', layerId: draft.activeLayerId, points: [[0, 0], [10, 0], [5, 5]], closed: false, dimension });
        } else {
          const angularDimension = createAngularDimension();
          angularDimension.nativeUnknownFields = { envelope: b, outerEnvelope: a, extensions: new Map([['', a], [kind === 'edges' ? 'edgeAnchors' : 'rayDefinition', b]]) };
          if (kind === 'edges') angularDimension.edgeAnchors = [
            { entityId: 999, segmentIndex: 0, pointCount: 2, direction: 1, nativeUnknownFields: a },
            { entityId: 998, segmentIndex: 0, pointCount: 2, direction: -1, nativeUnknownFields: b },
          ];
          else angularDimension.rayDefinition = { points: [[0, 0], [1, 0], [0, 0], [0, 1]], anchors: [anchor(), null, null, null],
            nativeUnknownFields: new Map([['', a], ['anchors', b], ['anchors/1', a]]) };
          page.entities.set(id, { id, kind: 'angular-dimension', layerId: draft.activeLayerId, points: [[0, 0], [10, 0], [0, 10], [5, 5]], closed: false, angularDimension });
        }
        page.entityOrder.push(id);
      }
      return ids;
    }).value;
    const editable = new LayoutDocument((await openLayoutFile(await encodeLayoutSnapshot(doc.state))).state);
    expect(editable.state).toEqual(doc.state);
    const baseline = layoutContentIdentity(editable.state);
    const edit = editable.transact('move anchors and remove scale', draft => {
      const page = draft.pages.get(pageId)!, linear = page.entities.get(ids[0]!)!.dimension!;
      linear.anchors = [null, linear.anchors[0]]; delete linear.anchors[1]!.t; delete linear.scale; linear.text = 'Updated <>';
      const angular = page.entities.get(ids[1]!)!.angularDimension!, edges = angular.edgeAnchors!;
      angular.edgeAnchors = [edges[1], edges[0]];
      const ray = page.entities.get(ids[2]!)!.angularDimension!.rayDefinition!;
      ray.anchors = [null, ray.anchors[0], null, null]; ray.points[0] = [2, 3];
    });
    const linear = editable.state.pages.get(pageId)!.entities.get(ids[0]!)!.dimension!;
    expect(linear.nativeUnknownFields!.extensions!.has('anchors/1')).toBe(false);
    expect(linear.nativeUnknownFields!.extensions!.has('scale')).toBe(false);
    expect(linear.anchors[1]!.nativeUnknownFields!.extensions!.has('t')).toBe(false);
    expect((await openLayoutFile(await encodeLayoutSnapshot(editable.state))).state).toEqual(editable.state);
    editable.applyPatches(edit.inversePatches, edit.patches, 'undo', 'move anchors and remove scale');
    expect(layoutContentIdentity(editable.state)).toBe(baseline);
    const removal = editable.transact('remove angular attachment records', draft => {
      const page = draft.pages.get(pageId)!;
      delete page.entities.get(ids[1]!)!.angularDimension!.edgeAnchors;
      delete page.entities.get(ids[2]!)!.angularDimension!.rayDefinition;
    });
    expect((await openLayoutFile(await encodeLayoutSnapshot(editable.state))).state).toEqual(editable.state);
    editable.applyPatches(removal.inversePatches, removal.patches, 'undo', 'remove angular attachment records');
    expect(layoutContentIdentity(editable.state)).toBe(baseline);
  });

  it.each(['inline', 'worker'])('retains label attachment fields through moves, detachment and undo: %s', async mode => {
    if (mode === 'worker') vi.stubGlobal('Worker', FakeWorker);
    const doc = createLayoutDocument(), a = [new Uint8Array([0xa0, 6, 7])], b = [new Uint8Array([0xa0, 6, 8])], pageId = doc.state.pageOrder[0]!;
    const id = doc.transact('future label', draft => {
      const page = draft.pages.get(pageId)!, sourceId = draft.meta.nextId++, id = draft.meta.nextId++;
      page.entities.set(sourceId, { id: sourceId, kind: 'path', layerId: draft.activeLayerId, points: [[0, 0], [10, 0]], closed: false });
      const text = createLayoutTable(1, 1).cells[0]!.text; text.content = 'Attached'; text.leader = 'straight';
      page.entities.set(id, { id, kind: 'label', layerId: draft.activeLayerId, points: [[10, 10], [30, 20], [5, 0]], closed: false, text,
        labelAnchor: { entityId: sourceId, pointIndex: 0, pointCount: 2, t: 0.5,
          nativeUnknownFields: { envelope: a, outerEnvelope: b, extensions: new Map([['', a], ['t', b]]) } } });
      page.entityOrder.push(sourceId, id); return id;
    }).value;
    const editable = new LayoutDocument((await openLayoutFile(await encodeLayoutSnapshot(doc.state))).state);
    expect(editable.state).toEqual(doc.state);
    const baseline = layoutContentIdentity(editable.state), get = () => editable.state.pages.get(pageId)!.entities.get(id)!;
    const edit = editable.transact('move label text', draft => {
      const page = draft.pages.get(pageId)!, moved = moveLayoutLabel(page.entities.get(id)!, [2, 3], 'text');
      delete moved.labelAnchor!.t; page.entities.set(id, moved);
    });
    expect(get().labelAnchor!.nativeUnknownFields!.extensions!.has('t')).toBe(false);
    expect((await openLayoutFile(await encodeLayoutSnapshot(editable.state))).state).toEqual(editable.state);
    editable.applyPatches(edit.inversePatches, edit.patches, 'undo', 'move label text');
    expect(layoutContentIdentity(editable.state)).toBe(baseline);
    const detach = editable.transact('detach label tip', draft => {
      const page = draft.pages.get(pageId)!; page.entities.set(id, moveLayoutLabel(page.entities.get(id)!, [1, 1], 'tip'));
    });
    expect(get().labelAnchor).toBeUndefined();
    expect((await openLayoutFile(await encodeLayoutSnapshot(editable.state))).state).toEqual(editable.state);
    editable.applyPatches(detach.inversePatches, detach.patches, 'undo', 'detach label tip');
    expect(layoutContentIdentity(editable.state)).toBe(baseline);
  });

  it.each(['inline', 'worker'])('preserves empty payload envelopes until replacement or removal: %s', async mode => {
    if (mode === 'worker') vi.stubGlobal('Worker', FakeWorker);
    const doc = createLayoutDocument(), a = [new Uint8Array([0xa0, 6, 7])], b = [new Uint8Array([0xa0, 6, 8])], pageId = doc.state.pageOrder[0]!;
    const keys = ['table', 'image', 'dimension', 'angularDimension', 'text', 'labelAnchor', 'modelAnnotation', 'preservedModelConnections'] as const;
    const id = doc.transact('future empty records', draft => {
      const page = draft.pages.get(pageId)!, id = draft.meta.nextId++;
      page.entities.set(id, { id, kind: 'path', layerId: draft.activeLayerId, points: [[0, 0], [10, 10]], closed: false,
        nativeUnknownFields: { emptyPayloads: new Map(keys.map(key => [key, { envelope: a, outerEnvelope: b }])) } });
      const entity = page.entities.get(id)!;
      for (const key of keys) Reflect.set(entity, key, undefined);
      page.entityOrder.push(id); return id;
    }).value;
    const editable = new LayoutDocument((await openLayoutFile(await encodeLayoutSnapshot(doc.state))).state);
    expect(editable.state).toEqual(doc.state);
    const baseline = layoutContentIdentity(editable.state), get = () => editable.state.pages.get(pageId)!.entities.get(id)!;
    const rename = editable.transact('rename', draft => { draft.pages.get(pageId)!.entities.get(id)!.name = 'Empty payloads'; });
    expect(get().nativeUnknownFields!.emptyPayloads!.size).toBe(keys.length);
    expect((await openLayoutFile(await encodeLayoutSnapshot(editable.state))).state).toEqual(editable.state);
    editable.applyPatches(rename.inversePatches, rename.patches, 'undo', 'rename');
    expect(layoutContentIdentity(editable.state)).toBe(baseline);
    const replacement = editable.transact('replace empty text and remove other payloads', draft => {
      const entity = draft.pages.get(pageId)!.entities.get(id)!;
      entity.kind = 'text'; entity.text = createLayoutTable(1, 1).cells[0]!.text;
      for (const key of keys) if (key !== 'text') Reflect.deleteProperty(entity, key);
    });
    expect(get().nativeUnknownFields).toBeUndefined();
    expect(get().text!.nativeUnknownFields).toBeUndefined();
    expect((await openLayoutFile(await encodeLayoutSnapshot(editable.state))).state).toEqual(editable.state);
    editable.applyPatches(replacement.inversePatches, replacement.patches, 'undo', 'replace empty text and remove other payloads');
    expect(layoutContentIdentity(editable.state)).toBe(baseline);
    expect((await openLayoutFile(await encodeLayoutSnapshot(editable.state))).state).toEqual(editable.state);
  });

  it.each(['inline', 'worker'])('retains model annotation owners through attachment edits and field removal: %s', async mode => {
    if (mode === 'worker') vi.stubGlobal('Worker', FakeWorker);
    const doc = createLayoutDocument(), a = [new Uint8Array([0xa0, 6, 7])], b = [new Uint8Array([0xa0, 6, 8])], pageId = doc.state.pageOrder[0]!;
    const ids = doc.transact('future model annotations', draft => {
      const page = draft.pages.get(pageId)!;
      const attachment = (fields: Uint8Array[]) => ({ viewportId: 999, modelGuid: 'model', source: { referenceId: 9, nativeUnknownFields: fields },
        anchor: { kind: 'sketchVertex' as const, path: [] as Id[], id: 123 as Id, nativeUnknownFields: fields }, nativeUnknownFields: fields });
      const labelId = draft.meta.nextId++, dimensionId = draft.meta.nextId++;
      page.entities.set(labelId, { id: labelId, kind: 'label', layerId: draft.activeLayerId, points: [[10, 10], [30, 20], [5, 0]], closed: false,
        text: createLayoutTable(1, 1).cells[0]!.text, modelAnnotation: { attachments: [attachment(a)], status: 'unavailable',
          fields: { Name: 'Beam', 'a/b': 'Slash', ['__proto__']: 'Own' }, nativeUnknownFields: { envelope: a, outerEnvelope: b,
            extensions: new Map(['', 'fields', 'fields/Name', 'fields/a/b', 'fields/__proto__'].map(key => [key, a])) } } });
      page.entities.set(dimensionId, { id: dimensionId, kind: 'dimension', layerId: draft.activeLayerId, points: [[0, 0], [10, 0], [5, 5]], closed: false,
        dimension: createLinearDimension(), modelAnnotation: { attachments: [attachment(a), attachment(b)], status: 'unavailable',
          nativeUnknownFields: { envelope: b, outerEnvelope: a, extensions: new Map([['', b]]) } } });
      page.entityOrder.push(labelId, dimensionId); return [labelId, dimensionId];
    }).value;
    const editable = new LayoutDocument((await openLayoutFile(await encodeLayoutSnapshot(doc.state))).state);
    expect(editable.state).toEqual(doc.state);
    const baseline = layoutContentIdentity(editable.state);
    const edit = editable.transact('edit model attachments', draft => {
      const page = draft.pages.get(pageId)!, label = page.entities.get(ids[0]!)!.modelAnnotation!, dimension = page.entities.get(ids[1]!)!.modelAnnotation!;
      delete label.fields!['a/b'];
      // Production Auto-Text refresh replaces the dictionary; Immer cannot patch __proto__ in place.
      label.fields = { Name: 'Renamed' };
      label.attachments[0]!.source = { archiveId: 'archive', modelReferenceId: 'replacement' };
      label.attachments[0]!.anchor = { kind: 'bodyVertex', path: [], bodyId: 77 as Id, faceIds: [0 as FaceLocalId] };
      label.status = 'detached'; dimension.attachments = [dimension.attachments[1]!, dimension.attachments[0]!];
    });
    const label = editable.state.pages.get(pageId)!.entities.get(ids[0]!)!.modelAnnotation!;
    expect([...label.nativeUnknownFields!.extensions!.keys()]).toEqual(['', 'fields', 'fields/Name']);
    expect(label.attachments[0]!.source.nativeUnknownFields).toBeUndefined();
    expect(label.attachments[0]!.anchor.nativeUnknownFields).toBeUndefined();
    expect((await openLayoutFile(await encodeLayoutSnapshot(editable.state))).state).toEqual(editable.state);
    editable.applyPatches(edit.inversePatches, edit.patches, 'undo', 'edit model attachments');
    expect(editable.state).toEqual(doc.state);
    expect(layoutContentIdentity(editable.state)).toBe(baseline);
    const removal = editable.transact('remove model fields and annotation', draft => {
      const page = draft.pages.get(pageId)!;
      delete page.entities.get(ids[0]!)!.modelAnnotation!.fields;
      delete page.entities.get(ids[1]!)!.modelAnnotation;
    });
    expect((await openLayoutFile(await encodeLayoutSnapshot(editable.state))).state).toEqual(editable.state);
    editable.applyPatches(removal.inversePatches, removal.patches, 'undo', 'remove model fields and annotation');
    expect(layoutContentIdentity(editable.state)).toBe(baseline);
  });

  it.each(['inline', 'worker'])('retains preserved connection owners and exact snapshots through edits: %s', async mode => {
    if (mode === 'worker') vi.stubGlobal('Worker', FakeWorker);
    const doc = createLayoutDocument(), a = [new Uint8Array([0xa0, 6, 7])], b = [new Uint8Array([0xa0, 6, 8])], pageId = doc.state.pageOrder[0]!;
    const snapshot = '{"original":"?", "preserve spacing": true}';
    const id = doc.transact('future preserved connections', draft => {
      const page = draft.pages.get(pageId)!, id = draft.meta.nextId++;
      page.entities.set(id, { id, kind: 'label', layerId: draft.activeLayerId, points: [[10, 10], [30, 20], [5, 0]], closed: false,
        text: createLayoutTable(1, 1).cells[0]!.text, preservedModelConnections: { archiveId: 'archive', originalId: 'annotation', snapshot, nativeAssetFields: { unknownFields: a, envelopeUnknown: b },
          viewports: [{ originalId: 'source-a', entityId: 999, nativeUnknownFields: a }, { originalId: 'source-b', entityId: 999, nativeUnknownFields: b }],
          fields: { Name: 'Beam', 'a/b': 'Slash', ['__proto__']: 'Own' }, nativeUnknownFields: { envelope: a, outerEnvelope: b,
            extensions: new Map(['', 'fields', 'fields/Name', 'fields/a/b', 'fields/__proto__'].map(key => [key, a])) } } });
      page.entityOrder.push(id); return id;
    }).value;
    const editable = new LayoutDocument((await openLayoutFile(await encodeLayoutSnapshot(doc.state))).state);
    expect(editable.state).toEqual(doc.state);
    const baseline = layoutContentIdentity(editable.state), get = () => editable.state.pages.get(pageId)!.entities.get(id)!.preservedModelConnections!;
    const edit = editable.transact('edit source associations', draft => {
      const c = draft.pages.get(pageId)!.entities.get(id)!.preservedModelConnections!;
      c.viewports = [c.viewports[1]!, c.viewports[0]!]; c.viewports[0]!.entityId = 998;
      c.fields = { Name: 'Updated' }; c.originalId = 'Renamed';
    });
    expect(get().viewports.map(view => view.nativeUnknownFields)).toEqual([b, a]);
    expect([...get().nativeUnknownFields!.extensions!.keys()]).toEqual(['', 'fields', 'fields/Name']);
    expect(get().snapshot).toBe(snapshot);
    expect((await openLayoutFile(await encodeLayoutSnapshot(editable.state))).state).toEqual(editable.state);
    editable.applyPatches(edit.inversePatches, edit.patches, 'undo', 'edit source associations');
    expect(layoutContentIdentity(editable.state)).toBe(baseline);
    const fields = editable.transact('remove saved fields', draft => { delete draft.pages.get(pageId)!.entities.get(id)!.preservedModelConnections!.fields; });
    expect([...get().nativeUnknownFields!.extensions!.keys()]).toEqual(['']);
    expect((await openLayoutFile(await encodeLayoutSnapshot(editable.state))).state).toEqual(editable.state);
    editable.applyPatches(fields.inversePatches, fields.patches, 'undo', 'remove saved fields');
    expect(layoutContentIdentity(editable.state)).toBe(baseline);
    const detach = editable.transact('detach preserved connection', draft => {
      const page = draft.pages.get(pageId)!; page.entities.set(id, moveLayoutLabel(page.entities.get(id)!, [1, 1], 'tip'));
    });
    expect(get()).toBeUndefined();
    expect((await openLayoutFile(await encodeLayoutSnapshot(editable.state))).state).toEqual(editable.state);
    editable.applyPatches(detach.inversePatches, detach.patches, 'undo', 'detach preserved connection');
    expect(layoutContentIdentity(editable.state)).toBe(baseline);
  });

  it.each(['inline', 'worker'])('retains image and crop fields through editing and undo: %s', async mode => {
    if (mode === 'worker') vi.stubGlobal('Worker', FakeWorker);
    const doc = createLayoutDocument(), a = [new Uint8Array([0xa0, 6, 7])], b = [new Uint8Array([0xa0, 6, 8])], pageId = doc.state.pageOrder[0]!;
    const id = doc.transact('future image', draft => {
      const page = draft.pages.get(pageId)!, id = draft.meta.nextId++;
      page.entities.set(id, { id, kind: 'image', layerId: draft.activeLayerId, points: [[0, 0], [20, 0], [20, 10], [0, 10]], closed: true,
        image: { src: 'data:image/png;base64,AQID', viewport: undefined, nativeAssetFields: { unknownFields: b, envelopeUnknown: a },
          nativeUnknownFields: { envelope: a, outerEnvelope: b, extensions: new Map([['', a], ['clip', b], ['viewport', a]]) },
          clip: { points: [[0, 0], [1, 0], [1, 1], [0, 1]], handles: [{ out: [0.5, -0.25] }, {}, {}, {}],
            nativeUnknownFields: new Map(['', 'points', 'handleFlags', 'handleValues'].map(key => [key, b])) } } });
      page.entityOrder.push(id); return id;
    }).value;
    const editable = new LayoutDocument((await openLayoutFile(await encodeLayoutSnapshot(doc.state))).state);
    expect(editable.state).toEqual(doc.state);
    const baseline = layoutContentIdentity(editable.state), get = () => editable.state.pages.get(pageId)!.entities.get(id)!.image!;
    const edit = editable.transact('edit crop and image source', draft => {
      const image = draft.pages.get(pageId)!.entities.get(id)!.image!;
      image.src = 'data:image/png;base64,BAUG'; image.clip!.points[0] = [0.1, 0.2]; delete image.clip!.handles; delete image.viewport;
    });
    expect([...get().clip!.nativeUnknownFields!.keys()]).toEqual(['', 'points']);
    expect(get().nativeUnknownFields!.extensions!.has('viewport')).toBe(false);
    expect((await openLayoutFile(await encodeLayoutSnapshot(editable.state))).state).toEqual(editable.state);
    editable.applyPatches(edit.inversePatches, edit.patches, 'undo', 'edit crop and image source');
    expect(layoutContentIdentity(editable.state)).toBe(baseline);
    const crop = editable.transact('remove crop', draft => { delete draft.pages.get(pageId)!.entities.get(id)!.image!.clip; });
    expect(get().nativeUnknownFields!.extensions!.has('clip')).toBe(false);
    expect((await openLayoutFile(await encodeLayoutSnapshot(editable.state))).state).toEqual(editable.state);
    editable.applyPatches(crop.inversePatches, crop.patches, 'undo', 'remove crop');
    expect(layoutContentIdentity(editable.state)).toBe(baseline);
    const deletion = editable.transact('delete image', draft => { const page = draft.pages.get(pageId)!; page.entities.delete(id); page.entityOrder = []; });
    expect((await openLayoutFile(await encodeLayoutSnapshot(editable.state))).state).toEqual(editable.state);
    editable.applyPatches(deletion.inversePatches, deletion.patches, 'undo', 'delete image');
    expect(layoutContentIdentity(editable.state)).toBe(baseline);
  });

  it.each(['inline', 'worker'])('retains viewport owners through camera swaps and optional-record removal: %s', async mode => {
    if (mode === 'worker') vi.stubGlobal('Worker', FakeWorker);
    const doc = createLayoutDocument(), a = [new Uint8Array([0xa0, 6, 7])], b = [new Uint8Array([0xa0, 6, 8])], pageId = doc.state.pageOrder[0]!;
    const id = doc.transact('future viewport', draft => {
      draft.modelArchives = new Map([['archive', { format: 'sketchup-layout', archiveBase64: 'AAEC', annotationConnectionsVersion: 1,
        models: new Map([['model', { internalTarget: 'models/model.skp', externalTarget: null }]]), viewports: new Map() }]]);
      const page = draft.pages.get(pageId)!, id = draft.meta.nextId++;
      const camera = { eye: [1, 2, 3] as [number, number, number], target: [0, 0, 0] as [number, number, number], up: [0, 0, 1] as [number, number, number], projection: 'perspective' as const, fov: 45, scale: 1 };
      page.entities.set(id, { id, kind: 'image', layerId: draft.activeLayerId, points: [[0, 0], [20, 0], [20, 10], [0, 10]], closed: true,
        image: { src: 'data:image/png;base64,AQID', viewport: { source: { archiveId: 'archive', modelReferenceId: 'model', nativeUnknownFields: a },
          templateId: 'template', originalId: null, scene: null, background: null, camera: { ...camera, nativeUnknownFields: a },
          nativeUnknownFields: new Map([['', a], ['display', b]]),
          cache: { camera: { ...camera, nativeUnknownFields: b }, widthMm: 20, heightMm: 10, sha256: 'a'.repeat(64), nativeUnknownFields: new Map([['', b], ['sha256', a]]) },
          display: { faceStyle: 'shaded', edges: true, profiles: false, backEdges: false, xray: false, hiddenGeometry: false,
            nativeUnknownFields: new Map([['', b], ['shadows', a]]), shadows: { ...DEFAULT_SHADOWS, nativeUnknownFields: new Map([['', a]]) } } } } });
      page.entityOrder.push(id); return id;
    }).value;
    const editable = new LayoutDocument((await openLayoutFile(await encodeLayoutSnapshot(doc.state))).state);
    expect(editable.state).toEqual(doc.state);
    const baseline = layoutContentIdentity(editable.state), get = () => editable.state.pages.get(pageId)!.entities.get(id)!.image!.viewport!;
    const copied = editable.transact('copy native viewport', draft => {
      const page = draft.pages.get(pageId)!, original = page.entities.get(id)!, copyId = draft.meta.nextId++;
      page.entities.set(copyId, { ...original, id: copyId, image: copyLayoutImage(original.image!) }); page.entityOrder.push(copyId);
      return copyId;
    });
    expect(editable.state.pages.get(pageId)!.entities.get(copied.value)!.image!.viewport!.nativeUnknownFields).toEqual(get().nativeUnknownFields);
    expect((await openLayoutFile(await encodeLayoutSnapshot(editable.state))).state).toEqual(editable.state);
    editable.applyPatches(copied.inversePatches, copied.patches, 'undo', 'copy native viewport');
    expect(layoutContentIdentity(editable.state)).toBe(baseline);
    const edit = editable.transact('swap cameras and remove optional viewport fields', draft => {
      const view = draft.pages.get(pageId)!.entities.get(id)!.image!.viewport!, camera = view.camera;
      view.camera = view.cache!.camera; view.cache!.camera = camera; view.camera.fov = 60;
      delete view.cache!.sha256; delete view.display!.shadows;
      view.source = { archiveId: 'archive', modelReferenceId: 'model' };
    });
    expect(get().camera.nativeUnknownFields).toEqual(b);
    expect(get().cache!.camera.nativeUnknownFields).toEqual(a);
    expect(get().cache!.nativeUnknownFields!.has('sha256')).toBe(false);
    expect(get().display!.nativeUnknownFields!.has('shadows')).toBe(false);
    expect(get().source.nativeUnknownFields).toBeUndefined();
    expect((await openLayoutFile(await encodeLayoutSnapshot(editable.state))).state).toEqual(editable.state);
    editable.applyPatches(edit.inversePatches, edit.patches, 'undo', 'swap cameras and remove optional viewport fields');
    expect(layoutContentIdentity(editable.state)).toBe(baseline);
    const removal = editable.transact('clear cache and display', draft => {
      const view = draft.pages.get(pageId)!.entities.get(id)!.image!.viewport!; view.cache = null; delete view.display;
    });
    expect([...get().nativeUnknownFields!.keys()]).toEqual(['']);
    expect((await openLayoutFile(await encodeLayoutSnapshot(editable.state))).state).toEqual(editable.state);
    editable.applyPatches(removal.inversePatches, removal.patches, 'undo', 'clear cache and display');
    expect(layoutContentIdentity(editable.state)).toBe(baseline);
  });

  it('surfaces worker errors and falls back inline when the worker script fails to load', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    FakeWorker.fail = 'message';
    await expect(openModelFile(new Uint8Array([1, 2, 3]))).rejects.toThrow('worker said no');
    FakeWorker.fail = 'none';
    await expect(openModelFile(new Uint8Array([1, 2, 3]))).rejects.toThrow('Invalid .pf archive');
    FakeWorker.fail = 'load';
    const layout = createLayoutDocument();
    const bytes = await encodeLayoutArchive(layoutJson(layout.state));
    expect(layoutJson(decodeLayoutDocument(bytes).state)).toBe(layoutJson(layout.state));
  });
});
