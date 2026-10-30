// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * Browser client for the `fr-conversation` Edge Function. The UI depends only on this HTTP contract:
 * bearer session token plus publishable key on every call, JSON bodies, and a `text/event-stream`
 * reply for agent turns (the browser never holds tracker credentials).
 */

export type ErrorCode = 'unauthorized' | 'forbidden' | 'not_found' | 'invalid' | 'rate_limited' | 'limit' |
  'tracker_unavailable' | 'config_invalid' | 'network' | 'unknown';
export type ConversationKind = 'help' | 'intake' | 'feedback';
/** The three intents a requester can choose; `open` is a conversation whose path the agent has not set yet. */
export type IntentPath = 'help' | 'problem' | 'feature';
export type ConversationPath = IntentPath | 'open';
export type ConversationStatus = 'open' | 'filed' | 'discarded' | 'closed';
export type EffectiveRole = 'none' | 'user' | 'builder' | 'maintainer' | 'admin';
export type ChangeClass = 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6' | 'C7';
export type Area = 'Modeling' | 'Layout' | 'Cloud' | 'Shell';

/** Feature or UX change brief; null sections render as "Not provided". */
export interface FeatureBrief {
  readonly kind: 'feature' | 'ux-change';
  readonly problem: string | null;
  readonly workaround: string | null;
  readonly desired: string | null;
  readonly acceptance: readonly string[];
  readonly mustNotChange: string | null;
  readonly area: Area | null;
  readonly importance: { readonly level: 'nice' | 'important' | 'blocking'; readonly reason: string } | null;
  readonly estimatedClass: ChangeClass | null;
}
/** Problem report; the panel supplies the environment block. */
export interface ProblemReport {
  readonly kind: 'problem';
  readonly steps: readonly string[];
  readonly expected: string | null;
  readonly happened: string | null;
  readonly frequency: 'always' | 'sometimes' | 'once' | null;
  readonly area: Area | null;
  readonly impact: 'cannot_work' | 'workaround' | 'cosmetic' | null;
  readonly estimatedClass: ChangeClass | null;
  readonly environment?: { readonly build?: string; readonly browser?: string; readonly os?: string; readonly documentType?: string; readonly at?: string } | undefined;
}
export type Brief = FeatureBrief | ProblemReport;

export interface ScreenInfo {
  readonly editor: 'home' | 'model' | 'layout';
  readonly documentType?: string | undefined;
  readonly build: { readonly version: string; readonly commit: string };
  readonly browser: string;
  readonly os: string;
}
export interface Me {
  readonly email: string;
  readonly roles: readonly { readonly role: string; readonly org_id?: string | null }[];
  readonly effective: EffectiveRole;
  readonly filingDisabled: boolean;
  readonly buildsDisabled: boolean;
  readonly trialsDisabled: boolean;
  readonly openRequests: number;
  readonly limits: { readonly openRequestsPerAccount: number; readonly messagesPerConversation: number };
}
export interface ConversationSummary {
  readonly id: string; readonly kind: ConversationKind; readonly path: ConversationPath;
  readonly title: string | null; readonly updatedAt: string; readonly messageCount: number;
}
export interface Message { readonly role: 'user' | 'assistant' | 'tool'; readonly text: string; readonly at: string }
export interface Conversation {
  readonly id: string; readonly kind: ConversationKind; readonly path: ConversationPath; readonly status: ConversationStatus;
  readonly title: string | null; readonly brief: Brief | null; readonly messages: readonly Message[];
  readonly messageCount: number; readonly requestId: string | null;
}
/** The request a `filed` or `added` event names. */
export interface FiledRequest {
  readonly id: string; readonly issueKey: string; readonly issueUrl: string | null; readonly title: string;
  readonly requesterState: string; readonly eligibility: string | null;
}

/**
 * Server-sent events of `POST /conversations/:id/messages`. The agent files, adds the requester to an existing
 * request, or starts over through its own tools; the stream only reports the outcome. Other event names the
 * server may still send (`offer`, `duplicate`) are skipped.
 */
