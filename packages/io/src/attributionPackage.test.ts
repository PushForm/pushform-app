// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { unzipSync, zipSync, strToU8 } from 'fflate';
import { createDocument, type ModelAttribution } from '@pushform/model';
import { encodeModelDocument, openModelFile } from './index';
import { packageModelExport, readStoredAttributionPackage } from './attributionPackage';
const notice: ModelAttribution = { modelId: 'part', revision: 'r1', assetId: 'a1', title: 'Original part', creator: 'Maker', source: { name: 'Original source', url: 'https://example.com/model' },
  licenses: [{ name: 'CC BY 3.0', url: 'https://creativecommons.org/licenses/by/3.0/', commercialUse: 'allowed', conditions: ['Keep Maker credit.'] }], credits: [{ name: 'Maker', url: null, text: 'Original model.' }], file: { name: 'part.stl', sizeBytes: 3, sha256: 'a'.repeat(64) } };
it('retains original notices through native save, edits and reopening', async () => {
  const doc = createDocument(); doc.transact('Add notices', draft => { draft.meta.attributions = [notice]; });
  const first = await openModelFile(await encodeModelDocument(doc));
  expect(first.state.meta.attributions).toEqual([notice]);
  const edited = createDocument(); edited.replaceState(first.state); edited.transact('Change units', draft => { draft.meta.units.lengthPrecision = 4; });
  expect((await openModelFile(await encodeModelDocument(edited))).state.meta.attributions).toEqual([notice]);
});
it('keeps exported geometry unchanged and includes original notices with all payload files', () => {
  const doc = createDocument(); doc.transact('Add notices', draft => { draft.meta.attributions = [notice]; });
  for (const name of ['part.stl', 'part.step', 'part.glb', 'part.dae', 'render.png']) {
    const bytes = new Uint8Array([1, 2, 3]); const result = packageModelExport(doc.state, bytes, name); expect(result.fileName).toBe(name.replace(/\.[^.]+$/, '.zip'));
    const files = unzipSync(result.bytes); expect(files[name]).toEqual(bytes); expect(JSON.parse(new TextDecoder().decode(files['ATTRIBUTION.json']))).toEqual({ version: 1, attributions: [notice] });
  }
  const payload = zipSync({ 'part.obj': strToU8('geometry'), 'part.mtl': strToU8('materials'), 'ATTRIBUTION.json': strToU8('original bundled notices') });
  const files = unzipSync(packageModelExport(doc.state, payload, 'part.zip').bytes); expect(new TextDecoder().decode(files['ATTRIBUTION.json'])).toBe('original bundled notices'); expect(files['PUSHFORM_ATTRIBUTION.json']).toBeTruthy(); expect(files['part.mtl']).toBeTruthy();
});
it('rejects compressed service payloads and missing attribution records before import', () => {
  expect(() => readStoredAttributionPackage(zipSync({ 'file.stl': strToU8('geometry') }, { level: 0 }))).toThrow('Missing model notices');
  const compressed = zipSync({ 'ATTRIBUTION.json': strToU8('x'.repeat(10000)), 'README.txt': strToU8('notices'), 'files/part.stl': strToU8('geometry') }, { level: 6 });
  expect(() => readStoredAttributionPackage(compressed)).toThrow('Invalid model package');
});
