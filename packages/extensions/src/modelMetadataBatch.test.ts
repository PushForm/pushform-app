// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it } from 'vitest';
import { CommandRegistry, DocumentHost, SERVICE_DOCUMENT, SERVICE_KERNEL, editCommands, materialCommands, modelCommands, groupCommands } from '@pushform/commands';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import { extensionManifestSchema, modelMetadataBatchSchema, metadataApplySchema, type ModelMetadataBatchInput } from '@pushform/extension-protocol';
import { readPluginValue } from '@pushform/model';
import { ModelDocumentApi } from './modelApi';
import { ModelMetadataApi } from './metadataApi';
import { applyModelWithMetadata } from './modelMetadataBatch';

const kernels: KernelClient[] = [];
afterEach(() => { for (const kernel of kernels.splice(0)) kernel.dispose(); });
function setup() {
  const host = new DocumentHost(), kernel = new KernelClient(new InlineBackend()); kernels.push(kernel);
  const commands = new CommandRegistry({ tx: host, services: new Map<string, unknown>([[SERVICE_DOCUMENT, host], [SERVICE_KERNEL, kernel]]) });
  for (const set of [editCommands, materialCommands, modelCommands, groupCommands]) commands.registerAll(set);
  const model = new ModelDocumentApi(commands, 'Materials'), metadata = new ModelMetadataApi(commands);
  const manifest = extensionManifestSchema.parse({ id: 'com.example.materials', name: 'Materials', publisher: 'Example', version: '1.0.0', apiVersion: '^0.1.0', editors: ['modeling'], defaultLocale: 'en', license: 'MIT', permissions: ['model.read', 'model.write'], files: {}, contributions: [{ target: 'model.command', id: 'com.example.materials.edit', name: 'Edit' }],
    metadata: { dataVersion: 1, schema: { type: 'object', properties: { label: { type: 'string', maxLength: 262144 } }, required: ['label'] } } });
  const run = (metadataInput: ModelMetadataBatchInput, operations: { op: string; [key: string]: unknown }[] = [{ op: 'add_material', as: 'maple', name: 'Maple', color: '#bba077' }], expectedRevision = host.doc.version, signal?: AbortSignal) =>
    applyModelWithMetadata(model, metadata, manifest, { expectedRevision, label: 'Create configured material', operations, metadata: modelMetadataBatchSchema.parse(metadataInput) }, signal);
  const entry = { id: 'material', target: { kind: 'material' as const, created: 'maple' }, value: { label: 'Maple stock' } };
  return { host, commands, model, metadata, manifest, run, entry };
}

