// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { CommandRegistry, DocumentHost, SERVICE_DOCUMENT, SERVICE_KERNEL, modelCommands, modelClipboard, groupCommands, componentCommands, transformCommands } from '@pushform/commands';
import { KernelClient, InlineBackend } from '@pushform/kernel';
import { extensionManifestSchema, FRAGMENT_LIMITS, NATIVE_FRAGMENT_MIME, type ExtensionPermission, type FragmentDescription, type FragmentProjection, type FragmentFitResult, type MetadataReadResult, type MetadataListResult, type ModelQueryResult, type AssetDescriptor, type FileReadDescription, type ModelBatchResult, type StagedEditProgress, type StagedEditCommitResult } from '@pushform/extension-protocol';
import { containerAt, contextMatrix } from '@pushform/model';
import { m4identity, m4translation, m4transformPoint, LENGTH_TOL, type Id } from '@pushform/core';
import { encodeModelSnapshot, openModelFile } from '@pushform/io/native-files';
import { memoryAssetStore } from '../assetStore';
import { ExtensionFragmentHost } from './fragments';
import { ExtensionFileTransfers } from './fileTransfers';
import { commandsDocument, ExtensionDocumentHost, type ExtensionDocuments } from './documents';
import { ExtensionSession } from './host';
import { startGuest, type ExtensionContext } from './guest';
import { messagePortTransport } from './port';
import type { FilePicker } from './io';
import { ExtensionAssetHost } from './assets';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); modelClipboard.set(null); });
const all: ExtensionPermission[] = ['model.read', 'model.write', 'settings', 'file.read', 'file.export'];
type Call<T> = (input: unknown) => Promise<T>;
interface Services {
  fragments: Record<'capture' | 'openFile' | 'openAsset' | 'openPackage' | 'describe' | 'derive', Call<FragmentDescription>> & {
    query: Call<ModelQueryResult>; metadataList: Call<MetadataListResult>; metadataRead: Call<MetadataReadResult>; project: Call<FragmentProjection>; fit: Call<FragmentFitResult>;
    save: Call<AssetDescriptor>; export: Call<{ name: string }>; discard: Call<null>;
  };
  files: { openRead: Call<FileReadDescription> };
  model: { apply: Call<ModelBatchResult>; batchBegin: Call<StagedEditProgress>; batchAppend: Call<StagedEditProgress>; batchCommit: Call<StagedEditCommitResult> };
}
const manifest = (permissions = all) => extensionManifestSchema.parse({ id: 'com.example.modules', name: 'Modules', publisher: 'Example', version: '1.0.0', apiVersion: '^0.1.0', editors: ['modeling'], defaultLocale: 'en', license: 'MIT', permissions, files: {}, contributions: [{ target: 'model.command', id: 'com.example.modules.run', name: 'Run' }], metadata: { dataVersion: 1, schema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false } } });
function source() {
  const host = new DocumentHost(), kernel = new KernelClient(new InlineBackend()), commands = new CommandRegistry({ tx: host, services: new Map<string, unknown>([[SERVICE_DOCUMENT, host], [SERVICE_KERNEL, kernel]]) });
  cleanup.push(() => kernel.dispose());
  for (const set of [modelCommands, groupCommands, componentCommands, transformCommands]) commands.registerAll(set);
  const id = commands.execute('model.addBox', { min: [0, 0, 0], max: [0.6, 0.3, 0.018] }) as number;
  host.doc.transact('Fixture properties', draft => { draft.pluginData = new Map([
    ['com.example.modules', { dataVersion: 1, entries: new Map([['label', { target: { kind: 'body', id }, payload: new TextEncoder().encode(JSON.stringify({ label: 'Maple shelf' })), references: [] }]]) }],
    ['org.example.foreign', { dataVersion: 99, entries: new Map([['opaque', { target: { kind: 'body', id }, payload: new Uint8Array([255, 0, 128]), references: [] }]]) }],
  ]); });
  return { host, commands, id, document: commandsDocument(commands) };
}
function connection(options: { grants?: ExtensionPermission[]; documents?: ExtensionDocuments; store?: ReturnType<typeof memoryAssetStore> | null; picker?: FilePicker; packageBytes?: Uint8Array; now?: () => number; dataVersion?: number; createFitKernel?:()=>KernelClient } = {}) {
  const m = manifest(), store = options.store === undefined ? memoryAssetStore() : options.store;
  m.metadata!.dataVersion = options.dataVersion ?? 1;
  if (options.packageBytes) m.files['examples/shelf.pf'] = 'a'.repeat(64);
  const picker = options.picker ?? { open: async () => null, save: async () => null };
  const files = new ExtensionFileTransfers(m, picker, options.now);
  const fragments = new ExtensionFragmentHost({ manifest: m, files, packageFiles: new Map(options.packageBytes ? [['examples/shelf.pf', options.packageBytes]] : []), store, picker,
    ...(options.documents ? { documents: options.documents } : {}), ...(options.now ? { now: options.now } : {}), ...(options.createFitKernel ? { createFitKernel:options.createFitKernel } : {}) });
  const assets = new ExtensionAssetHost(m.id, store, options.now), channel = new MessageChannel();
  const ref: { session?: ExtensionSession } = {};
  const documents = options.documents ? new ExtensionDocumentHost({ manifest: m, grants: new Set(options.grants ?? all), documents: options.documents, session: () => ref.session, nativePlacements: fragments }) : null;
  const session = ref.session = new ExtensionSession({ manifest: m, grants: options.grants ?? all, port: messagePortTransport(channel.port1), services: { ...files.services(), ...fragments.services(), ...assets.services(), ...documents?.services() } });
  let body: (context: Services) => unknown;
  void startGuest(messagePortTransport(channel.port2), async () => ({ activate(context: ExtensionContext) { context.commands.register('com.example.modules.run', () => body(context as unknown as Services)); } }));
  cleanup.push(() => { documents?.dispose(); fragments.dispose(); files.dispose(); assets.dispose(); channel.port1.close(); channel.port2.close(); });
  return { session, fragments, store, run<T>(fn: (context: Services) => T | Promise<T>, document?: string): Promise<T> {
    body = fn; return session.invoke('com.example.modules.run', {}, document ? { document } : {}) as Promise<T>;
  } };
}
const capture = (s: ReturnType<typeof source>) => ({ expectedRevision: s.host.doc.version, name: 'Shelf module', ref: { kind: 'body' as const, id: s.id, path: [] } });

