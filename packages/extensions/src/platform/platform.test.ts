// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import { zipSync } from 'fflate';
import { ExtensionError, buildManifest, sha256Hex, type ExtensionManifestInput } from '@pushform/extension-protocol';
import { memoryAssetStore } from '../assetStore';
import type { FileReadDescription, FileReadChunk, FileStageResult } from '@pushform/extension-protocol';
import { startGuest } from '../runtime/guest';
import { messagePortTransport } from '../runtime/port';
import { memorySettingsStore, type SettingsStore } from '../runtime/settings';
import { memoryDeveloperMode } from './developerMode';
import { ExtensionPlatform, type ExtensionPlatformOptions } from './platform';
import { memoryExtensionStore, type InstalledExtension } from './store';
import type { ToolInput, ToolSource, ToolStopReason, ToolView } from '@pushform/extension-protocol';
import type { ExtensionToolRequest } from '../runtime/tools';

const encode = (s: string) => new TextEncoder().encode(s);
const base = {
  id: 'com.example.stairs', name: 'Stairs', publisher: 'Example', version: '1.0.0', apiVersion: '^0.1.0', editors: ['modeling'],
  defaultLocale: 'en', license: 'MIT', permissions: ['settings'],
  contributions: [
    { target: 'model.command', id: 'com.example.stairs.make', name: 'Make stairs' },
    { target: 'model.panel', id: 'com.example.stairs.panel', name: 'Stairs' },
  ],
} satisfies Omit<ExtensionManifestInput, 'files'>;

async function archive(overrides: Partial<Omit<ExtensionManifestInput, 'files'>> = {}, extra: Record<string, Uint8Array> = {}): Promise<Uint8Array> {
  const files = new Map<string, Uint8Array>([['main.js', encode('export function activate() {}')], ...Object.entries(extra)]);
  files.set('manifest.json', await buildManifest({ ...base, ...overrides }, files));
  return zipSync(Object.fromEntries(files));
}

const channels: MessageChannel[] = [];
afterEach(() => { for (const c of channels.splice(0)) { c.port1.close(); c.port2.close(); } });

/** A platform whose runtimes run `modules[id]` in this process. */
function setup(modules: Record<string, unknown>, overrides: Partial<ExtensionPlatformOptions> = {}) {
  const started: string[] = [];
  const terminated: string[] = [];
  const settings = new Map<string, SettingsStore>();
  const settingsFor = (record: InstalledExtension): SettingsStore => {
    if (!settings.has(record.id)) settings.set(record.id, memorySettingsStore());
    return settings.get(record.id)!;
  };
  const failures: string[] = [];
  const store = memoryExtensionStore();
  const developerMode = memoryDeveloperMode(true);
  const platform = new ExtensionPlatform({
    store, developerMode,
    startRuntime: async (record: InstalledExtension) => {
      started.push(record.id);
      const channel = new MessageChannel();
      channels.push(channel);
      void startGuest(messagePortTransport(channel.port2), async () => modules[record.id]);
      return { port: messagePortTransport(channel.port1), terminate: () => terminated.push(record.id) };
    },
    settingsStore: settingsFor,
    onFailure: (record, failure) => failures.push(`${record.id}:${failure.kind}`),
    ...overrides,
  });
  return { platform, store, developerMode, started, terminated, settings, settingsFor, failures };
}

const failure = async (promise: Promise<unknown>): Promise<ExtensionError> => {
  try { await promise; } catch (error) { if (error instanceof ExtensionError) return error; throw error; }
  throw new Error('expected an ExtensionError');
};

