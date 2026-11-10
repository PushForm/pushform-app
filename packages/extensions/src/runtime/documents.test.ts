// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CommandRegistry, DocumentHost, SERVICE_DOCUMENT, SERVICE_KERNEL, editCommands, groupCommands, materialCommands, modelCommands, modelInfoCommands, transformCommands,
} from '@pushform/commands';
import { MODEL_LIMITS, extensionManifestSchema, type StagedEditProgress, type StagedEditCommitResult, type StagedEditResultPage, type MaterialReadResult, type MaterialStageResult, type ModelBatchResult, type InspectorCapture, type ModelQueryResult, type MetadataReadResult, type ExtensionError, type ExtensionPermission } from '@pushform/extension-protocol';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import { ModelDocumentApi } from '../modelApi';
import { commandsDocument, documentUnitsOf, ExtensionDocumentHost, type DocumentChange, type ExtensionDocument, type ExtensionDocuments } from './documents';
import { startGuest, type ExtensionContext } from './guest';
import { ExtensionSession, type ServiceCall } from './host';
import { messagePortTransport } from './port';

const ALL: ExtensionPermission[] = ['model.read', 'model.write', 'selection.read', 'selection.write', 'viewport.presentation'];
const manifestFor = (permissions: ExtensionPermission[]) => extensionManifestSchema.parse({
  id: 'com.example.parts', name: 'Parts', publisher: 'Example', version: '1.0.0', apiVersion: '^0.1.0',
  editors: ['modeling'], defaultLocale: 'en', license: 'MIT', files: {}, permissions,
  contributions: [{ target: 'model.command', id: 'com.example.parts.run', name: 'Run' }],
});

const kernels: KernelClient[] = [];
const channels: MessageChannel[] = [];
afterEach(() => {
  for (const kernel of kernels.splice(0)) kernel.dispose();
  for (const c of channels.splice(0)) { c.port1.close(); c.port2.close(); }
});

function model() {
  const host = new DocumentHost();
  const kernel = new KernelClient(new InlineBackend());
  kernels.push(kernel);
  const commands = new CommandRegistry({ tx: host, services: new Map<string, unknown>([[SERVICE_DOCUMENT, host], [SERVICE_KERNEL, kernel]]) });
  for (const group of [editCommands, modelCommands, modelInfoCommands, transformCommands, groupCommands, materialCommands]) commands.registerAll(group);
  const addBox = (min: [number, number, number], max: [number, number, number]): number => commands.execute('model.addBox', { min, max }) as number;
  return { host, commands, addBox, document: commandsDocument(commands) };
}

type Call = (input?: unknown) => Promise<unknown>;
interface Services {
  metadata: Record<'read' | 'list' | 'apply', Call>;
  model: Record<'batchBegin' | 'batchAppend' | 'batchCommit' | 'batchResult' | 'batchDiscard' | 'materialRead' | 'materialStage' | 'read' | 'query' | 'apply' | 'subscribe', Call> & { onChange(handler: (event: unknown) => void): () => void };
  selection: Record<'get' | 'set' | 'frame', Call>;
  document: { units: Call; info: Call; onUnitsChange(handler: (event: unknown) => void): () => void; onChange(handler: (event: unknown) => void): () => void };
}

/** A document whose name the test changes, as a tab rename does. */
const named = (document: ExtensionDocument, initial: string) => {
  let name = initial;
  const listeners = new Set<(change: DocumentChange) => void>();
  const out: ExtensionDocument = { ...document, name: () => name, listen(listener) {
    listeners.add(listener);
    const off = document.listen(listener);
    return () => { off(); listeners.delete(listener); };
  } };
  return { document: out, rename(next: string) { name = next; for (const l of [...listeners]) l('name'); } };
};

/**
 * An extension whose command runs `body` with its context and invocation; the services are the real document
 * services over `documents`, behind the real session and guest.
 */
function connect(documents: ExtensionDocuments, grants: ExtensionPermission[] = ALL, metadata = false, inspectorBinding?: InspectorCapture) {
  const manifest = extensionManifestSchema.parse({ ...manifestFor(ALL), ...(metadata ? { metadata: { dataVersion: 1, schema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] } } } : {}) });
  const channel = new MessageChannel();
  channels.push(channel);
  const ref: { session?: ExtensionSession } = {};
  const host = new ExtensionDocumentHost({ manifest, grants: new Set(grants), documents, session: () => ref.session, coalesceMs: 0, ...(inspectorBinding ? { inspectorBinding: (binding: string, documentId: string) => { if (binding !== inspectorBinding.binding || documentId !== 'one') throw new Error('Stale inspector'); return inspectorBinding; } } : {}) });
  const session = ref.session = new ExtensionSession({ manifest, grants, port: messagePortTransport(channel.port1), services: host.services(),
    onDocument: (id) => host.documentChanged(id) });
  let context!: ExtensionContext & Partial<Services>;
  let body: (invocation: { document?: string }) => unknown = () => null;
  void startGuest(messagePortTransport(channel.port2), async () => ({
    activate(c: ExtensionContext) {
      context = c as ExtensionContext & Partial<Services>;
      c.commands.register('com.example.parts.run', (_params, invocation) => body(invocation));
    },
  }));
  const run = <T>(fn: (context: ExtensionContext & Partial<Services>, invocation: { document?: string }) => T | Promise<T>, document?: string): Promise<T> => {
    body = (invocation) => fn(context, invocation);
    return session.invoke('com.example.parts.run', {}, document === undefined ? {} : { document }) as Promise<T>;
  };
  return { session, host, run, context: () => context };
}