const projectionAxes = [[1,0,0],[0,1,0],[0,0,1]];
const fitRequest = (fragment:string) => ({fragment,expectedRevision:1,axes:projectionAxes,size:[.8,.3,.018],planes:[{normal:[1,0,0],offset:.3,side:'positive',displacement:[.2,0,0]}]});

it('projects complete rotated geometry rather than projecting its axis-aligned bounding box',async()=>{
  const s=source(),a=Math.SQRT1_2;
  await s.commands.execute('transform.apply',{refs:[{kind:'body',id:s.id,path:[]}],matrix:[a,a,0,0,-a,a,0,0,0,0,1,0,0,0,0,1]});
  const before=s.host.doc.state,c=connection({documents:{get:()=>s.document}});
  const result=await c.run(async({fragments:f})=>{const snapshot=await f.capture(capture(s));return f.project({fragment:snapshot.fragment,axes:[[a,a,0],[-a,a,0],[0,0,1]]});},'one');
  expect(result.size[0]).toBeCloseTo(.6,7);expect(result.size[1]).toBeCloseTo(.3,7);expect(result.size[2]).toBeCloseTo(.018,7);expect(s.host.doc.state).toBe(before);
});

it('fits a new immutable snapshot, proves all dimensions and retains private native save/reopen data',async()=>{
  const s=source(),before=s.host.doc.state,undo=s.host.undoStack.length,owned:KernelClient[]=[];
  const c=connection({documents:{get:()=>s.document},createFitKernel:()=>{const kernel=new KernelClient(new InlineBackend());vi.spyOn(kernel,'dispose');owned.push(kernel);return kernel;}});
  const result=await c.run(async({fragments:f})=>{
    const original=await f.capture(capture(s)),first=await f.project({fragment:original.fragment,axes:projectionAxes});
    const fitted=await f.fit(fitRequest(original.fragment));
    expect(fitted.description.fragment).not.toBe(original.fragment);expect(fitted.projection.size[0]).toBeCloseTo(.8,7);
    expect(await f.project({fragment:original.fragment,axes:projectionAxes})).toEqual(first);
    const saved=await f.save({fragment:fitted.description.fragment,key:'modules/fitted',expectedRevision:null});
    await f.discard({fragment:fitted.description.fragment});
    const reopened=await f.openAsset({key:saved.key,expectedRevision:saved.revision,name:'Fitted again'});
    return f.project({fragment:reopened.fragment,axes:projectionAxes});
  },'one');
  expect(result.size).toEqual([expect.closeTo(.8,7),expect.closeTo(.3,7),expect.closeTo(.018,7)]);
  const bytes=(await c.store!.read('com.example.modules','modules/fitted'))!.bytes,opened=await openModelFile(bytes);
  expect([...opened.state.pluginData!.get('org.example.foreign')!.entries.values()][0]!.payload).toEqual(new Uint8Array([255,0,128]));
  expect(opened.state.pluginData!.get('org.example.foreign')!.dataVersion).toBe(99);
  expect(owned).toHaveLength(1);expect(owned[0]!.dispose).toHaveBeenCalledTimes(1);expect(s.host.doc.state).toBe(before);expect(s.host.undoStack.length).toBe(undo);
});

it('permits rigid/reflected poses while refusing global scale and mismatched/fixed dimensions without publishing a handle',async()=>{
  const s=source(),c=connection({documents:{get:()=>s.document}});
  await c.run(async({fragments:f})=>{
    const original=await f.capture(capture(s));
    await expect(f.fit({...fitRequest(original.fragment),pose:[2,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]})).rejects.toBeDefined();
    await expect(f.fit({...fitRequest(original.fragment),planes:[]})).rejects.toMatchObject({code:'validation.failed'});
    await expect(f.fit({...fitRequest(original.fragment),size:[.8,.4,.018]})).rejects.toMatchObject({code:'validation.failed'});
    const fit=await f.fit({...fitRequest(original.fragment),pose:[0,1,0,0,1,0,0,0,0,0,1,0,0,0,0,1],axes:[[0,1,0],[1,0,0],[0,0,1]],planes:[{normal:[0,1,0],offset:.3,side:'positive',displacement:[0,.2,0]}]});
    expect(fit.projection.size[0]).toBeCloseTo(.8,7);expect(fit.projection.size[1]).toBeCloseTo(.3,7);
    await f.discard({fragment:fit.description.fragment});
    await expect(f.describe({fragment:original.fragment})).resolves.toEqual(original);
  },'one');
});

it('enforces projection/fitting grants, native handle quotas and axis validation',async()=>{
  const s=source(),read=connection({grants:['model.read'],documents:{get:()=>s.document}});
  await read.run(async({fragments:f})=>{const snapshot=await f.capture(capture(s));await expect(f.fit(fitRequest(snapshot.fragment))).rejects.toMatchObject({code:'permission.denied'});await expect(f.project({fragment:snapshot.fragment,axes:[[1,0,0],[1,0,0],[0,0,1]]})).rejects.toMatchObject({code:'validation.failed'});},'one');
  const denied=connection({grants:['model.write']});await expect(denied.run(({fragments:f})=>f.project({fragment:'fragment_'+'a'.repeat(32),axes:projectionAxes}))).rejects.toMatchObject({code:'permission.denied'});
  const c=connection({documents:{get:()=>s.document}});await c.run(async({fragments:f})=>{const a=await f.capture(capture(s)),b=await f.capture(capture(s));await expect(f.fit(fitRequest(a.fragment))).rejects.toMatchObject({code:'limit.exceeded'});await f.discard({fragment:b.fragment});await expect(f.fit(fitRequest(a.fragment))).resolves.toBeDefined();},'one');
});