export type StreamEvent =
  | { readonly type: 'text'; readonly delta: string }
  /** The panel reads only `path` (and `title` for the remembered draft); the brief itself reaches the requester as chat text. */
  | { readonly type: 'brief'; readonly brief: Brief | null; readonly title: string | null; readonly path: ConversationPath | null; readonly estimatedClass: string | null }
  /** The agent filed the request on the requester's confirmation; arrives before the closing `text`. */
  | { readonly type: 'filed'; readonly request: FiledRequest }
  /** The agent added the requester to an existing request; arrives before the closing `text`. */
  | { readonly type: 'added'; readonly request: FiledRequest }
  | { readonly type: 'error'; readonly code: ErrorCode; readonly message: string }
  /** The turn waits for the editor to run these document tool calls and send the results with `sendToolResults`. */
  | { readonly type: 'tool_request'; readonly calls: readonly ToolCall[] }
  /**
   * `ended`: the server closed the conversation (after a filing or Add me, a start over, or abusive content);
   * the next message starts a new one. `reason` is `start_over` when the requester asked to discard it.
   */
  | { readonly type: 'done'; readonly messageCount: number; readonly limitReached: boolean; readonly ended: boolean; readonly reason: string | null; readonly awaitingTools: boolean };

/** A document tool call the agent asked the editor to run. */
export interface ToolCall { readonly id: string; readonly name: string; readonly input: unknown }
/** The editor's answer to one `ToolCall`. */
export interface ToolCallResult { readonly toolUseId: string; readonly content: string; readonly isError: boolean }
/** What the sending tab can edit this turn; the backend offers matching document tools. */
export interface DocumentDescriptor { readonly type: 'layout' | 'model'; readonly apiVersion: number; readonly guidance?: 1 | undefined }

/** A problem report's attachment as the panel shows it. */
export type AttachmentKind = 'screenshot' | 'document';
export interface Attachment { readonly id: string; readonly kind: AttachmentKind; readonly name: string; readonly size: number }
/** A file the requester chose to attach: a PNG, JPEG or WebP screenshot, or a document copy sent as an opaque file. */
export interface AttachmentFile { readonly kind: AttachmentKind; readonly name: string; readonly mime: string; readonly blob: Blob }
export const SCREENSHOT_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp'];
export const DOCUMENT_TYPE = 'application/octet-stream';
export const ATTACHMENT_MAX_BYTES = 26_214_400;
export const ATTACHMENTS_PER_REPORT = 5;
/** Bytes as people read them, as the issue lists attachments. */
export function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

export class RequestsError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly status = 0) { super(message); this.name = 'RequestsError'; }
}

export interface RequestsClientOptions {
  readonly baseUrl: string;
  readonly getToken: () => Promise<string | null>;
  readonly apikey: string;
  /**
   * The Supabase region to run the backend in, sent as `forceFunctionRegion` on every call. Edge Functions otherwise run
   * near the user; pinning them to the database's region saves a cross-region round trip per database call. A query
   * parameter rather than the `x-region` header, so cross-origin requests need no extra allowed header.
   */
  readonly region?: string | undefined;
  readonly fetch?: typeof fetch | undefined;
}

type Json = Record<string, unknown>;
const str = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : fallback;
const nullable = (value: unknown): string | null => typeof value === 'string' && value !== '' ? value : null;
const num = (value: unknown, fallback = 0): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const pick = (row: Json, snake: string, camel: string): unknown => row[camel] ?? row[snake];

export function normalizeConversation(raw: unknown): Conversation {
  const row = (raw ?? {}) as Json;
  const messages = Array.isArray(row['messages']) ? row['messages'] as Json[] : [];
  return {
    id: str(row['id']), kind: (str(row['kind'], 'intake') as ConversationKind), path: (str(row['path'], 'help') as ConversationPath),
    status: (str(row['status'], 'open') as ConversationStatus), title: nullable(row['title']),
    brief: (row['brief'] as Brief | null | undefined) ?? null,
    messages: messages.map(m => ({ role: str(m['role'], 'assistant') as Message['role'], text: str(m['text'] ?? m['content']), at: str(m['at']) })),
    messageCount: num(pick(row, 'message_count', 'messageCount')), requestId: nullable(pick(row, 'request_id', 'requestId')),
  };
}
function normalizeSummary(raw: unknown): ConversationSummary {
  const row = (raw ?? {}) as Json;
  return { id: str(row['id']), kind: str(row['kind'], 'intake') as ConversationKind, path: str(row['path'], 'help') as ConversationPath,
    title: nullable(row['title']), updatedAt: str(pick(row, 'updated_at', 'updatedAt')), messageCount: num(pick(row, 'message_count', 'messageCount')) };
}
function normalizeFiled(raw: unknown): FiledRequest {
  const row = (raw ?? {}) as Json;
  return { id: str(row['id']), issueKey: str(pick(row, 'issue_key', 'issueKey')), issueUrl: nullable(pick(row, 'issue_url', 'issueUrl')),
    title: str(row['title']), requesterState: str(pick(row, 'requester_state', 'requesterState'), 'Submitted'), eligibility: nullable(row['eligibility']) };
}
function normalizeAttachment(raw: unknown): Attachment {
  const row = (raw ?? {}) as Json;
  return { id: str(row['id']), kind: str(row['kind'], 'screenshot') as AttachmentKind, name: str(row['name']), size: num(row['size']) };
}

