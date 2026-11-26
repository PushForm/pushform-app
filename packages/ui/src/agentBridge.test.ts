// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_BRIDGE_CLIENT, AGENT_BRIDGE_CLOSE, AGENT_BRIDGE_VERSION, MODEL_TOOLS } from '@pushform/extension-protocol';

const run = vi.fn();
const documentToolsFor = vi.fn((..._args: unknown[]) => ({ document: { type: 'model', apiVersion: 1, edit: 1 }, run }));
vi.mock('./documentTools', () => ({ documentToolsFor: (...args: unknown[]) => documentToolsFor(...args) }));

const { AgentBridgeConnection, RECONNECT_MS } = await import('./agentBridge');
type Session = ConstructorParameters<typeof AgentBridgeConnection>[0];

/** A WebSocket the test drives: it records what the app sends and lets the test answer as the server. */
class FakeSocket {
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  close(): void { this.readyState = 3; }
  opened(): void { this.readyState = 1; this.onopen?.(); }
  receive(message: unknown): void { this.onmessage?.({ data: JSON.stringify(message) }); }
  closed(code: number): void { this.readyState = 3; this.onclose?.({ code }); }
}

function fakeSession(type: 'model' | 'layout' = 'model') {
  const listeners = new Set<() => void>();
  const tab = { id: 'tab-1', type, name: 'Shed.pf', app: { document: { doc: { version: 7 } } } };
  const session = {
    active: tab, activeId: tab.id,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
    notify: () => { for (const fn of listeners) fn(); },
  };
  return session;
}

function memoryStorage() {
  const items = new Map<string, string>();
  return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v), removeItem: (k: string) => void items.delete(k), items };
}

let sockets: FakeSocket[] = [];
const socket = (url: string) => { const s = new FakeSocket(url); sockets.push(s); return s as unknown as WebSocket; };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => { sockets = []; run.mockReset(); documentToolsFor.mockClear(); });
afterEach(() => { vi.useRealTimers(); });

describe('AgentBridgeConnection', () => {
  it('pairs with the code, then runs calls on the active model tab under its own undo name', async () => {
    const session = fakeSession();
    const storage = memoryStorage();
    const bridge = new AgentBridgeConnection(session as unknown as Session, { storage, socket });
    expect(bridge.getSnapshot()).toEqual({ status: 'off' });
    bridge.connect({ port: 47615, code: 'K7QM-4XRT' });
    expect(sockets[0]!.url).toBe('ws://127.0.0.1:47615');
    expect(bridge.getSnapshot().status).toBe('connecting');
    sockets[0]!.opened();
    expect(sockets[0]!.sent[0]).toEqual({ type: 'hello', version: AGENT_BRIDGE_VERSION, code: 'K7QM-4XRT', app: 'PushForm', document: { name: 'Shed.pf', revision: 7 } });
    sockets[0]!.receive({ type: 'welcome', version: AGENT_BRIDGE_VERSION, agent: 'pushform-mcp' });
    expect(bridge.getSnapshot()).toEqual({ status: 'connected', port: 47615, agent: 'pushform-mcp' });

    run.mockResolvedValue({ content: '{"ok":true}', isError: false, notice: 'Changed the document: Box. Undo reverts it.', images: [{ mime: 'image/jpeg', data: 'AAAA' }] });
    sockets[0]!.receive({ type: 'call', id: 4, name: MODEL_TOOLS.applyOperations.name, input: { label: 'Box' } });
    await flush();
    expect(documentToolsFor.mock.calls[0]![5]).toBe(AGENT_BRIDGE_CLIENT);
    expect(run).toHaveBeenCalledWith({ id: 'agent-4', name: MODEL_TOOLS.applyOperations.name, input: { label: 'Box' } });
    expect(sockets[0]!.sent[1]).toEqual({ type: 'result', id: 4, content: '{"ok":true}', isError: false, notice: 'Changed the document: Box. Undo reverts it.', images: [{ mime: 'image/jpeg', data: 'AAAA' }] });

    // The same tool session serves the next call, so names from one batch carry to the next.
    sockets[0]!.receive({ type: 'call', id: 5, name: MODEL_TOOLS.query.name, input: {} });
    await flush();
    expect(documentToolsFor).toHaveBeenCalledTimes(1);
    expect(storage.items.size).toBe(1);
    bridge.dispose();
  });

  it('refuses calls when the active tab is not a 3D model, and tools it does not offer', async () => {
    const session = fakeSession('layout');
    const bridge = new AgentBridgeConnection(session as unknown as Session, { storage: null, socket });
    bridge.connect({ port: 1, code: 'x' });
    sockets[0]!.opened();
    expect((sockets[0]!.sent[0] as { document: unknown }).document).toBeNull();
    sockets[0]!.receive({ type: 'welcome', version: 1, agent: 'a' });
    sockets[0]!.receive({ type: 'call', id: 1, name: MODEL_TOOLS.getDocument.name, input: {} });
    sockets[0]!.receive({ type: 'call', id: 2, name: 'file_delete_everything', input: {} });
    await flush();
    const results = sockets[0]!.sent.slice(1) as { id: number; isError: boolean; content: string }[];
    expect(results.map((r) => [r.id, r.isError])).toEqual([[1, true], [2, true]]);
    expect(results[0]!.content).toContain('not a 3D model');
    expect(run).not.toHaveBeenCalled();
    bridge.dispose();
  });

  it('tells the agent when another document comes forward', () => {
    const session = fakeSession();
    const bridge = new AgentBridgeConnection(session as unknown as Session, { storage: null, socket });
    bridge.connect({ port: 1, code: 'x' });
    sockets[0]!.opened();
    sockets[0]!.receive({ type: 'welcome', version: 1, agent: 'a' });
    session.notify(); // an edit alone: nothing to report
    expect(sockets[0]!.sent).toHaveLength(1);
    session.active = { ...session.active, id: 'tab-2', name: 'Desk.pf' };
    session.activeId = 'tab-2';
    session.notify();
    expect(sockets[0]!.sent[1]).toEqual({ type: 'document', document: { name: 'Desk.pf', revision: 7 } });
    bridge.dispose();
  });

  it('keeps retrying while the agent is not running, and stops on a wrong code', () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const bridge = new AgentBridgeConnection(fakeSession() as unknown as Session, { storage, socket });
    bridge.connect({ port: 1, code: 'x' });
    sockets[0]!.closed(1006);
    expect(bridge.getSnapshot().status).toBe('connecting');
    vi.advanceTimersByTime(RECONNECT_MS);
    expect(sockets).toHaveLength(2);
    sockets[1]!.closed(AGENT_BRIDGE_CLOSE.badCode);
    expect(bridge.getSnapshot()).toMatchObject({ status: 'off', error: expect.stringContaining('pairing code') });
    vi.advanceTimersByTime(RECONNECT_MS * 3);
    expect(sockets).toHaveLength(2);
    expect(storage.items.size).toBe(0);
    bridge.dispose();
  });

  it('reconnects by itself after a reload with the pairing it kept', () => {
    const storage = memoryStorage();
    new AgentBridgeConnection(fakeSession() as unknown as Session, { storage, socket }).connect({ port: 5000, code: 'K7QM-4XRT' });
    const reloaded = new AgentBridgeConnection(fakeSession() as unknown as Session, { storage, socket });
    expect(sockets.at(-1)!.url).toBe('ws://127.0.0.1:5000');
    expect(reloaded.lastSettings).toEqual({ port: 5000, code: 'K7QM-4XRT' });
    reloaded.disconnect();
    expect(reloaded.getSnapshot()).toEqual({ status: 'off', error: undefined });
  });
});