/** Errors returned from a handler cross the port as plain data. */
const plain = (e: ExtensionError) => ({ code: e.code, details: e.details });
const codeOf = (promise: Promise<unknown>): Promise<string> => promise.then(() => 'ok', (e: ExtensionError) => e.code);
const openDocuments = (entries: Record<string, ExtensionDocument>): ExtensionDocuments & { close(id: string): void } => {
  const open = new Map(Object.entries(entries));
  return { get: (id) => open.get(id) ?? null, close: (id) => { open.delete(id); } };
};

it('prepares and commits a large edit through the real guest transport with paged results and one Undo', async () => {
  const a = model(), connection = connect(openDocuments({ one: a.document }), ALL, true);
  const before = a.host.doc.state;
  await connection.run(async ({ model: m }) => {
    const draft = await m!.batchBegin({ expectedRevision: a.host.doc.version, label: 'Import library', metadata: { expectedDataVersion: null } }) as StagedEditProgress;
    for (let chunk = 0; chunk < 3; chunk++) {
      const rows = Array.from({ length: 200 }, (_, j) => chunk * 200 + j);
      await m!.batchAppend({ batch: draft.batch, sequence: chunk,
        operations: rows.map(i => ({ op: 'add_material', name: `Material ${i}`, color: '#abcdef', as: `m${i}` })),
        metadata: { upserts: rows.map(i => ({ id: `stock:${i}`, target: { kind: 'material', created: `m${i}` }, value: { label: `Stock ${i}` } })) } });
      expect(a.host.doc.state).toBe(before);
    }
    const committed = await m!.batchCommit({ batch: draft.batch }) as StagedEditCommitResult;
    expect(committed).toMatchObject({ ok: true, created: 600, operations: 600, metadataChanges: 600 });
    expect(await m!.batchCommit({ batch: draft.batch })).toEqual(committed);
    let next: number | null = 0, created = 0, changed = 0;
    while (next !== null) {
      const page = await m!.batchResult({ batch: draft.batch, offset: next, limit: 200 }) as StagedEditResultPage;
      created += Object.keys(page.created).length; changed += page.changed.length; next = page.next;
    }
    expect([created, changed]).toEqual([600, 600]);
    await m!.batchDiscard({ batch: draft.batch });
  }, 'one');
  expect(a.host.undoStack.entries).toHaveLength(1); a.host.undo();
  expect(a.host.doc.state.materials).toEqual(before.materials); expect(a.host.doc.state.pluginData).toEqual(before.pluginData);
  connection.host.dispose(); await connection.session.deactivate('shutdown');
});

it('requires model.write for every draft method and never rebinds a token to another document', async () => {
  const a = model(), b = model(), documents = openDocuments({ one: a.document, two: b.document });
  const readOnly = connect(documents, ['model.read']);
  await expect(readOnly.run(({ model: m }) => m!.batchBegin({ expectedRevision: 0, label: 'Denied' }), 'one')).rejects.toMatchObject({ code: 'permission.denied' });
  readOnly.host.dispose(); await readOnly.session.deactivate('shutdown');
  const writer = connect(documents, ['model.write']);
  const token = await writer.run(async ({ model: m }) => (await m!.batchBegin({ expectedRevision: 0, label: 'Captured one' }) as StagedEditProgress).batch, 'one');
  await expect(writer.run(({ model: m }) => m!.batchAppend({ batch: token, sequence: 0, operations: [{ op: 'add_material', name: 'Foreign', color: '#ffffff' }] }), 'two')).rejects.toMatchObject({ code: 'validation.failed' });
  await writer.run(({ model: m }) => m!.batchDiscard({ batch: token }), 'one');
  writer.host.dispose(); await writer.session.deactivate('shutdown');
});

describe('model services', () => {
  it('read and query the invocation\'s document and apply one undo entry named after the extension', async () => {
    const a = model();
    const id = a.addBox([0, 0, 0], [1, 2, 3]);
    const { run } = connect(openDocuments({ 'doc-a': a.document }));
    const result = await run(async ({ model: m }) => {
      const snapshot = await m!.read({}) as { revision: number; bounds: unknown };
      const query = await m!.query({ kinds: ['body'] }) as { entities: { ref: unknown; volume: number }[] };
      const applied = await m!.apply({ expectedRevision: snapshot.revision, label: 'Hide it', operations: [{ op: 'set_hidden', refs: [{ kind: 'body', id }], hidden: true }] });
      return { snapshot, query, applied };
    }, 'doc-a');
    expect(result.snapshot.bounds).toEqual({ min: [0, 0, 0], max: [1, 2, 3] });
    expect(result.query.entities).toHaveLength(1);
    expect(result.query.entities[0]).toMatchObject({ ref: { path: [], kind: 'body', id } });
    expect(result.query.entities[0]!.volume).toBeCloseTo(6);
    expect(result.applied).toMatchObject({ ok: true, label: 'Parts: Hide it' });
    expect(a.host.undoStack.peek()?.label).toBe('Parts: Hide it');
    expect(a.host.doc.rootDefinition.entities.bodies.get(id as never)?.hidden).toBe(true);
  });

  it('refuses invalid input with validation.failed, oversized batches with limit.exceeded, and stale ones with revision.stale', async () => {
    const a = model();
    const id = a.addBox([0, 0, 0], [1, 1, 1]);
    const { run } = connect(openDocuments({ 'doc-a': a.document }));
    const codes = await run(async ({ model: m, selection }) => {
      const revision = (await m!.read() as { revision: number }).revision;
      const op = { op: 'set_hidden', refs: [{ kind: 'body', id }], hidden: true };
      const stale = await m!.apply({ expectedRevision: revision + 5, label: 'Hide', operations: [op] }).catch(plain);
      return {
        kind: await codeOf(m!.query({ kinds: ['shelf'] })),
        unknownKey: await codeOf(m!.read({ revision: 1 })),
        tooMany: await codeOf(m!.apply({ expectedRevision: revision, label: 'Many', operations: Array.from({ length: MODEL_LIMITS.operationsPerBatch + 1 }, () => op) })),
        badOperation: await codeOf(m!.apply({ expectedRevision: revision, label: 'Bad', operations: [{ op: 'set_hidden', refs: [] }] })),
        missingRef: await m!.apply({ expectedRevision: revision, label: 'Gone', operations: [{ op: 'delete', refs: [{ kind: 'body', id: 999 }] }] }).catch(plain),
        stale,
        badRefs: await codeOf(selection!.set({ refs: [{ kind: 'shelf', id: 1 }] })),
      };
    }, 'doc-a');
    expect(codes).toMatchObject({ kind: 'validation.failed', unknownKey: 'validation.failed', tooMany: 'limit.exceeded', badOperation: 'validation.failed', badRefs: 'validation.failed' });
    expect(codes.missingRef).toMatchObject({ code: 'validation.failed', details: { modelCode: 'invalid_reference', operationIndex: 0 } });
    expect(codes.stale).toMatchObject({ code: 'revision.stale', details: { modelCode: 'stale_revision' } });
    expect(a.host.undoStack.peek()?.label).not.toMatch(/^Parts:/);
  });

  it('answers unavailable for a document that is not a 3D model', async () => {
    const layout: ExtensionDocument = { name: () => 'Plan', units: () => documentUnitsOf({ format: 'decimal', lengthUnit: 'mm', lengthPrecision: 1 }), model: () => null, listen: () => () => {} };
    const { run } = connect(openDocuments({ 'doc-l': layout }));
    expect(await run(({ model: m, document }) => Promise.all([codeOf(m!.read()), codeOf(document!.units())]), 'doc-l')).toEqual(['unavailable', 'ok']);
    expect(await run(({ document }) => document!.info(), 'doc-l')).toEqual({ name: 'Plan', units: layout.units() });
  });
});