it('moves a file larger than one runtime message through bounded guest calls and expires handles on restart', async () => {
  const bytes = Uint8Array.from({ length:5 * 1024 * 1024 + 3 },(_,i) => i % 251), hash = await sha256Hex(bytes);
  type Context = { commands: { register(id: string,fn: (params: { old?: string }) => Promise<unknown>): void }; files: Record<string,(input: unknown) => Promise<unknown>> };
  const module = { activate(c: Context) { c.commands.register('com.example.stairs.make',async params => {
    if (params.old) return c.files.read!({ transfer:params.old });
    const source = await c.files.openRead!({ purpose:'Import test library' }) as FileReadDescription;
    const received = new Uint8Array(source.byteLength);
    for (let at = 0; at < source.byteLength;) {
      const part = await c.files.read!({ transfer:source.transfer,offset:at }) as FileReadChunk;
      received.set(part.bytes,at); at += part.bytes.length;
    }
    let tooLarge = '';
    try { await c.files.save!({ purpose:'Legacy oversized export',data:received }); } catch (error) { tooLarge = (error as ExtensionError).code; }
    let upload = '';
    for (let at = 0; at < received.length; at += 256 * 1024) {
      const result = await c.files.stage!({ ...(upload ? { upload,offset:at } : { byteLength:received.length,sha256:hash }),bytes:received.slice(at,at + 256 * 1024) }) as FileStageResult;
      upload = result.upload;
    }
    await c.files.saveStaged!({ upload,purpose:'Export test library',suggestedName:'materials.zip' });
    return { source,hash:await sha256Hex(received),tooLarge };
  }); } };
  const save = vi.fn(async (_request: unknown,received: Uint8Array) => { expect(await sha256Hex(received)).toBe(hash); return { name:'materials.zip' }; });
  const filePicker = { open:async () => ({ name:'materials.zip',type:'application/zip',data:bytes }),save };
  const { platform } = setup({ [base.id]:module },{ filePicker });
  await platform.install(await platform.sideload(await archive({ permissions:['file.read','file.export'] })),['file.read','file.export']);
  try {
    const result = await platform.invoke(base.id,'com.example.stairs.make',{}) as { source:FileReadDescription;hash:string;tooLarge:string };
    expect(result.hash).toBe(hash); expect(result.tooLarge).toBe('limit.exceeded'); expect(save).toHaveBeenCalledOnce();
    await platform.setEnabled(base.id,false); await platform.setEnabled(base.id,true);
    await expect(platform.invoke(base.id,'com.example.stairs.make',{ old:result.source.transfer })).rejects.toMatchObject({ code:'validation.failed' });
  } finally { await platform.stopAll(); }
  const denied = setup({ [base.id]:module },{ filePicker }).platform;
  await denied.install(await denied.sideload(await archive({ permissions:['file.read','file.export'] })),[]);
  try { await expect(denied.invoke(base.id,'com.example.stairs.make',{})).rejects.toMatchObject({ code:'permission.denied' }); }
  finally { await denied.stopAll(); }
});

describe('side-loading', () => {
  it('needs developer mode, and refuses reserved ids, signed packages and anything the validator refuses', async () => {
    const { platform, developerMode } = setup({});
    developerMode.set(false);
    expect((await failure(platform.sideload(await archive()))).message).toMatch(/developer mode/);
    developerMode.set(true);
    expect((await failure(platform.sideload(await archive({ id: 'io.pushform.cut-list', contributions: [{ target: 'model.command', id: 'io.pushform.cut-list.x', name: 'X' }] })))).message).toMatch(/belongs to PushForm/);
    await expect(platform.sideload(await archive({}, { 'signature.json': encode('{}') }))).rejects.toMatchObject({ details: { problem: 'signature.invalid' } });
    await expect(platform.sideload(await archive({}, { 'panel.html': encode('<b>') }))).rejects.toMatchObject({ details: { problem: 'file.type' } });
  });

  it('installs what the user approved, unsigned and from developer mode, with only granted permissions', async () => {
    const { platform, store } = setup({});
    const request = await platform.sideload(await archive({ permissions: ['settings', 'clipboard.write'] }));
    expect(request).toMatchObject({ integrity: 'unsigned', source: 'developer', replaces: null, newPermissions: ['settings', 'clipboard.write'] });
    const record = await platform.install(request, ['settings']);
    expect(record).toMatchObject({ id: 'com.example.stairs', integrity: 'unsigned', source: 'developer', enabled: true, grants: ['settings'] });
    expect((await store.list()).map((r) => r.id)).toEqual(['com.example.stairs']);
  });

  it('shows a reload what it newly asks for', async () => {
    const { platform } = setup({});
    await platform.install(await platform.sideload(await archive()), ['settings']);
    const reload = await platform.sideload(await archive({ version: '1.0.1', permissions: ['settings', 'file.export'] }));
    expect(reload.replaces?.version).toBe('1.0.0');
    expect(reload.newPermissions).toEqual(['file.export']);
  });

  it('a reload stops the running release and lets open panels run the new one', async () => {
    const { platform, started, terminated } = setup({ 'com.example.stairs': { activate(c: { commands: { register(i: string, h: () => unknown): void } }) {
      c.commands.register('com.example.stairs.make', () => 'made');
    } } });
    await platform.install(await platform.sideload(await archive()), []);
    expect(platform.state('com.example.stairs')!.generation).toBe(0);
    await platform.invoke('com.example.stairs', 'com.example.stairs.make');
    await platform.install(await platform.sideload(await archive({ version: '1.0.1' })), []);
    expect(terminated).toEqual(['com.example.stairs']);
    expect(platform.state('com.example.stairs')).toMatchObject({ run: 'stopped', generation: 1, record: { version: '1.0.1' } });
    expect(await platform.invoke('com.example.stairs', 'com.example.stairs.make')).toBe('made');
    expect(started).toEqual(['com.example.stairs', 'com.example.stairs']);
  });
});

