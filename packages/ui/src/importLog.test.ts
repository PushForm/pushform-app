// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it, vi } from 'vitest';
import type { CloudFilesApi } from '@pushform/cloud';
import type { ModelImportReport, SketchUpImport } from '@pushform/io';
import { layoutImportReport, logImport, modelImportReport, sketchUpVersion } from './importLog';

const build = { version: '0.1.0', commit: 'abc1234', date: '2026-10-22T00:00:00Z' };
const source = { fileName: 'Chair.skp', sizeBytes: 4096, startedAt: 0, fileModifiedAt: Date.UTC(2026, 9, 20, 12) };
const scene = { version: '{26.2.242}', warnings: ['Guides are not imported.'] } as unknown as SketchUpImport;
const report: ModelImportReport = { bodies: 2, sheetFaces: 1, looseEdges: 0, definitions: 3, instances: 4, materials: 5, tags: 6, scenes: 7, sectionPlanes: 8, guides: 9, dimensions: 10, texts: 11, warnings: ['Guides are not imported.', 'Some faces reference unavailable materials.'] };

it('describes a successful SketchUp model import with its saving version, counts, and every warning', () => {
  const result = modelImportReport(source, { scene, report }, build);
  expect(result).toMatchObject({ source: 'sketchup_model', status: 'imported', error: null, fileName: 'Chair.skp', sizeBytes: 4096,
    sourceVersion: '26.2.242', sourceCreatedAt: null, sourceModifiedAt: null, fileModifiedAt: '2026-10-20T12:00:00.000Z',
    counts: { bodies: 2, sheetFaces: 1, looseEdges: 0, definitions: 3, instances: 4, materials: 5, tags: 6, scenes: 7, sectionPlanes: 8, guides: 9, dimensions: 10, texts: 11 },
    issues: report.warnings, appVersion: '0.1.0', appBuild: 'abc1234' });
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
});
it('describes failed and cancelled model imports, keeping the version when the scene was read', () => {
  expect(modelImportReport({ ...source, sizeBytes: null, fileModifiedAt: null }, { error: new Error('Not a SketchUp model: invalid file header.') }))
    .toMatchObject({ status: 'failed', error: 'Not a SketchUp model: invalid file header.', sizeBytes: null, sourceVersion: null, counts: {}, issues: [], fileModifiedAt: null, appVersion: null, appBuild: null });
  expect(modelImportReport(source, { scene, error: new DOMException('Import cancelled.', 'AbortError') }))
    .toMatchObject({ status: 'cancelled', error: null, sourceVersion: '26.2.242', issues: ['Guides are not imported.'] });
  expect(modelImportReport(source, { error: '' }).error).toBe('Import failed.');
});
it('reports glTF imports, read or failed, under their own source', () => {
  const gltf = { ...scene, version: '2.0, Blender', format: { kind: 'gltf', name: 'glTF', notes: [] } } as unknown as SketchUpImport;
  expect(modelImportReport({ ...source, fileName: 'Duck.glb' }, { scene: gltf, report }).source).toBe('gltf_model');
  expect(modelImportReport({ ...source, fileName: 'Duck.gltf' }, { error: new Error('Only glTF 2.0 files are supported.') }).source).toBe('gltf_model');
});
it('reports STEP imports, read or failed, under their own source with the protocol and originating system', () => {
  const step = { ...scene, version: 'AP214, FreeCAD', format: { kind: 'step', name: 'STEP', notes: [] } } as unknown as SketchUpImport;
  expect(modelImportReport({ ...source, fileName: 'Chair.step' }, { scene: step, report })).toMatchObject({ source: 'step_model', sourceVersion: 'AP214, FreeCAD' });
  expect(modelImportReport({ ...source, fileName: 'Chair.STP' }, { error: new Error('Not a STEP model.') }).source).toBe('step_model');
});
it('describes LayOut imports with the document properties, page count, and limitations', () => {
  const properties = { version: '16.1.1449', created: '2011-12-08T21:20:31.000Z', modified: '2016-08-04T15:24:06.000Z', revision: 251, pageCount: 2 };
  expect(layoutImportReport({ ...source, fileName: 'Plan.layout' }, { properties, warnings: ['Viewports are placeholders (3×)'], pages: 2 }, build))
    .toMatchObject({ source: 'sketchup_layout', status: 'imported', fileName: 'Plan.layout', sourceVersion: '16.1.1449',
      sourceCreatedAt: properties.created, sourceModifiedAt: properties.modified, counts: { pages: 2, sourceRevision: 251 }, issues: ['Viewports are placeholders (3×)'] });
  expect(layoutImportReport({ ...source, fileName: 'Broken.layout' }, { error: new Error('Invalid .layout archive') }))
    .toMatchObject({ status: 'failed', error: 'Invalid .layout archive', sourceVersion: null, sourceCreatedAt: null, counts: {}, issues: [] });
  expect(layoutImportReport(source, { properties: { ...properties, revision: null }, warnings: [], pages: 1 }).counts).toEqual({ pages: 1 });
});
it('strips the SketchUp header braces from the version', () => {
  expect(sketchUpVersion('{26.2.242}')).toBe('26.2.242'); expect(sketchUpVersion(' 8.0.3117 ')).toBe('8.0.3117');
  expect(sketchUpVersion('{}')).toBeNull(); expect(sketchUpVersion(undefined)).toBeNull();
});
it('stores through the cloud API and never rejects when storage is missing or fails', async () => {
  const entry = modelImportReport(source, { scene, report });
  const recordImport = vi.fn().mockResolvedValue({ id: 'r1' });
  await logImport({ recordImport } as unknown as CloudFilesApi, entry);
  expect(recordImport).toHaveBeenCalledWith(entry);
  await expect(logImport(undefined, entry)).resolves.toBeUndefined();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await expect(logImport({ recordImport: vi.fn().mockRejectedValue(new Error('offline')) } as unknown as CloudFilesApi, entry)).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalledOnce(); warn.mockRestore();
});

it('captures failed source bytes only after storing the report, without changing the outcome on upload failure', async () => {
  const entry = modelImportReport({ fileName: 'broken.skp', sizeBytes: 3, startedAt: 0 }, { error: new Error('Broken') });
  const saved = { id: 'report', status: 'failed' };
  const recordImport = vi.fn().mockResolvedValue(saved), saveFailedImport = vi.fn().mockResolvedValue(undefined);
  const api = { recordImport, saveFailedImport } as unknown as CloudFilesApi;
  const bytes = new Uint8Array([1, 2, 3]);
  await logImport(api, entry, bytes);
  expect(saveFailedImport).toHaveBeenCalledWith(saved, bytes);
  saveFailedImport.mockClear();
  await logImport(api, { ...entry, status: 'cancelled', error: null }, bytes);
  await logImport(api, { ...entry, status: 'imported', error: null }, bytes);
  expect(saveFailedImport).not.toHaveBeenCalled();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  saveFailedImport.mockRejectedValue(new Error('offline'));
  await expect(logImport(api, entry, bytes)).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalled(); warn.mockRestore();
});