describe('document services', () => {
  it('tell the document\'s name and units, without any permission', async () => {
    const a = model();
    const { run } = connect(openDocuments({ 'doc-a': named(a.document, 'Bookcase').document }), []);
    expect(await run(({ document }) => document!.info(), 'doc-a')).toEqual({ name: 'Bookcase', units: a.document.units() });
    expect(await run(({ document }) => codeOf(document!.info({ revision: 1 })), 'doc-a')).toBe('validation.failed');
    expect(commandsDocument(a.commands).name()).toBe('Untitled');
  });
});

describe('selection services', () => {
  it('reads, replaces and frames the selection as model refs', async () => {
    const a = model();
    const first = a.addBox([0, 0, 0], [1, 1, 1]);
    const second = a.addBox([2, 0, 0], [3, 1, 1]);
    const frame = vi.spyOn(ModelDocumentApi.prototype, 'frame').mockReturnValue(null as never);
    const { run } = connect(openDocuments({ 'doc-a': a.document }));
    const out = await run(async ({ selection }) => {
      const before = await selection!.get({});
      const set = await selection!.set({ refs: [{ kind: 'body', id: second }] });
      const after = await selection!.get();
      const framed = await selection!.frame({ refs: [{ kind: 'body', id: second }] });
      const missing = await codeOf(selection!.set({ refs: [{ kind: 'body', id: 999 }] }));
      const cleared = await selection!.set({ refs: [] });
      return { before, set, after, framed, missing, cleared };
    }, 'doc-a');
    expect(out.before).toEqual({ refs: [] });
    expect(out.set).toEqual({ refs: [{ path: [], kind: 'body', id: second }] });
    expect(out.after).toEqual(out.set);
    expect(out.framed).toBeNull();
    expect(frame).toHaveBeenCalledWith([{ kind: 'body', id: second }]);
    expect(out.missing).toBe('validation.failed');
    expect(out.cleared).toEqual({ refs: [] });
    expect(a.host.selection.refs).toEqual([]);
    expect(first).not.toBe(second);
    frame.mockRestore();
  });

  it('selects and frames entities inside groups by their path, without opening the group', async () => {
    const a = model();
    const loose = a.addBox([0, 0, 0], [1, 1, 1]);
    const grouped = a.addBox([3, 0, 0], [4, 1, 1]);
    const frame = vi.spyOn(ModelDocumentApi.prototype, 'frame').mockReturnValue(null as never);
    const { run } = connect(openDocuments({ 'doc-a': a.document }));
    const out = await run(async ({ model: m, selection }) => {
      const revision = (await m!.read() as { revision: number }).revision;
      const group = await m!.apply({ expectedRevision: revision, label: 'Group', operations: [{ op: 'make_group', as: 'g', refs: [{ kind: 'body', id: grouped }] }] }) as { created: { g: number } };
      const path = [group.created.g];
      const inside = await m!.query({ container: path, kinds: ['body'] }) as { entities: { ref: { path: number[]; kind: string; id: number } }[] };
      const refs = [inside.entities[0]!.ref, { kind: 'body', id: loose }];
      const set = await selection!.set({ refs });
      await selection!.frame({ refs: [inside.entities[0]!.ref] });
      const missing = await codeOf(selection!.set({ refs: [{ kind: 'body', id: 999, path }] }));
      const context = (await m!.read() as { editContext: { path: number[] } }).editContext.path;
      return { path, set, missing, context, part: inside.entities[0]!.ref };
    }, 'doc-a');
    expect(out.set).toEqual({ refs: [{ path: out.path, kind: 'body', id: out.part.id }, { path: [], kind: 'body', id: loose }] });
    expect(out.missing).toBe('validation.failed');
    expect(out.context).toEqual([]);
    expect(frame).toHaveBeenCalledWith([{ path: out.path, kind: 'body', id: out.part.id }]);
    frame.mockRestore();
  });

  it('frames through the model API, which needs a viewport', async () => {
    const a = model();
    const id = a.addBox([0, 0, 0], [1, 1, 1]);
    const { run } = connect(openDocuments({ 'doc-a': a.document }));
    expect(await run(({ selection }) => codeOf(selection!.frame({ refs: [{ kind: 'body', id }] })), 'doc-a')).toBe('unavailable');
  });
});