it('upgrades a compatible header beside model work without touching retained entries and rolls back both',async()=>{
  const s=setup();await s.run({expectedDataVersion:null,upserts:[{id:'keep',target:{kind:'document'},value:{label:'Retained'}}]},[]);
  s.manifest.metadata!.dataVersion=2;const record=s.host.doc.state.pluginData!.get(s.manifest.id)!,undo=s.host.undoStack.length;
  await s.run({expectedDataVersion:1,upgradeCompatible:true},[{op:'add_material',name:'Maple',color:'#bba077'}]);
  const updated=s.host.doc.state.pluginData!.get(s.manifest.id)!;expect(updated.dataVersion).toBe(2);expect(updated.entries).toEqual(record.entries);expect(s.host.undoStack.length).toBe(undo+1);
  s.host.undo();expect(s.host.doc.state.pluginData!.get(s.manifest.id)).toEqual(record);
  await expect(s.run({expectedDataVersion:1,upgradeCompatible:true},[{op:'add_material',name:'Refused',color:'#bba077'},{op:'remove_material',materialId:s.host.doc.state.defaultMaterialId}])).rejects.toThrow();
  expect(s.host.doc.state.pluginData!.get(s.manifest.id)).toEqual(record);expect(s.host.undoStack.length).toBe(undo);
});
it('creates a material and typed linked properties in one independent undo entry', async () => {
  const s = setup();
  await s.model.apply({ expectedRevision: s.host.doc.version, label: 'Earlier material', operations: [{ op: 'add_material', name: 'Earlier', color: '#cccccc' }] });
  const earlier = s.host.undoStack.entries.length;
  const result = await s.run({ expectedDataVersion: null, upserts: [s.entry, { id: 'job', target: { kind: 'document' }, value: { label: '$maple stays literal' }, references: [{ target: s.entry.target, entryId: 'material' }] }] });
  const material = result.created.maple!;
  expect(result.metadata.changed).toEqual(['material', 'job']); expect(result.metadata.revision).toBe(result.revision);
  expect(s.host.undoStack.entries).toHaveLength(earlier + 1);
  const record = s.host.doc.state.pluginData!.get(s.manifest.id)!;
  expect(record.entries.get('material')!.target).toEqual({ kind: 'material', id: material });
  expect(record.entries.get('job')!.references[0]!.target).toEqual({ kind: 'material', id: material });
  expect(readPluginValue(record, 'job', 1)).toEqual({ label: '$maple stays literal' });
  s.host.undo(); expect(s.host.doc.state.materials.has(material as never)).toBe(false); expect(s.host.doc.state.pluginData?.has(s.manifest.id) ?? false).toBe(false);
  expect([...s.host.doc.state.materials.values()].some(material => material.name === 'Earlier')).toBe(true);
  s.host.redo(); expect(s.host.doc.state.materials.has(material as never)).toBe(true);
  expect(s.host.doc.state.pluginData!.get(s.manifest.id)).toEqual(record);
});
it('rolls back every material and attachment on invalid schema, wrong/missing aliases, quota and model operation failures', async () => {
  const s = setup();
  const before = s.host.doc.state, undo = s.host.undoStack.entries.length;
  for (const upsert of [
    { ...s.entry, value: { label: 4 } },
    { ...s.entry, target: { kind: 'body' as const, created: 'maple' } },
    { ...s.entry, target: { kind: 'material' as const, created: 'absent' } },
    { ...s.entry, value: { label: '\u00e9'.repeat(150000) } },
  ]) {
    await expect(s.run({ expectedDataVersion: null, upserts: [upsert] })).rejects.toThrow();
    // ID allocation stays monotonic across rollback, as for every ordinary model batch.
    expect({ ...s.host.doc.state, meta: { ...s.host.doc.state.meta, nextId: before.meta.nextId } }).toEqual(before); expect(s.host.undoStack.entries).toHaveLength(undo);
  }
  await expect(s.run({ expectedDataVersion: null, upserts: [s.entry] }, [{ op: 'add_material', as: 'maple', color: '#bba077', name: 'Maple' }, { op: 'remove_material', materialId: s.host.doc.state.defaultMaterialId }])).rejects.toThrow();
  // ID allocation stays monotonic across rollback, as for every ordinary model batch.
  expect({ ...s.host.doc.state, meta: { ...s.host.doc.state.meta, nextId: before.meta.nextId } }).toEqual(before); expect(s.host.undoStack.entries).toHaveLength(undo);
});
it('checks exact revisions and data versions before model work and refuses aborted requests', async () => {
  const s = setup(), revision = s.host.doc.version;
  await s.model.apply({ expectedRevision: revision, label: 'Earlier own batch', operations: [{ op: 'add_material', name: 'Earlier', color: '#cccccc' }] });
  const before = s.host.doc.state;
  await expect(s.run({ expectedDataVersion: null, upserts: [s.entry] }, undefined, revision)).rejects.toMatchObject({ code: 'revision.stale' });
  await expect(s.run({ expectedDataVersion: 1, upserts: [s.entry] })).rejects.toMatchObject({ code: 'revision.stale' });
  const signal = AbortSignal.abort();
  await expect(s.run({ expectedDataVersion: null, upserts: [s.entry] }, undefined, undefined, signal)).rejects.toThrow();
  expect(s.host.doc.state).toBe(before);
  const newer = extensionManifestSchema.parse({ ...s.manifest, metadata: { ...s.manifest.metadata, dataVersion: 2 } });
  s.metadata.apply(newer, metadataApplySchema.parse({ expectedRevision: s.host.doc.version, expectedDataVersion: null, upserts: [{ id: 'job', target: { kind: 'document' }, value: { label: 'Newer data' } }] }));
  const retained = s.host.doc.state;
  await expect(s.run({ expectedDataVersion: 2, upserts: [s.entry] })).rejects.toMatchObject({ code: 'extension.unsupported' });
  expect(s.host.doc.state).toBe(retained);
});
it('duplicates all opaque material attachments and removes/purges through the ordinary host lifecycle', async () => {
  const s = setup(), result = await s.run({ expectedDataVersion: null, upserts: [s.entry] }), source = result.created.maple!;
  const foreign = extensionManifestSchema.parse({ ...s.manifest, id: 'com.example.other', contributions: [{ target: 'model.command', id: 'com.example.other.edit', name: 'Edit' }], metadata: { ...s.manifest.metadata, dataVersion: 3 } });
  s.metadata.apply(foreign, metadataApplySchema.parse({ expectedRevision: s.host.doc.version, expectedDataVersion: null, upserts: [{ id: 'other', target: { kind: 'material', id: source }, value: { label: 'Other plugin' } }] }));
  const copy = await s.model.apply({ expectedRevision: s.host.doc.version, label: 'Duplicate maple', operations: [{ op: 'duplicate_material', materialId: source, name: 'Maple copy', as: 'copy' }] });
  const duplicate = copy.created.copy!;
  expect(s.host.doc.state.materials.get(duplicate as never)!.name).toBe('Maple copy');
  for (const id of [s.manifest.id, foreign.id]) {
    const record = s.host.doc.state.pluginData!.get(id)!;
    const entry = [...record.entries.values()].find(entry => entry.target.kind === 'material' && entry.target.id === duplicate)!;
    expect(entry).toBeDefined(); expect(readPluginValue(record, [...record.entries].find(([, value]) => value === entry)![0], record.dataVersion)).toEqual({ label: id === foreign.id ? 'Other plugin' : 'Maple stock' });
  }
  await s.model.apply({ expectedRevision: s.host.doc.version, label: 'Remove duplicate', operations: [{ op: 'remove_material', materialId: duplicate }] });
  expect(s.host.doc.state.materials.has(duplicate as never)).toBe(false);
  expect([...s.host.doc.state.pluginData!.get(foreign.id)!.entries.values()].some(entry => entry.target.kind === 'material' && entry.target.id === duplicate)).toBe(false);
  await s.model.apply({ expectedRevision: s.host.doc.version, label: 'Purge unused materials', operations: [{ op: 'purge_materials' }] });
  expect(s.host.doc.state.materials.has(source as never)).toBe(false); expect(s.host.doc.state.materials.has(s.host.doc.state.defaultMaterialId)).toBe(true);
});

