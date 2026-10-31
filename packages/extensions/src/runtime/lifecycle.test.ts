// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExtensionError, extensionManifestSchema, type ExtensionManifest, type ExtensionPermission } from '@pushform/extension-protocol';
import { startGuest, type ExtensionContext } from './guest';
import { ExtensionSession, type ServiceImplementations, type SessionFailure } from './host';
import { messagePortTransport, type RuntimePort } from './port';

const manifest = (overrides: Record<string, unknown> = {}): ExtensionManifest => extensionManifestSchema.parse({
  id: 'com.example.stairs', name: 'Stairs', publisher: 'Example', version: '1.0.0', apiVersion: '^0.1.0',
  editors: ['modeling'], defaultLocale: 'en', license: 'MIT', files: {},
  permissions: ['model.read', 'model.write', 'selection.read'],
  contributions: [
    { target: 'model.command', id: 'com.example.stairs.generate', name: 'Generate' },
    { target: 'model.panel', id: 'com.example.stairs.panel', name: 'Stairs' },
  ],
  ...overrides,
});

const channels: MessageChannel[] = [];
afterEach(() => { for (const c of channels.splice(0)) { c.port1.close(); c.port2.close(); } vi.useRealTimers(); });

interface Setup {
  session: ExtensionSession;
  hostPort: RuntimePort;
  failures: SessionFailure[];
}

/** A session and a guest connected by a MessageChannel, with `module` as the extension's entry module. */
function connect(module: unknown, options: { grants?: ExtensionPermission[]; services?: ServiceImplementations;
  manifest?: ExtensionManifest; limits?: Record<string, number> } = {}): Setup {
  const channel = new MessageChannel();
  channels.push(channel);
  const hostPort = messagePortTransport(channel.port1);
  const failures: SessionFailure[] = [];
  const session = new ExtensionSession({
    manifest: options.manifest ?? manifest(), grants: options.grants ?? ['model.read', 'model.write'], port: hostPort,
    services: options.services ?? {}, limits: options.limits ?? {}, onFailure: (f) => failures.push(f),
  });
  void startGuest(messagePortTransport(channel.port2), async () => module);
  return { session, hostPort, failures };
}

const failureOf = async (promise: Promise<unknown>): Promise<ExtensionError> => {
  try { await promise; } catch (error) { if (error instanceof ExtensionError) return error; throw error; }
  throw new Error('expected an ExtensionError');
};

