// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CommandRegistry, DocumentHost, SERVICE_DOCUMENT, SERVICE_KERNEL, editCommands, groupCommands, modelCommands, modelInfoCommands, transformCommands,
} from '@pushform/commands';
import { MODEL_LIMITS, extensionManifestSchema, type ExtensionError, type ExtensionPermission } from '@pushform/extension-protocol';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import { ModelDocumentApi } from '../modelApi';
import { commandsDocument, documentUnitsOf, ExtensionDocumentHost, type DocumentChange, type ExtensionDocument, type ExtensionDocuments } from './documents';
import { startGuest, type ExtensionContext } from './guest';
import { ExtensionSession } from './host';
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
  for (const group of [editCommands, modelCommands, modelInfoCommands, transformCommands, groupCommands]) commands.registerAll(group);
  const addBox = (min: [number, number, number], max: [number, number, number]): number => commands.execute('model.addBox', { min, max }) as number;
  return { host, commands, addBox, document: commandsDocument(commands) };
}

type Call = (input?: unknown) => Promise<unknown>;
interface Services {
  model: Record<'read' | 'query' | 'apply' | 'subscribe', Call> & { onChange(handler: (event: unknown) => void): () => void };
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
function connect(documents: ExtensionDocuments, grants: ExtensionPermission[] = ALL) {
  const manifest = manifestFor(ALL);
  const channel = new MessageChannel();
  channels.push(channel);
  const ref: { session?: ExtensionSession } = {};
  const host = new ExtensionDocumentHost({ manifest, grants: new Set(grants), documents, session: () => ref.session, coalesceMs: 0 });
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
