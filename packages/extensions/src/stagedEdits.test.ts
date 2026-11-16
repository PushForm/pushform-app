// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { CommandRegistry, DocumentHost, SERVICE_DOCUMENT, SERVICE_KERNEL, editCommands, materialCommands, modelCommands, groupCommands } from '@pushform/commands';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import { extensionManifestSchema, stagedEditBeginSchema, stagedEditAppendSchema, materialStageSchema, metadataApplySchema, STAGED_EDIT_LIMITS, type MaterialAppearance } from '@pushform/extension-protocol';
import { readPluginValue } from '@pushform/model';
import { MaterialAppearanceStaging } from './materialAssets';
import { ModelDocumentApi } from './modelApi';
import { ModelMetadataApi } from './metadataApi';
import { StagedModelEdits } from './stagedEdits';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); vi.useRealTimers(); });
const image = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB7sAAAAASUVORK5CYII='), c => c.charCodeAt(0));
const appearance: MaterialAppearance = { name: 'Maple', color: [.3123, .4234, .5345], opacity: .75,
  texture: { widthM: .6, heightM: 1.2, colorize: true, colorizeType: 'tint', grain: 'height', image: { name: 'maple.png', mime: 'image/png', width: 1, height: 1, byteLength: image.length } } };
const entry = (i: number) => ({ id: `part:${i}`, target: { kind: 'document' as const }, value: { label: String(i) } });
function setup(now = () => Date.now()) {
  const host = new DocumentHost(), kernel = new KernelClient(new InlineBackend());
  const commands = new CommandRegistry({ tx: host, services: new Map<string, unknown>([[SERVICE_DOCUMENT, host], [SERVICE_KERNEL, kernel]]) });
  for (const set of [editCommands, materialCommands, modelCommands, groupCommands]) commands.registerAll(set);
  const model = new ModelDocumentApi(commands, 'Materials'), metadata = new ModelMetadataApi(commands);
  const manifest = extensionManifestSchema.parse({ id: 'com.example.materials', name: 'Materials', publisher: 'Example', version: '1.0.0', apiVersion: '^0.1.0', editors: ['modeling'], defaultLocale: 'en', license: 'MIT', permissions: ['model.read', 'model.write'], files: {}, contributions: [{ target: 'model.command', id: 'com.example.materials.edit', name: 'Edit' }],
    metadata: { dataVersion: 1, schema: { type: 'object', properties: { label: { type: 'string', maxLength: 262144 } }, required: ['label'] } } });
  const appearances: MaterialAppearanceStaging = new MaterialAppearanceStaging(now, (): number => edits.imageBytes);
  const edits = new StagedModelEdits(manifest, appearances, now);
  cleanup.push(() => { edits.dispose(); appearances.dispose(); kernel.dispose(); });
  const signal = new AbortController().signal;
  const begin = (extra: object = {}) => edits.begin('one', model, metadata, stagedEditBeginSchema.parse({ expectedRevision: model.revision, label: 'Large edit', metadata: { expectedDataVersion: null }, ...extra }), signal);
  const append = (batch: string, sequence: number, extra: object) => edits.append('one', model, stagedEditAppendSchema.parse({ batch, sequence, ...extra }), signal);
  const commit = (batch: string, abort = signal, progress?: (value: number) => void) => edits.commit('one', batch, model, metadata, abort, progress);
  return { host, kernel, commands, model, metadata, manifest, appearances, edits, signal, begin, append, commit };
}