describe('running', () => {
  it('lists contributions without starting anything, then starts the runtime once on first use', async () => {
    const activate = vi.fn((context: { commands: { register(id: string, h: () => unknown): void } }) => {
      context.commands.register('com.example.stairs.make', () => 'made');
    });
    const { platform, started } = setup({ 'com.example.stairs': { activate } });
    await platform.install(await platform.sideload(await archive()), ['settings']);
    expect(platform.contributions('modeling').map((c) => c.name)).toEqual(['Make stairs', 'Stairs']);
    expect(platform.contributions('layout')).toEqual([]);
    expect(started).toEqual([]);
    expect(await platform.invoke('com.example.stairs', 'com.example.stairs.make')).toBe('made');
    expect(await platform.invoke('com.example.stairs', 'com.example.stairs.make')).toBe('made');
    expect(started).toEqual(['com.example.stairs']);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(platform.state('com.example.stairs')?.run).toBe('running');
  });

  it('stops a disabled extension and refuses to run it', async () => {
    const { platform, terminated } = setup({ 'com.example.stairs': { activate(c: { commands: { register(i: string, h: () => unknown): void } }) { c.commands.register('com.example.stairs.make', () => 1); } } });
    await platform.install(await platform.sideload(await archive()), []);
    await platform.invoke('com.example.stairs', 'com.example.stairs.make');
    await platform.setEnabled('com.example.stairs', false);
    expect(terminated).toEqual(['com.example.stairs']);
    expect(platform.contributions()).toEqual([]);
    expect((await failure(platform.invoke('com.example.stairs', 'com.example.stairs.make'))).message).toMatch(/turned off/);
  });

  it('uninstalls keeping or deleting settings, never anything else', async () => {
    const assets = memoryAssetStore();
    const { platform, settings, settingsFor } = setup({}, { assetStore: () => assets });
    await platform.install(await platform.sideload(await archive()), ['settings']);
    const record = platform.state('com.example.stairs')!.record;
    await settingsFor(record).save(record.id, 1, { kerf: 1 }, null);
    await assets.put(record.id, { key:'Library',version:1,contentType:'application/octet-stream',byteLength:0,sha256:await sha256Hex(new Uint8Array()) }, new Uint8Array(),null);
    await platform.uninstall('com.example.stairs', { deleteSettings: false });
    expect(await settings.get('com.example.stairs')!.load('com.example.stairs')).not.toBeNull();
    expect(await assets.read(record.id,'Library')).not.toBeNull();
    await platform.install(await platform.sideload(await archive()), []);
    await platform.uninstall('com.example.stairs', { deleteSettings: true });
    expect(await settings.get('com.example.stairs')!.load('com.example.stairs')).toBeNull();
    expect(await assets.read(record.id,'Library')).toBeNull();
    expect(platform.list()).toEqual([]);
  });

  it('turns side-loaded extensions off with developer mode, and drops them where policy forbids it', async () => {
    const { platform, store } = setup({});
    await platform.install(await platform.sideload(await archive()), []);
    await platform.setDeveloperMode(false);
    expect(platform.state('com.example.stairs')?.record.enabled).toBe(false);
    expect(platform.contributions()).toEqual([]);
    const forbidden = new ExtensionPlatform({ ...platform['options'], developerMode: memoryDeveloperMode(true, false), store });
    await forbidden.load();
    expect(forbidden.list()).toEqual([]);
    expect(await store.list()).toEqual([]);
  });

  it('ends a failed runtime, reports it, and starts again on the next use', async () => {
    const { platform, terminated, failures, started } = setup({ 'com.example.stairs': { activate() { throw new Error('broken start'); } } });
    await platform.install(await platform.sideload(await archive()), []);
    expect((await failure(platform.invoke('com.example.stairs', 'com.example.stairs.make'))).message).toBe('broken start');
    expect(platform.state('com.example.stairs')).toMatchObject({ run: 'failed', failure: { kind: 'activation-failed' } });
    expect(terminated).toEqual(['com.example.stairs']);
    expect(failures).toEqual(['com.example.stairs:activation-failed']);
    await failure(platform.invoke('com.example.stairs', 'com.example.stairs.make'));
    expect(started).toEqual(['com.example.stairs', 'com.example.stairs']);
  });

  it('names the action that was running, turns off an extension that keeps failing, and restarts it on request', async () => {
    let clock = 0;
    const { platform, store } = setup({ 'com.example.stairs': { activate() { throw new Error('broken start'); } } }, { now: () => new Date(clock) });
    await platform.install(await platform.sideload(await archive()), []);
    await failure(platform.invoke('com.example.stairs', 'com.example.stairs.make'));
    expect(platform.state('com.example.stairs')).toMatchObject({ run: 'failed', failedAction: 'Make stairs', crashDisabled: false });
    platform.dismissFailure('com.example.stairs');
    expect(platform.state('com.example.stairs')).toMatchObject({ run: 'stopped', failure: null, failedAction: null });
    // Failures far apart do not count together.
    clock += 11 * 60_000;
    await failure(platform.invoke('com.example.stairs', 'com.example.stairs.make'));
    clock += 1000;
    await failure(platform.invoke('com.example.stairs', 'com.example.stairs.make'));
    expect(platform.state('com.example.stairs')!.record.enabled).toBe(true);
    clock += 1000;
    await failure(platform.invoke('com.example.stairs', 'com.example.stairs.make'));
    expect(platform.state('com.example.stairs')).toMatchObject({ run: 'failed', crashDisabled: true, record: { enabled: false } });
    expect((await store.list())[0]!.enabled).toBe(false);
    expect((await failure(platform.invoke('com.example.stairs', 'com.example.stairs.make'))).message).toMatch(/turned off/);

    await platform.restart('com.example.stairs');
    expect(platform.state('com.example.stairs')).toMatchObject({ run: 'stopped', failure: null, crashDisabled: false, generation: 1, record: { enabled: true } });
    expect((await failure(platform.invoke('com.example.stairs', 'com.example.stairs.make'))).message).toBe('broken start');
  });

  it('keeps the latest log lines of each extension', async () => {
    const { platform } = setup({ 'com.example.stairs': { activate(c: { log: { write(e: unknown): Promise<unknown> }; commands: { register(i: string, h: () => unknown): void } }) {
      c.commands.register('com.example.stairs.make', async () => { await c.log.write({ step: 'made' }); });
    } } });
    await platform.install(await platform.sideload(await archive()), []);
    await platform.invoke('com.example.stairs', 'com.example.stairs.make');
    expect(platform.state('com.example.stairs')?.logs.map((l) => l.entry)).toEqual([{ step: 'made' }]);
  });
});