describe('permissions', () => {
  it('leaves out services that were not granted and refuses methods whose permission is missing, also when called directly', async () => {
    const a = model();
    a.addBox([0, 0, 0], [1, 1, 1]);
    const { run, session } = connect(openDocuments({ 'doc-a': a.document }), ['model.read', 'selection.read']);
    const out = await run(async (context) => {
      let selectionWrite = '';
      const snapshot = await context.model!.read() as { selection: unknown[] };
      try { await context.selection!.set({ refs: [] }); } catch (e) { selectionWrite = (e as ExtensionError).code; }
      return { snapshot, selectionWrite, apply: await codeOf(context.model!.apply({ expectedRevision: 0, label: 'x', operations: [{ op: 'delete', refs: [] }] })),
        frame: await codeOf(context.selection!.frame({ refs: [{ kind: 'body', id: 1 }] })) };
    }, 'doc-a');
    expect(out).toMatchObject({ selectionWrite: 'permission.denied', apply: 'permission.denied', frame: 'permission.denied' });
    expect(session.grants.has('model.write')).toBe(false);
  });

  it('hides the selection from a model read without selection.read, and has no model service without model.read', async () => {
    const a = model();
    const id = a.addBox([0, 0, 0], [1, 1, 1]);
    a.host.selection.set([{ kind: 'body', path: [], id: id as never }]);
    const reader = connect(openDocuments({ 'doc-a': a.document }), ['model.read']);
    expect(await reader.run(async ({ model: m }) => (await m!.read() as { selection: unknown[] }).selection, 'doc-a')).toEqual([]);
    const none = connect(openDocuments({ 'doc-a': a.document }), []);
    expect(await none.run((context) => { try { return context.model; } catch (e) { return (e as ExtensionError).code; } }, 'doc-a')).toBe('permission.denied');
    expect(await none.run(({ document }) => document!.units(), 'doc-a')).toEqual({ system: 'imperial', lengthUnit: 'in', format: 'architectural', lengthPrecision: 4 });
  });
});

describe('document scope', () => {
  it('acts on the latest invocation\'s document, or the one a handle names, and never on an id the extension supplies', async () => {
    const a = model(), b = model();
    a.addBox([0, 0, 0], [1, 1, 1]);
    b.addBox([0, 0, 0], [4, 4, 4]);
    const { run, session } = connect(openDocuments({ 'doc-a': a.document, 'doc-b': b.document }));
    const bounds = async (m: Services['model'], input?: unknown) => (await m.read(input) as { bounds: { max: number[] } }).bounds.max[0];
    const handleA = await run(async ({ model: m }, { document }) => ({ handle: document!, max: await bounds(m!) }), 'doc-a');
    expect(handleA.max).toBe(1);
    const onB = await run(async ({ model: m }) => ({ current: await bounds(m!), viaA: await bounds(m!, { document: handleA.handle }),
      spoofed: await codeOf(m!.read({ document: 'doc-a' })) }), 'doc-b');
    expect(onB).toEqual({ current: 4, viaA: 1, spoofed: 'permission.denied' });
    expect(session.openDocument('doc-a')).toBe(handleA.handle);
  });

  it('answers unavailable before any invocation named a document, and document.closed once it closed', async () => {
    const a = model();
    const documents = openDocuments({ 'doc-a': a.document });
    const { run, session, host, context } = connect(documents);
    expect(await run(({ model: m }) => codeOf(m!.read()))).toBe('unavailable');
    const handle = await run((_c, { document }) => document!, 'doc-a');
    session.closeDocument('doc-a');
    host.closed('doc-a');
    documents.close('doc-a');
    const m = context().model!;
    expect(await Promise.all([codeOf(m.read()), codeOf(m.read({ document: handle })), codeOf(context().document!.units())]))
      .toEqual(['document.closed', 'document.closed', 'document.closed']);
  });
});