/** Parses an SSE byte stream into typed events; the `event:` line names the type, else `data.type` does. */
export async function* parseEventStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  const emit = (block: string): StreamEvent | null => {
    let name = '', data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).replace(/^ /, '');
    }
    if (!data) return null;
    let payload: Json;
    try { payload = JSON.parse(data) as Json; } catch { return { type: 'error', code: 'unknown', message: 'The server sent an unreadable event.' }; }
    const type = name || str(payload['type']);
    switch (type) {
      case 'text': return { type, delta: str(payload['delta'] ?? payload['text']) };
      case 'brief': return { type, brief: (payload['brief'] as Brief | null | undefined) ?? null, title: nullable(payload['title']),
        path: nullable(payload['path']) as ConversationPath | null, estimatedClass: nullable(payload['estimatedClass']) };
      case 'filed': case 'added': return { type, request: normalizeFiled(payload['request']) };
      case 'error': return { type, code: str(payload['code'], 'unknown') as ErrorCode, message: str(payload['message'], 'Something went wrong.') };
      case 'tool_request': return { type, calls: (Array.isArray(payload['calls']) ? payload['calls'] as Json[] : []).map(c => ({ id: str(c['id']), name: str(c['name']), input: c['input'] ?? {} })) };
      case 'done': return { type, messageCount: num(payload['messageCount'] ?? payload['message_count']), limitReached: Boolean(payload['limitReached'] ?? payload['limit_reached']), ended: Boolean(payload['ended']), reason: nullable(payload['reason']), awaitingTools: Boolean(payload['awaitingTools']) };
      default: return null;
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? '' : decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let index: number;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const event = emit(buffer.slice(0, index)); buffer = buffer.slice(index + 2);
        if (event) yield event;
      }
      if (done) { const last = buffer.trim() ? emit(buffer) : null; if (last) yield last; return; }
    }
  } finally {
    // Cancelling (not only releasing) closes the connection when the consumer stops early, e.g. the panel unmounting mid-turn.
    await reader.cancel().catch(() => {});
  }
}