describe('documents', () => {
  it('serves the document services over the documents it is given, scoped to each invocation, until the document closes', async () => {
    const units = (lengthUnit: 'mm' | 'in') => ({ system: lengthUnit === 'mm' ? 'metric' as const : 'imperial' as const, lengthUnit, format: 'decimal' as const, lengthPrecision: 2 });
    const open = new Map([['tab-a', units('mm')], ['tab-b', units('in')]]);
    const documents = { get: (id: string) => {
      const u = open.get(id);
      return u ? { name: () => 'Stairs', units: () => u, model: () => null, listen: () => () => {} } : null;
    } };
    const module = { activate(context: { commands: { register(id: string, h: () => unknown): void }; document: { units(): Promise<unknown> } }) {
      context.commands.register('com.example.stairs.make', () => context.document.units());
    } };
    const { platform } = setup({ 'com.example.stairs': module }, { documents });
    await platform.install(await platform.sideload(await archive()), ['settings']);
    expect(await platform.invoke('com.example.stairs', 'com.example.stairs.make', {}, { document: 'tab-a' })).toEqual(units('mm'));
    expect(await platform.invoke('com.example.stairs', 'com.example.stairs.make', {}, { document: 'tab-b' })).toEqual(units('in'));
    open.delete('tab-b');
    platform.closeDocument('tab-b');
    expect((await failure(platform.invoke('com.example.stairs', 'com.example.stairs.make', {}))).code).toBe('document.closed');
    await platform.stopAll();
  });
});