describe('activation', () => {
  it('loads the entry module but does not activate it until the first invocation', async () => {
    const activate = vi.fn((context: ExtensionContext) => {
      context.commands.register('com.example.stairs.generate', (params) => ({ steps: (params as { n: number }).n }));
    });
    const { session } = connect({ activate });
    await vi.waitFor(() => expect(session.state).toBe('loaded'));
    expect(activate).not.toHaveBeenCalled();
    await expect(session.invoke('com.example.stairs.generate', { n: 12 })).resolves.toEqual({ steps: 12 });
    expect(activate).toHaveBeenCalledTimes(1);
    expect(session.state).toBe('active');
    await session.invoke('com.example.stairs.generate', { n: 3 });
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it('reports an entry module without activate as a load failure', async () => {
    const { session, failures } = connect({ start() {} });
    expect((await failureOf(session.invoke('com.example.stairs.generate', {}))).code).toBe('validation.failed');
    expect(failures).toMatchObject([{ kind: 'load-failed' }]);
    expect(session.state).toBe('failed');
  });

  it('fails when activate throws, with the extension message but no stack', async () => {
    const { session, failures } = connect({ activate() { throw new Error('no license key'); } });
    const error = await failureOf(session.invoke('com.example.stairs.generate', {}));
    expect(error).toMatchObject({ code: 'extension.failed', message: 'no license key' });
    expect(failures[0]?.error).toEqual({ code: 'extension.failed', message: 'no license key' });
  });

  it('times out an activate that never settles', async () => {
    const { session, failures } = connect({ activate: () => new Promise(() => {}) }, { limits: { activateMs: 50 } });
    expect((await failureOf(session.invoke('com.example.stairs.generate', {}))).code).toBe('extension.failed');
    expect(failures).toMatchObject([{ kind: 'activation-timeout' }]);
  });

  it('refuses invocations of ids the manifest does not declare, and handlers registered for them', async () => {
    let registerError: unknown;
    const { session } = connect({ activate(context: ExtensionContext) {
      try { context.commands.register('com.example.other.run', () => {}); } catch (e) { registerError = e; }
    } });
    expect((await failureOf(session.invoke('com.example.stairs.unknown', {}))).code).toBe('validation.failed');
    expect((await failureOf(session.invoke('com.example.stairs.generate', {}))).code).toBe('unavailable');
    expect(registerError).toMatchObject({ code: 'validation.failed' });
  });
});

describe('context', () => {
  it('holds only granted services and names the missing permission otherwise', async () => {
    let seen: { keys: string[]; selection?: unknown; clipboard?: unknown; compute?: unknown } = { keys: [] };
    const { session } = connect({ activate(context: ExtensionContext) {
      seen = { keys: Object.keys(context).sort() };
      for (const name of ['selection', 'clipboard', 'compute'] as const)
        try { void context[name]; } catch (e) { seen[name] = e; }
    } }, { grants: ['model.read'] });
    await session.activate();
    expect(seen.keys).toEqual(['commands', 'extensionId', 'log', 'model', 'signal', 'ui']);
    expect(seen.selection).toMatchObject({ code: 'permission.denied', details: { permissions: ['selection.read', 'selection.write', 'viewport.presentation'] } });
    expect(seen.clipboard).toMatchObject({ code: 'permission.denied' });
    expect(seen.compute).toMatchObject({ code: 'unavailable' });
  });

  it('rejects an ungranted method on a granted service without asking the host', async () => {
    const apply = vi.fn();
    let error: unknown;
    const { session } = connect({ async activate(context: ExtensionContext) {
      error = await (context.model as { apply(input: unknown): Promise<unknown> }).apply({}).catch((e: unknown) => e);
    } }, { grants: ['model.read'], services: { 'model.apply': apply } });
    await session.activate();
    expect(error).toMatchObject({ code: 'permission.denied', details: { permission: 'model.write' } });
    expect(apply).not.toHaveBeenCalled();
  });

  it('calls host services asynchronously and returns structured data', async () => {
    const query = vi.fn(async (input: unknown, _call: { extensionId: string }) => ({ echoed: input, parts: [1, 2] }));
    const { session } = connect({ activate(context: ExtensionContext) {
      context.commands.register('com.example.stairs.generate', () =>
        (context.model as { query(input: unknown): Promise<unknown> }).query({ kind: 'instances' }));
    } }, { services: { 'model.query': query } });
    await expect(session.invoke('com.example.stairs.generate', {})).resolves.toEqual({ echoed: { kind: 'instances' }, parts: [1, 2] });
    expect(query.mock.calls[0]?.[1]).toMatchObject({ extensionId: 'com.example.stairs' });
  });

  it('turns host failures into structured errors without leaking internals', async () => {
    const { session } = connect({ activate(context: ExtensionContext) {
      context.commands.register('com.example.stairs.generate', async () => {
        const model = context.model as { read(): Promise<unknown>; query(): Promise<unknown> };
        const stale = await model.read().catch((e: ExtensionError) => e.toJSON());
        const internal = await model.query().catch((e: ExtensionError) => e.toJSON());
        return { stale, internal };
      });
    } }, { services: {
      'model.read': () => { throw new ExtensionError('revision.stale', 'The document changed.'); },
      'model.query': () => { throw new TypeError('Cannot read properties of undefined (reading kernel)'); },
    } });
    await expect(session.invoke('com.example.stairs.generate', {})).resolves.toEqual({
      stale: { code: 'revision.stale', message: 'The document changed.' },
      internal: { code: 'unavailable', message: 'The host could not complete the request.' },
    });
  });
});

describe('host checks', () => {
  it('re-checks permissions on every request, whatever the runtime sends', async () => {
    const apply = vi.fn();
    const { session } = connect({ activate() {} }, { grants: ['model.read'], services: { 'model.apply': apply } });
    await session.activate();
    // Bypass the guest's own context and post from the runtime's end directly, as a compromised runtime would.
    const raw = (channels.at(-1)!).port2;
    raw.postMessage({ type: 'request', id: 900, service: 'model', method: 'apply', input: {} });
    raw.postMessage({ type: 'request', id: 901, service: 'kernel', method: 'eval', input: 'x' });
    raw.postMessage({ type: 'mystery', payload: 1 });
    await vi.waitFor(() => expect(session.invalidMessages).toBe(1));
    expect(apply).not.toHaveBeenCalled();
  });

  it('answers unavailable for a granted method the host does not implement', async () => {
    let error: unknown;
    const { session } = connect({ async activate(context: ExtensionContext) {
      error = await (context.model as { subscribe(): Promise<unknown> }).subscribe().catch((e: unknown) => e);
    } });
    await session.activate();
    expect(error).toMatchObject({ code: 'unavailable' });
  });
});

describe('cancellation', () => {
  const slowExtension = (seenAbort: { count: number }) => ({
    activate(context: ExtensionContext) {
      context.commands.register('com.example.stairs.panel', (_params, { signal }) => new Promise((resolve) => {
        signal.addEventListener('abort', () => { seenAbort.count++; setTimeout(() => resolve('late result'), 5); });
      }));
    },
  });

  it('cancels on the caller signal, aborts the handler and drops its late result', async () => {
    const seen = { count: 0 };
    const { session } = connect(slowExtension(seen));
    const controller = new AbortController();
    const running = session.invoke('com.example.stairs.panel', {}, { signal: controller.signal });
    await vi.waitFor(() => expect(session.state).toBe('active'));
    controller.abort();
    expect((await failureOf(running)).code).toBe('cancelled');
    await vi.waitFor(() => expect(seen.count).toBe(1));
  });

  it('cancels everything in a scope when its panel or document closes, and nothing else', async () => {
    const seen = { count: 0 };
    const { session } = connect(slowExtension(seen));
    const inPanel = session.invoke('com.example.stairs.panel', {}, { scopes: ['panel:p1', 'document:d1'] });
    const other = session.invoke('com.example.stairs.panel', {}, { scopes: ['document:d2'] });
    await vi.waitFor(() => expect(session.state).toBe('active'));
    await new Promise((r) => setTimeout(r, 10));
    session.cancelScope('document:d1');
    expect((await failureOf(inPanel)).code).toBe('cancelled');
    await vi.waitFor(() => expect(seen.count).toBe(1));
    session.cancelScope('document:d2');
    expect((await failureOf(other)).code).toBe('cancelled');
  });

  it('aborts service calls in flight when the invocation is cancelled', async () => {
    let hostSignal: AbortSignal | undefined;
    const { session } = connect({ activate(context: ExtensionContext) {
      context.commands.register('com.example.stairs.generate', (_p, { signal }) =>
        (context.model as { query(input: unknown, o: { signal: AbortSignal }): Promise<unknown> }).query({}, { signal }));
    } }, { services: { 'model.query': (_input, { signal }) => { hostSignal = signal; return new Promise(() => {}); } } });
    const controller = new AbortController();
    const running = session.invoke('com.example.stairs.generate', {}, { signal: controller.signal });
    await vi.waitFor(() => expect(hostSignal).toBeDefined());
    controller.abort();
    expect((await failureOf(running)).code).toBe('cancelled');
    await vi.waitFor(() => expect(hostSignal?.aborted).toBe(true));
  });
});

describe('deactivation', () => {
  it('aborts the context signal, runs deactivate and refuses further work', async () => {
    const order: string[] = [];
    const { session } = connect({
      activate(context: ExtensionContext) { context.signal.addEventListener('abort', () => order.push('signal')); },
      deactivate() { order.push('deactivate'); },
    });
    await session.activate();
    await expect(session.deactivate('disable')).resolves.toBe(true);
    expect(order).toEqual(['signal', 'deactivate']);
    expect(session.state).toBe('stopped');
    expect((await failureOf(session.invoke('com.example.stairs.generate', {}))).code).toBe('unavailable');
  });

  it('cancels running invocations on update and reports an unresponsive deactivate', async () => {
    const { session } = connect({
      activate(context: ExtensionContext) { context.commands.register('com.example.stairs.panel', () => new Promise(() => {})); },
      deactivate: () => new Promise(() => {}),
    }, { limits: { deactivateMs: 30 } });
    const running = session.invoke('com.example.stairs.panel', {});
    await vi.waitFor(() => expect(session.state).toBe('active'));
    const outcome = failureOf(running);
    await expect(session.deactivate('update')).resolves.toBe(false);
    expect((await outcome).code).toBe('cancelled');
  });

  it('never activates an extension that is deactivated before its first use', async () => {
    const activate = vi.fn();
    const { session } = connect({ activate });
    await vi.waitFor(() => expect(session.state).toBe('loaded'));
    await expect(session.deactivate('disable')).resolves.toBe(true);
    expect(activate).not.toHaveBeenCalled();
  });
});

describe('heartbeat', () => {
  it('keeps an extension that answers active across many beats', async () => {
    const { session, failures } = connect({ activate() {} }, { limits: { heartbeatMs: 10, unresponsiveMs: 60 } });
    await session.activate();
    await new Promise((r) => setTimeout(r, 200));
    expect(session.state).toBe('active');
    expect(failures).toEqual([]);
    await session.deactivate('disable');
  });

  it('fails a runtime that stops answering, as one that ran out of memory does, and cancels its work', async () => {
    // A runtime that activates and then never answers again: the guest's port is closed after activation.
    const channel = new MessageChannel();
    channels.push(channel);
    const failures: SessionFailure[] = [];
    const session = new ExtensionSession({ manifest: manifest(), grants: [], port: messagePortTransport(channel.port1),
      limits: { heartbeatMs: 10, unresponsiveMs: 50 }, onFailure: (f) => failures.push(f) });
    channel.port2.onmessage = (e) => {
      const message = e.data as { type: string; invocation?: number };
      if (message.type === 'activate') channel.port2.postMessage({ type: 'activated' });
    };
    channel.port2.postMessage({ type: 'ready', v: 1 });
    await session.activate();
    const running = failureOf(session.invoke('com.example.stairs.generate', {}));
    await vi.waitFor(() => expect(failures).toMatchObject([{ kind: 'unresponsive' }]), { timeout: 2000 });
    expect(session.state).toBe('failed');
    expect((await running).code).toBe('cancelled');
  });
});