it('disposes only the fit kernel when the source handle is discarded during active geometry work',async()=>{
  const s=source();let begun!:()=>void,reject!:()=>void,dispose!:ReturnType<typeof vi.spyOn>;
  const started=new Promise<void>(resolve=>{begun=resolve;});
  const c=connection({documents:{get:()=>s.document},createFitKernel:()=>{
    const kernel=new KernelClient(new InlineBackend()),release=kernel.dispose.bind(kernel);
    vi.spyOn(kernel,'autofold').mockImplementation(()=>new Promise((_resolve,fail)=>{reject=()=>fail(Error('Stopped owned fit worker'));begun();}));
    dispose=vi.spyOn(kernel,'dispose').mockImplementation(()=>{release();reject?.();});return kernel;
  }});
  const handle=await c.run(({fragments:f})=>f.capture(capture(s)),'one');
  const pending=c.run(({fragments:f})=>f.fit(fitRequest(handle.fragment)),'one'),failure=expect(pending).rejects.toBeDefined();
  await started;c.fragments.dispose();await failure;expect(dispose).toHaveBeenCalledTimes(1);expect(s.host.doc.rootDefinition.entities.bodies.has(s.id as Id)).toBe(true);
});

it('places and stretches one immutable module in the same atomic broker batch', async () => {
  const s = source(), d = source(), c = connection({ documents: { get: id => id === 'source' ? s.document : id === 'destination' ? d.document : null } });
  const snapshot = await c.run(({ fragments }) => fragments.capture(capture(s)), 'source');
  const sourceState = s.host.doc.state, original = d.host.doc.state, undo = d.host.undoStack.length;
  const result = await c.run(({ model }) => model.apply({ expectedRevision: d.host.doc.version, label: 'Place and stretch module', operations: [
    { op:'place_fragment',fragment:snapshot.fragment,worldMatrix:m4translation([0,0,1]),as:'placed' },
    { op:'stretch_physical',ref:'$placed',as:'fitted',planes:[{normal:[1,0,0],offset:.3,side:'positive',displacement:[.2,0,0]}] },
  ],metadata:{expectedDataVersion:1,upserts:[{id:'fitted-definition',target:{kind:'definition',created:'fitted'},value:{label:'Fitted module'}}]} }), 'destination');
  const ref = result.results[1]!.refs![0]!, root = containerAt(d.host.doc.state,ref.path as Id[]).instances.get(ref.id as Id)!;
  const b = [...d.host.doc.state.definitions.get(root.definitionId)!.entities.bodies.values()][0]!;
  expect(Math.max(...Array.from({length:b.mesh.verts.length/3},(_,i)=>b.mesh.verts[i*3]!))).toBeCloseTo(.8,7);
  expect(d.host.doc.state.pluginData!.get('com.example.modules')!.entries.get('fitted-definition')!.target).toEqual({kind:'definition',id:root.definitionId});
  expect(s.host.doc.state).toBe(sourceState); expect(d.host.undoStack.length).toBe(undo+1);
  d.host.undo(); expect({...d.host.doc.state,meta:{...d.host.doc.state.meta,nextId:original.meta.nextId}}).toEqual(original);
});

it('derives only the installed namespace into a new immutable snapshot and persists opaque data with a compatible upgrade', async () => {
  const s = source(), before = s.host.doc.state, undo = s.host.undoStack.length;
  const c = connection({ dataVersion: 2, documents: { get: () => s.document } });
  const saved = await c.run(async ({ fragments: f }) => {
    const original = await f.capture(capture(s));
    const derived = await f.derive({ fragment: original.fragment, expectedRevision: 1, name: 'Authored module', metadata: { expectedDataVersion: 1, upgradeCompatible: true,
      upserts: [{ id: 'authored', target: { kind: 'instance', id: original.root.id }, value: { label: 'Authored shelf' } }] } });
    expect(derived.fragment).not.toBe(original.fragment); expect(derived.root).toEqual(original.root); expect(derived.bounds).toEqual(original.bounds);
    const old = await f.metadataRead({ fragment: original.fragment, query: { ids: ['authored'] } });
    const next = await f.metadataRead({ fragment: derived.fragment, query: { ids: ['authored'] } });
    expect(old.dataVersion).toBe(1); expect(old.missing).toEqual(['authored']); expect(next.dataVersion).toBe(2); expect(next.entries[0]!.value).toEqual({ label: 'Authored shelf' });
    expect(await f.query({ fragment: original.fragment, query: {} })).toEqual(await f.query({ fragment: derived.fragment, query: {} }));
    return f.save({ fragment: derived.fragment, key: 'modules/authored', expectedRevision: null });
  }, 'one');
  const stored = await c.store!.read('com.example.modules', saved.key), opened = await openModelFile(stored!.bytes);
  const record = opened.state.pluginData!.get('org.example.foreign')!; expect(record.dataVersion).toBe(99); expect([...record.entries.values()][0]!.payload).toEqual(new Uint8Array([255, 0, 128]));
  expect(s.host.doc.state).toBe(before); expect(s.host.undoStack.length).toBe(undo); expect(modelClipboard.current).toBeNull();
});

it('refuses invalid derivations without consuming a slot or modifying the source snapshot', async () => {
  const s = source(), c = connection({ documents: { get: () => s.document } });
  await c.run(async ({ fragments: f }) => {
    const source = await f.capture(capture(s)), metadata = { expectedDataVersion: 1, upserts: [{ id: 'authored', target: { kind: 'instance', id: source.root.id }, value: { label: 'Valid' } }] };
    await expect(f.derive({ fragment: source.fragment, expectedRevision: 2, metadata })).rejects.toMatchObject({ code: 'revision.stale' });
    await expect(f.derive({ fragment: source.fragment, expectedRevision: 1, metadata: { ...metadata, owner: 'org.example.foreign' } })).rejects.toMatchObject({ code: 'validation.failed' });
    await expect(f.derive({ fragment: source.fragment, expectedRevision: 1, metadata: { ...metadata, upserts: [{ ...metadata.upserts[0], value: { label: 4 } }] } })).rejects.toMatchObject({ code: 'validation.failed' });
    await expect(f.derive({ fragment: source.fragment, expectedRevision: 1, metadata: { ...metadata, upserts: [{ ...metadata.upserts[0], target: { kind: 'body', id: 99999 } }] } })).rejects.toMatchObject({ code: 'validation.failed' });
    const derived = await f.derive({ fragment: source.fragment, expectedRevision: 1, metadata }); expect(derived.name).toBe(source.name);
    expect((await f.metadataRead({ fragment: source.fragment, query: { ids: ['authored'] } })).missing).toEqual(['authored']);
    await f.discard({ fragment: derived.fragment });
  }, 'one');
  const denied = connection({ grants: ['model.read'], documents: { get: () => s.document } });
  await denied.run(async ({ fragments: f }) => {
    const source = await f.capture(capture(s));
    await expect(f.derive({ fragment: source.fragment, expectedRevision: 1, metadata: { expectedDataVersion: 1, deletes: ['anything'] } })).rejects.toMatchObject({ code: 'permission.denied' });
  }, 'one');
});