it('captures 600 precise appearances and typed attachments across chunks, then commits and undoes exactly once', async () => {
  const s = setup();
  await s.model.apply({ expectedRevision: s.model.revision, label: 'Earlier edit', operations: [{ op: 'add_material', name: 'Earlier', color: '#ffffff' }] });
  const before = s.host.doc.state, undo = s.host.undoStack.entries.length, draft = s.begin();
  for (let chunk = 0; chunk < 3; chunk++) {
    const rows = Array.from({ length: 200 }, (_, j) => chunk * 200 + j);
    const result = await s.append(draft.batch, chunk, {
      appearances: rows.map(i => ({ id: `a${i}`, appearance: { ...appearance, name: `Panel ${i}`, texture: null } })),
      operations: rows.map(i => ({ op: 'add_material_appearance', asset: `a${i}`, as: `m${i}` })),
      metadata: { upserts: rows.map(i => ({ ...entry(i), target: { kind: 'material', created: `m${i}` },
        references: [{ target: { kind: 'material', created: 'm599' }, entryId: 'part:599' }] })) },
    });
    expect(result.operations).toBe((chunk + 1) * 200); expect(s.host.doc.state).toBe(before);
    expect(s.host.undoStack.entries).toHaveLength(undo);
  }
  const progress: number[] = [], result = await s.commit(draft.batch, s.signal, v => progress.push(v));
  const created = Object.assign({}, ...Array.from({ length: 6 }, (_, i) => s.edits.result('one', draft.batch, i * 200, 200).created)) as Record<string, number>;
  expect(result.created).toBe(600); expect(s.host.undoStack.entries).toHaveLength(undo + 1);
  expect(progress[0]).toBe(0); expect(progress.at(-1)).toBe(1);
  const record = s.host.doc.state.pluginData!.get(s.manifest.id)!;
  expect(record.entries.size).toBe(600); expect(record.entries.get('part:0')!.references[0]!.target).toEqual({ kind: 'material', id: created.m599 });
  expect(s.host.doc.state.materials.get(created.m500 as never)).toMatchObject({ color: appearance.color, alpha: .75, name: 'Panel 500' });
  const committed = s.host.doc.state;
  expect(await s.commit(draft.batch)).toEqual(result); expect(s.host.doc.state).toBe(committed);
  s.host.undo(); expect(s.host.doc.state.materials).toEqual(before.materials); expect(s.host.doc.state.pluginData).toEqual(before.pluginData);
  s.host.redo(); expect(s.host.doc.state.materials).toEqual(committed.materials); expect(s.host.doc.state.pluginData).toEqual(committed.pluginData);
  s.edits.discard('one', draft.batch); await expect(s.commit(draft.batch)).rejects.toMatchObject({ code: 'validation.failed' });
});

it('moves more than sixteen uploads into a draft and rebinds shared bytes without duplicating image reservations', async () => {
  const s = setup(), draft = s.begin();
  for (let i = 0; i < 20; i++) {
    const upload = s.appearances.stage('one', s.model.revision, materialStageSchema.parse({ expectedRevision: s.model.revision, appearance, bytes: image }));
    await s.append(draft.batch, i, { appearances: [{ id: `a${i}`, source: upload.upload }], operations: [{ op: 'add_material_appearance', asset: `a${i}`, as: `m${i}` }] });
    expect(() => s.appearances.resolve('one', s.model.revision, [{ op: 'add_material_appearance', asset: upload.upload }])).toThrow(/unavailable/);
  }
  await s.append(draft.batch, 20, { appearances: [{ id: 'birch', source: 'a0', appearance: { ...appearance, name: 'Birch', texture: { ...appearance.texture!, image:{...appearance.texture!.image,name:'birch.png'},widthM: .3, grain: 'width' } } }], operations: [{ op: 'add_material_appearance', asset: 'birch', as: 'birch' }] });
  expect(s.edits.imageBytes).toBe(20 * image.length);
  const result = await s.commit(draft.batch); expect(s.edits.imageBytes).toBe(0);
  const id = s.edits.result('one', draft.batch, 0, 200).created.birch;
  expect(result.created).toBe(21);
  const material = s.host.doc.state.materials.get(id as never)!;
  expect(material.texture).toMatchObject({ widthM: .3, grain: 'width', colorizeType: 'tint' }); expect(material.color).toEqual(appearance.color);
  expect(s.host.images.get(material.texture!.imageId)!.bytes).toEqual(image);
  expect(s.model.materialRead({expectedRevision:s.model.revision,materialId:id!,offset:0,limit:1}).appearance.texture!.image.name).toBe('birch.png');
  expect(s.host.doc.state.images.size).toBe(1);
  s.commands.execute('material.update',{id,texture:{widthM:.4}});
  expect(s.host.doc.state.materials.get(id as never)!.texture!.imageName).toBe('birch.png');
  s.host.undo();
  const duplicate=s.commands.execute('material.duplicate',{id,activate:false}) as number;
  expect(s.host.doc.state.materials.get(duplicate as never)!.texture!.imageName).toBe('birch.png');s.host.undo();
  const replacement=await s.host.images.put(new Uint8Array([...image,1]),'image/png','replacement.png',{width:1,height:1});
  s.commands.execute('material.update',{id,texture:{imageId:replacement.id}});
  expect(s.host.doc.state.materials.get(id as never)!.texture!.imageName).toBeUndefined();
  expect(s.model.materialRead({expectedRevision:s.model.revision,materialId:id!,offset:0,limit:1}).appearance.texture!.image.name).toBe('replacement.png');s.host.undo();
  expect(s.host.undoStack.entries).toHaveLength(1); s.host.undo(); expect(s.host.doc.state.images.size).toBe(0);
});

