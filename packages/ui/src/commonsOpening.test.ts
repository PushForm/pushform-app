// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it } from 'vitest';
import { createApp } from './bootstrap';
import { DocumentSession } from './session';
import { openCommonsModel } from './commonsOpening';
import { openModelFile, encodeModelDocument } from '@pushform/io';
import { createDocument } from '@pushform/model';
import type { OpenedCommonsModel } from '@pushform/cloud';
let session: DocumentSession | null = null;
afterEach(() => { session?.dispose(); session = null; });
const stl = `solid tetrahedron
facet normal 0 0 -1
outer loop
vertex 0 0 0
vertex 0 20 0
vertex 20 0 0
endloop
endfacet
facet normal 0 -1 0
outer loop
vertex 0 0 0
vertex 20 0 0
vertex 0 0 20
endloop
endfacet
facet normal -1 0 0
outer loop
vertex 0 0 0
vertex 0 0 20
vertex 0 20 0
endloop
endfacet
facet normal 1 1 1
outer loop
vertex 20 0 0
vertex 0 20 0
vertex 0 0 20
endloop
endfacet
endsolid tetrahedron`;
const source: OpenedCommonsModel = { bytes: new TextEncoder().encode(stl), name: 'tetrahedron.stl', attribution: {
  modelId: 'tetrahedron', revision: 'revision-1', assetId: 'asset-1', title: 'Tetrahedron', creator: 'Maker', source: null,
  licenses: [{ name: 'CC BY 3.0', url: 'https://creativecommons.org/licenses/by/3.0/', commercialUse: 'allowed', conditions: ['Keep creator credit.'] }], credits: [{ name: 'Maker', url: null, text: 'Original test fixture.' }], file: { name: 'tetrahedron.stl', sizeBytes: stl.length, sha256: 'a'.repeat(64) } } };
function setup() { const app = createApp({ demo: false, expose: false }); session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), true); return { app, session }; }
it('opens verified geometry as a separate unsaved copy and preserves notices through a native save', async () => {
  const { app, session } = setup(); const original = app.document.doc.state; const originalId = session.activeId;
  const { tab } = await openCommonsModel(session, source, new AbortController().signal, { unit: 'mm', up: 'z' });
  expect(session.tabs).toHaveLength(2); expect(tab.id).not.toBe(originalId); expect(app.document.doc.state).toBe(original);
  expect(tab.identity).toBeUndefined(); expect(session.isDirty(tab)).toBe(true); expect(tab.app.document.doc.state.meta.attributions).toEqual([source.attribution]);
  expect((await openModelFile(await session.saveModelBytes(tab.id))).state.meta.attributions).toEqual([source.attribution]);
  const entities = [...tab.app.document.doc.state.definitions.values()].flatMap(d => [...d.entities.meshParts.values(), ...d.entities.bodies.values()]); expect(entities.length).toBeGreaterThan(0);
});
it('cancels and rejects failed conversion without adding a tab or altering existing work', async () => {
  const { app, session } = setup(); const original = app.document.doc.state;
  const cancel = new AbortController(); cancel.abort(); await expect(openCommonsModel(session, source, cancel.signal)).rejects.toThrow();
  await expect(openCommonsModel(session, { ...source, bytes: new Uint8Array([1, 2, 3]) }, new AbortController().signal)).rejects.toThrow();
  expect(session.tabs).toHaveLength(1); expect(app.document.doc.state).toBe(original);
});
it('opens a native model with a fresh document identity while keeping earlier attribution records', async () => {
  const { session } = setup(); const native = createDocument(); native.transact('Keep earlier notice', draft => { draft.meta.attributions = [{ ...source.attribution, modelId: 'earlier-model' }]; });
  const { tab } = await openCommonsModel(session, { ...source, name: 'native.pf', bytes: await encodeModelDocument(native) }, new AbortController().signal);
  expect(tab.app.document.doc.state.meta.guid).not.toBe(native.state.meta.guid); expect(tab.app.document.doc.state.meta.attributions).toHaveLength(2); expect(session.isDirty(tab)).toBe(true);
});