it('upgrades a legacy destination before importing derived native data in the same model/tool/staged batch boundary', async () => {
  const s = source(), d = source(), c = connection({ dataVersion: 2, documents: { get: id => id === 'source' ? s.document : d.document } });
  const derived = await c.run(async ({ fragments: f }) => {
    const snapshot = await f.capture(capture(s));
    return f.derive({ fragment: snapshot.fragment, expectedRevision: 1, metadata: { expectedDataVersion: 1, upgradeCompatible: true, upserts: [{ id: 'authoring', target: { kind: 'instance', id: snapshot.root.id }, value: { label: 'Saved module authoring' } }] } });
  }, 'source');
  const before = d.host.doc.state, undo = d.host.undoStack.length;
  const batch = (label: unknown) => ({ expectedRevision: d.host.doc.version, label: 'Upgrade and import native module', operations: [{ op: 'place_fragment', fragment: derived.fragment, worldMatrix: m4identity(), as: 'module' }],
    metadata: { expectedDataVersion: 1, upgradeCompatible: true, upserts: [{ id: 'placed', target: { kind: 'instance', created: 'module' }, value: { label } }] } });
  await c.run(async ({ model }) => { await expect(model.apply(batch(4))).rejects.toMatchObject({ code: 'validation.failed' }); }, 'destination');
  expect(d.host.doc.state.pluginData!.get('com.example.modules')!.dataVersion).toBe(1); expect(d.host.doc.rootDefinition.entities.instances.size).toBe(0); expect(d.host.undoStack.length).toBe(undo);
  await c.run(({ model }) => model.apply(batch('Placed module')), 'destination');
  expect(d.host.doc.state.pluginData!.get('com.example.modules')!.dataVersion).toBe(2); expect(d.host.doc.rootDefinition.entities.instances.size).toBe(1); expect(d.host.undoStack.length).toBe(undo + 1);
  d.host.undo(); expect({ ...d.host.doc.state, meta: { ...d.host.doc.state.meta, nextId: before.meta.nextId } }).toEqual(before);
  await c.run(({model})=>model.apply({expectedRevision:d.host.doc.version,label:'Upgrade header and import native module',operations:[{op:'place_fragment',fragment:derived.fragment,worldMatrix:m4identity(),as:'module'}],metadata:{expectedDataVersion:1,upgradeCompatible:true}}),'destination');
  expect(d.host.doc.state.pluginData!.get('com.example.modules')!.dataVersion).toBe(2);expect(d.host.doc.rootDefinition.entities.instances.size).toBe(1);expect(d.host.undoStack.length).toBe(undo+1);
  d.host.undo();expect({...d.host.doc.state,meta:{...d.host.doc.state.meta,nextId:before.meta.nextId}}).toEqual(before);
  await c.run(async ({ model }) => {
    const staged = await model.batchBegin({ expectedRevision: d.host.doc.version, label: 'Staged upgrade and native import', metadata: { expectedDataVersion: 1, upgradeCompatible: true } });
    await model.batchAppend({ batch: staged.batch, sequence: 0, operations: [{ op: 'place_fragment', fragment: derived.fragment, worldMatrix: m4identity(), as: 'module' }],
      metadata: { upserts: [{ id: 'placed', target: { kind: 'instance', created: 'module' }, value: { label: 'Staged module' } }] } });
    const result = await model.batchCommit({ batch: staged.batch }); expect(result.metadataChanges).toBe(1);
  }, 'destination');
  expect(d.host.doc.state.pluginData!.get('com.example.modules')!.dataVersion).toBe(2); expect(d.host.undoStack.length).toBe(undo + 1);
  d.host.undo(); expect({ ...d.host.doc.state, meta: { ...d.host.doc.state.meta, nextId: before.meta.nextId } }).toEqual(before);
});

it.each(['legacy', 'derived'] as const)('initializes own metadata created by a %s native import before finalizing a new destination', async kind => {
  const s = source(), d = source(); d.host.doc.transact('Empty own namespace', draft => { draft.pluginData!.delete('com.example.modules'); });
  const c = connection({ dataVersion: 2, documents: { get: id => id === 'source' ? s.document : d.document } });
  const snapshot = await c.run(async ({ fragments: f }) => {
    const original = await f.capture(capture(s));
    return kind === 'legacy' ? original : f.derive({ fragment: original.fragment, expectedRevision: 1, metadata: { expectedDataVersion: 1, upgradeCompatible: true,
      upserts: [{ id: 'authoring', target: { kind: 'instance', id: original.root.id }, value: { label: 'Derived module' } }] } });
  }, 'source');
  const before = d.host.doc.state, undo = d.host.undoStack.length;
  await c.run(({ model }) => model.apply({ expectedRevision: d.host.doc.version, label: 'Initialize namespace during native import', operations: [{ op: 'place_fragment', fragment: snapshot.fragment, worldMatrix: m4identity(), as: 'module' }],
    metadata: { expectedDataVersion: null, upgradeCompatible: true, upserts: [{ id: 'placement', target: { kind: 'instance', created: 'module' }, value: { label: 'Placed module' } }] } }), 'destination');
  expect(d.host.doc.state.pluginData!.get('com.example.modules')!.dataVersion).toBe(2); expect(d.host.doc.rootDefinition.entities.instances.size).toBe(1); expect(d.host.undoStack.length).toBe(undo + 1);
  d.host.undo(); expect({ ...d.host.doc.state, meta: { ...d.host.doc.state.meta, nextId: before.meta.nextId } }).toEqual(before);
});

