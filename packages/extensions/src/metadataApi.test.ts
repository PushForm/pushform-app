// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { CommandRegistry, DocumentHost, SERVICE_DOCUMENT, modelCommands } from '@pushform/commands';
import { extensionManifestSchema, metadataApplySchema, metadataListSchema, metadataReadSchema } from '@pushform/extension-protocol';
import { meshBox } from '@pushform/core';
import { bodyFromMesh } from '@pushform/model';
import { ModelDocumentApi } from './modelApi';
import { ModelMetadataApi } from './metadataApi';
import { applyModelWithMetadata } from './modelMetadataBatch';

const manifest = (id = 'com.example.parts', dataVersion = 1) => extensionManifestSchema.parse({
  id, name: 'Parts', publisher: 'Example', version: '1.0.0', apiVersion: '^0.1.0', editors: ['modeling'], defaultLocale: 'en', license: 'MIT', files: {}, permissions: ['model.read', 'model.write'],
  contributions: [{ target: 'model.command', id: `${id}.open`, name: 'Open' }],
  metadata: { dataVersion, schema: { type: 'object', properties: { label: { type: 'string', maxLength: 100 } }, required: ['label'] } },
});
function setup() {
  const host = new DocumentHost();
  const commands = new CommandRegistry({ tx: host, services: new Map([[SERVICE_DOCUMENT, host]]) });
  const api = new ModelMetadataApi(commands);
  const put = (label: unknown, extra: Record<string, unknown> = {}) => metadataApplySchema.parse({ expectedRevision: host.doc.version, expectedDataVersion: host.doc.state.pluginData?.get('com.example.parts')?.dataVersion ?? null,
    upserts: [{ id: 'job', target: { kind: 'document' }, value: { label } }], ...extra });
  return { host, commands, api, put };
}
it('explicitly upgrades compatible values while retaining missing targets, unresolved links and original bytes', () => {
  const { host, api, put } = setup(), current = manifest('com.example.parts', 2);
  const bytes = new TextEncoder().encode(' { "label" : "Retained" } ');
  host.doc.transact('Legacy retained fixture', draft => { draft.pluginData = new Map([
    [current.id, { dataVersion: 1, entries: new Map([
      ['lost', { target: { kind: 'body', id: 999 }, payload: bytes, needsReview: true, references: [{ entryId: 'gone', target: { kind: 'body', id: 998 } }] }],
      ['unresolved', { target: { kind: 'document' }, payload: bytes, references: [{ target: { kind: 'body', id: 997 }, unresolved: true }] }],
    ]) }],
    ['org.example.future', { dataVersion: 99, entries: new Map([['opaque', { target: { kind: 'document' }, payload: new Uint8Array([255, 0, 128]), references: [] }]]) }],
  ]); });
  const before = host.doc.state, old = before.pluginData!.get(current.id)!, foreign = before.pluginData!.get('org.example.future'), undo = host.undoStack.length;
  expect(() => api.apply(current, put('Edited'))).toThrow(/Migrate/);
  const result = api.apply(current, put('Edited', { upgradeCompatible: true }), undefined, [{ kind: 'document' }]);
  expect(result.dataVersion).toBe(2); expect(result.changed).toEqual(['job']);
  const upgraded = host.doc.state.pluginData!.get(current.id)!;
  expect(upgraded.entries.get('lost')).toBe(old.entries.get('lost')); expect(upgraded.entries.get('unresolved')).toBe(old.entries.get('unresolved'));
  expect(upgraded.entries.get('lost')!.payload).toBe(bytes); expect(host.doc.state.pluginData!.get('org.example.future')).toBe(foreign);
  expect(host.undoStack.length).toBe(undo + 1); host.undo(); expect(host.doc.state).toEqual(before); host.redo(); expect(host.doc.state.pluginData!.get(current.id)!.dataVersion).toBe(2);
});

it('refuses an incompatible retained value or newer record before a compatible upgrade can write', () => {
  const { host, api, put } = setup(), current = manifest('com.example.parts', 2);
  host.doc.transact('Incompatible legacy fixture', draft => { draft.pluginData = new Map([[current.id, { dataVersion: 1, entries: new Map([
    ['lost', { target: { kind: 'body', id: 999 }, payload: new TextEncoder().encode('{"label":4}'), references: [] }],
  ]) }]]); });
  const before = host.doc.state;
  expect(() => api.apply(current, put('Edited', { upgradeCompatible: true }))).toThrow(/explicit migration/); expect(host.doc.state).toBe(before);
  host.doc.transact('Newer fixture', draft => { draft.pluginData!.get(current.id)!.dataVersion = 3; }); const newer = host.doc.state;
  expect(() => api.apply(current, put('Edited', { upgradeCompatible: true }))).toThrow(/read-only/); expect(host.doc.state).toBe(newer);
});

