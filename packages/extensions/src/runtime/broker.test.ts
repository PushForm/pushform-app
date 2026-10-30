// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExtensionError, extensionManifestSchema, type ExtensionManifest } from '@pushform/extension-protocol';
import { startGuest, type ExtensionContext } from './guest';
import { ExtensionSession, type ServiceImplementations, type SessionFailure, type SessionLimits } from './host';
import { messagePortTransport } from './port';

const manifest: ExtensionManifest = extensionManifestSchema.parse({
  id: 'com.example.parts', name: 'Parts', publisher: 'Example', version: '1.0.0', apiVersion: '^0.1.0',
  editors: ['modeling'], defaultLocale: 'en', license: 'MIT', files: {}, permissions: ['model.read'],
  contributions: [{ target: 'model.command', id: 'com.example.parts.run', name: 'Run' }],
});

type Model = { read(input?: unknown, options?: { signal?: AbortSignal }): Promise<unknown> };
const channels: MessageChannel[] = [];
afterEach(() => { for (const c of channels.splice(0)) { c.port1.close(); c.port2.close(); } });

function connect(module: unknown, services: ServiceImplementations = {}, limits: Partial<SessionLimits> = {}) {
  const channel = new MessageChannel();
  channels.push(channel);
  const failures: SessionFailure[] = [];
  const session = new ExtensionSession({ manifest, grants: ['model.read'], port: messagePortTransport(channel.port1), services, limits,
    onFailure: (f) => failures.push(f) });
  void startGuest(messagePortTransport(channel.port2), async () => module);
  /** Posts from the runtime's end directly, as a compromised runtime would, bypassing its `context`. */
  const raw = (message: unknown) => channel.port2.postMessage(message);
  return { session, failures, raw };
}

const failureOf = async (promise: Promise<unknown>): Promise<ExtensionError> => {
  try { await promise; } catch (error) { if (error instanceof ExtensionError) return error; throw error; }
  throw new Error('expected an ExtensionError');
};

describe('message size', () => {
  it('answers an oversized request with limit.exceeded before the service sees it', async () => {
    const read = vi.fn();
    let error: unknown;
    const { session } = connect({ async activate(context: ExtensionContext) {
      error = await (context.model as Model).read({ blob: 'x'.repeat(3 * 1024 * 1024) }).catch((e: unknown) => e);
    } }, { 'model.read': read });
    await session.activate();
    expect(error).toMatchObject({ code: 'limit.exceeded' });
    expect(read).not.toHaveBeenCalled();
    expect(session.invalidMessages).toBe(1);
  });

  it('fails an invocation whose result is too large', async () => {
    const { session } = connect({ activate(context: ExtensionContext) {
      context.commands.register('com.example.parts.run', () => new Uint8Array(5 * 1024 * 1024));
    } });
    expect((await failureOf(session.invoke('com.example.parts.run', {}))).code).toBe('limit.exceeded');
  });

  it('treats too deep a message as oversized', async () => {
    const read = vi.fn();
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) deep = { deep };
    let error: unknown;
    const { session } = connect({ async activate(context: ExtensionContext) {
      error = await (context.model as Model).read(deep).catch((e: unknown) => e);
    } }, { 'model.read': read });
    await session.activate();
    expect(error).toMatchObject({ code: 'limit.exceeded' });
    expect(read).not.toHaveBeenCalled();
  });
});

