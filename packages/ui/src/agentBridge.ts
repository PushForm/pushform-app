// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import {
  AGENT_BRIDGE_CLIENT, AGENT_BRIDGE_CLOSE, AGENT_BRIDGE_DEFAULT_PORT, AGENT_BRIDGE_TOOL_NAMES, AGENT_BRIDGE_VERSION,
  agentBridgeServerMessageSchema, type AgentBridgeAppMessage, type AgentBridgeDocument,
} from '@pushform/extension-protocol';
import type { DocumentToolSession } from '@pushform/requests-ui';
import { documentToolsFor } from './documentTools';
import type { DocumentSession, DocumentTab } from './session';

/**
 * The app end of the live agent bridge (see agentBridge.ts in @pushform/extension-protocol): connects to
 * `pushform-mcp --live` on this computer and runs the agent's model tool calls on the active model tab, through the
 * same document API AI Chat uses, so each change lands in the viewport as it is made. It needs no backend.
 */
export type AgentBridgeState =
  | { readonly status: 'off'; readonly error?: string | undefined }
  | { readonly status: 'connecting'; readonly port: number }
  | { readonly status: 'connected'; readonly port: number; readonly agent: string };

export interface AgentBridgeSettings { readonly port: number; readonly code: string }

/** Where the last pairing is kept, so a reload or a restarted agent with the same code reconnects by itself. */
const STORAGE_KEY = 'pushform:agent-bridge';
/** How often a dropped connection is retried while the bridge stays on. */
export const RECONNECT_MS = 3000;

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;
type SocketFactory = (url: string) => WebSocket;

export interface AgentBridgeOptions {
  readonly storage?: Storage | null;
  readonly socket?: SocketFactory;
  /** Names this window to the agent. */
  readonly app?: string;
}

function browserStorage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

const closeReason = (code: number): string | null =>
  code === AGENT_BRIDGE_CLOSE.badCode ? 'The pairing code does not match. Check the code the agent gave you.'
    : code === AGENT_BRIDGE_CLOSE.version ? 'The agent runs a different version of PushForm. Update pushform-mcp to match this app.'
      : code === AGENT_BRIDGE_CLOSE.replaced ? 'Another PushForm window connected to the agent.'
        : null;

export class AgentBridgeConnection {
  private state: AgentBridgeState = { status: 'off' };
  private readonly listeners = new Set<() => void>();
  private socket: WebSocket | null = null;
  private settings: AgentBridgeSettings | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  /** One tool session per tab for as long as the agent stays connected, so names from one batch carry to the next. */
  private tools = new WeakMap<DocumentTab, DocumentToolSession>();
  private sentDocument = '';
  private readonly unsubscribe: () => void;
  private readonly storage: Storage | null;
  private readonly open: SocketFactory;
  private readonly app: string;
  private disposed = false;

  constructor(private readonly session: DocumentSession, options: AgentBridgeOptions = {}) {
    this.storage = options.storage === undefined ? browserStorage() : options.storage;
    this.open = options.socket ?? ((url) => new WebSocket(url));
    this.app = options.app ?? 'PushForm';
    this.unsubscribe = session.subscribe(() => this.sendDocument());
    const saved = this.saved();
    if (saved) this.start(saved);
  }

  getSnapshot = (): AgentBridgeState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  /** The port and code last used, for the connect form. */
  get lastSettings(): AgentBridgeSettings { return this.settings ?? this.saved() ?? { port: AGENT_BRIDGE_DEFAULT_PORT, code: '' }; }

  /** Pair with the agent listening on `port`, and keep reconnecting until `disconnect`. */
  connect(settings: AgentBridgeSettings): void {
    try { this.storage?.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* Optional: pairing is asked again after a reload. */ }
    this.start(settings);
  }

  disconnect(error?: string): void {
    try { this.storage?.removeItem(STORAGE_KEY); } catch { /* Nothing kept. */ }
    this.stop();
    this.set({ status: 'off', error });
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    this.stop();
    this.listeners.clear();
  }

  private saved(): AgentBridgeSettings | null {
    try {
      const value: unknown = JSON.parse(this.storage?.getItem(STORAGE_KEY) ?? 'null');
      if (value && typeof value === 'object' && typeof (value as AgentBridgeSettings).port === 'number' && typeof (value as AgentBridgeSettings).code === 'string') return value as AgentBridgeSettings;
    } catch { /* Ignore a damaged entry. */ }
    return null;
  }