it('uses the real broker to capture, query own data, privately save and export without changing the live document', async () => {
  const s = source(), before = s.host.doc.state, revision = s.host.doc.version, undo = s.host.undoStack.entries.length;
  let exported: Uint8Array | undefined;
  const c = connection({ documents: { get: id => id === 'one' ? s.document : null }, picker: { open: async () => null, save: async (request, bytes) => { expect(request.extensionName).toBe('Modules'); exported = bytes; return { name: 'Shelf.pf' }; } } });
  const result = await c.run(async ({ fragments: f }) => {
    const native = await f!.capture(capture(s)), query = await f!.query({ fragment: native.fragment, query: { kinds: ['instance'], fields: ['geometry', 'bounds'] } });
    const list = await f!.metadataList({ fragment: native.fragment, query: {} });
    const own = await f!.metadataRead({ fragment: native.fragment, query: { expectedRevision: 1, ids: [list.entries[0]!.id, 'opaque'] } });
    const saved = await f!.save({ fragment: native.fragment, key: 'modules/shelf', expectedRevision: null });
    await f!.export({ fragment: native.fragment, purpose: 'Save reusable module', suggestedName: 'Shelf.pf' });
    return { native, query, list, own, saved };
  }, 'one');
  expect(result.native.fragment).toMatch(/^fragment_[a-f0-9]{32}$/);
  expect(result.query.revision).toBe(1); expect(result.query.entities).toHaveLength(1);
  expect(result.list.entries).toHaveLength(1);
  expect(result.own.entries[0]?.value).toEqual({ label: 'Maple shelf' }); expect(result.own.missing).toEqual(['opaque']);
  expect(JSON.stringify(result)).not.toContain('org.example.foreign');
  expect(result.saved.contentType).toBe(NATIVE_FRAGMENT_MIME);
  const opened = await openModelFile(exported!); expect([...opened.state.pluginData!.get('org.example.foreign')!.entries.values()][0]!.payload).toEqual(new Uint8Array([255, 0, 128]));
  expect(s.host.doc.state).toBe(before); expect(s.host.doc.version).toBe(revision); expect(s.host.undoStack.entries.length).toBe(undo); expect(modelClipboard.current).toBeNull();
});

it('binds handles and file captures to their runtime and preserves stable snapshot revisions after cache eviction', async () => {
  const s = source(), bytes = await encodeModelSnapshot(s.host.doc.state, []), store = memoryAssetStore();
  const c = connection({ store, documents: { get: () => s.document }, packageBytes: bytes, picker: { open: async () => ({ name: 'Shelf.pf', type: 'application/octet-stream', data: bytes }), save: async () => null } });
  let transfer = '', first!: FragmentDescription, savedRevision = 0;
  await c.run(async ({ fragments: f, files }) => {
    first = await f!.capture(capture(s));
    const saved = await f!.save({ fragment: first.fragment, key: 'modules/shelf', expectedRevision: null }); savedRevision = saved.revision;
    const read = await files!.openRead({ purpose: 'Choose native module' }); transfer = read.transfer;
    const second = await f!.openFile({ transfer, name: 'From file' });
    expect((await f!.describe({ fragment: first.fragment })).root).toEqual(first.root);
    const metadata = await f!.metadataRead({ fragment: first.fragment, query: { expectedRevision: 1, ids: ['label'] } }); expect(metadata.revision).toBe(1);
    await expect(f!.openPackage({ path: 'examples/shelf.pf', name: 'Package' })).rejects.toMatchObject({ code: 'limit.exceeded' });
    await f!.discard({ fragment: second.fragment });
    const packaged = await f!.openPackage({ path: 'examples/shelf.pf', name: 'Package' }); await f!.discard({ fragment: packaged.fragment });
    await expect(f!.openPackage({ path: 'hidden.pf', name: 'Hidden' })).rejects.toMatchObject({ code: 'permission.denied' });
    await expect(f!.save({ fragment: first.fragment, key: 'modules/shelf', expectedRevision: null })).rejects.toMatchObject({ code: 'revision.stale' });
    await f!.discard({ fragment: first.fragment });
    const reopened = await f!.openAsset({ key: 'modules/shelf', expectedRevision: savedRevision, name: 'Saved shelf' }); expect(reopened.name).toBe('Saved shelf');
  }, 'one');
  const other = connection({ store });
  await other.run(async ({ fragments: f }) => {
    await expect(f!.describe({ fragment: first.fragment })).rejects.toMatchObject({ code: 'unavailable' });
    await expect(f!.openFile({ transfer, name: 'Foreign transfer' })).rejects.toMatchObject({ code: 'validation.failed' });
  });
});

it('rejects missing grants, guessed document handles, stale captures, expiry and unavailable durable stores', async () => {
  const s = source(), c = connection({ grants: ['file.read'], documents: { get: () => s.document } });
  await c.run(async ({ fragments: f }) => { await expect(f!.capture(capture(s))).rejects.toMatchObject({ code: 'permission.denied' }); }, 'one');
  let now = 0;
  const d = connection({ now: () => now, store: null, documents: { get: () => s.document } });
  let handle = '';
  await d.run(async ({ fragments: f }) => {
    await expect(f!.capture({ ...capture(s), document: 'doc_guess' })).rejects.toMatchObject({ code: 'permission.denied' });
    await expect(f!.capture({ ...capture(s), expectedRevision: 0 })).rejects.toMatchObject({ code: 'revision.stale' });
    const snap = await f!.capture(capture(s)); handle = snap.fragment;
    await expect(f!.metadataRead({ fragment: handle, query: { expectedRevision: 2, ids: ['label'] } })).rejects.toMatchObject({ code: 'revision.stale' });
    await expect(f!.save({ fragment: handle, key: 'shelf', expectedRevision: null })).rejects.toMatchObject({ code: 'unavailable' });
    now += FRAGMENT_LIMITS.lifetimeMs;
    await expect(f!.describe({ fragment: handle })).rejects.toMatchObject({ code: 'unavailable' });
  }, 'one');
});

it('propagates runtime disposal into an active native export', async () => {
  const s = source(); let begun!: () => void;
  const started = new Promise<void>(resolve => { begun = resolve; });
  const c = connection({ documents: { get: () => s.document }, picker: { open: async () => null, save: async (_request, _bytes, options) => {
    begun(); await new Promise<void>((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true })); return null;
  } } });
  const pending = c.run(async ({ fragments: f }) => { const snapshot = await f!.capture(capture(s)); return f!.export({ fragment: snapshot.fragment, purpose: 'Save module', suggestedName: 'Shelf.pf' }); }, 'one');
  const failed = expect(pending).rejects.toBeDefined(); await started; c.fragments.dispose(); await failed;
});