it('serves permission-bound durable assets through the real guest and keeps them across runtime restart', async () => {
  const assets = memoryAssetStore(), bytes = new Uint8Array([1,2,3]), sha256 = await sha256Hex(bytes);
  type Context = { commands: { register(id: string, fn: (params: { save?: boolean }) => unknown): void }; assets: Record<'list'|'stage'|'commit', (input: unknown) => Promise<unknown>> };
  const module = { activate(c: Context) { c.commands.register('com.example.stairs.make',async params => {
    if (params.save) { const staged = await c.assets.stage({ description:{key:'Library',version:1,contentType:'application/octet-stream',byteLength:bytes.length,sha256},expectedRevision:null,bytes }) as {upload:string}; return c.assets.commit({upload:staged.upload}); }
    return c.assets.list({});
  }); } };
  const { platform } = setup({ 'com.example.stairs':module },{assetStore:()=>assets});
  await platform.install(await platform.sideload(await archive()),['settings']);
  const saved = await platform.invoke(base.id,'com.example.stairs.make',{save:true}) as {revision:number}; expect(saved.revision).toBe(1);
  await platform.setEnabled(base.id,false); await platform.setEnabled(base.id,true);
  expect(await platform.invoke(base.id,'com.example.stairs.make',{})).toMatchObject({entries:[{key:'Library',revision:1}]});
  await platform.stopAll();
  const denied = setup({ 'com.example.stairs':module },{assetStore:()=>assets}).platform;
  await denied.install(await denied.sideload(await archive()),[]);
  await expect(denied.invoke(base.id,'com.example.stairs.make',{})).rejects.toMatchObject({code:'permission.denied'}); await denied.stopAll();
});