it('resolves new body occurrences, groups and definitions and rolls back a cancellation after model work begins', async () => {
  const s = setup();
  const result = await s.run({ expectedDataVersion: null, upserts: [
    { id: 'body', target: { kind: 'bodyOccurrence', created: 'panel', path: [] }, value: { label: 'Physical panel' } },
    { id: 'group', target: { kind: 'group', created: 'assembly' }, value: { label: 'Assembly' } },
    { id: 'definition', target: { kind: 'definition', created: 'assembly' }, value: { label: 'Shared defaults' } },
  ] }, [{ op: 'add_box', as: 'panel', min: [0, 0, 0], max: [1, .5, .02] }, { op: 'add_box', as: 'other', min: [2, 0, 0], max: [3, .5, .02] }, { op: 'make_group', refs: ['$other'], as: 'assembly' }]);
  const entries = s.host.doc.state.pluginData!.get(s.manifest.id)!.entries;
  expect(entries.get('body')!.target).toEqual({ kind: 'bodyOccurrence', id: result.created.panel, path: [] });
  expect(entries.get('group')!.target).toEqual({ kind: 'group', id: result.created.assembly });
  expect(entries.get('definition')!.target.kind).toBe('definition');
  const before = s.host.doc.state, undo = s.host.undoStack.entries.length, abort = new AbortController();
  const off = s.host.doc.events.on('change', () => abort.abort());
  try { await expect(s.run({ expectedDataVersion: 1, upserts: [s.entry] }, undefined, undefined, abort.signal)).rejects.toThrow(); }
  finally { off(); }
  expect({ ...s.host.doc.state, meta: { ...s.host.doc.state.meta, nextId: before.meta.nextId } }).toEqual(before);
  expect(s.host.undoStack.entries).toHaveLength(undo);
});

it('purge preserves manufacturing-only material references while allowing unassigned configured materials to be removed', async () => {
  const s = setup();
  const created = await s.run({ expectedDataVersion: null, upserts: [s.entry,
    { id: 'treatment', target: { kind: 'document' }, value: { label: 'Manufacturing dependency' }, references: [{ target: s.entry.target }] },
  ] });
  const used = created.created.maple!;
  const unused = await s.model.apply({ expectedRevision: s.host.doc.version, label: 'Unused configured stock', operations: [{ op: 'add_material', as: 'extra', name: 'Extra', color: '#ffffff' }] });
  s.metadata.apply(s.manifest, metadataApplySchema.parse({ expectedRevision: s.host.doc.version, expectedDataVersion: 1, upserts: [{ id: 'unused', target: { kind: 'material', id: unused.created.extra! }, value: { label: 'Unused settings' } }] }));
  await s.model.apply({ expectedRevision: s.host.doc.version, label: 'Purge', operations: [{ op: 'purge_materials' }] });
  expect(s.host.doc.state.materials.has(used as never)).toBe(true);
  expect(s.host.doc.state.materials.has(unused.created.extra! as never)).toBe(false);
  await s.model.apply({ expectedRevision: s.host.doc.version, label: 'Explicitly remove used material', operations: [{ op: 'remove_material', materialId: used }] });
  expect(s.host.doc.state.pluginData!.get(s.manifest.id)!.entries.get('treatment')!.references[0]!.unresolved).toBe(true);
});


it('commits metadata-only edits without touching geometry and refuses empty ordinary model requests', async () => {
  const s = setup(), before = s.host.doc.state, undo = s.host.undoStack.length;
  const result = await s.run({ expectedDataVersion: null, upserts: [{ id: 'job', target: { kind: 'document' }, value: { label: 'Metadata only' } }] }, []);
  expect(result.created).toEqual({}); expect(result.results).toEqual([]);
  expect(s.host.doc.state.definitions).toBe(before.definitions); expect(s.host.undoStack.length).toBe(undo + 1);
  s.host.undo(); expect(s.host.doc.state.pluginData?.has(s.manifest.id) ?? false).toBe(false);
  await expect(s.model.apply({ expectedRevision: s.model.revision, label: 'Empty', operations: [] })).rejects.toThrow();
  const controller = new AbortController(); controller.abort();
  await expect(s.run({ expectedDataVersion: null, upserts: [{ id: 'job', target: { kind: 'document' }, value: { label: 'Cancelled' } }] }, [], s.model.revision, controller.signal)).rejects.toThrow();
  expect(s.host.doc.state.pluginData?.has(s.manifest.id) ?? false).toBe(false);
});