it('serializes native work while allowing discard to cancel the active snapshot', async () => {
  const s = source(); let begun!: () => void;
  const started = new Promise<void>(resolve => { begun = resolve; });
  const c = connection({ documents: { get: () => s.document }, picker: { open: async () => null, save: async (_request, _bytes, options) => {
    begun(); await new Promise<void>((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true })); return null;
  } } });
  const snapshot = await c.run(({ fragments: f }) => f.capture(capture(s)), 'one');
  const pending = c.run(({ fragments: f }) => f.export({ fragment: snapshot.fragment, purpose: 'Save module', suggestedName: 'Shelf.pf' }));
  const failed = expect(pending).rejects.toBeDefined(); await started;
  await c.run(async ({ fragments: f }) => {
    await expect(f.describe({ fragment: snapshot.fragment })).rejects.toMatchObject({ code: 'unavailable' });
    await f.discard({ fragment: snapshot.fragment });
  });
  await failed;
  await c.run(async ({ fragments: f }) => { await expect(f.describe({ fragment: snapshot.fragment })).rejects.toMatchObject({ code: 'unavailable' }); });
});

it('places complete native modules under affine shared ancestors with actual aliases, opaque references and one Undo', async () => {
  const s = source(), d = source();
  const outside = s.commands.execute('model.addBox', { min: [2, 0, 0], max: [2.6, 0.3, 0.018] }) as number;
  const coincident = d.commands.execute('model.addBox', { min: [-2, 0, 0], max: [-1.4, 0.3, 0.018] }) as number;
  expect(coincident).toBe(outside);
  s.host.doc.transact('Snapshot reference fixture', draft => { draft.pluginData!.get('org.example.foreign')!.entries.get('opaque')!.references = [
    { target: { kind: 'bodyOccurrence', id: s.id, path: [] } }, { target: { kind: 'bodyOccurrence', id: outside, path: [] } },
  ]; });
  const inner = (d.commands.execute('component.make', { refs: [{ kind: 'body', id: d.id, path: [] }], name: 'Inner' }) as { instanceId: number }).instanceId;
  const outer = (d.commands.execute('component.make', { refs: [{ kind: 'instance', id: inner, path: [] }], name: 'Outer' }) as { instanceId: number }).instanceId;
  const other = (await d.commands.execute('transform.apply', { refs: [{ kind: 'instance', id: outer, path: [] }], matrix: m4translation([0, 2, 0]), copy: true }) as { refs: { id: number }[] }).refs[0]!.id;
  await d.commands.execute('transform.apply', { refs: [{ kind: 'instance', id: outer, path: [] }], matrix: [0, -2, 0, 0, -3, 0, 0, 0, 0.5, 0, 0.5, 0, 4, 5, 6, 1] });
  d.host.selection.set([{ kind: 'instance', id: other as Id, path: [] }]);
  const c = connection({ documents: { get: id => id === 'source' ? s.document : id === 'destination' ? d.document : null } });
  const snapshot = await c.run(({ fragments: f }) => f.capture(capture(s)), 'source');
  const initial = d.host.doc.state, sourceState = s.host.doc.state, undo = d.host.undoStack.length, context = d.host.context, selection = d.host.selection.snapshot();
  const result = await c.run(({ model }) => model.apply({ expectedRevision: d.host.doc.version, label: 'Place native shelves', operations: [
    { op: 'place_fragment', fragment: snapshot.fragment, container: [outer, inner], worldMatrix: m4translation([4, 5, 6]), as: 'module' },
    { op: 'copy_physical', ref: { kind: 'body', id: d.id, path: [outer, inner] }, container: [outer, inner], worldMatrix: m4translation([0, 0, 1]), as: 'anchor' },
    { op: 'place_fragment', fragment: snapshot.fragment, container: '$anchor', worldMatrix: m4translation([4, 5.4, 6]), independent: true, as: 'second' },
  ], metadata: { expectedDataVersion: 1, upserts: [
    { id: 'placed', target: { kind: 'instance', created: 'module' }, value: { label: 'Assembly placement' } },
    { id: 'placed-definition', target: { kind: 'definition', created: 'module' }, value: { label: 'Module definition' } },
    { id: 'anchor', target: { kind: 'bodyOccurrence', created: 'anchor' }, value: { label: 'Container anchor' } },
  ] } }), 'destination');
  const first = result.results[0]!.refs![0]!, second = result.results[2]!.refs![0]!;
  expect(first.kind).toBe('instance'); expect(first.path[0]).toBe(outer); expect(first.path[1]).not.toBe(inner); expect(second.path).toEqual(first.path);
  const into = containerAt(d.host.doc.state, first.path as Id[]), firstDef = into.instances.get(first.id as Id)!.definitionId, secondDef = into.instances.get(second.id as Id)!.definitionId;
  expect(firstDef).not.toBe(secondDef);
  const body = [...d.host.doc.state.definitions.get(firstDef)!.entities.bodies.values()][0]!;
  const world = contextMatrix(d.host.doc.state, [...first.path, first.id] as Id[]), points = Array.from({ length: body.mesh.verts.length / 3 }, (_, i) => m4transformPoint(world, [body.mesh.verts[i * 3]!, body.mesh.verts[i * 3 + 1]!, body.mesh.verts[i * 3 + 2]!]));
  [4, 5, 6].forEach((value, axis) => expect(Math.abs(Math.min(...points.map(point => point[axis]!)) - value)).toBeLessThan(LENGTH_TOL));
  [4.6, 5.3, 6.018].forEach((value, axis) => expect(Math.abs(Math.max(...points.map(point => point[axis]!)) - value)).toBeLessThan(LENGTH_TOL));
  const own = d.host.doc.state.pluginData!.get('com.example.modules')!;
  expect(own.entries.get('placed')!.target).toEqual({ kind: 'instance', id: first.id });
  expect(own.entries.get('placed-definition')!.target).toEqual({ kind: 'definition', id: firstDef });
  const opaque = [...d.host.doc.state.pluginData!.get('org.example.foreign')!.entries.values()].find(entry => entry.target.kind === 'body' && entry.target.id === body.id)!;
  expect(opaque.payload).toEqual(new Uint8Array([255, 0, 128])); expect(opaque.references[0]!.unresolved).not.toBe(true); expect(opaque.references[1]!.unresolved).toBe(true);
  expect(containerAt(d.host.doc.state, [other, inner] as Id[]).bodies.has(d.id as Id)).toBe(true);
  expect(containerAt(d.host.doc.state, [other, inner] as Id[]).instances.size).toBe(0);
  expect(d.host.context).toBe(context); expect(d.host.selection.snapshot()).toEqual(selection); expect(modelClipboard.current).toBeNull(); expect(s.host.doc.state).toBe(sourceState); expect(d.host.undoStack.length).toBe(undo + 1);
  d.host.undo(); expect({ ...d.host.doc.state, meta: { ...d.host.doc.state.meta, nextId: initial.meta.nextId } }).toEqual(initial);
  d.host.redo(); expect(containerAt(d.host.doc.state, first.path as Id[]).instances.has(first.id as Id)).toBe(true);
});