describe('host-activated modeling tools', () => {
  type ToolContext = {
    commands: { register(id: string, handler: (params: unknown, invocation: { document?: string; signal: AbortSignal }) => unknown): void };
    tools: {
      present(input: { session: string; sequence: number; view: unknown }): Promise<null>;
      ack(input: { session: string; sequence: number }): Promise<null>;
      end(input: { session: string }): Promise<null>;
      onEvent(handler: (input: ToolInput) => void): () => void;
      onEnd(handler: (event: { session: string; reason: ToolStopReason }) => void): () => void;
    };
  };
  const toolId = 'com.example.stairs.tool';
  const toolManifest = { permissions: ['model.read', 'tool.interaction'], contributions: [{ target: 'model.tool', id: toolId, name: 'Draw stairs' }] } satisfies Partial<ExtensionManifestInput>;
  const key: ToolSource = { kind: 'keyDown', data: { key: 'Shift', code: 'ShiftLeft', repeat: false, modifiers: { shift: true, ctrl: false, alt: false, meta: false } } };
  function viewport() {
    let request: ExtensionToolRequest | undefined;
    const views: (ToolView | null)[] = [], stopped: ToolStopReason[] = [];
    return { views, stopped, request: () => request!, adapter: { open(value: ExtensionToolRequest) {
      request = value;
      return { stamp: () => ({ revision: 4, contextVersion: 0, cameraVersion: 0, context: [2] }),
        present: (view: ToolView | null) => views.push(view), close: (reason: ToolStopReason) => stopped.push(reason) };
    } } };
  }
  it('routes declared tools through guest proxies, owns their session and ends before runtime cleanup', async () => {
    const v = viewport(), heard: ToolInput[] = [], ended: ToolStopReason[] = [];
    let context!: ToolContext;
    const module = { activate(c: ToolContext) {
      context = c;
      c.tools.onEvent(input => { heard.push(input); void c.tools.present({ session: input.session, sequence: input.sequence, view: { instructor: input.kind } }); });
      c.tools.onEnd(event => ended.push(event.reason));
      c.commands.register(toolId, async (params, invocation) => {
        const { tool } = params as { tool: ToolInput };
        expect(invocation.document).toMatch(/^doc_/); expect(invocation.document).not.toBe('model-A');
        await c.tools.present({ session: tool.session, sequence: tool.sequence, view: { instructor: 'Ready' } });
        return tool;
      });
    } };
    const { platform } = setup({ [base.id]: module }, { tools: v.adapter });
    await platform.install(await platform.sideload(await archive(toolManifest)), ['model.read', 'tool.interaction']);
    try {
      const activation = await platform.invoke(base.id, toolId, {}, { document: 'model-A', userAction: true }) as ToolInput;
      expect(activation).toMatchObject({ kind: 'activate', sequence: 0, revision: 4, context: [2] });
      expect(v.views.at(-1)?.instructor).toBe('Ready');
      await expect(context.tools.ack({ session: 'guessed', sequence: 0 })).rejects.toMatchObject({ code: 'cancelled' });
      expect(v.stopped).toEqual([]);
      v.request().input(key);
      await vi.waitFor(() => expect(v.views.at(-1)?.instructor).toBe('keyDown'));
      expect(heard.map(input => input.sequence)).toEqual([1]);
      const stopping = platform.stop(base.id);
      // stop() invalidates input/preview synchronously, before awaiting guest deactivate().
      expect(v.views.at(-1)).toBeNull(); expect(v.stopped).toEqual(['disabled']);
      await stopping;
      expect(ended).toEqual(['disabled']);
      v.request().input(key); expect(heard).toHaveLength(1);
    } finally { await platform.stopAll(); }
  });
  it('does not open a viewport without both grants, an open model target and a viewport adapter', async () => {
    const v = viewport(), module = { activate(c: ToolContext) { c.commands.register(toolId, () => null); } };
    const denied = setup({ [base.id]: module }, { tools: v.adapter }).platform;
    await denied.install(await denied.sideload(await archive(toolManifest)), ['tool.interaction']);
    try { await expect(denied.invoke(base.id, toolId, {}, { document: 'model-A' })).rejects.toMatchObject({ code: 'permission.denied' }); expect(v.request()).toBeUndefined(); }
    finally { await denied.stopAll(); }
    const absent = setup({ [base.id]: module }).platform;
    await absent.install(await absent.sideload(await archive(toolManifest)), ['model.read', 'tool.interaction']);
    try {
      await expect(absent.invoke(base.id, toolId)).rejects.toMatchObject({ code: 'unavailable' });
      await expect(absent.invoke(base.id, toolId, {}, { document: 'model-A' })).rejects.toMatchObject({ code: 'unavailable' });
    } finally { await absent.stopAll(); }
  });
  it('document close and viewport cancellation invalidate late responses and only their own document', async () => {
    const v = viewport(); let context!: ToolContext;
    const module = { activate(c: ToolContext) { context = c; c.commands.register(toolId, params => (params as { tool: ToolInput }).tool); } };
    const { platform } = setup({ [base.id]: module }, { tools: v.adapter });
    await platform.install(await platform.sideload(await archive(toolManifest)), ['model.read', 'tool.interaction']);
    try {
      const first = await platform.invoke(base.id, toolId, {}, { document: 'model-A' }) as ToolInput;
      platform.closeDocument('model-B'); expect(v.stopped).toEqual([]);
      platform.closeDocument('model-A'); expect(v.stopped).toEqual(['document.closed']);
      await expect(context.tools.present({ session: first.session, sequence: 0, view: { instructor: 'Too late' } })).rejects.toMatchObject({ code: 'cancelled' });
      const second = await platform.invoke(base.id, toolId, {}, { document: 'model-B' }) as ToolInput;
      expect(second.session).not.toBe(first.session);
      v.request().ended('cancelled'); expect(v.stopped).toEqual(['document.closed', 'cancelled']);
      await expect(context.tools.ack({ session: second.session, sequence: 0 })).rejects.toMatchObject({ code: 'cancelled' });
    } finally { await platform.stopAll(); }
  });
});
