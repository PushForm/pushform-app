// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { meshBox } from '@pushform/core';
import type { CloudFilesApi } from '@pushform/cloud';
import {
  openLayoutFile, openModelFile, importSketchUpLayoutInWorker, readModelImport, readSketchUpInWorker, MAX_SKETCHUP_BYTES, type SketchUpImport,
} from '@pushform/io';
import type * as IoModule from '@pushform/io';
import { createLayoutDocument } from '@pushform/layout';
import { createApp } from './bootstrap';
import { convertImportFile, importSketchUpBytes, importLayoutBytes, isImportableFile, IMPORT_FILE_ACCEPT } from './importFiles';
import { DocumentSession } from './session';

vi.mock('@pushform/io', async original => ({ ...await original<typeof IoModule>(), readSketchUpInWorker: vi.fn(), importSketchUpLayoutInWorker: vi.fn() }));
const readModel = vi.mocked(readSketchUpInWorker), readLayout = vi.mocked(importSketchUpLayoutInWorker);
let session: DocumentSession;
afterEach(() => { session?.dispose(); readModel.mockReset(); readLayout.mockReset(); });
function setup(): { session: DocumentSession; recordImport: ReturnType<typeof vi.fn> } {
  session = new DocumentSession(createApp({ demo: false, expose: false }), () => createApp({ demo: false, expose: false }), true, null);
  return { session, recordImport: vi.fn().mockResolvedValue({ id: 'report' }) };
}
function picked(name: string, size = 4): File {
  const file = new File([new Uint8Array(size)], name, { lastModified: Date.UTC(2026, 9, 20) });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new Uint8Array(size).buffer, configurable: true });
  return file;
}
const scene: SketchUpImport = { version: '{26.2.242}', root: { key: -1, guid: 'ROOT', name: 'Model', image: false, group: false, alwaysFaceCamera: false, shadowsFaceSun: false,
  solids: [{ mesh: meshBox([0, 0, 0], [1, 2, 3]), faces: [] }], sheets: [], edges: [], curves: [], sectionPlanes: [], guides: [], dimensions: [], texts: [], instances: [] },
  definitions: new Map(), materials: new Map(), images: [], tags: [], scenes: [], units: null, warnings: ['Textures are not imported.'] };