it('links native components by default, makes independent placements unique and supports staged placement', async () => {
  const s = source(), d = source(), c = connection({ documents: { get: id => id === 'source' ? s.document : d.document } });
  const snap = await c.run(({ fragments: f }) => f.capture(capture(s)), 'source');
  const before = d.host.undoStack.length;
  const result = await c.run(({ model }) => model.apply({ expectedRevision: d.host.doc.version, label: 'Linked modules', operations: [
    { op: 'place_fragment', fragment: snap.fragment, worldMatrix: m4identity(), as: 'a' },
    { op: 'place_fragment', fragment: snap.fragment, worldMatrix: m4translation([0, 1, 0]), as: 'b' },
    { op: 'place_fragment', fragment: snap.fragment, worldMatrix: m4translation([0, 2, 0]), independent: true, as: 'c' },
  ] }), 'destination');
  const root = d.host.doc.rootDefinition.entities, definitions = result.results.map(row => root.instances.get(row.refs![0]!.id as Id)!.definitionId);
  expect(definitions[0]).toBe(definitions[1]); expect(definitions[2]).not.toBe(definitions[0]); expect(d.host.undoStack.length).toBe(before + 1);
  await c.run(async ({ model }) => {
    const batch = await model.batchBegin({ expectedRevision: d.host.doc.version, label: 'Staged module', metadata: { expectedDataVersion: 1 } });
    await model.batchAppend({ batch: batch.batch, sequence: 0, operations: [{ op: 'place_fragment', fragment: snap.fragment, worldMatrix: m4translation([0, 3, 0]), as: 'staged' }],
      metadata: { upserts: [{ id: 'staged', target: { kind: 'instance', created: 'staged' }, value: { label: 'Staged native module' } }] } });
    const committed = await model.batchCommit({ batch: batch.batch }); expect(committed.created).toBe(1); expect(committed.metadataChanges).toBe(1);
  }, 'destination');
  expect(d.host.undoStack.length).toBe(before + 2);
});

it('rolls back native placement and isolation on later-operation, schema, matrix, lock and discarded-handle failures', async () => {
  const s = source(), d = source(), c = connection({ documents: { get: id => id === 'source' ? s.document : d.document } });
  const snap = await c.run(({ fragments: f }) => f.capture(capture(s)), 'source');
  const inner = (d.commands.execute('component.make', { refs: [{ kind: 'body', id: d.id, path: [] }], name: 'Shared target' }) as { instanceId: number }).instanceId;
  await d.commands.execute('transform.apply', { refs: [{ kind: 'instance', id: inner, path: [] }], matrix: m4translation([0, 2, 0]), copy: true });
  const before = d.host.doc.state, undo = d.host.undoStack.length;
  const same = () => { expect({ ...d.host.doc.state, meta: { ...d.host.doc.state.meta, nextId: before.meta.nextId } }).toEqual(before); expect(d.host.undoStack.length).toBe(undo); };
  const op = { op: 'place_fragment', fragment: snap.fragment, container: [inner], worldMatrix: m4identity(), as: 'module' };
  await c.run(async ({ model }) => {
    const apply = (operations: unknown[], metadata?: unknown) => model.apply({ expectedRevision: d.host.doc.version, label: 'Refuse partial module', operations, ...(metadata ? { metadata } : {}) });
    await expect(apply([op, { op: 'paint_part', ref: { kind: 'body', id: 99999, path: [] }, materialId: null }])).rejects.toBeDefined(); same();
    await expect(apply([op], { expectedDataVersion: 1, upserts: [{ id: 'invalid', target: { kind: 'instance', created: 'module' }, value: { label: 4 } }] })).rejects.toBeDefined(); same();
    await expect(apply([{ ...op, worldMatrix: new Array(16).fill(0) }])).rejects.toBeDefined(); same();
    await expect(apply([{ ...op, container: [99999] }])).rejects.toBeDefined(); same();
  }, 'destination');
  d.commands.execute('instance.setLocked', { refs: [{ kind: 'instance', id: inner, path: [] }], locked: true }); const locked = d.host.doc.state;
  await c.run(async ({ model, fragments }) => {
    await expect(model.apply({ expectedRevision: d.host.doc.version, label: 'Locked module target', operations: [op] })).rejects.toBeDefined(); expect(d.host.doc.state).toBe(locked);
    await fragments.discard({ fragment: snap.fragment });
    await expect(model.apply({ expectedRevision: d.host.doc.version, label: 'Discarded module', operations: [{ ...op, container: [] }] })).rejects.toMatchObject({ code: 'unavailable' }); expect(d.host.doc.state).toBe(locked);
  }, 'destination');
});

it.each(['model', 'context'] as const)('refuses a native placement when the %s changes during preparation', async change => {
  const s = source(), d = source(), c = connection({ documents: { get: id => id === 'source' ? s.document : d.document } });
  const inner = (d.commands.execute('component.make', { refs: [{ kind: 'body', id: d.id, path: [] }], name: 'Context fixture' }) as { instanceId: number }).instanceId;
  const snapshot = await c.run(({ fragments: f }) => f.capture(capture(s)), 'source');
  let begun!: () => void, resume!: () => void;
  const started = new Promise<void>(resolve => { begun = resolve; }), gate = new Promise<void>(resolve => { resume = resolve; });
  const prepare = c.fragments.withPlacements.bind(c.fragments);
  c.fragments.withPlacements = (handles, signal, run) => prepare(handles, signal, async (placements, active) => { begun(); await gate; return run(placements, active); });
  const pending = c.run(({ model }) => model.apply({ expectedRevision: d.host.doc.version, label: 'Stale preparation', operations: [{ op: 'place_fragment', fragment: snapshot.fragment, worldMatrix: m4identity() }] }), 'destination');
  const failed = expect(pending).rejects.toMatchObject({ code: 'revision.stale' }); await started;
  if (change === 'model') d.commands.execute('model.addBox', { min: [2, 0, 0], max: [2.6, 0.3, 0.018] });
  else { d.host.setContext([inner as Id]); d.host.setContext([]); }
  const state = d.host.doc.state, undo = d.host.undoStack.length;
  resume(); await failed; expect(d.host.doc.state).toBe(state); expect(d.host.undoStack.length).toBe(undo);
});

