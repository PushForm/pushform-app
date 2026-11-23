// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { randomInt, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  AGENT_BRIDGE_CLOSE, AGENT_BRIDGE_DEFAULT_PORT, AGENT_BRIDGE_TOOLS, AGENT_BRIDGE_TOOL_NAMES, AGENT_BRIDGE_VERSION,
  agentBridgeAppMessageSchema, type AgentBridgeAppMessage, type AgentBridgeDocument, type AgentBridgeServerMessage,
} from '@pushform/extension-protocol';
// Only the document rules module: the package root also holds the AI Chat backend.
import { MODEL_DOCUMENT_RULES } from '@pushform/requests-core/document-rules';
import { SERVER_NAME, SERVER_VERSION } from './server';
import { objectSchema } from './tools';

/** Letters and digits that cannot be misread for one another (no 0/O, 1/I/L). */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** A fresh pairing code, such as `K7QM-4XRT`: 40 bits, typed once into the app. */
export function pairingCode(): string {
  let code = '';
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Codes compare without case, spaces or dashes, so `k7qm 4xrt` pairs with `K7QM-4XRT`. */
export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, '');
}

function sameCode(a: string, b: string): boolean {
  const x = Buffer.from(normalizeCode(a)), y = Buffer.from(normalizeCode(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** How long a new connection has to say `hello`, and how long a call may run before the agent is told it timed out. */
export const HELLO_TIMEOUT_MS = 10_000;
export const CALL_TIMEOUT_MS = 180_000;
/** A render result carries up to three pictures of about 1.5 MB each. */
const MAX_PAYLOAD = 16 * 1024 * 1024;

export interface LiveBridgeOptions {
  port?: number | undefined;
  /** The pairing code; a fresh one by default. */
  code?: string | undefined;
  host?: string | undefined;
  callTimeoutMs?: number | undefined;
  log?: ((line: string) => void) | undefined;
}

export interface LiveBridgeStatus {
  port: number;
  code: string;
  connected: boolean;
  app: string | null;
  document: AgentBridgeDocument;
}

/** The result of a call the app ran. */
export type LiveCallResult = Extract<AgentBridgeAppMessage, { type: 'result' }>;

export class LiveBridgeUnavailable extends Error {}

/**
 * The server end of the live bridge: a loopback WebSocket that one paired PushForm window at a time connects to.
 * A window that pairs later takes over; calls in flight on the window it replaced fail.
 */
export class LiveBridge {
  readonly code: string;
  private readonly host: string;
  private readonly callTimeoutMs: number;
  private readonly log: (line: string) => void;
  private wss: WebSocketServer | null = null;
  private boundPort: number;
  private app: { socket: WebSocket; name: string; document: AgentBridgeDocument } | null = null;
  private readonly pending = new Map<number, { resolve(result: LiveCallResult): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private nextId = 1;
  private readonly listeners = new Set<() => void>();

  constructor(options: LiveBridgeOptions = {}) {
    this.code = options.code ?? pairingCode();
    this.host = options.host ?? '127.0.0.1';
    this.boundPort = options.port ?? AGENT_BRIDGE_DEFAULT_PORT;
    this.callTimeoutMs = options.callTimeoutMs ?? CALL_TIMEOUT_MS;
    this.log = options.log ?? (() => {});
  }

  get port(): number { return this.boundPort; }

  /** Listen; resolves with the bound port (useful with port 0), rejects when the port is taken. */
  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: this.host, port: this.boundPort, maxPayload: MAX_PAYLOAD });
      wss.once('error', reject);
      wss.once('listening', () => {
        wss.off('error', reject);
        wss.on('error', (e) => this.log(`bridge error: ${e.message}`));
        const address = wss.address();
        if (typeof address === 'object' && address) this.boundPort = address.port;
        this.wss = wss;
        resolve(this.boundPort);
      });
      wss.on('connection', (socket) => this.accept(socket));
    });
  }

  status(): LiveBridgeStatus {
    return { port: this.boundPort, code: this.code, connected: !!this.app, app: this.app?.name ?? null, document: this.app?.document ?? null };
  }

  /** Called whenever an app pairs, leaves, or changes the document it has open. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Run one tool in the paired app. Rejects with LiveBridgeUnavailable when no app is paired or it leaves mid-call. */
  call(name: string, input: unknown): Promise<LiveCallResult> {
    const app = this.app;
    if (!app) return Promise.reject(new LiveBridgeUnavailable('No PushForm window is connected.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`PushForm did not answer ${name} within ${Math.round(this.callTimeoutMs / 1000)} s. It may still finish: read the model again before retrying.`));
      }, this.callTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send(app.socket, { type: 'call', id, name, input });
    });
  }

  close(): Promise<void> {
    this.dropApp(new LiveBridgeUnavailable('The bridge closed.'));
    const wss = this.wss;
    this.wss = null;
    if (!wss) return Promise.resolve();
    for (const client of wss.clients) client.terminate();
    return new Promise((resolve) => wss.close(() => resolve()));
  }

  private accept(socket: WebSocket): void {
    let paired = false;
    const hello = setTimeout(() => socket.close(AGENT_BRIDGE_CLOSE.protocol, 'No hello'), HELLO_TIMEOUT_MS);
    socket.on('message', (data, binary) => {
      let message: AgentBridgeAppMessage;
      try {
        if (binary) throw new Error('binary');
        const parsed = agentBridgeAppMessageSchema.safeParse(JSON.parse(String(data)));
        if (!parsed.success) throw new Error(parsed.error.message);
        message = parsed.data;
      } catch {
        socket.close(AGENT_BRIDGE_CLOSE.protocol, 'Malformed message');
        return;
      }
      if (!paired) {
        clearTimeout(hello);
        if (message.type !== 'hello') return socket.close(AGENT_BRIDGE_CLOSE.protocol, 'Expected hello');
        if (message.version !== AGENT_BRIDGE_VERSION) return socket.close(AGENT_BRIDGE_CLOSE.version, `This agent speaks bridge version ${AGENT_BRIDGE_VERSION}`);
        if (!sameCode(message.code, this.code)) {
          this.log('a PushForm window offered the wrong pairing code');
          // A short pause makes guessing codes slow.
          setTimeout(() => socket.close(AGENT_BRIDGE_CLOSE.badCode, 'Wrong pairing code'), 500);
          return;
        }
        paired = true;
        if (this.app) {
          const previous = this.app.socket;
          this.dropApp(new LiveBridgeUnavailable('Another PushForm window took over the connection.'));
          previous.close(AGENT_BRIDGE_CLOSE.replaced, 'Another PushForm window connected');
        }
        this.app = { socket, name: message.app, document: message.document };
        this.send(socket, { type: 'welcome', version: AGENT_BRIDGE_VERSION, agent: SERVER_NAME });
        this.log(`connected to ${message.app}${message.document ? ` (${message.document.name})` : ''}`);
        this.changed();
        return;
      }
      if (this.app?.socket !== socket) return;
      if (message.type === 'document') {
        this.app.document = message.document;
        this.changed();
      } else if (message.type === 'result') {
        const waiting = this.pending.get(message.id);
        if (!waiting) return;
        this.pending.delete(message.id);
        clearTimeout(waiting.timer);
        waiting.resolve(message);
      } else socket.close(AGENT_BRIDGE_CLOSE.protocol, 'Unexpected hello');
    });
    socket.on('close', () => {
      clearTimeout(hello);
      if (this.app?.socket === socket) {
        this.dropApp(new LiveBridgeUnavailable('The PushForm window disconnected.'));
        this.log('PushForm disconnected');
        this.changed();
      }
    });
    socket.on('error', () => {});
  }

  private dropApp(reason: Error): void {
    this.app = null;
    for (const [id, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(reason);
      this.pending.delete(id);
    }
  }

  private send(socket: WebSocket, message: AgentBridgeServerMessage): void {
    socket.send(JSON.stringify(message));
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}

export const STATUS_TOOL = 'pushform_status';

/** What a disconnected agent tells the requester, with the steps to pair. */
export function pairingSteps(status: LiveBridgeStatus): string {
  return `In PushForm, click "Connect agent" in the status bar at the bottom of a 3D model, enter port ${status.port} and pairing code ${status.code}, then click Connect.`;
}

/** The server's instructions: how this bridge works, then the rules PushForm's own AI Chat follows when it edits a model. */
export function liveInstructions(): string {
  return `This server edits the 3D model the user has open in a running PushForm window, so the user watches every change appear in their own viewport as you make it.
Call ${STATUS_TOOL} first. If no PushForm window is connected, give the user the pairing steps it returns and wait for them to connect; do not retry the model tools in a loop.
The model_* tools are the document API PushForm's in-app AI Chat uses. Each model_apply_operations batch is one undo entry labelled "External agent: <label>", so the user can undo your changes in the app. model_render draws pictures in the app's own viewport without moving the user's view.
In the rules below, "the requester" is the user you are working for.

${MODEL_DOCUMENT_RULES({} as never)}`;
}

function text(value: string): CallToolResult['content'][number] {
  return { type: 'text', text: value };
}

/** The MCP server over a live bridge: the model document API, run in the paired app, plus a status tool. */
export function createLiveMcpServer(bridge: LiveBridge): Server {
  const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} }, instructions: liveInstructions() });
  let queue: Promise<unknown> = Promise.resolve();

  server.setRequestHandler(ListToolsRequestSchema, () => {
    const tools: Tool[] = [{
      name: STATUS_TOOL,
      description: 'Whether a PushForm window is connected, which 3D model it has open, and how the user connects one (port and pairing code). Call it first, and again when a model tool says no window is connected.',
      inputSchema: { type: 'object', properties: {} },
    }];
    for (const tool of AGENT_BRIDGE_TOOLS) tools.push({ name: tool.name, description: tool.description, inputSchema: objectSchema(tool.schema) as Tool['inputSchema'] });
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const run = async (): Promise<CallToolResult> => {
      const { name, arguments: args = {} } = request.params;
      if (name === STATUS_TOOL) {
        const status = bridge.status();
        return { content: [text(JSON.stringify({ ...status, ...(status.connected ? {} : { howToConnect: pairingSteps(status) }) }))] };
      }
      if (!AGENT_BRIDGE_TOOL_NAMES.has(name)) return { content: [text(`Unknown tool: ${name}`)], isError: true };
      try {
        const result = await bridge.call(name, args);
        const content: CallToolResult['content'] = [text(result.content)];
        if (result.notice) content.push(text(result.notice));
        for (const image of result.images ?? []) content.push({ type: 'image', data: image.data, mimeType: image.mime });
        return { content, isError: result.isError };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const steps = error instanceof LiveBridgeUnavailable ? ` ${pairingSteps(bridge.status())}` : '';
        return { content: [text(`${message}${steps}`)], isError: true };
      }
    };
    const next = queue.then(run, run);
    queue = next;
    return next;
  });

  return server;
}