it('retains the accepted prefix and complete upload after failed append, and acknowledges identical retries', async () => {
  const s = setup(), draft = s.begin(), revision = s.model.revision;
  const upload = s.appearances.stage('one', revision, materialStageSchema.parse({ expectedRevision: revision, appearance, bytes: image }));
  const chunk = { appearances: [{ id: 'maple', source: upload.upload }], metadata: { upserts: [entry(0)] } };
  await expect(s.append(draft.batch, 0, { ...chunk, operations: [{ op: 'add_material_appearance', asset: 'missing' }] })).rejects.toThrow(/Bind each/);
  expect(s.edits.imageBytes).toBe(0); expect(s.appearances.resolve('one', revision, [{ op: 'add_material_appearance', asset: upload.upload }]).size).toBe(1);
  const result = await s.append(draft.batch, 0, chunk);
  expect(await s.append(draft.batch, 0, chunk)).toEqual(result);
  await expect(s.append(draft.batch, 0, { metadata: { upserts: [entry(1)] } })).rejects.toThrow(/cannot change/);
  await expect(s.append(draft.batch, 2, { metadata: { upserts: [entry(2)] } })).rejects.toThrow(/sequence/);
  await expect(s.append(draft.batch, 1, { metadata: { upserts: [entry(0)] } })).rejects.toThrow(/only once/);
  await expect(s.append(draft.batch, 1, { appearances: [{ id: 'bad', source: 'maple', appearance: { ...appearance, texture: null } }] })).rejects.toThrow(/byte length/);
  await s.commit(draft.batch); expect(s.host.doc.state.pluginData!.get(s.manifest.id)!.entries.size).toBe(1);
});

it('replaces complete appearances without inheriting absent grain or colorization fields from the destination',async()=>{
  const s=setup();
  async function stage(batch:string,sequence:number,value:MaterialAppearance,operation:object){
    const upload=s.appearances.stage('one',s.model.revision,materialStageSchema.parse({expectedRevision:s.model.revision,appearance:value,bytes:image}));
    return await s.append(batch,sequence,{appearances:[{id:'source',source:upload.upload}],operations:[operation]});
  }
  const first=s.begin({metadata:undefined});await stage(first.batch,0,appearance,{op:'add_material_appearance',asset:'source',as:'material'});await s.commit(first.batch);
  const id=s.edits.result('one',first.batch,0,200).created.material!;s.edits.discard('one',first.batch);
  const before=s.host.doc.state.materials.get(id as never)!,second=s.begin({metadata:undefined});
  const {grain:_grain,colorizeType:_type,...texture}=appearance.texture!;
  const replacement={...appearance,texture};
  await stage(second.batch,0,replacement,{op:'set_material_appearance',materialId:id,asset:'source'});await s.commit(second.batch);
  const saved=s.host.doc.state.materials.get(id as never)!;
  expect(Object.hasOwn(saved.texture!,'grain')).toBe(false);expect(Object.hasOwn(saved.texture!,'colorizeType')).toBe(false);
  expect(s.model.materialRead({expectedRevision:s.model.revision,materialId:id,offset:0,limit:1}).appearance).toEqual(replacement);
  expect(s.host.doc.state.images.size).toBe(1);expect(s.host.undoStack.entries).toHaveLength(2);
  s.host.undo();expect(s.host.doc.state.materials.get(id as never)).toEqual(before);s.host.redo();expect(s.host.doc.state.materials.get(id as never)).toEqual(saved);
});