  private start(settings: AgentBridgeSettings): void {
    this.stop();
    this.settings = settings;
    this.attempt();
  }

  private stop(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.settings = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) { socket.onclose = null; socket.close(); }
    this.tools = new WeakMap();
  }

  private attempt(): void {
    const settings = this.settings;
    if (!settings || this.disposed) return;
    this.retry = null;
    this.set({ status: 'connecting', port: settings.port });
    let socket: WebSocket;
    try {
      socket = this.open(`ws://127.0.0.1:${settings.port}`);
    } catch {
      this.disconnect('This window cannot open a connection to the agent.');
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.send({ type: 'hello', version: AGENT_BRIDGE_VERSION, code: settings.code, app: this.app, document: this.document() });
    };
    socket.onmessage = (event) => void this.receive(socket, event.data);
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.tools = new WeakMap();
      const reason = closeReason(event.code);
      if (reason) { this.disconnect(reason); return; }
      // The agent is not running yet, or it restarted: try again quietly while the bridge stays on.
      this.set({ status: 'connecting', port: settings.port });
      this.retry = setTimeout(() => this.attempt(), RECONNECT_MS);
    };
  }

  private async receive(socket: WebSocket, data: unknown): Promise<void> {
    if (typeof data !== 'string' || this.socket !== socket) return;
    let parsed;
    try { parsed = agentBridgeServerMessageSchema.safeParse(JSON.parse(data)); } catch { return; }
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.type === 'welcome') {
      if (this.settings) this.set({ status: 'connected', port: this.settings.port, agent: message.agent });
      return;
    }
    const result = await this.run(message.id, message.name, message.input);
    if (this.socket === socket) this.send(result);
  }

  /** One tool call, on whichever model tab is active when it arrives. Failures are error results, never exceptions. */
  private async run(id: number, name: string, input: unknown): Promise<AgentBridgeAppMessage> {
    const error = (content: string): AgentBridgeAppMessage => ({ type: 'result', id, content: JSON.stringify({ ok: false, error: { code: 'unavailable', message: content } }), isError: true });
    if (!AGENT_BRIDGE_TOOL_NAMES.has(name)) return error(`${name} is not a tool this window runs.`);
    const tab = this.session.active;
    if (tab.type !== 'model') return error('The active tab is not a 3D model. Ask the user to bring a 3D model tab forward; nothing was changed.');
    let tools = this.tools.get(tab);
    if (!tools) {
      const made = documentToolsFor(this.session, tab, undefined, undefined, undefined, AGENT_BRIDGE_CLIENT);
      if (!made) return error('This tab cannot be edited.');
      this.tools.set(tab, (tools = made));
    }
    try {
      const outcome = await tools.run({ id: `agent-${id}`, name, input });
      return { type: 'result', id, content: outcome.content, isError: outcome.isError,
        ...(outcome.notice ? { notice: outcome.notice } : {}), ...(outcome.images?.length ? { images: [...outcome.images] } : {}) };
    } catch (cause) {
      return error(cause instanceof Error ? cause.message : String(cause));
    }
  }

  private document(): AgentBridgeDocument {
    const tab = this.session.active;
    return tab.type === 'model' ? { name: tab.name, revision: tab.app.document.doc.version } : null;
  }

  /** What the agent was last told about: the active model tab and its name. */
  private shownDocument(): string {
    const document = this.document();
    return JSON.stringify(document && { name: document.name, tab: this.session.activeId });
  }

  /** Tell the agent when the user brings another document forward or renames it; edits alone are not reported. */
  private sendDocument(): void {
    if (this.state.status !== 'connected') return;
    const shown = this.shownDocument();
    if (shown === this.sentDocument) return;
    this.sentDocument = shown;
    this.send({ type: 'document', document: this.document() });
  }

  private send(message: AgentBridgeAppMessage): void {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(message));
  }

  private set(state: AgentBridgeState): void {
    this.state = state;
    if (state.status === 'connected') this.sentDocument = this.shownDocument();
    for (const listener of this.listeners) listener();
  }
}