it('commits compatible upgrades with model aliases and rolls the entire edit back on later metadata failure', async () => {
  const { host, commands, api, put } = setup(), old = manifest(), current = manifest('com.example.parts', 2);
  commands.registerAll(modelCommands); api.apply(old, put('Legacy'));
  const model = new ModelDocumentApi(commands, 'Compatible upgrade');
  const run = (label: unknown) => applyModelWithMetadata(model, api, current, { expectedRevision: host.doc.version, label: 'Upgrade and model edit', operations: [{ op: 'add_box', min: [0, 0, 0], max: [1, 1, 1], as: 'body' }],
    metadata: { expectedDataVersion: 1, upgradeCompatible: true, upserts: [{ id: 'created', target: { kind: 'body', created: 'body' }, value: { label } }], deletes: [] } });
  const before = host.doc.state, undo = host.undoStack.length;
  await expect(run(4)).rejects.toBeDefined(); expect(host.doc.rootDefinition.entities.bodies.size).toBe(0); expect(host.doc.state.pluginData!.get(old.id)!.dataVersion).toBe(1); expect(host.undoStack.length).toBe(undo);
  await run('Created'); expect(host.doc.rootDefinition.entities.bodies.size).toBe(1); expect(host.doc.state.pluginData!.get(old.id)!.dataVersion).toBe(2); expect(host.undoStack.length).toBe(undo + 1);
  host.undo(); expect({ ...host.doc.state, meta: { ...host.doc.state.meta, nextId: before.meta.nextId } }).toEqual(before);
});
it('cannot move an unrelated saved entry into a captured inspector by reusing its ID', () => {
  const { host, api, put } = setup(), a = manifest();
  api.apply(a, put('Outside', { upserts: [{ id: 'outside', target: { kind: 'definition', id: host.doc.state.rootDefinitionId }, value: { label: 'Unrelated defaults' } }] }));
  const before = host.doc.state, count = host.undoStack.entries.length;
  expect(() => api.apply(a, put('Moved', { upserts: [{ id: 'outside', target: { kind: 'document' }, value: { label: 'Moved' } }] }), undefined, [{ kind: 'document' }])).toThrow(/captured scope/);
  expect(host.doc.state).toBe(before);
  expect(host.undoStack.entries).toHaveLength(count);
});

it('retargeting a retained entry invalidates inbound links in the same undo step', () => {
  const { host, api, put } = setup(), a = manifest();
  const target = { kind: 'definition', id: host.doc.state.rootDefinitionId };
  api.apply(a, put('Seed', { upserts: [
    { id: 'part', target, value: { label: 'Original' } },
    { id: 'job', target: { kind: 'document' }, value: { label: 'Job' }, references: [{ entryId: 'part', target }] },
  ] }));
  const before = host.doc.state;
  const changed = api.apply(a, put('Move', { upserts: [{ id: 'part', target: { kind: 'document' }, value: { label: 'Retained' } }] }));
  expect(changed.changed).toContain('job');
  expect(host.doc.state.pluginData!.get(a.id)!.entries.get('job')!.references[0]!.unresolved).toBe(true);
  host.undo(); expect(host.doc.state).toEqual(before);
  host.redo(); expect(api.list(a, metadataListSchema.parse({})).entries.find(entry => entry.id === 'job')!.needsReview).toBe(true);
});

it('reports links to retained ambiguous entries as needing review without changing their saved bytes', () => {
  const { host, api, put } = setup(), a = manifest();
  const target = { kind: 'document' };
  api.apply(a, put('Seed', { upserts: [
    { id: 'source', target, value: { label: 'Retained' } },
    { id: 'job', target, value: { label: 'Job' }, references: [{ entryId: 'source', target }] },
  ] }));
  host.doc.transact('Retained ambiguity', draft => { draft.pluginData!.get(a.id)!.entries.get('source')!.needsReview = true; });
  const before = host.doc.state, count = host.undoStack.entries.length;
  expect(api.list(a, metadataListSchema.parse({})).entries.find(entry => entry.id === 'job')!.needsReview).toBe(true);
  expect(host.doc.state).toBe(before); expect(host.undoStack.entries).toHaveLength(count);
});