describe('request limits', () => {
  it('refuses host calls beyond the pending limit and serves them again once others finish', async () => {
    const release: (() => void)[] = [];
    const outcomes: string[] = [];
    const { session } = connect({ activate(context: ExtensionContext) {
      context.commands.register('com.example.parts.run', async () => {
        const model = context.model as Model;
        const calls = Array.from({ length: 4 }, () => model.read({}).then(() => 'ok', (e: ExtensionError) => e.code));
        await vi.waitFor(() => expect(release.length).toBe(3));
        release.splice(0).forEach((r) => r());
        outcomes.push(...await Promise.all(calls));
        outcomes.push(await model.read({}).then(() => 'ok', (e: ExtensionError) => e.code));
      });
    } }, { 'model.read': () => new Promise<void>((resolve) => release.push(resolve)) }, { maxPendingRequests: 3 });
    const run = session.invoke('com.example.parts.run', {});
    await vi.waitFor(() => expect(outcomes.length).toBe(4));
    expect(outcomes.sort()).toEqual(['limit.exceeded', 'ok', 'ok', 'ok']);
    release.splice(0).forEach((r) => r());
    await run;
    expect(outcomes.at(-1)).toBe('ok');
  });

  it('refuses a request id that is already running', async () => {
    const read = vi.fn(() => new Promise(() => {}));
    const { session, raw } = connect({ activate() {} }, { 'model.read': read });
    await session.activate();
    raw({ type: 'request', id: 77, service: 'model', method: 'read', input: {} });
    raw({ type: 'request', id: 77, service: 'model', method: 'read', input: {} });
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('fails the session after repeated invalid messages, so the runtime can be ended', async () => {
    const { session, failures, raw } = connect({ activate() {} }, {}, { maxInvalidMessages: 5 });
    await session.activate();
    for (let i = 0; i < 8; i++) raw({ type: 'request', id: 'not a number' });
    await vi.waitFor(() => expect(failures).toMatchObject([{ kind: 'protocol-violation' }]));
    expect(session.state).toBe('failed');
  });
});

describe('document handles', () => {
  it('gives the runtime an opaque handle, resolves only handles it issued, and keeps them per session', async () => {
    const seen: { handle?: string | undefined; spoof?: string; resolved?: unknown } = {};
    const read = vi.fn((input: unknown, call: { document(handle: unknown): string }) => ({ document: call.document((input as { document: unknown }).document) }));
    const extension = { activate(context: ExtensionContext) {
      context.commands.register('com.example.parts.run', async (_params, { document }) => {
        const model = context.model as Model;
        seen.handle = document;
        seen.resolved = await model.read({ document });
        seen.spoof = await model.read({ document: 'doc-a' }).then(() => 'resolved', (e: ExtensionError) => e.code);
      });
    } };
    const { session } = connect(extension, { 'model.read': read });
    await session.invoke('com.example.parts.run', {}, { document: 'doc-a' });
    expect(seen.handle).toMatch(/^doc_[0-9a-f]{32}$/);
    expect(seen.handle).not.toContain('doc-a');
    expect(seen.resolved).toEqual({ document: 'doc-a' });
    expect(seen.spoof).toBe('permission.denied');
    const other = connect(extension, { 'model.read': read }).session;
    await other.invoke('com.example.parts.run', {}, { document: 'doc-a' });
    expect(other.openDocument('doc-a')).not.toBe(session.openDocument('doc-a'));
  });

  it('keeps an invocation on its own document, and cancels it and revokes the handle when that document closes', async () => {
    let handle: string | undefined;
    let later: string | undefined;
    const { session } = connect({ activate(context: ExtensionContext) {
      context.commands.register('com.example.parts.run', (_p, { document }) => { handle = document; return new Promise(() => {}); });
    } }, { 'model.read': (input, call) => call.document((input as { document: unknown }).document) });
    const running = session.invoke('com.example.parts.run', {}, { document: 'doc-a' });
    await vi.waitFor(() => expect(handle).toBeDefined());
    session.openDocument('doc-b'); // the user switched to another document
    expect((session as unknown as { resolveDocument(h: unknown): string }).resolveDocument(handle)).toBe('doc-a');
    session.closeDocument('doc-a');
    expect((await failureOf(running)).code).toBe('cancelled');
    try { (session as unknown as { resolveDocument(h: unknown): string }).resolveDocument(handle); } catch (e) { later = (e as ExtensionError).code; }
    expect(later).toBe('permission.denied');
  });
});

describe('generations', () => {
  it('numbers sessions and ignores the old runtime once its session stopped', async () => {
    const read = vi.fn();
    const first = connect({ activate() {} }, { 'model.read': read });
    const second = connect({ activate() {} }, { 'model.read': read });
    expect(second.session.generation).toBeGreaterThan(first.session.generation);
    await first.session.activate();
    await first.session.deactivate('update');
    first.raw({ type: 'request', id: 1, service: 'model', method: 'read', input: {} });
    await new Promise((r) => setTimeout(r, 20));
    expect(read).not.toHaveBeenCalled();
    expect(first.session.invalidMessages).toBe(0);
  });
});