it('recognizes SketchUp, COLLADA and LayOut files case-insensitively', () => {
  expect(['a.skp', 'B.SKB', 'c.Layout', 'd.DAE', 'e.zip', 'f.KMZ', 'g.GLB', 'h.gltf'].every(isImportableFile)).toBe(true);
  expect(['a.pf', 'b.pfl', 'c.txt', 'skp'].some(isImportableFile)).toBe(false);
  expect(IMPORT_FILE_ACCEPT).toBe('.skp,.skb,.dae,.obj,.3ds,.stl,.dxf,.gltf,.glb,.zip,.kmz,.layout');
});
it('converts a model file to native bytes without opening a tab, with its notes, and stores a report', async () => {
  const { session, recordImport } = setup(); readModel.mockResolvedValue(scene);
  const result = await convertImportFile(picked('Chair.skp'), { cloudFiles: { recordImport } as unknown as CloudFilesApi });
  expect(result.kind).toBe('model'); expect(result.name).toBe('Chair.pf'); expect(result.notes).toEqual(['Textures are not imported.']);
  expect((await openModelFile(result.bytes)).state.definitions.size).toBeGreaterThan(0);
  expect(session.tabs).toHaveLength(1);
  expect(recordImport).toHaveBeenCalledWith(expect.objectContaining({ source: 'sketchup_model', status: 'imported', fileName: 'Chair.skp', sizeBytes: 4, sourceVersion: '26.2.242', counts: expect.objectContaining({ bodies: 1 }) }));
});
it('converts a COLLADA model with the real reader and reports it as a COLLADA import', async () => {
  const { recordImport } = setup(); readModel.mockImplementation(bytes => readModelImport(bytes));
  const dae = new TextEncoder().encode(`<COLLADA version="1.4.1"><asset><unit meter="1"/><up_axis>Z_UP</up_axis></asset>
    <library_geometries><geometry id="g"><mesh><source id="p"><float_array id="pa" count="9">0 0 0 1 0 0 0 1 0</float_array>
      <technique_common><accessor source="#pa" count="3" stride="3"/></technique_common></source>
      <vertices id="v"><input semantic="POSITION" source="#p"/></vertices>
      <triangles count="1"><input semantic="VERTEX" source="#v" offset="0"/><p>0 1 2</p></triangles></mesh></geometry></library_geometries>
    <library_visual_scenes><visual_scene id="s"><node name="Tri"><instance_geometry url="#g"/></node></visual_scene></library_visual_scenes></COLLADA>`);
  const file = new File([dae], 'Chair.DAE');
  Object.defineProperty(file, 'arrayBuffer', { value: async () => dae.buffer });
  const result = await convertImportFile(file, { cloudFiles: { recordImport } as unknown as CloudFilesApi });
  expect(result.kind).toBe('model'); expect(result.name).toBe('Chair.pf');
  expect(result.notes[0]).toMatch(/^COLLADA import: geometry, nodes/);
  expect(recordImport).toHaveBeenCalledWith(expect.objectContaining({ source: 'collada_model', status: 'imported', fileName: 'Chair.DAE',
    sourceVersion: '1.4.1', counts: expect.objectContaining({ sheetFaces: 1 }) }));
});
it('converts a LayOut file to native drawing bytes with its limitations and stores a report', async () => {
  const { recordImport } = setup();
  readLayout.mockResolvedValue({ doc: createLayoutDocument(), warnings: ['Viewports are placeholders'], properties: { version: '16.1.1449', created: null, modified: null, revision: 2, pageCount: 1 } });
  const controller = new AbortController();
  const result = await convertImportFile(picked('Plan.layout'), { cloudFiles: { recordImport } as unknown as CloudFilesApi, signal: controller.signal });
  expect(readLayout).toHaveBeenCalledWith(expect.any(Uint8Array), 'Plan.layout', { signal: controller.signal });
  expect(result.kind).toBe('layout'); expect(result.name).toBe('Plan.pfl'); expect(result.notes).toEqual(['Viewports are placeholders']);
  expect((await openLayoutFile(result.bytes)).state.pageOrder).toHaveLength(1);
  expect(recordImport).toHaveBeenCalledWith(expect.objectContaining({ source: 'sketchup_layout', sourceVersion: '16.1.1449', counts: { pages: 1, sourceRevision: 2 } }));
});
it('rejects unsupported and oversized files before reading them, and reports reader failures', async () => {
  const { recordImport } = setup();
  const api = { recordImport } as unknown as CloudFilesApi;
  await expect(convertImportFile(picked('Notes.txt'), { cloudFiles: api })).rejects.toThrow('Choose .skp, .skb, .dae, .obj, .3ds, .stl, .dxf, .gltf, .glb, .zip, .kmz, or .layout files.');
  const huge = picked('Huge.skp'); Object.defineProperty(huge, 'size', { value: MAX_SKETCHUP_BYTES + 1 });
  await expect(convertImportFile(huge, { cloudFiles: api })).rejects.toThrow('128 MiB');
  expect(readModel).not.toHaveBeenCalled(); expect(recordImport).not.toHaveBeenCalled();
  readModel.mockRejectedValue(new Error('Not a SketchUp model: invalid file header.'));
  await expect(convertImportFile(picked('Broken.skp'), { cloudFiles: api })).rejects.toThrow('invalid file header');
  expect(recordImport).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', error: 'Not a SketchUp model: invalid file header.' }));
});

for (const route of ['editor-model', 'editor-layout', 'library-model', 'library-layout'] as const) {
  it(`retains the original bytes for a failed ${route} import and preserves its error`, async () => {
    const { session, recordImport } = setup();
    const saveFailedImport = vi.fn().mockResolvedValue(undefined);
    const cloudFiles = { recordImport, saveFailedImport } as unknown as CloudFilesApi;
    const error = new Error('Invalid source');
    readModel.mockRejectedValue(error); readLayout.mockRejectedValue(error);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const file = picked(route.endsWith('layout') ? 'broken.layout' : 'broken.skp');
    Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.buffer, configurable: true });
    const attempt = route === 'editor-model' ? importSketchUpBytes(session, bytes, file.name, { cloudFiles })
      : route === 'editor-layout' ? importLayoutBytes(session, bytes, file.name, { cloudFiles })
      : convertImportFile(file, { cloudFiles });
    await expect(attempt).rejects.toBe(error);
    await vi.waitFor(() => expect(saveFailedImport).toHaveBeenCalledWith({ id: 'report' }, bytes));
    expect(recordImport).toHaveBeenCalledOnce();
  });
}