describe('notifications', () => {
  it('tells the extension the units when it starts acting on another document and when they change', async () => {
    const a = model(), b = model();
    const { run, context } = connect(openDocuments({ 'doc-a': a.document, 'doc-b': b.document }));
    const events: { document: string; units: unknown }[] = [];
    // The first invocation activates the extension; its listener hears from the next one on.
    const handleA = await run(({ document }, invocation) => { document!.onUnitsChange((e) => events.push(e as never)); return invocation.document!; }, 'doc-a');
    a.commands.execute('model.setUnits', { patch: { format: 'decimal', lengthUnit: 'mm', lengthPrecision: 0 } });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toEqual({ document: handleA, units: { system: 'metric', lengthUnit: 'mm', format: 'decimal', lengthPrecision: 0 } });
    const handleB = await run((_c, invocation) => invocation.document!, 'doc-b');
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events[1]).toEqual({ document: handleB, units: b.document.units() });
    await run(() => null, 'doc-b'); // the same document again: nothing new
    a.addBox([0, 0, 0], [1, 1, 1]); // a change that leaves the units alone
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toHaveLength(2);
    expect(context().document).toBeDefined();
  });

  it('tells the extension the name and units when they change, when it starts acting on another document, and not on renames of other documents', async () => {
    const a = model(), b = model();
    const docA = named(a.document, 'Bookcase'), docB = named(b.document, 'Bench');
    const { run } = connect(openDocuments({ 'doc-a': docA.document, 'doc-b': docB.document }));
    const events: { document: string; name: string; units: unknown }[] = [];
    const unitEvents: unknown[] = [];
    const handleA = await run(({ document }, invocation) => {
      document!.onChange((e) => events.push(e as never));
      document!.onUnitsChange((e) => unitEvents.push(e));
      return invocation.document!;
    }, 'doc-a');
    docA.rename('Bookcase v2');
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toEqual({ document: handleA, name: 'Bookcase v2', units: a.document.units() });
    expect(unitEvents).toEqual([]);
    a.commands.execute('model.setUnits', { patch: { format: 'decimal', lengthUnit: 'mm', lengthPrecision: 0 } });
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events[1]).toMatchObject({ document: handleA, name: 'Bookcase v2', units: { lengthUnit: 'mm' } });
    expect(unitEvents).toHaveLength(1);
    const handleB = await run((_c, invocation) => invocation.document!, 'doc-b');
    await vi.waitFor(() => expect(events).toHaveLength(3));
    expect(events[2]).toEqual({ document: handleB, name: 'Bench', units: b.document.units() });
    expect(await run(({ document }) => document!.info({ document: handleA }), 'doc-b')).toMatchObject({ name: 'Bookcase v2' });
  });

  it('notifies subscribers of model and selection changes, coalesced, and selection only with selection.read', async () => {
    const a = model();
    const id = a.addBox([0, 0, 0], [1, 1, 1]);
    const full = connect(openDocuments({ 'doc-a': a.document }));
    const partial = connect(openDocuments({ 'doc-a': a.document }), ['model.read']);
    const heard: { full: unknown[]; partial: unknown[] } = { full: [], partial: [] };
    const subscribe = (key: 'full' | 'partial') => async ({ model: m }: Partial<Services>) => {
      m!.onChange((event) => heard[key].push(event));
      return m!.subscribe({});
    };
    const subscribed = await full.run(subscribe('full'), 'doc-a') as { document: string; revision: number };
    await partial.run(subscribe('partial'), 'doc-a');
    expect(subscribed.revision).toBe(a.host.doc.version);
    a.commands.execute('model.addBox', { min: [2, 0, 0], max: [3, 1, 1] });
    a.commands.execute('model.addBox', { min: [4, 0, 0], max: [5, 1, 1] });
    await vi.waitFor(() => expect(heard.full).toHaveLength(1));
    expect(heard.full[0]).toEqual({ document: subscribed.document, revision: a.host.doc.version, changes: ['model'] });
    a.host.selection.set([{ kind: 'body', path: [], id: id as never }]);
    await vi.waitFor(() => expect(heard.full).toHaveLength(2));
    expect(heard.full[1]).toMatchObject({ changes: ['selection'] });
    await new Promise((r) => setTimeout(r, 20));
    expect(heard.partial).toEqual([expect.objectContaining({ changes: ['model'] })]);
    full.host.closed('doc-a');
    a.commands.execute('model.addBox', { min: [6, 0, 0], max: [7, 1, 1] });
    await new Promise((r) => setTimeout(r, 20));
    expect(heard.full).toHaveLength(2);
  });
});