it('rolls back a placed module when its runtime ends before the batch finishes', async () => {
  const s = source(), d = source(), c = connection({ documents: { get: id => id === 'source' ? s.document : d.document } });
  const snapshot = await c.run(({ fragments: f }) => f.capture(capture(s)), 'source'), before = d.host.doc.state, undo = d.host.undoStack.length;
  const stop = d.commands.events.on('executed', event => { if (event.id === 'part.placeNative') c.fragments.dispose(); }); cleanup.push(stop);
  await c.run(async ({ model }) => {
    await expect(model.apply({ expectedRevision: d.host.doc.version, label: 'Cancelled placement', operations: [{ op: 'place_fragment', fragment: snapshot.fragment, worldMatrix: m4identity() }] })).rejects.toMatchObject({ code: 'cancelled' });
  }, 'destination');
  expect({ ...d.host.doc.state, meta: { ...d.host.doc.state.meta, nextId: before.meta.nextId } }).toEqual(before); expect(d.host.undoStack.length).toBe(undo);
});

it('reuses unchanged imports across cache eviction and imports fresh native data after shared properties change', async () => {
  const s = source(), d = source(), c = connection({ documents: { get: id => id === 'source' ? s.document : d.document } });
  const snapshot = await c.run(({ fragments: f }) => f.capture(capture(s)), 'source');
  const place = () => c.run(({ model }) => model.apply({ expectedRevision: d.host.doc.version, label: 'Place same module', operations: [{ op: 'place_fragment', fragment: snapshot.fragment, worldMatrix: m4identity() }] }), 'destination');
  const definition = (result: ModelBatchResult) => d.host.doc.rootDefinition.entities.instances.get(result.results[0]!.refs![0]!.id as Id)!.definitionId;
  const first = definition(await place());
  await c.run(({ fragments: f }) => f.capture({ ...capture(s), name: 'Evict decoded cache' }), 'source');
  expect(definition(await place())).toBe(first);
  const part = [...d.host.doc.state.definitions.get(first)!.entities.bodies.values()][0]!;
  d.host.doc.transact('Change shared native properties', draft => {
    const entry = [...draft.pluginData!.get('org.example.foreign')!.entries.values()].find(entry => entry.target.kind === 'body' && entry.target.id === part.id)!;
    entry.payload = new Uint8Array([128, 1, 255]);
  });
  const next = definition(await place()); expect(next).not.toBe(first);
  const imported = [...d.host.doc.state.definitions.get(next)!.entities.bodies.values()][0]!;
  const entries = [...d.host.doc.state.pluginData!.get('org.example.foreign')!.entries.values()];
  expect(entries.find(entry => entry.target.kind === 'body' && entry.target.id === imported.id)!.payload).toEqual(new Uint8Array([255, 0, 128]));
  expect(entries.find(entry => entry.target.kind === 'body' && entry.target.id === part.id)!.payload).toEqual(new Uint8Array([128, 1, 255]));
});

it('keeps captured group roots independent and bounds the complete repeated physical assembly before editing', async () => {
  const s = source(), d = source(), c = connection({ documents: { get: id => id === 'source' ? s.document : d.document } });
  const group = (s.commands.execute('group.make', { refs: [{ kind: 'body', id: s.id, path: [] }], name: 'Independent module group' }) as { instanceId: number }).instanceId;
  const snapshot = await c.run(({ fragments: f }) => f.capture({ expectedRevision: s.host.doc.version, name: 'Group module', ref: { kind: 'instance', id: group, path: [] } }), 'source');
  const result = await c.run(({ model }) => model.apply({ expectedRevision: d.host.doc.version, label: 'Group modules', operations: [0, 1].map(y => ({ op: 'place_fragment', fragment: snapshot.fragment, worldMatrix: m4translation([0, y, 0]) })) }), 'destination');
  const definitions = result.results.map(row => d.host.doc.rootDefinition.entities.instances.get(row.refs![0]!.id as Id)!.definitionId); expect(definitions[0]).not.toBe(definitions[1]);
  const many = source();
  const inner = (many.commands.execute('component.make', { refs: [{ kind: 'body', id: many.id, path: [] }], name: 'Repeated part' }) as { instanceId: number }).instanceId;
  const outer = (many.commands.execute('component.make', { refs: [{ kind: 'instance', id: inner, path: [] }], name: 'Large physical module' }) as { instanceId: number }).instanceId;
  many.host.doc.transact('Repeated module fixture', draft => {
    const root = draft.definitions.get(draft.rootDefinitionId)!.entities.instances.get(outer as Id)!, entities = draft.definitions.get(root.definitionId)!.entities, template = entities.instances.get(inner as Id)!;
    for (let i = 1; i < 5500; i++) { const id = draft.meta.nextId++ as Id; entities.instances.set(id, { ...template, id }); entities.order.push(id); }
  });
  const large = connection({ documents: { get: id => id === 'source' ? many.document : d.document } });
  const big = await large.run(({ fragments: f }) => f.capture({ expectedRevision: many.host.doc.version, name: 'Complete repeated module', ref: { kind: 'instance', id: outer, path: [] } }), 'source');
  const before = d.host.doc.state, undo = d.host.undoStack.length;
  await large.run(async ({ model }) => { await expect(model.apply({ expectedRevision: d.host.doc.version, label: 'Too many physical occurrences', operations: [0, 1].map(y => ({ op: 'place_fragment', fragment: big.fragment, worldMatrix: m4translation([0, y, 0]) })) })).rejects.toMatchObject({ code: 'limit.exceeded' }); }, 'destination');
  expect(d.host.doc.state).toBe(before); expect(d.host.undoStack.length).toBe(undo);
});
