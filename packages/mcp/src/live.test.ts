// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AGENT_BRIDGE_CLOSE, AGENT_BRIDGE_TOOLS, AGENT_BRIDGE_VERSION, MODEL_TOOLS, type AgentBridgeServerMessage } from '@pushform/extension-protocol';
import { LiveBridge, STATUS_TOOL, createLiveMcpServer, liveInstructions, normalizeCode, pairingCode } from './live';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function bridge(options: { callTimeoutMs?: number } = {}) {
  const live = new LiveBridge({ port: 0, code: 'K7QM-4XRT', ...options });
  await live.start();
  const server = createLiveMcpServer(live);
  const client = new Client({ name: 'test', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
    await live.close();
  });
  return { live, client };
}

interface FakeApp {
  socket: WebSocket;
  /** Messages the server sent, in order. */
  messages: AgentBridgeServerMessage[];
  closed: Promise<number>;
  next(): Promise<AgentBridgeServerMessage>;
}

/** A PushForm window: connects and says hello with the given code. */
async function app(live: LiveBridge, code: string, document: { name: string; revision: number } | null = { name: 'Shed.pf', revision: 3 }): Promise<FakeApp> {
  const socket = new WebSocket(`ws://127.0.0.1:${live.port}`);
  const messages: AgentBridgeServerMessage[] = [];
  const waiting: ((m: AgentBridgeServerMessage) => void)[] = [];
  socket.on('message', (data) => {
    const message = JSON.parse(String(data)) as AgentBridgeServerMessage;
    messages.push(message);
    waiting.shift()?.(message);
  });
  const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)));
  await new Promise((resolve) => socket.once('open', resolve));
  socket.send(JSON.stringify({ type: 'hello', version: AGENT_BRIDGE_VERSION, code, app: 'PushForm test', document }));
  cleanups.push(() => socket.terminate());
  let read = 0;
  const next = () => (read < messages.length ? Promise.resolve(messages[read++]!) : new Promise<AgentBridgeServerMessage>((resolve) => waiting.push((m) => { read++; resolve(m); })));
  return { socket, messages, closed, next };
}

type Result = { content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean };
const status = async (client: Client) => JSON.parse(((await client.callTool({ name: STATUS_TOOL, arguments: {} })) as Result).content[0]!.text!);

describe('pairing codes', () => {
  it('are two groups of four unambiguous characters, compared without case or dashes', () => {
    const code = pairingCode();
    expect(code).toMatch(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
    expect(normalizeCode('k7qm 4xrt')).toBe(normalizeCode('K7QM-4XRT'));
  });
});

describe('live MCP server', () => {
  it('lists the status tool and the model document API with object schemas, and carries the model rules', async () => {
    const { client } = await bridge();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([STATUS_TOOL, ...AGENT_BRIDGE_TOOLS.map((t) => t.name)]);
    for (const t of tools) expect(t.inputSchema.type).toBe('object');
    expect(tools.find((t) => t.name === MODEL_TOOLS.applyOperations.name)!.inputSchema.properties).toHaveProperty('operations');
    expect(client.getInstructions()).toBe(liveInstructions());
    expect(liveInstructions()).toContain('model_apply_operations');
  });

  it('tells the agent how to connect while no window is paired', async () => {
    const { client, live } = await bridge();
    const s = await status(client);
    expect(s).toMatchObject({ connected: false, port: live.port, code: 'K7QM-4XRT' });
    expect(s.howToConnect).toContain('K7QM-4XRT');
    const res = (await client.callTool({ name: MODEL_TOOLS.getDocument.name, arguments: {} })) as Result;
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('No PushForm window is connected');
  });

  it('refuses a window with the wrong pairing code', async () => {
    const { client, live } = await bridge();
    const window = await app(live, 'WRONG-CODE');
    expect(await window.closed).toBe(AGENT_BRIDGE_CLOSE.badCode);
    expect((await status(client)).connected).toBe(false);
  });

  it('runs model tools in the paired window, with its notice and pictures', async () => {
    const { client, live } = await bridge();
    const window = await app(live, 'k7qm4xrt');
    expect(await window.next()).toMatchObject({ type: 'welcome', version: AGENT_BRIDGE_VERSION });
    expect(await status(client)).toMatchObject({ connected: true, app: 'PushForm test', document: { name: 'Shed.pf', revision: 3 } });

    const answering = (async () => {
      for (;;) {
        const call = await window.next();
        if (call.type !== 'call') continue;
        if (call.name === MODEL_TOOLS.render.name)
          window.socket.send(JSON.stringify({ type: 'result', id: call.id, content: '{"views":[{"name":"iso"}]}', isError: false, images: [{ mime: 'image/jpeg', data: 'AAAA' }] }));
        else
          window.socket.send(JSON.stringify({ type: 'result', id: call.id, content: JSON.stringify({ echo: call.input }), isError: false, notice: 'Changed the document: Add a box. Undo reverts it.' }));
      }
    })();
    void answering;

    const input = { expectedRevision: 3, label: 'Add a box', operations: [{ op: 'add_box', min: [0, 0, 0], max: [1, 1, 1] }] };
    const applied = (await client.callTool({ name: MODEL_TOOLS.applyOperations.name, arguments: input })) as Result;
    expect(applied.isError).toBeFalsy();
    expect(JSON.parse(applied.content[0]!.text!)).toEqual({ echo: input });
    expect(applied.content[1]!.text).toContain('Undo reverts it');

    const render = (await client.callTool({ name: MODEL_TOOLS.render.name, arguments: {} })) as Result;
    expect(render.content[1]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/jpeg' });
  });

  it('follows the document the window brings forward', async () => {
    const { client, live } = await bridge();
    const window = await app(live, 'K7QM-4XRT');
    await window.next();
    const changed = new Promise<void>((resolve) => { const off = live.onChange(() => { off(); resolve(); }); });
    window.socket.send(JSON.stringify({ type: 'document', document: null }));
    await changed;
    expect((await status(client)).document).toBeNull();
  });

  it('fails a call in flight when the window leaves, and a later window takes over', async () => {
    const { client, live } = await bridge();
    const first = await app(live, 'K7QM-4XRT');
    await first.next();
    const call = client.callTool({ name: MODEL_TOOLS.getDocument.name, arguments: {} }) as Promise<Result>;
    expect((await first.next()).type).toBe('call');
    const second = await app(live, 'K7QM-4XRT', { name: 'Desk.pf', revision: 1 });
    expect(await first.closed).toBe(AGENT_BRIDGE_CLOSE.replaced);
    const res = await call;
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('Another PushForm window');
    await second.next();
    expect(await status(client)).toMatchObject({ connected: true, document: { name: 'Desk.pf' } });
    second.socket.close();
    await second.closed;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await status(client)).connected).toBe(false);
  });

  it('times out a call the window never answers', async () => {
    const { client, live } = await bridge({ callTimeoutMs: 50 });
    const window = await app(live, 'K7QM-4XRT');
    await window.next();
    const res = (await client.callTool({ name: MODEL_TOOLS.query.name, arguments: {} })) as Result;
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('did not answer');
  });

  it('closes a connection that does not start with hello', async () => {
    const { live } = await bridge();
    const socket = new WebSocket(`ws://127.0.0.1:${live.port}`);
    cleanups.push(() => socket.terminate());
    const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)));
    await new Promise((resolve) => socket.once('open', resolve));
    socket.send(JSON.stringify({ type: 'result', id: 1, content: '', isError: false }));
    expect(await closed).toBe(AGENT_BRIDGE_CLOSE.protocol);
  });
});