describe('owned metadata services', () => {
  it('enforces a captured inspector scope, revision and document over the runtime boundary', async () => {
    const a = model(), b = model();
    const capture: InspectorCapture = { binding: 'edit-one', revision: 0, scope: 'placement', targets: [{ kind: 'definition', id: a.host.doc.state.rootDefinitionId }], placementCount: 1, overrideCount: 0 };
    const docs = openDocuments({ one: a.document, two: b.document });
    const { run } = connect(docs, ALL, true, capture);
    const input = { inspectorBinding: capture.binding, expectedRevision: 0, expectedDataVersion: null, upserts: [{ id: 'part', target: capture.targets[0], value: { label: 'Door' } }] };
    expect(await run(({ metadata }) => codeOf(metadata!.apply({ ...input, upserts: [{ id: 'job', target: { kind: 'document' }, value: { label: 'Wrong scope' } }] })), 'one')).toBe('permission.denied');
    expect(await run(({ metadata }) => codeOf(metadata!.apply({ ...input, expectedRevision: 1 })), 'one')).toBe('revision.stale');
    expect(await run(({ metadata }) => codeOf(metadata!.apply({ ...input, inspectorBinding: 'old-view' })), 'one')).not.toBe('ok');
    expect(await run(({ metadata }) => codeOf(metadata!.apply(input)), 'two')).not.toBe('ok');
    await run(({ metadata }) => metadata!.apply(input), 'one');
    expect(a.host.doc.state.pluginData!.get('com.example.parts')!.entries.get('part')!.target).toEqual(capture.targets[0]);
    expect(b.host.doc.state.pluginData).toBeUndefined();
    expect(await run(({ metadata }) => codeOf(metadata!.apply(input)), 'one')).toBe('revision.stale');
  });
  it('uses the invocation document across switches and denies guessed handles and namespaces', async () => {
    const a = model(), b = model(), documents = openDocuments({ 'doc-a': a.document, 'doc-b': b.document });
    const { run } = connect(documents, ALL, true);
    const handle = await run(async ({ metadata, model: m }, invocation) => {
      const revision = (await m!.read() as { revision: number }).revision;
      await metadata!.apply({ document: invocation.document, expectedRevision: revision, expectedDataVersion: null,
        upserts: [{ id: 'job', target: { kind: 'document' }, value: { label: 'Model A' } }] });
      return invocation.document!;
    }, 'doc-a');
    const result = await run(async ({ metadata }) => {
      const first = await metadata!.read({ document: handle, ids: ['job'] });
      const second = await metadata!.list();
      const guessed = await codeOf(metadata!.read({ document: 'doc-a', ids: ['job'] }));
      const otherOwner = await codeOf(metadata!.list({ owner: 'com.someone.else' }));
      return { first, second, guessed, otherOwner };
    }, 'doc-b');
    expect(result.first).toMatchObject({ entries: [{ value: { label: 'Model A' } }] });
    expect(result.second).toMatchObject({ entries: [], dataVersion: null });
    expect(result.guessed).toBe('permission.denied');
    expect(result.otherOwner).toBe('validation.failed');
    expect(b.host.doc.state.pluginData).toBeUndefined();
    documents.close('doc-a');
    expect(await run(({ metadata }) => codeOf(metadata!.read({ document: handle, ids: ['job'] })), 'doc-b')).toBe('document.closed');
  });
  it('transports topology descriptors through the guest and preserves assignment revisions after a model transform', async () => {
    const a = model(), id = a.addBox([0, 0, 0], [.6, .3, .018]);
    const { run } = connect(openDocuments({ one: a.document }), ALL, true);
    const captured = await run(async ({ metadata, model: m }) => {
      const query = await m!.query({ container: [], kinds: ['face', 'edge'], ids: [id], fields: ['geometry'] }) as ModelQueryResult;
      const references = [query.entities.find(entity => entity.ref.kind === 'face')!, query.entities.find(entity => entity.ref.kind === 'edge')!].map(entity => ({ target: { kind: 'bodyOccurrence', id, path: [] }, element: entity.element }));
      await metadata!.apply({ expectedRevision: query.revision, expectedDataVersion: null, upserts: [{ id: 'part', target: { kind: 'bodyOccurrence', id, path: [] }, value: { label: 'Tracked panel' }, references }] });
      return await metadata!.read({ ids: ['part'] }) as MetadataReadResult;
    }, 'one');
    expect(captured.entries[0]!.references.every(ref => ref.element?.bodyVersion === 0)).toBe(true);
    await a.commands.execute('transform.apply', { refs: [{ kind: 'body', id, path: [] }], matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 3, 0, 1] });
    const current = await run(({ metadata }) => metadata!.read({ ids: ['part'] }) as Promise<MetadataReadResult>, 'one');
    expect(current.entries[0]!.references.every(ref => !ref.unresolved && ref.element?.bodyVersion === 1)).toBe(true);
    expect(current.entries[0]!.needsReview).toBe(false);
    expect(captured.entries[0]!.references.every(ref => ref.element?.bodyVersion === 0)).toBe(true);
  });
  it('enforces grants over the runtime boundary and requires an installed schema declaration', async () => {
    const a = model(), docs = openDocuments({ 'doc-a': a.document });
    const reader = connect(docs, ['model.read'], true);
    expect(await reader.run(({ metadata }) => codeOf(metadata!.apply({ expectedRevision: 0, expectedDataVersion: null, upserts: [] })), 'doc-a')).toBe('permission.denied');
    const writer = connect(docs, ['model.write'], true);
    expect(await writer.run(({ metadata }) => codeOf(metadata!.read({ ids: ['job'] })), 'doc-a')).toBe('permission.denied');
    const missing = connect(docs);
    expect(await missing.run(({ metadata }) => codeOf(metadata!.list()), 'doc-a')).toBe('extension.unsupported');
    expect(a.host.doc.state.pluginData).toBeUndefined();
  });
});


describe('compound model and metadata services', () => {
  it('resolves created material aliases through the real session and guest with a single undo entry', async () => {
    const a = model(), { run } = connect(openDocuments({ one: a.document }), ALL, true);
    const before = a.host.undoStack.entries.length;
    const result = await run(async ({ model: api }) => {
      const snapshot = await api!.read({}) as { revision: number };
      return api!.apply({ expectedRevision: snapshot.revision, label: 'Configured maple', operations: [{ op: 'add_material', as: 'maple', name: 'Maple', color: '#bb9977' }],
        metadata: { expectedDataVersion: null, upserts: [{ id: 'material', target: { kind: 'material', created: 'maple' }, value: { label: 'Maple stock' } }] } }) as Promise<{ created: { maple: number }; metadata: { changed: string[] } }>;
    }, 'one');
    expect(result.metadata.changed).toEqual(['material']);
    expect(a.host.doc.state.pluginData!.get('com.example.parts')!.entries.get('material')!.target).toEqual({ kind: 'material', id: result.created.maple });
    expect(a.host.undoStack.entries).toHaveLength(before + 1);
    a.host.undo(); expect(a.host.doc.state.materials.has(result.created.maple as never)).toBe(false);
    expect(a.host.doc.state.pluginData?.size ?? 0).toBe(0);
  });
  it('refuses missing schemas, denied write permission and injected namespace/binding fields before mutation', async () => {
    for (const [grants, declared, extra, code] of [
      [ALL, false, {}, 'extension.unsupported'],
      [['model.read'], true, {}, 'permission.denied'],
      [ALL, true, { owner: 'com.example.other' }, 'validation.failed'],
      [ALL, true, { inspectorBinding: 'pretend' }, 'validation.failed'],
    ] as [ExtensionPermission[], boolean, object, string][]) {
      const a = model(), { run } = connect(openDocuments({ one: a.document }), grants, declared);
      const before = a.host.doc.state;
      const result = run(({ model: api }) => api!.apply({ expectedRevision: a.host.doc.version, label: 'Configured maple', operations: [{ op: 'add_material', as: 'maple', name: 'Maple', color: '#bb9977' }],
        metadata: { expectedDataVersion: null, upserts: [{ id: 'material', target: { kind: 'material', created: 'maple' }, value: { label: 'Maple stock' } }], ...extra } }), 'one');
      expect(await codeOf(result)).toBe(code); expect(a.host.doc.state).toBe(before);
    }
  });
});