it('supports metadata-only numbering, complete migrations and deletions beyond ordinary per-call limits', async () => {
  const s = setup(), draft = s.begin();
  for (let i = 0; i < 3; i++) await s.append(draft.batch, i, { metadata: { upserts: Array.from({ length: 200 }, (_, j) => entry(i * 200 + j)) } });
  await s.commit(draft.batch); s.edits.discard('one', draft.batch);
  const old = s.host.doc.state.pluginData!.get(s.manifest.id)!; expect(old.entries.size).toBe(600);
  s.manifest.metadata!.dataVersion = 2;
  expect(() => s.begin({ metadata: { expectedDataVersion: 1 } })).toThrow(/Migrate/);
  const migration = s.begin({ metadata: { expectedDataVersion: 1, replaceRecord: true } });
  for (let i = 0; i < 3; i++) await s.append(migration.batch, i, { metadata: { upserts: Array.from({ length: 200 }, (_, j) => ({ ...entry(i * 200 + j), value: { label: `v2:${j}` } })) } });
  await s.commit(migration.batch); s.edits.discard('one', migration.batch);
  expect(s.host.doc.state.pluginData!.get(s.manifest.id)!.dataVersion).toBe(2);
  s.host.undo(); expect(s.host.doc.state.pluginData!.get(s.manifest.id)).toEqual(old); s.host.redo();
  const deletion = s.begin({ metadata: { expectedDataVersion: 2 } });
  for (let i = 0; i < 3; i++) await s.append(deletion.batch, i, { metadata: { deletes: Array.from({ length: 200 }, (_, j) => entry(i * 200 + j).id) } });
  await s.commit(deletion.batch); expect(s.host.doc.state.pluginData!.get(s.manifest.id)!.entries.size).toBe(0);
  s.host.undo(); expect(s.host.doc.state.pluginData!.get(s.manifest.id)!.entries.size).toBe(600);
  s.manifest.metadata!.dataVersion = 1;
  expect(() => s.begin({ metadata: { expectedDataVersion: 2, replaceRecord: true } })).toThrow(/newer/i);
});

it.each(['cancel', 'discard', 'close', 'stop', 'bad-alias', 'bad-reference', 'bad-operation', 'quota'])('rolls back all commands and metadata on %s', async mode => {
  const s = setup(), before = s.host.doc.state, draft = s.begin(), abort = new AbortController();
  for (let i = 0; i < 2; i++) await s.append(draft.batch, i, { operations: Array.from({ length: 200 }, (_, j) => ({ op: 'add_material', name: `Row ${i * 200 + j}`, color: '#abcdef' })) });
  const update = mode === 'bad-alias' ? { ...entry(0), target: { kind: 'material', created: 'unknown' } }
    : mode === 'bad-reference' ? { ...entry(0), references: [{ target: { kind: 'document' }, entryId: 'missing' }] } : entry(0);
  await s.append(draft.batch, 2, { metadata: { upserts: mode === 'quota' ? Array.from({ length: 25 }, (_, i) => ({ ...entry(i), value: { label: 'x'.repeat(180000) } })) : [update] },
    ...(mode === 'bad-operation' ? { operations: [{ op: 'set_material', materialId: 4294967295, color: '#ffffff' }] } : {}) });
  let ended = false;
  const pending = s.commit(draft.batch, abort.signal, value => {
    if (ended || value === 0 || value === 1) return; ended = true;
    if (mode === 'cancel') abort.abort(); if (mode === 'discard') s.edits.discard('one', draft.batch);
    if (mode === 'close') s.edits.closed('one'); if (mode === 'stop') s.edits.dispose();
  });
  await expect(pending).rejects.toBeDefined();
  expect(s.host.doc.state.materials).toEqual(before.materials); expect(s.host.doc.state.pluginData).toEqual(before.pluginData);
  expect(s.host.undoStack.entries).toHaveLength(0); expect(s.edits.imageBytes).toBe(0);
});