it('stores isolated owner data as one undo entry and returns detached values', () => {
  const { host, api, put } = setup(), a = manifest(), b = manifest('com.example.other');
  api.apply(a, put('First'));
  expect(host.undoStack.entries).toHaveLength(1);
  expect(api.list(b, metadataListSchema.parse({})).entries).toEqual([]);
  const read = api.read(a, metadataReadSchema.parse({ ids: ['job', 'missing'] }));
  expect(read.missing).toEqual(['missing']);
  (read.entries[0]!.value as { label: string }).label = 'Changed';
  expect(api.read(a, metadataReadSchema.parse({ ids: ['job'] })).entries[0]!.value).toEqual({ label: 'First' });
  host.undo(); expect(host.doc.state.pluginData).toBeUndefined();
  host.redo(); expect(api.list(a, metadataListSchema.parse({})).dataVersion).toBe(1);
});
it('reports retained ambiguous attachments and clears review only through an explicit validated replacement', () => {
  const { host, api, put } = setup(), a = manifest();
  api.apply(a, put('Original'));
  host.doc.transact('Ambiguous edit', draft => { draft.pluginData!.get(a.id)!.entries.get('job')!.needsReview = true; });
  expect(api.list(a, metadataListSchema.parse({})).entries[0]!.needsReview).toBe(true);
  expect(api.read(a, metadataReadSchema.parse({ ids: ['job'] })).entries[0]!.needsReview).toBe(true);
  api.apply(a, put('Resolved'));
  expect(api.list(a, metadataListSchema.parse({})).entries[0]!.needsReview).toBe(false);
  host.undo(); expect(api.list(a, metadataListSchema.parse({})).entries[0]!.needsReview).toBe(true);
});
it('limits captured inspector writes and deletions to its targets and refuses whole-record replacement', () => {
  const { host, api, put } = setup(), a = manifest();
  api.apply(a, put('Original'));
  const allowed = [{ kind: 'definition' as const, id: host.doc.state.rootDefinitionId }];
  for (const batch of [put('Wrong owner'), put('Replace', { replaceRecord: true }), put('Delete', { upserts: [], deletes: ['job'] })]) expect(() => api.apply(a, batch, undefined, allowed)).toThrow(/captured scope/);
  api.apply(a, put('Selected', { upserts: [{ id: 'definition', target: allowed[0], value: { label: 'Selected' } }] }), undefined, allowed);
  expect(api.list(a, metadataListSchema.parse({})).entries).toHaveLength(2);
});
it('rejects stale revisions, invalid targets, duplicate edits and schema failures atomically', () => {
  const { host, api, put, commands } = setup(), a = manifest();
  api.apply(a, put('First'));
  const before = host.doc.state, count = host.undoStack.entries.length;
  for (const input of [put(12), put('Next', { expectedRevision: 0 }), put('Next', { expectedDataVersion: null }),
    put('Next', { deletes: ['job'] }), put('Next', { upserts: [{ id: 'other', target: { kind: 'body', id: 9999 }, value: { label: 'No' } }] }),
    put('Next', { upserts: [{ id: 'job', target: { kind: 'document' }, value: { label: 'Good' } }, { id: 'second', target: { kind: 'document' }, value: { label: 99 } }] })]) {
    expect(() => api.apply(a, input)).toThrow(); expect(host.doc.state).toBe(before);
  }
  expect(host.undoStack.entries).toHaveLength(count);
  const controller = new AbortController(); controller.abort();
  expect(() => api.apply(a, put('Cancelled'), controller.signal)).toThrow();
  expect(host.doc.state).toBe(before);
  expect(() => commands.execute('internal.pluginMetadata.apply', { owner: a.id })).toThrow();
});
it('keeps newer data opaque and requires explicit complete-record migration', () => {
  const { host, api, put } = setup();
  api.apply(manifest(), put('Original'));
  expect(() => api.apply(manifest(undefined, 2), put('New'))).toThrow(/Migrate/);
  api.apply(manifest(undefined, 2), put('Migrated', { replaceRecord: true }));
  expect(api.list(manifest(), metadataListSchema.parse({})).writable).toBe(false);
  expect(() => api.read(manifest(), metadataReadSchema.parse({ ids: ['job'] }))).toThrow(/newer/);
  expect(() => api.apply(manifest(), put('Downgrade', { replaceRecord: true }))).toThrow(/Newer/);
  host.undo(); expect(api.read(manifest(), metadataReadSchema.parse({ ids: ['job'] })).entries[0]!.value).toEqual({ label: 'Original' });
});
it('marks references unresolved when their owned entry is deleted, with undo restoration', () => {
  const { host, api } = setup(), a = manifest();
  api.apply(a, metadataApplySchema.parse({ expectedRevision: 0, expectedDataVersion: null, upserts: [
    { id: 'source', target: { kind: 'document' }, value: { label: 'Source' } },
    { id: 'link', target: { kind: 'document' }, references: [{ entryId: 'source', target: { kind: 'document' } }], value: { label: 'Link' } },
  ] }));
  api.apply(a, metadataApplySchema.parse({ expectedRevision: host.doc.version, expectedDataVersion: 1, deletes: ['source'] }));
  expect(api.list(a, metadataListSchema.parse({})).entries[0]!.references[0]!.unresolved).toBe(true);
  host.undo(); expect(api.list(a, metadataListSchema.parse({})).entries.find(e => e.id === 'link')!.references[0]!.unresolved).toBeUndefined();
});
it('supports direct model references without inventing an extra metadata record', () => {
  const { host, api, put } = setup();
  api.apply(manifest(), put('Job', { upserts: [{ id: 'job', target: { kind: 'document' }, value: { label: 'Job' }, references: [{ target: { kind: 'definition', id: host.doc.state.rootDefinitionId } }] }] }));
  const list = api.list(manifest(), metadataListSchema.parse({}));
  expect(list.entries).toHaveLength(1);
  expect(list.entries[0]!.references[0]!.entryId).toBeUndefined();
  expect(list.entries[0]!.needsReview).toBe(false);
  expect(api.list(manifest(), metadataListSchema.parse({ targets: [{ kind: 'definition', id: host.doc.state.rootDefinitionId }] })).entries).toEqual([]);
  expect(api.list(manifest(), metadataListSchema.parse({ targets: [{ kind: 'document' }] })).entries).toHaveLength(1);
});
it('retains undecodable payload bytes and rolls back record-quota failures', () => {
  const { host, api } = setup();
  const a = extensionManifestSchema.parse({ ...manifest(), metadata: { dataVersion: 1, schema: { type: 'string' } } });
  for (let i = 0; i < 16; i++) api.apply(a, metadataApplySchema.parse({ expectedRevision: host.doc.version, expectedDataVersion: i ? 1 : null,
    upserts: [{ id: `part${i}`, target: { kind: 'document' }, value: 'x'.repeat(250000) }] }));
  const before = host.doc.state, undoCount = host.undoStack.entries.length;
  expect(() => api.read(a, metadataReadSchema.parse({ ids: ['part0', 'part1', 'part2'] }))).toThrow(/page is too large/);
  expect(() => api.apply(a, metadataApplySchema.parse({ expectedRevision: host.doc.version, expectedDataVersion: 1,
    upserts: [{ id: 'tooMany', target: { kind: 'document' }, value: 'x'.repeat(250000) }] }))).toThrow(/large/);
  expect(host.doc.state).toBe(before);
  expect(host.undoStack.entries).toHaveLength(undoCount);
  host.doc.transact('Unknown saved payload', d => { d.pluginData!.get(a.id)!.entries.get('part0')!.payload = new Uint8Array([255]); });
  const saved = host.doc.state;
  expect(() => api.read(a, metadataReadSchema.parse({ ids: ['part0'] }))).toThrow(/retained/);
  expect(host.doc.state).toBe(saved);
});