export class RequestsClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: RequestsClientOptions) {
    this.base = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  private async request(method: string, path: string, body?: unknown, accept = 'application/json', signal?: AbortSignal): Promise<Response> {
    const token = await this.options.getToken();
    if (!token) throw new RequestsError('unauthorized', 'Sign in to use AI Chat.', 401);
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, apikey: this.options.apikey, Accept: accept };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(path), { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), ...(signal ? { signal } : {}) });
    } catch { throw new RequestsError('network', 'Could not reach the requests service. Check your connection and try again.'); }
    if (!response.ok) throw await RequestsClient.errorOf(response);
    return response;
  }
  private url(path: string): string {
    const region = this.options.region;
    return region ? `${this.base}${path}${path.includes('?') ? '&' : '?'}forceFunctionRegion=${encodeURIComponent(region)}` : `${this.base}${path}`;
  }
  private static async errorOf(response: Response): Promise<RequestsError> {
    let code: ErrorCode = 'unknown', message = `The requests service answered ${response.status}.`;
    try {
      const error = ((await response.json()) as { error?: { code?: string; message?: string } }).error;
      if (error?.code) code = error.code as ErrorCode;
      if (error?.message) message = error.message;
    } catch { /* Non-JSON body; keep the status message. */ }
    if (code === 'unknown') code = response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden' : response.status === 404 ? 'not_found'
      : response.status === 429 ? 'rate_limited' : response.status === 409 ? 'limit' : response.status === 502 ? 'tracker_unavailable' : 'unknown';
    return new RequestsError(code, message, response.status);
  }
  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await this.request(method, path, body)).json() as Promise<T>;
  }

  async me(): Promise<Me> {
    const row = await this.json<Json>('GET', '/me');
    const limits = (row['limits'] as Json | undefined) ?? {};
    return { email: str(row['email']), roles: Array.isArray(row['roles']) ? row['roles'] as Me['roles'] : [],
      effective: str(row['effective'], 'user') as EffectiveRole, filingDisabled: Boolean(row['filingDisabled']),
      buildsDisabled: Boolean(row['buildsDisabled']), trialsDisabled: Boolean(row['trialsDisabled']), openRequests: num(row['openRequests']),
      limits: { openRequestsPerAccount: num(limits['openRequestsPerAccount'], 5), messagesPerConversation: num(limits['messagesPerConversation'], 30) } };
  }
  async listOpenConversations(): Promise<ConversationSummary[]> {
    const row = await this.json<Json>('GET', '/conversations/open');
    return (Array.isArray(row['conversations']) ? row['conversations'] : []).map(normalizeSummary);
  }
  /** `path: 'open'` starts a conversation whose path the agent sets from the first message or intent. */
  async startConversation(input: { kind: 'help' | 'intake'; path: ConversationPath; screen: ScreenInfo }): Promise<Conversation> {
    return normalizeConversation((await this.json<Json>('POST', '/conversations', input))['conversation']);
  }
  /** Clear Chat discards the conversation; it is not offered again. */
  async discardConversation(id: string): Promise<void> {
    await this.request('POST', `/conversations/${encodeURIComponent(id)}/discard`);
  }
  async getConversation(id: string): Promise<Conversation> {
    return normalizeConversation((await this.json<Json>('GET', `/conversations/${encodeURIComponent(id)}`))['conversation']);
  }
  /**
   * One agent turn; yields events until `done`. Network and HTTP failures throw `RequestsError`; `signal` aborts the
   * connection. `intent` travels in the body when the requester clicked an intent card: the backend sets
   * the conversation path from it and answers on that path.
   */
  async *sendMessage(id: string, text: string, options: { readonly intent?: IntentPath | undefined; readonly document?: DocumentDescriptor | null | undefined; readonly signal?: AbortSignal | undefined } = {}): AsyncGenerator<StreamEvent> {
    const body: Json = { text, ...(options.intent ? { intent: options.intent } : {}), ...(options.document ? { document: options.document } : {}) };
    yield* this.stream(`/conversations/${encodeURIComponent(id)}/messages`, body, options.signal);
  }
  /** Answer a turn's `tool_request` and stream the rest of the turn, which may request more calls. */
  async *sendToolResults(id: string, results: readonly ToolCallResult[], options: { readonly signal?: AbortSignal | undefined } = {}): AsyncGenerator<StreamEvent> {
    yield* this.stream(`/conversations/${encodeURIComponent(id)}/tool-results`, { results }, options.signal);
  }
  /**
   * Upload a retained image on an open feature request or problem report.
   * The backend reserves it and hands back a signed upload URL; the file goes straight to storage, and
   * the attachment counts only once the backend has seen the stored size match.
   */
  async attach(conversationId: string, file: AttachmentFile): Promise<Attachment> {
    const id = encodeURIComponent(conversationId);
    const reserved = await this.json<Json>('POST', `/conversations/${id}/attachments`, { kind: file.kind, name: file.name, mime: file.mime, size: file.blob.size });
    const attachment = normalizeAttachment(reserved['attachment']);
    try {
    let upload: Response;
    try {
      upload = await this.fetchImpl(str(reserved['uploadUrl']), { method: 'PUT', headers: { 'Content-Type': file.mime }, body: file.blob });
    } catch { throw new RequestsError('network', 'The upload did not finish. Check your connection and try again.'); }
    if (!upload.ok) throw new RequestsError('unknown', `The upload was refused (${upload.status}).`, upload.status);
    return normalizeAttachment((await this.json<Json>('POST', `/conversations/${id}/attachments/${encodeURIComponent(attachment.id)}/complete`, {}))['attachment']);
    } catch (error) {
      await this.removeAttachment(conversationId, attachment.id).catch(() => {});
      throw error;
    }
  }
  async removeAttachment(conversationId: string, attachmentId: string): Promise<void> {
    await this.request('DELETE', `/conversations/${encodeURIComponent(conversationId)}/attachments/${encodeURIComponent(attachmentId)}`);
  }
  async attachmentUrl(id: string): Promise<string> {
    return str((await this.json<Json>('GET', `/attachments/${encodeURIComponent(id)}`))['url']);
  }

  async attachmentBlob(id: string): Promise<Blob> {
    const url = await this.attachmentUrl(id);
    const response = await this.fetchImpl(url, { mode: 'cors', credentials: 'omit' });
    if (!response.ok) throw new RequestsError('network', 'The image preview could not be loaded. Try again.', response.status);
    return response.blob();
  }

  async listAttachments(conversationId: string): Promise<Attachment[]> {
    const row = await this.json<Json>('GET', `/conversations/${encodeURIComponent(conversationId)}/attachments`);
    return (Array.isArray(row['attachments']) ? row['attachments'] : []).map(normalizeAttachment);
  }
  private async *stream(path: string, body: Json, signal: AbortSignal | undefined): AsyncGenerator<StreamEvent> {
    const response = await this.request('POST', path, body, 'text/event-stream', signal);
    if (!response.body) throw new RequestsError('unknown', 'The requests service sent no reply.');
    yield* parseEventStream(response.body);
  }
}