it('rejects stale revisions, foreign drafts and overlarge ordinary calls, and releases slots at expiry', async () => {
  let now = 0; const s = setup(() => now), draft = s.begin();
  await expect(s.edits.append('two', s.model, stagedEditAppendSchema.parse({ batch: draft.batch, sequence: 0, metadata: { upserts: [entry(0)] } }), s.signal)).rejects.toThrow(/another document/);
  const second = s.begin(); expect(() => s.begin()).toThrow(/discard/);
  now = STAGED_EDIT_LIMITS.lifetimeMs;
  await expect(s.commit(draft.batch)).rejects.toThrow(/expired/); expect(() => s.edits.discard('one', second.batch)).toThrow(/expired/);
  const fresh = s.begin();
  await s.model.apply({ expectedRevision: s.model.revision, label: 'Concurrent edit', operations: [{ op: 'add_material', name: 'Other', color: '#ffffff' }] });
  await expect(s.commit(fresh.batch)).rejects.toMatchObject({ code: 'revision.stale' });
  await expect(s.model.apply({ expectedRevision: s.model.revision, label: 'Too large', operations: Array.from({ length: 201 }, () => ({ op: 'add_material', name: 'Extra', color: '#ffffff' })) })).rejects.toMatchObject({ error: { code: 'limit_exceeded' } });
  expect(metadataApplySchema.safeParse({ expectedRevision: s.model.revision, expectedDataVersion: null, upserts: Array.from({ length: 201 }, (_, i) => entry(i)) }).success).toBe(false);
});

it('preserves literal payload strings, captured inspector scope and committed edits after observer failure', async () => {
  const s = setup(), parsed = stagedEditBeginSchema.parse({ expectedRevision: s.model.revision, label: 'Scoped edit', metadata: { expectedDataVersion: null } });
  const draft = s.edits.begin('one', s.model, s.metadata, parsed, s.signal, [{ kind: 'document' }]);
  await s.append(draft.batch, 0, { metadata: { upserts: [{ ...entry(0), value: { label: '$m599 remains literal' } }] } });
  await s.commit(draft.batch, s.signal, () => { throw Error('Disconnected observer'); });
  expect(readPluginValue(s.host.doc.state.pluginData!.get(s.manifest.id)!, 'part:0', 1)).toEqual({ label: '$m599 remains literal' });
  s.edits.discard('one', draft.batch);
  const forbidden = s.edits.begin('one', s.model, s.metadata, stagedEditBeginSchema.parse({ ...parsed, expectedRevision: s.model.revision, metadata: { expectedDataVersion: 1 } }), s.signal, []);
  await s.append(forbidden.batch, 0, { metadata: { upserts: [entry(1)] } });
  await expect(s.commit(forbidden.batch)).rejects.toMatchObject({ code: 'permission.denied' });
  expect(s.host.undoStack.entries).toHaveLength(1);
});