it('transfers a precise textured appearance through real permission-bound services and commits its configuration in one Undo step', async () => {
  const m = model(), docs = openDocuments({ one: m.document, two: model().document }), connection = connect(docs, ALL, true);
  const pixels = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB7sAAAAASUVORK5CYII='), value => value.charCodeAt(0));
  const before = m.host.doc.state, undo = m.host.undoStack.entries.length;
  const result = await connection.run(async context => {
    const revision = m.host.doc.version;
    const uploaded = await context.model!.materialStage({ expectedRevision: revision, appearance: { name: 'Textured maple', color: [.1234, .5678, .9012], opacity: .63,
      texture: { widthM: .6, heightM: 1.2, colorize: true, colorizeType: 'tint', grain: 'height', image: { name: 'grain.png', mime: 'image/png', width: 1, height: 1, byteLength: pixels.length } } }, bytes: pixels }) as MaterialStageResult;
    expect(uploaded.complete).toBe(true); expect(m.host.doc.state).toBe(before); expect(m.host.undoStack.entries.length).toBe(undo);
    const committed = await context.model!.apply({ expectedRevision: revision, label: 'Import textured maple', operations: [{ op: 'add_material_appearance', asset: uploaded.upload, as: 'maple' }],
      metadata: { expectedDataVersion: null, upserts: [{ id: 'material-config', target: { kind: 'material', created: 'maple' }, value: { label: 'Sheet good' } }] } }) as ModelBatchResult;
    await expect(context.model!.apply({ expectedRevision: committed.revision, label: 'Reuse consumed upload', operations: [{ op: 'add_material_appearance', asset: uploaded.upload }] })).rejects.toMatchObject({ code: 'validation.failed' });
    const first = await context.model!.materialRead({ expectedRevision: committed.revision, materialId: committed.created.maple, limit: 17 }) as MaterialReadResult;
    expect(first.appearance).toMatchObject({ color: [.1234, .5678, .9012], opacity: .63, texture: { widthM: .6, heightM: 1.2, colorizeType: 'tint', grain: 'height' } });
    const second = await context.model!.materialRead({ expectedRevision: committed.revision, materialId: committed.created.maple, offset: first.next }) as MaterialReadResult;
    expect(new Uint8Array([...first.bytes, ...second.bytes])).toEqual(pixels); expect(second.next).toBeNull();
    first.bytes.fill(0);
    const reread = await context.model!.materialRead({ expectedRevision: committed.revision, materialId: committed.created.maple }) as MaterialReadResult;
    expect(reread.bytes).toEqual(pixels);
    const saved = await context.metadata!.read({ ids: ['material-config'] }) as MetadataReadResult;
    expect(saved.entries[0]!.value).toEqual({ label: 'Sheet good' });
    const retry = await context.model!.materialStage({ expectedRevision: committed.revision, appearance: reread.appearance, bytes: reread.bytes }) as MaterialStageResult;
    const prior = m.host.doc.state, undoBeforeFailure = m.host.undoStack.entries.length;
    await expect(context.model!.apply({ expectedRevision: committed.revision, label: 'Invalid configured texture', operations: [{ op: 'add_material_appearance', asset: retry.upload, as: 'bad' }],
      metadata: { expectedDataVersion: 1, upserts: [{ id: 'invalid-config', target: { kind: 'material', created: 'bad' }, value: { label: 5 } }] } })).rejects.toMatchObject({ code: 'validation.failed' });
    expect({ ...m.host.doc.state, meta: { ...m.host.doc.state.meta, nextId: prior.meta.nextId } }).toEqual(prior);
    expect(m.host.undoStack.entries.length).toBe(undoBeforeFailure);
    // Rollback advances the revision, but a failed import still permits discarding its retained staging.
    await context.model!.materialStage({ expectedRevision: m.host.doc.version, upload: retry.upload, discard: true });
    return committed;
  }, 'one');
  expect(m.host.undoStack.entries).toHaveLength(undo + 1);
  expect(m.host.doc.state.pluginData!.get('com.example.parts')!.entries.get('material-config')!.target).toEqual({ kind: 'material', id: result.created.maple });
  m.host.undo(); expect(m.host.doc.state.materials.has(result.created.maple! as never)).toBe(false); expect(m.host.doc.state.images.size).toBe(before.images.size);
  m.host.redo(); expect(m.host.doc.state.materials.has(result.created.maple! as never)).toBe(true);
  const version = m.host.doc.version;
  await connection.run(async context => {
    const plain = await context.model!.materialStage({ expectedRevision: version, appearance: { name: 'Plain maple', color: [.2, .3, .4], opacity: 1, texture: null } }) as MaterialStageResult;
    await context.model!.apply({ expectedRevision: version, label: 'Replace appearance', operations: [{ op: 'set_material_appearance', materialId: result.created.maple, asset: plain.upload }] });
  }, 'one');
  expect(m.host.doc.state.materials.get(result.created.maple! as never)!.texture).toBeNull();
  m.host.undo(); expect(m.host.doc.state.materials.get(result.created.maple! as never)!.texture).not.toBeNull();
  connection.host.dispose(); await connection.session.deactivate('shutdown');
});