it('captures detached face/edge descriptors and rejects stale, absent and non-body topology assignments atomically', () => {
  const s = setup(), a = manifest();
  const id = s.host.doc.transact('Solid', draft => bodyFromMesh(draft, meshBox([0, 0, 0], [1, 1, 1]), { container: draft.definitions.get(draft.rootDefinitionId)!.entities }).id).value;
  const model = new ModelDocumentApi(s.commands, 'Reference check');
  const result = model.query({ container: [], kinds: ['face', 'edge'], ids: [id], fields: ['geometry'], facing: null, containing: null, offset: 0, limit: 100 });
  const before = s.host.doc.state;
  const face = result.entities.find(entity => entity.ref.kind === 'face')!, edge = result.entities.find(entity => entity.ref.kind === 'edge')!;
  expect(face.element).toEqual({ kind: 'face', faceId: face.ref.faceId, bodyVersion: 0 });
  expect(edge.element).toEqual({ kind: 'edge', edgeKey: edge.ref.edgeKey, bodyVersion: 0 });
  expect(s.host.doc.state).toBe(before);
  const target = { kind: 'body', id };
  const upsert = (element: unknown, referenceTarget: unknown = target) => [{ id: 'part', target, value: { label: 'Assigned' }, references: [{ target: referenceTarget, element }] }];
  s.api.apply(a, s.put('Assigned', { upserts: upsert(face.element) }));
  for (const element of [{ ...face.element, bodyVersion: 1 }, { ...face.element, faceId: 9999 }, { ...edge.element, edgeKey: '500:600:0' }]) {
    const state = s.host.doc.state, count = s.host.undoStack.entries.length;
    expect(() => s.api.apply(a, s.put('Invalid', { upserts: upsert(element) }))).toThrow(/face or edge changed/);
    expect(s.host.doc.state).toBe(state); expect(s.host.undoStack.entries).toHaveLength(count);
  }
  expect(() => s.put('Invalid', { upserts: upsert(face.element, { kind: 'document' }) })).toThrow(/body target/);
  const read = s.api.read(a, metadataReadSchema.parse({ ids: ['part'] }));
  read.entries[0]!.references[0]!.element!.bodyVersion = 100;
  expect(s.api.read(a, metadataReadSchema.parse({ ids: ['part'] })).entries[0]!.references[0]!.element!.bodyVersion).toBe(0);
});