it('pins the captured container while the user changes editing context and preserves exclusive command ownership', async () => {
  const s = setup();
  const made = await s.model.apply({ expectedRevision: s.model.revision, label: 'Assembly', operations: [{ op: 'add_box', min: [0,0,0], max: [1,1,1], as: 'panel' }, { op: 'make_group', refs: ['$panel'], as: 'assembly' }] });
  s.host.setContext([made.created.assembly! as never]);
  const draft = s.begin({ metadata: undefined }); s.host.setContext([]);
  await s.append(draft.batch, 0, { operations: [{ op: 'add_box', min: [2,0,0], max: [3,1,1] }] });
  let checked = false;
  await s.commit(draft.batch, s.signal, value => {
    if (value !== 0) return;
    expect(() => s.commands.execute('material.create', { name: 'Intruder', color: [1,1,1] })).toThrow(/Wait|applying|applied/);
    expect(s.host.undo()).toBe(false); checked = true;
  });
  expect(checked).toBe(true); expect(s.host.context.path).toEqual([]); expect(s.host.doc.rootDefinition.entities.bodies.size).toBe(0);
  const instance = s.host.doc.rootDefinition.entities.instances.get(made.created.assembly as never)!;
  expect(s.host.doc.state.definitions.get(instance.definitionId)!.entities.bodies.size).toBe(2);
});

it('bounds aggregate operations, prepared JSON and image reservations without consuming the accepted prefix', async () => {
  const s = setup(), draft = s.begin();
  for (let i = 0; i < 50; i++) await s.append(draft.batch, i, { operations: Array.from({ length: 200 }, () => ({ op: 'add_material', name: 'Prepared', color: '#ffffff' })) });
  await expect(s.append(draft.batch, 50, { operations: [{ op: 'add_material', name: 'Overflow', color: '#ffffff' }] })).rejects.toMatchObject({ code: 'limit.exceeded' });
  s.edits.discard('one', draft.batch);
  const json = s.begin();
  await expect(s.append(json.batch, 0, { metadata: { upserts: Array.from({ length: 100 }, (_, i) => ({ ...entry(i), value: { label: 'x'.repeat(180000) } })) } })).rejects.toMatchObject({ code: 'limit.exceeded' });
  await s.append(json.batch, 0, { metadata: { upserts: [entry(0)] } });
  const big = { ...appearance, texture: { ...appearance.texture!, image: { ...appearance.texture!.image, byteLength: 64 * 1024 * 1024 } } };
  // Valid header + padding exercises accounting without requiring a different decoded image.
  const pixels = new Uint8Array(big.texture.image.byteLength); pixels.set(image);
  let upload = s.appearances.stage('one', s.model.revision, materialStageSchema.parse({ expectedRevision: s.model.revision, appearance: big }));
  for (let at = 0; at < pixels.length; at += 256 * 1024) upload = s.appearances.stage('one', s.model.revision, materialStageSchema.parse({ expectedRevision: s.model.revision, upload: upload.upload, offset: at, bytes: pixels.slice(at, at + 256 * 1024) }));
  await s.append(json.batch, 1, { appearances: [{ id: 'retained', source: upload.upload }] });
  s.appearances.stage('one', s.model.revision, materialStageSchema.parse({ expectedRevision: s.model.revision, appearance: big }));
  expect(() => s.appearances.stage('one', s.model.revision, materialStageSchema.parse({ expectedRevision: s.model.revision, appearance }))).toThrow(/quota/);
  s.edits.discard('one', json.batch); expect(s.edits.imageBytes).toBe(0);
  expect(s.appearances.stage('one', s.model.revision, materialStageSchema.parse({ expectedRevision: s.model.revision, appearance, bytes: image })).complete).toBe(true);
});

it('cancels a long-running commit at the normal kernel deadline after commands have started', async () => {
  const s = setup(), draft = s.begin(), initial = s.host.doc.state, start = Date.now();
  await s.append(draft.batch, 0, { operations: Array.from({ length: 100 }, () => ({ op: 'add_material', name: 'Timed', color: '#abcdef' })) });
  let advanced = false;
  await expect(s.commit(draft.batch, s.signal, value => { if (value > 0 && value < 1 && !advanced) { advanced = true; vi.spyOn(Date, 'now').mockReturnValue(start + 31000); } })).rejects.toMatchObject({ error: { code: 'limit_exceeded' } });
  expect(advanced).toBe(true); expect(s.host.doc.state.materials).toEqual(initial.materials); expect(s.host.undoStack.entries).toHaveLength(0);
  vi.restoreAllMocks();
});