it('refuses ungranted, foreign-document, incomplete and stale appearance transfers before mutations', async () => {
  const one = model(), two = model(), docs = openDocuments({ one: one.document, two: two.document }), connection = connect(docs);
  const upload = await connection.run(async context => (await context.model!.materialStage({ expectedRevision: one.host.doc.version, appearance: { name: 'Oak', color: [.2,.3,.4], opacity: 1, texture: null } }) as MaterialStageResult).upload, 'one');
  await connection.run(async context => {
    const revision = one.host.doc.version, before = one.host.doc.state;
    const partial = await context.model!.materialStage({ expectedRevision: revision, appearance: { name: 'Incomplete image', color: [.2,.3,.4], opacity: 1,
      texture: { widthM: 1, heightM: 1, colorize: false, image: { name: 'image.png', mime: 'image/png', width: 1, height: 1, byteLength: 100 } } } }) as MaterialStageResult;
    await expect(context.model!.apply({ expectedRevision: revision, label: 'Incomplete upload', operations: [{ op: 'add_material_appearance', asset: partial.upload }] })).rejects.toMatchObject({ code: 'validation.failed' });
    expect(one.host.doc.state).toBe(before);
  }, 'one');
  const before = two.host.doc.state;
  await expect(connection.run(context => context.model!.apply({ expectedRevision: two.host.doc.version, label: 'Foreign upload', operations: [{ op: 'add_material_appearance', asset: upload }] }), 'two')).rejects.toMatchObject({ code: 'validation.failed' });
  expect(two.host.doc.state).toBe(before);
  one.addBox([0,0,0], [1,1,1]);
  await expect(connection.run(context => context.model!.apply({ expectedRevision: one.host.doc.version, label: 'Stale staged appearance', operations: [{ op: 'add_material_appearance', asset: upload }] }), 'one')).rejects.toMatchObject({ code: 'revision.stale' });
  await expect(connection.run(context => context.model!.materialRead({ expectedRevision: 0, materialId: one.host.doc.state.defaultMaterialId }), 'one')).rejects.toMatchObject({ code: 'revision.stale' });
  connection.host.dispose(); await connection.session.deactivate('shutdown');
  const readOnly = connect(docs, ['model.read']);
  await expect(readOnly.run(context => context.model!.materialStage({ expectedRevision: one.host.doc.version }), 'one')).rejects.toMatchObject({ code: 'permission.denied' });
  readOnly.host.dispose(); await readOnly.session.deactivate('shutdown');
  const writeOnly = connect(docs, ['model.write']);
  await expect(writeOnly.run(context => context.model!.materialRead({ expectedRevision: one.host.doc.version, materialId: one.host.doc.state.defaultMaterialId }), 'one')).rejects.toMatchObject({ code: 'permission.denied' });
  writeOnly.host.dispose(); await writeOnly.session.deactivate('shutdown');
});

it('refuses incomplete source images and future native appearance fields without producing a reduced export', async () => {
  const m = model(), docs = openDocuments({ one: m.document }), connection = connect(docs);
  const id = m.commands.execute('material.create', { name: 'Retained appearance', color: [.2,.3,.4], activate: false }) as number;
  m.host.doc.transact('Simulate missing image bytes', draft => {
    draft.materials.get(id as never)!.texture = { imageId: 999 as never, widthM: 1, heightM: 1, colorize: false };
  });
  const before = m.host.doc.state;
  await expect(connection.run(context => context.model!.materialRead({ expectedRevision: m.host.doc.version, materialId: id }), 'one')).rejects.toMatchObject({ code: 'unavailable' });
  expect(m.host.doc.state).toBe(before);
  m.host.doc.transact('Retain a future appearance field', draft => {
    draft.materials.get(id as never)!.texture = null;
    draft.nativeMaterialUnknownFields = new Map([[id, { required: true, envelopeUnknown: [new Uint8Array([8, 1])] }]]);
  });
  const retained = m.host.doc.state;
  await expect(connection.run(context => context.model!.materialRead({ expectedRevision: m.host.doc.version, materialId: id }), 'one')).rejects.toMatchObject({ code: 'extension.unsupported' });
  expect(m.host.doc.state).toBe(retained);
  connection.host.dispose(); await connection.session.deactivate('shutdown');
});


it('retains model ownership only for the same trusted tool session when amending a gesture', async () => {
  const m = model(), host = new ExtensionDocumentHost({ manifest: manifestFor(ALL), grants: new Set(ALL), documents: { get: () => m.document }, session: () => undefined });
  const apply = host.services()['model.apply']!;
  const call = { signal: new AbortController().signal, extensionId: 'com.example.parts', generation: 1, currentDocument: () => 'one', document: () => 'one', toolSession: 'tool-A', separateUndo: true, progress() {}, userActivated: () => true } satisfies ServiceCall;
  const created = await apply({ expectedRevision: m.document.model('Test')!.revision, label: 'Draw', operations: [{ op: 'add_prism', as: 'part', points: [[0,0,0],[1,0,0],[1,1,0],[0,1,0]], normal: [0,0,1], distance: 0.1 }] }, call) as ModelBatchResult;
  const edit = { expectedRevision: created.revision, label: 'Correct', operations: [{ op: 'scale', refs: [{ kind: 'body', id: created.created.part }], origin: [0,0,0], factors: [1,1,2] }] };
  const corrected = await apply(edit, { ...call, separateUndo: false, amendToolUndo: true }) as ModelBatchResult;
  expect(m.host.undoStack.length).toBe(1); expect(m.host.doc.rootDefinition.entities.bodies.size).toBe(1);
  await expect(apply({ ...edit, expectedRevision: corrected.revision }, { ...call, toolSession: 'tool-B', separateUndo: false, amendToolUndo: true })).rejects.toMatchObject({ code: 'revision.stale' });
  m.host.undo(); expect(m.host.doc.rootDefinition.entities.bodies.size).toBe(0); host.dispose();
});
