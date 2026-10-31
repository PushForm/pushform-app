// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Tracker, TrackerIssue } from '../adapters/tracker.ts';
import { TrackerError } from '../adapters/tracker.ts';
import { briefSchema, completeness, emptyBriefFor, type Brief, type DeclineReason, type Path } from '../agents/brief.ts';
import { answerPending, runTurn, type AnthropicLike, type ClientToolCall, type PendingClientTools, type ToolCallEvent, type ToolHandler, type ToolResult } from '../agents/client.ts';
import { retrieveUserHelp, USER_HELP_RULES } from '../agents/digest.ts';
import { GUIDANCE_RULES } from '../guidance.ts';
import { DOCUMENT_RULES, MODEL_DOCUMENT_RULES, documentTools, editableDocument, type DocumentCapability } from '../agents/document.ts';
import type { DigestSection } from '../agents/digest.ts';
import { helpAgent } from '../agents/help.ts';
import { intakeAgent } from '../agents/intake.ts';
import { openAgent } from '../agents/open.ts';
import { problemAgent } from '../agents/problem.ts';
import { frameRequesterText, withScreenArea, reportEnvironment, type AgentContext, type ConversationAgent, type ConversationStore, type FiledRequestSummary, type OpenIssueSummary, type OwnRequestSummary, type TurnEndReason } from '../agents/store.ts';
import { checkTrackerProjects, checkTrackerStates } from '../config/load.ts';
import type { Config } from '../config/schema.ts';
import { issueBody, issueLabels, issueTitle, transcriptUrl } from '../domain/issue.ts';
import { isClosedRequesterState } from '../domain/states.ts';
import type { Conversation, ConversationKind, ConversationMessage, ConversationPath, Eligibility, Kind, PanelScreen, Request as PipelineRequest, RequestDetail, SuspendedTurn } from '../domain/types.ts';
import { CORS_HEADERS, enforceRate, errorResponse, HttpError, httpErrorOf, json, lookupRoles, validateSession, type SessionUser, type SessionValidator } from './auth.ts';
import { conversationFromRow, requestDetailFromRow, requestFromRow, type AttachmentKind, type MeView, type ServiceDb, type SqlAttachmentRow, type UserDb } from './db.ts';

/**
 * HTTP router of the fr-conversation Edge Function (brief §HTTP contract, architecture §6.1). Every route
 * except `GET /health` validates the session JWT; service-role SQL runs through `db`, and the RPCs that
 * must see the account under RLS (own requests, withdraw, reply) run through the per-request `userDb`.
 */
export interface ConversationDeps {
  config: Config;
  db: ServiceDb;
  /** A user-scoped RPC built from the request's Authorization header (anon key + bearer), so RLS applies. */
  userDb: (req: Request) => UserDb;
  auth: SessionValidator;
  tracker: Tracker | null;
  anthropic: AnthropicLike | null;
  digest: DigestSection[];
  /** The private `fr-attachments` bucket; without it, attaching answers 503. */
  storage?: AttachmentStorage | null | undefined;
  /** Public base URL of this function, for the transcript link in issues. */
  backendUrl: string;
  now?: (() => Date) | undefined;
  log?: ((message: string) => void) | undefined;
  /** Seconds the open-issue list is reused between turns; 0 disables the cache. */
  openIssuesTtlSeconds?: number | undefined;
  /**
   * Setup the database calls depend on (the host row, `fr_apply_config`), run alongside each request's session check
   * instead of before it, since neither needs the other. Its failure answers 503 as the backend not being ready.
   */
  ready?: (() => Promise<void>) | undefined;
}
/** The private `fr-attachments` bucket as the conversation backend uses it. */
export interface AttachmentStorage {
  /** Read private bytes for transfer to Linear at filing time. */
  read?(path: string): Promise<Blob>;
  /** A short-lived URL the browser uploads the object to with PUT. */
  uploadUrl(path: string): Promise<string>;
  /** The stored object's size in bytes, or null when nothing was uploaded. */
  size(path: string): Promise<number | null>;
  /** A short-lived download URL. */
  downloadUrl(path: string, seconds: number): Promise<string>;
  remove(paths: readonly string[]): Promise<void>;
}
/** The bucket's own size limit (25 MiB) and image types; a document copy is stored as an opaque file. */
export const ATTACHMENT_MAX_BYTES = 26_214_400;
export const SCREENSHOT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const DOCUMENT_TYPE = 'application/octet-stream';
/** How long an attachment's download link works once a reader asks for it. */
const ATTACHMENT_URL_SECONDS = 300;
export const FUNCTION_NAME = 'fr-conversation';
export const MESSAGE_MAX_CHARS = 4000;
/** Bound on one document tool result the browser returns. */
export const TOOL_RESULT_MAX_CHARS = 200_000;
/** Model rounds a document turn may use across all its requests. */
export const DOCUMENT_TOOL_ROUNDS = 12;
const NOT_ANSWERED = 'Not run: the editor did not return a result.';
const ABANDONED = 'Not run: the requester sent a new message before the editor answered.';

/* ---------- request parsing ---------- */

const screenSchema = z.object({
  editor: z.enum(['home', 'model', 'layout']),
  documentType: z.string().max(100).optional(),
  build: z.object({ version: z.string().max(100), commit: z.string().max(100) }),
  browser: z.string().max(200),
  os: z.string().max(200),
});
/** `path: 'open'` (kind intake) starts a conversation before the requester chose a card; the first message settles it. */
const startSchema = z.object({ kind: z.enum(['help', 'intake']), path: z.enum(['open', 'help', 'problem', 'feature']), screen: screenSchema })
  .refine(b => (b.kind === 'help') === (b.path === 'help'), { message: 'kind help pairs with path help; kind intake with open, problem or feature', path: ['path'] });
/** `intent` is the card the requester clicked; it settles an open conversation's path before the agent runs and is ignored once a path is set. */
/** `document` is what the sending tab can edit this turn; absent or null offers no document tools. */
const documentSchema = z.object({ type: z.enum(['layout', 'model']), apiVersion: z.int().min(1), guidance: z.literal(1).optional(), edit: z.literal(1).optional() });
const messageSchema = z.object({ text: z.string().min(1).max(MESSAGE_MAX_CHARS), intent: z.enum(['help', 'problem', 'feature']).optional(), document: documentSchema.nullable().optional() });
/** The editor's answers to a suspended turn; a call left out is answered as not run. */
const toolResultsSchema = z.object({ results: z.array(z.object({ toolUseId: z.string().min(1).max(200), content: z.string().max(TOOL_RESULT_MAX_CHARS), isError: z.boolean().default(false) })).max(20) });
const briefBodySchema = z.object({ brief: briefSchema.nullable(), title: z.string().trim().max(300).nullable().optional() });
const addMeSchema = z.object({ requestId: z.uuid(), notes: z.string().max(4000).default('') });
const replySchema = z.object({ text: z.string().trim().min(1).max(4000) });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const attachmentBodySchema = z.object({
  kind: z.literal('screenshot'),
  name: z.string().trim().min(1).max(200).refine(n => ![...n].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127), 'control characters'),
  mime: z.string().min(1).max(100),
  size: z.number().int().min(1).max(ATTACHMENT_MAX_BYTES),
}).refine(b => (SCREENSHOT_TYPES as readonly string[]).includes(b.mime),
  { message: 'Images must be PNG, JPEG or WebP.', path: ['mime'] });
/** What the panel and the issue show of an attachment: never the storage path. */
export interface AttachmentView { id: string; kind: AttachmentKind; name: string; size: number }
const attachmentView = (row: Pick<SqlAttachmentRow, 'id' | 'kind' | 'name' | 'size'>): AttachmentView => ({ id: row.id, kind: row.kind, name: row.name, size: Number(row.size) });
/** Bytes as people read them. */
export function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}
/** The issue's links to a report's attachments: readable by the requester and the scope's maintainers through the backend. */
export function attachmentSection(attachments: readonly Pick<SqlAttachmentRow, 'id' | 'kind' | 'name' | 'size'>[], backendUrl: string): string {
  if (!attachments.length) return '';
  const base = backendUrl.replace(/\/+$/, '');
  const lines = attachments.map(a => `- ${a.kind === 'document' ? 'Document copy' : 'Screenshot'}: ${a.name} (${formatBytes(Number(a.size))}): ${base}/attachments/${a.id}`);
  return `\n\n## Attachments\n\n${lines.join('\n')}`;
}

async function parseBody<S extends z.ZodType>(req: Request, schema: S): Promise<z.output<S>> {
  let raw: unknown = {};
  const text = await req.text();
  if (text.trim()) { try { raw = JSON.parse(text); } catch { throw new HttpError('invalid', 'The body is not valid JSON.'); } }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HttpError('invalid', parsed.error.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return parsed.data;
}
/** Route path with the `/functions/v1/<name>` prefix removed, so `http://x/me` and `https://p.supabase.co/functions/v1/fr-conversation/me` both route. */
export function routePath(url: string, functionName = FUNCTION_NAME): string {
  const segments = new URL(url).pathname.split('/').filter(Boolean);
  const at = segments.indexOf(functionName);
  const rest = at >= 0 ? segments.slice(at + 1) : segments;
  return `/${rest.join('/')}`;
}

/* ---------- views ---------- */

export function conversationView(c: Conversation): Record<string, unknown> {
  // A suspended turn's raw model state stays on the server.
  const messages = c.messages.map(m => (m.role === 'assistant' && m.turn ? { role: m.role, text: m.text, at: m.at } : m));
  return { id: c.id, kind: c.kind, path: c.path, status: c.status, title: c.title, brief: c.brief, messages, messageCount: c.messageCount, requestId: c.requestId, screen: c.screen, startedAt: c.startedAt, updatedAt: c.updatedAt };
}
/**
 * Tool records answering a turn that is still waiting for the editor when a new requester message arrives:
 * every tool_use in the transcript then has a result, and the abandoned calls are never run.
 */
export function closeSuspended(messages: readonly ConversationMessage[], at: string): ConversationMessage[] {
  const last = messages.at(-1);
  if (last?.role !== 'assistant' || !last.turn) return [];
  return last.turn.pending.calls.map(call => ({ role: 'tool', name: call.name, toolUseId: call.id, input: call.input, output: ABANDONED, at }));
}
export function filedRequestEvent(r: PipelineRequest): FiledRequestEvent {
  return { id: r.id, issueKey: r.issueKey, issueUrl: r.issueUrl, title: r.title, requesterState: r.requesterState, eligibility: r.eligibility };
}
export function filedRequestView(r: PipelineRequest): Record<string, unknown> {
  return { id: r.id, issueKey: r.issueKey, issueUrl: r.issueUrl, title: r.title, requesterState: r.requesterState, kind: r.kind, eligibility: r.eligibility, estimatedClass: r.estimatedClass, createdAt: r.createdAt };
}
/** The pipeline request an issue was filed from: `issueBody` links the transcript as `<backend>/requests/<id>`. */
export function requestIdOfIssue(body: string | null): string | null {
  const m = /\/requests\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i.exec(body ?? '');
  return m?.[1]?.toLowerCase() ?? null;
}
export function issueSummaryOf(issue: TrackerIssue, config: Config): OpenIssueSummary {
  const labels = new Set(issue.labels);
  const kind: OpenIssueSummary['kind'] = labels.has(config.tracker.problemDestination.label) ? 'problem' : labels.has('ux-change') ? 'ux-change' : 'feature';
  const summary = (issue.body ?? '').replace(/^## Request details[\s\S]*$/m, '').replace(/^##\s+/gm, '').replace(/\s+/g, ' ').trim().slice(0, 400);
  return { id: issue.id, key: issue.key, title: issue.title, url: issue.url, kind, state: issue.state, requestId: requestIdOfIssue(issue.body), summary };
}

/* ---------- transcript <-> model messages ---------- */

/**
 * Rebuild the model's view of a stored transcript. Tool messages of a turn become one assistant message of
 * `tool_use` blocks and one user message of `tool_result` blocks; the latest requester message carries the
 * volatile context block (account, screen, brief, limits) so the cached system prompt stays stable.
 */
export function historyOf(messages: readonly ConversationMessage[], contextBlock: string, latestText: string): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  let tools: Extract<ConversationMessage, { role: 'tool' }>[] = [];
  const flushTools = () => {
    if (!tools.length) return;
    out.push({ role: 'assistant', content: tools.map(t => ({ type: 'tool_use' as const, id: t.toolUseId, name: t.name, input: t.input ?? {} })) });
    out.push({ role: 'user', content: tools.map(t => ({ type: 'tool_result' as const, tool_use_id: t.toolUseId, content: t.name === 'search_docs' ? 'Earlier help passages omitted. Search user help again if needed.' : t.output })) });
    tools = [];
  };
  for (const m of messages) {
    if (m.role === 'tool') { tools.push(m); continue; }
    flushTools();
    if (m.role === 'user') out.push({ role: 'user', content: frameRequesterText(m.text) });
    else if (m.text.trim()) out.push({ role: 'assistant', content: m.text });
  }
  flushTools();
  // Two consecutive messages of one role are merged so the transcript alternates as the API requires.
  const merged: { role: 'user' | 'assistant'; content: Anthropic.ContentBlockParam[] }[] = [];
  for (const m of out) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) { last.content.push(...blocks(m.content)); continue; }
    merged.push({ role: m.role, content: blocks(m.content) });
  }
  if (merged.length && merged[merged.length - 1]!.role === 'user') merged.push({ role: 'assistant', content: [{ type: 'text', text: '(continued)' }] });
  return [...merged, { role: 'user', content: `${contextBlock}\n\n${frameRequesterText(latestText)}` }];
}
function blocks(content: Anthropic.MessageParam['content']): Anthropic.ContentBlockParam[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : [...(content as Anthropic.ContentBlockParam[])];
}

/* ---------- the conversation store the agent tools write to ---------- */

/** A filing prepared during a turn: the issue exists, the request row is written once the turn's transcript is saved. */
export interface PreparedFiling { issue: TrackerIssue; brief: Brief; title: string; kind: Kind; eligibility: Eligibility; summary: FiledRequestSummary }
/** The backend operations a turn's store performs on the agent's behalf. */
export interface StoreActions {
  issues: () => Promise<OpenIssueSummary[]>;
  openCount: () => Promise<number>;
  /** Checks, then creates the tracker issue for the brief as it stands; throws an `HttpError` with a readable message. */
  prepareFiling: (brief: Brief | null, title: string | null) => Promise<PreparedFiling>;
  /** Subscribes the account at once; the conversation is closed when the turn ends. */
  addMe: (requestId: string, notes: string) => Promise<RequestDetail>;
}
/**
 * Per-turn state over a loaded conversation; persisted once with `fr_conversation_append` when the turn ends.
 * `fr_request_file` closes the conversation and `fr_conversation_append` refuses a closed one, so a filing is split:
 * the tool creates the issue and tells the agent its key during the turn, and the request row is recorded right after
 * the turn's transcript (including the agent's closing text) is appended. The `filed` SSE event follows that record.
 */
export class DbConversationStore implements ConversationStore {
  changed = false;
  pendingFiling: PreparedFiling | null = null;
  added: RequestDetail | null = null;
  private end: TurnEndReason | null = null;
  constructor(private brief: Brief | null, private title: string | null, private path: ConversationPath, private readonly actions: StoreActions) {}
  getBrief(): Brief | null { return this.brief; }
  setBrief(brief: Brief | null): void { this.brief = brief; this.changed = true; }
  getTitle(): string | null { return this.title; }
  setTitle(title: string | null): void { this.title = title; this.changed = true; }
  getPath(): ConversationPath { return this.path; }
  setPath(path: Path): void { this.path = path; this.changed = true; }
  async searchOpenIssues(query: string): Promise<OpenIssueSummary[]> {
    const words = query.toLowerCase().split(/\W+/).filter(w => w.length > 2);
    const all = await this.actions.issues();
    const exact = all.filter(i => i.key.toLowerCase() === query.trim().toLowerCase());
    if (exact.length) return exact;
    return all.map(i => ({ i, score: words.filter(w => `${i.title} ${i.summary}`.toLowerCase().includes(w)).length })).filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score).map(x => x.i);
  }
  countOpenRequests(): Promise<number> { return this.actions.openCount(); }
  async fileRequest(): Promise<FiledRequestSummary> {
    if (this.pendingFiling) return this.pendingFiling.summary;
    if (this.end) throw new HttpError('invalid', 'This conversation is already complete.');
    this.pendingFiling = await this.actions.prepareFiling(this.brief, this.title);
    this.title = this.pendingFiling.title; this.end = 'filed';
    return this.pendingFiling.summary;
  }
  async addMe(requestId: string, notes: string): Promise<FiledRequestSummary> {
    if (this.end) throw new HttpError('invalid', 'This conversation is already complete.');
    const r = await this.actions.addMe(requestId, notes);
    this.added = r; this.end = 'added';
    return { id: r.id, issueKey: r.issueKey, issueUrl: r.issueUrl, title: r.title, requesterState: r.requesterState, eligibility: r.eligibility };
  }
  startOver(): void { if (!this.end) this.end = 'start_over'; }
  decline(reason: DeclineReason): void { if (reason === 'abusive' && !this.end) this.end = 'abusive'; }
  ended(): TurnEndReason | null { return this.end; }
}

/* ---------- SSE ---------- */

/** The request a turn filed or joined, as the panel shows it. */
export interface FiledRequestEvent { id: string; issueKey: string; issueUrl: string; title: string; requesterState: string; eligibility: Eligibility }
export type SseEvent =
  | { event: 'text'; data: { delta: string } }
  /** Also sent whenever the path changes during a turn (an `intent`, or the open agent settling the path), so the panel learns the path. */
  | { event: 'brief'; data: { brief: Brief | null; title: string | null; path: ConversationPath; estimatedClass: Brief['estimatedClass'] | null } }
  /** The agent filed the brief after the requester's confirmation; the conversation is complete. */
  | { event: 'filed'; data: { request: FiledRequestEvent } }
  /** The agent added the requester to an existing request; the conversation is complete. */
  | { event: 'added'; data: { request: FiledRequestEvent } }
  /** The turn is suspended until the editor answers these document tool calls through `POST /conversations/:id/tool-results`. */
  | { event: 'tool_request'; data: { calls: ClientToolCall[] } }
  | { event: 'error'; data: { code: string; message: string } }
  /** `ended`: the conversation is closed and the next message needs a new one; `reason` says why (filed, added, start_over, or abusive content). */
  | { event: 'done'; data: { messageCount: number; limitReached: boolean; ended: boolean; reason?: TurnEndReason; awaitingTools?: boolean } };
export function formatSse(e: SseEvent): string { return `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`; }
/** Parse an SSE body back into events (used by the panel client and tests). */
export function parseSse(text: string): SseEvent[] {
  return text.split('\n\n').filter(chunk => chunk.trim()).map(chunk => {
    const event = /^event: (.*)$/m.exec(chunk)?.[1] ?? 'message';
    const data = chunk.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('\n');
    return { event, data: data ? JSON.parse(data) : {} } as SseEvent;
  });
}
function sseResponse(run: (emit: (e: SseEvent) => void) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: SseEvent) => { try { controller.enqueue(encoder.encode(formatSse(e))); } catch { /* client went away */ } };
      try { await run(emit); } catch (error) { const e = httpErrorOf(error); emit({ event: 'error', data: { code: e.code, message: e.message } }); }
      try { controller.close(); } catch { /* already closed */ }
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', ...CORS_HEADERS } });
}

/* ---------- the handler ---------- */

type TurnBase = Omit<AgentContext, 'path' | 'brief' | 'title'>;
/** What one request of a turn runs: a new turn's first request, or a resume after the editor answered. */
interface TurnRun {
  user: SessionUser;
  conversation: Conversation;
  store: DbConversationStore;
  handlers: Record<string, ToolHandler>;
  pathChanged: boolean;
  /** Records saved ahead of the turn's own: the requester message (after any closers), or the editor's answers. */
  leading: ConversationMessage[];
  setup: {
    model: string; system: string; tools: Anthropic.Tool[]; context: string; historyLength: number;
    messages: Anthropic.MessageParam[]; document: DocumentCapability | null;
    resume: { appended: Anthropic.MessageParam[]; rounds: number } | undefined;
  };
}
const agentFor = (path: ConversationPath): ConversationAgent => (path === 'open' ? openAgent : path === 'help' ? helpAgent : path === 'problem' ? problemAgent : intakeAgent);
/** The conversation kind a settled path implies: help conversations are kept 30 days, the two filing paths are intake. */
const kindOf = (path: ConversationPath): ConversationKind => (path === 'help' ? 'help' : 'intake');
const clientOf = (screen: PanelScreen | null): Record<string, unknown> | null => (screen ? { version: screen.build.version, build: screen.build.commit, editor: screen.editor, browser: screen.browser, os: screen.os } : null);

export function createConversationHandler(deps: ConversationDeps): (req: Request) => Promise<Response> {
  const { config, db } = deps;
  const now = () => deps.now?.() ?? new Date();
  const ttl = (deps.openIssuesTtlSeconds ?? 60) * 1000;
  let issueCache: { at: number; issues: OpenIssueSummary[] } | null = null;
  let statesChecked = false;

  /** Titles and summaries of open issues; a tracker outage leaves the list empty rather than failing the turn. */
  const openIssues = async (): Promise<OpenIssueSummary[]> => {
    if (!deps.tracker) return [];
    if (issueCache && ttl > 0 && now().getTime() - issueCache.at < ttl) return issueCache.issues;
    try {
      const issues = (await deps.tracker.searchOpen('')).map(i => issueSummaryOf(i, config));
      const requests = await db.requestsByIssueIds(config.host, issues.map(i => i.id)).catch(() => new Map<string, string>());
      for (const i of issues) i.requestId ??= requests.get(i.id) ?? null;
      issueCache = { at: now().getTime(), issues };
      return issues;
    } catch (error) { deps.log?.(`open issues unavailable: ${error instanceof Error ? error.message : String(error)}`); return issueCache?.issues ?? []; }
  };
  /** Before the first filing: every configured state must exist in the team, or nothing is created. */
  const ensureStates = async (tracker: Tracker): Promise<void> => {
    if (statesChecked) return;
    let names: string[];
    try { names = await tracker.listStateNames(); } catch (error) { throw trackerUnavailable(error); }
    const errors = checkTrackerStates(config, names);
    if (errors.length) throw new HttpError('config_invalid', 'The tracker configuration is invalid.', errors);
    statesChecked = true;
  };
  const trackerUnavailable = (error: unknown): HttpError => {
    const message = error instanceof TrackerError ? error.message : 'The tracker could not be reached.';
    deps.log?.(`tracker failure: ${error instanceof Error ? error.message : String(error)}`);
    return new HttpError('tracker_unavailable', `Filing failed: ${message} Your brief is kept; try again in a moment.`);
  };
  /** The session check and the host setup together: one round trip of waiting instead of two. */
  const session = async (req: Request): Promise<SessionUser> => {
    const ready = deps.ready?.().catch((error: unknown) => {
      deps.log?.(`fr_apply_config failed: ${error instanceof Error ? error.message : String(error)}`);
      throw new HttpError('unavailable', 'The pipeline backend is not ready.');
    });
    const [user] = await Promise.all([validateSession(req, deps.auth), ready]);
    return user;
  };
  const loadConversation = async (id: string, user: SessionUser): Promise<Conversation> => {
    if (!UUID.test(id)) throw new HttpError('not_found', 'Not found.');
    try { return conversationFromRow(await db.conversationGet(id, user.id)); } catch (error) { throw httpErrorOf(error, 'not_found'); }
  };
  const ownRequests = async (userDb: UserDb): Promise<PipelineRequest[]> => {
    try { return (await userDb.listMyRequests(config.host)).map(requestFromRow); } catch (error) { throw httpErrorOf(error); }
  };
  const filingAllowed = (me: MeView): boolean => me.effective !== 'none' && !me.filingDisabled;

  const health = async (): Promise<Response> => {
    const errors: string[] = [];
    if (deps.tracker) {
      try {
        errors.push(...checkTrackerStates(config, await deps.tracker.listStateNames()), ...checkTrackerProjects(config, await deps.tracker.listProjectNames()));
      } catch (error) { errors.push(`tracker: ${error instanceof Error ? error.message : String(error)}`); }
    }
    const ok = errors.length === 0;
    return json({ ok, config: ok ? 'valid' : 'invalid', host: config.host, ...(ok ? {} : { errors }) }, ok ? 200 : 503);
  };

  const me = async (req: Request): Promise<Response> => {
    await session(req);
    const view = await lookupRoles(deps.userDb(req), config);
    return json(view);
  };
  const listOpen = async (req: Request): Promise<Response> => {
    const user = await session(req);
    let rows; try { rows = await db.conversationListOpen(config.host, user.id); } catch (error) { throw httpErrorOf(error); }
    const conversations = rows.map(conversationFromRow).map(c => ({ id: c.id, kind: c.kind, path: c.path, title: c.title, updatedAt: c.updatedAt, messageCount: c.messageCount }));
    return json({ conversations });
  };
  const start = async (req: Request): Promise<Response> => {
    const user = await session(req);
    const body = await parseBody(req, startSchema);
    await enforceRate(db, user.id, config.limits.messagesPerMinute);
    const screen: PanelScreen = { editor: body.screen.editor, build: body.screen.build, browser: body.screen.browser, os: body.screen.os };
    if (body.screen.documentType !== undefined) screen.documentType = body.screen.documentType;
    let row; try { row = await db.conversationStart(config.host, user.id, user.email, body.kind, body.path, screen); } catch (error) { throw httpErrorOf(error); }
    return json({ conversation: conversationView(conversationFromRow(row)) }, 201);
  };
  const get = async (req: Request, id: string): Promise<Response> => {
    const user = await session(req);
    return json({ conversation: conversationView(await loadConversation(id, user)) });
  };
  const setBrief = async (req: Request, id: string): Promise<Response> => {
    const user = await session(req);
    const conversation = await loadConversation(id, user);
    if (conversation.status !== 'open') throw new HttpError('invalid', 'The conversation is closed.');
    const body = await parseBody(req, briefBodySchema);
    await enforceRate(db, user.id, config.limits.messagesPerMinute);
    // The estimated change class is the agent's, never the requester's; the stored value carries forward.
    const brief: Brief | null = body.brief ? { ...body.brief, estimatedClass: conversation.brief?.estimatedClass ?? null } : null;
    const path: ConversationPath | null = brief ? (brief.kind === 'problem' ? 'problem' : 'feature') : null;
    try {
      const row = await db.conversationAppend(id, user.id, [], brief, body.title ?? null, path);
      return json({ conversation: conversationView(conversationFromRow(row)) });
    } catch (error) { throw httpErrorOf(error); }
  };
  const discard = async (req: Request, id: string): Promise<Response> => {
    const user = await session(req);
    await loadConversation(id, user);
    try { await db.conversationClose(id, user.id, 'discarded'); } catch (error) { throw httpErrorOf(error); }
    return json({ ok: true });
  };

  /* ---------- problem-report attachments ---------- */

  /** A filing conversation's uploaded images; a list failure must never silently omit them. */
  const uploadedAttachments = async (conversation: Conversation): Promise<SqlAttachmentRow[]> => {
    if (!['feature', 'problem'].includes(conversation.path)) return [];
    try { return await db.attachmentList(conversation.id); } catch (error) {
      deps.log?.(`attachments of ${conversation.id} not listed: ${error instanceof Error ? error.message : String(error)}`);
      throw new HttpError('unavailable', 'Images could not be loaded. Your ticket has not been filed; please retry.');
    }
  };
  const storageOrThrow = (): AttachmentStorage => {
    if (!deps.storage) throw new HttpError('unavailable', 'Attachments are not available right now.');
    return deps.storage;
  };
  /** Reserve an attachment and hand back a URL to upload it to; the requester confirmed its name and size first. */
  const addAttachment = async (req: Request, id: string): Promise<Response> => {
    const user = await session(req);
    const conversation = await loadConversation(id, user);
    if (conversation.status !== 'open') throw new HttpError('invalid', 'The conversation is closed.');
    if (!['feature', 'problem'].includes(conversation.path)) throw new HttpError('invalid', 'Images belong to a feature request or problem report.');
    const body = await parseBody(req, attachmentBodySchema);
    const storage = storageOrThrow();
    await enforceRate(db, user.id, config.limits.messagesPerMinute);
    const safe = body.name.replace(/[^A-Za-z0-9._ -]+/g, '_').slice(-120) || 'file';
    const path = `${user.id}/${conversation.id}/${crypto.randomUUID()}-${safe}`;
    let row: SqlAttachmentRow;
    try { row = await db.attachmentAdd(conversation.id, user.id, { kind: body.kind, name: body.name, mime: body.mime, size: body.size, path }); } catch (error) {
      const e = httpErrorOf(error);
      throw e.code === 'limit' ? new HttpError('limit', 'A report takes at most 5 attachments.') : e;
    }
    return json({ attachment: attachmentView(row), uploadUrl: await storage.uploadUrl(path) });
  };
  /** Mark an attachment uploaded once the object is in the bucket with the size the requester confirmed. */
  const completeAttachment = async (req: Request, id: string, attachmentId: string): Promise<Response> => {
    const user = await session(req);
    await loadConversation(id, user);
    if (!UUID.test(attachmentId)) throw new HttpError('not_found', 'Not found.');
    const storage = storageOrThrow();
    const rows = await db.rpc.selectIn?.('fr_attachments', 'id,conversation_id,uploaded_by,storage_path,size', 'id', [attachmentId]) ?? [];
    const row = rows[0];
    if (!row || row['conversation_id'] !== id || row['uploaded_by'] !== user.id) throw new HttpError('not_found', 'Not found.');
    const stored = await storage.size(String(row['storage_path']));
    if (stored === null || stored !== Number(row['size'])) throw new HttpError('invalid', 'The upload is missing or does not match the confirmed size.');
    try { return json({ attachment: attachmentView(await db.attachmentComplete(attachmentId, user.id)) }); } catch (error) { throw httpErrorOf(error, 'not_found'); }
  };
  const listAttachments = async (req: Request, id: string): Promise<Response> => {
    const user = await session(req);
    const conversation = await loadConversation(id, user);
    return json({ attachments: (await uploadedAttachments(conversation)).map(attachmentView) });
  };
  /** The requester and the scope's maintainers get a short-lived download link; anyone else, not found. */
  const getAttachment = async (req: Request, attachmentId: string): Promise<Response> => {
    await session(req);
    if (!UUID.test(attachmentId)) throw new HttpError('not_found', 'Not found.');
    let view;
    try { view = await deps.userDb(req).attachmentGet(attachmentId); } catch (error) { throw httpErrorOf(error, 'not_found'); }
    const url = await storageOrThrow().downloadUrl(view.storage_path, ATTACHMENT_URL_SECONDS);
    return json({ attachment: attachmentView(view), url });
  };

  /* ---------- filing and Add me, shared by the agent tools and the panel routes ---------- */

  /** Every check, then the tracker issue. Nothing is recorded yet. */
  const prepareFiling = async (user: SessionUser, userDb: UserDb, conversation: Conversation, brief: Brief | null, title: string | null): Promise<PreparedFiling> => {
    if (conversation.status !== 'open') throw new HttpError('invalid', 'The conversation is closed.');
    const check = completeness(brief);
    if (!brief || !check.fileable) throw new HttpError('invalid', 'Nothing to file yet: give the problem or the desired behavior first.');
    const roles = await lookupRoles(userDb, config);
    if (!filingAllowed(roles)) throw new HttpError('forbidden', 'Filing is not available for this account.');
    let open: number; try { open = await db.requestCountOpen(user.id); } catch (error) { throw httpErrorOf(error); }
    if (open >= config.limits.openRequestsPerAccount) throw new HttpError('limit', `You already have ${open} open requests; the limit is ${config.limits.openRequestsPerAccount}. Add yourself to an existing request instead.`);
    const tracker = deps.tracker;
    if (!tracker) throw new HttpError('tracker_unavailable', 'The tracker is not configured (LINEAR_TOKEN missing). Your brief is kept.');
    await ensureStates(tracker);
    const eligibility = 'none' as const;
    const kind: Kind = brief.kind;
    const issueTitleText = issueTitle(title ?? (brief.kind === 'problem' ? brief.happened ?? brief.expected ?? '' : brief.desired ?? brief.problem ?? ''));
    const screen = conversation.screen;
    // fr_request_file assigns the request id after the issue exists, so the body links the transcript by conversation id
    // (`<backend>/conversations/<id>`); the `<backend>/requests/<id>` link follows as a tracker comment once the request is recorded.
    const images = await uploadedAttachments(conversation);
    const embedded: string[] = [];
    for (const image of images) {
      if (image.kind !== 'screenshot') continue; // Historical document copies remain private links only.
      const storage = storageOrThrow();
      if (!storage.read) throw new HttpError('unavailable', 'Image delivery is unavailable. Your ticket has not been filed.');
      const bytes = await storage.read(image.storage_path);
      if (bytes.size !== image.size) throw new HttpError('invalid', 'An image is missing or incomplete. Please remove it and upload it again.');
      const url = await tracker.uploadImage(image.name ?? 'Image', image.mime ?? 'image/png', bytes);
      const name = (image.name ?? 'Image').replace(/[[\]\\\r\n]/g, '_');
      embedded.push(`![${name}](${url})`);
    }
    const body = issueBody(brief, {
      requesterEmail: user.email, accountId: user.id, orgId: null, host: config.host, clientVersion: screen?.build.version ?? 'unknown',
      clientBuild: screen?.build.commit ?? 'unknown', requestId: conversation.id, backendUrl: deps.backendUrl,
    }).replace(`/requests/${conversation.id}`, `/conversations/${conversation.id}`) + (embedded.length ? `\n## Images\n\n${embedded.join('\n\n')}\n` : '') + attachmentSection(images.filter(image => image.kind !== 'screenshot'), deps.backendUrl);
    let issue: TrackerIssue;
    try { issue = await tracker.createIssue({ title: issueTitleText, body, labels: issueLabels(brief, eligibility, config), kind }); } catch (error) { throw trackerUnavailable(error); }
    return { issue, brief, title: issueTitleText, kind, eligibility, summary: { id: null, issueKey: issue.key, issueUrl: issue.url, title: issueTitleText, requesterState: 'Submitted', eligibility } };
  };
  /** Record the request for a created issue; cancels the issue when the record fails or another filing of the conversation won. */
  const recordFiling = async (user: SessionUser, conversation: Conversation, p: PreparedFiling): Promise<{ request: RequestDetail; created: boolean }> => {
    const tracker = deps.tracker;
    const cancel = async (note: string) => { if (!tracker) return; try { await tracker.setState(p.issue.id, config.tracker.states.canceled); await tracker.addComment(p.issue.id, note); } catch { /* best effort */ } };
    let row;
    try {
      row = await db.requestFile({ conversationId: conversation.id, ownerId: user.id, email: user.email, kind: p.kind, title: p.title, brief: p.brief, estimatedClass: p.brief.estimatedClass, eligibility: p.eligibility, issueId: p.issue.id, issueKey: p.issue.key, issueUrl: p.issue.url, client: clientOf(conversation.screen) });
    } catch (error) {
      // The issue exists but the request could not be recorded (a race with the limit, most likely): cancel it so nothing is filed twice.
      deps.log?.(`request_file failed after issue ${p.issue.key}: ${error instanceof Error ? error.message : String(error)}`);
      await cancel('Canceled by the pipeline: the request could not be recorded after the issue was created.');
      throw httpErrorOf(error);
    }
    const request = requestDetailFromRow(row);
    issueCache = null;
    if (row.issue_id && row.issue_id !== p.issue.id) {
      // A concurrent filing of the same conversation recorded its issue first (never filed twice): this one's
      // issue is surplus, so it is canceled and the recorded request is returned.
      deps.log?.(`duplicate filing of ${conversation.id}: ${p.issue.key} canceled in favour of ${request.issueKey}`);
      await cancel(`Canceled by the pipeline: duplicate of ${request.issueKey}, filed concurrently from the same conversation.`);
      return { request, created: false };
    }
    if (['feature', 'problem'].includes(conversation.path)) {
      try {
        const bound = await db.attachmentBind(conversation.id);
        if (bound.removed.length) await deps.storage?.remove(bound.removed);
      } catch (error) { deps.log?.(`attachments not bound to ${request.id}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    try {
      await db.outboxEnqueue('tracker_comment', p.issue.id, { issue_id: p.issue.id, host_id: config.host, body: `Filed as request ${request.id}. Transcript: ${transcriptUrl(deps.backendUrl, request.id)}` }, request.id);
    } catch (error) { deps.log?.(`transcript comment not queued: ${error instanceof Error ? error.message : String(error)}`); }
    return { request, created: true };
  };
  /** Subscribe the account to a request of this host; `fr_invalid` means the request is gone or closed. */
  const subscribe = async (user: SessionUser, requestId: string, notes: string): Promise<RequestDetail> => {
    try { return requestDetailFromRow(await db.requestAddMe(config.host, requestId, user.id, user.email, notes)); } catch (error) {
      const e = httpErrorOf(error, 'not_found');
      throw e.code === 'invalid' || e.code === 'not_found' ? new HttpError('invalid', 'That request no longer accepts new subscribers.') : e;
    }
  };

  /** The account lookups a turn needs. The listed requests include Add me subscriptions; the limit counts the account's own open filings. */
  const accountContext = (user: SessionUser, userDb: UserDb) =>
    Promise.all([lookupRoles(userDb, config), ownRequests(userDb), db.requestCountOpen(user.id).catch(error => { throw httpErrorOf(error); })]);
  /** Everything a turn knows besides the transcript, assembled fresh for every request of the turn. */
  const turnBase = (user: SessionUser, conversation: Conversation, messageCount: number, document: DocumentCapability | null,
    [roles, requests, openRequestCount]: Awaited<ReturnType<typeof accountContext>>, issues: OpenIssueSummary[]): TurnBase => {
    const openRequests: OwnRequestSummary[] = requests.filter(r => !isClosedRequesterState(r.requesterState)).map(r => ({ id: r.id, issueKey: r.issueKey, title: r.title, requesterState: r.requesterState }));
    const screen = conversation.screen ?? { editor: 'home', build: { version: '', commit: '' }, browser: '', os: '' };
    return {
      host: config.host, accountEmail: user.email, roles: roles.roles.map(r => r.role), filingAllowed: filingAllowed(roles),
      screen: { editor: screen.editor, documentType: screen.documentType ?? null, browser: screen.browser, os: screen.os }, build: screen.build, now: now().toISOString(),
      messageCount, openRequests, openRequestCount, limits: { openRequestsPerAccount: config.limits.openRequestsPerAccount, messagesPerConversation: config.limits.messagesPerConversation },
      openIssues: issues, digest: deps.digest, document,
    };
  };
  const storeFor = (user: SessionUser, userDb: UserDb, conversation: Conversation, base: TurnBase, path: ConversationPath): DbConversationStore => {
    const initialBrief = withScreenArea(conversation.brief ?? emptyBriefFor(path, reportEnvironment({ ...base, path, brief: null, title: null })), base.screen);
    return new DbConversationStore(initialBrief, conversation.title, path, {
      issues: openIssues, openCount: () => db.requestCountOpen(user.id),
      prepareFiling: (brief, title) => prepareFiling(user, userDb, conversation, brief, title),
      addMe: (requestId, notes) => subscribe(user, requestId, notes),
    });
  };

  /**
   * One request of an agent turn as an SSE stream: text deltas while the model speaks, brief events as the tools change
   * it, then `filed` or `added` when the agent completed the conversation, and `done`. When the model calls a document
   * tool the turn suspends: the transcript is saved with the suspended round, `tool_request` names the calls
   * and `done` says `awaitingTools`; the browser's answers resume it through `POST /conversations/:id/tool-results`.
   * The transcript (including the agent's closing text) is appended before a filing is recorded, since the record
   * closes the conversation.
   */
  const streamTurn = (t: TurnRun): Response => {
    const { user, conversation, store, setup } = t;
    const id = conversation.id;
    const anthropic = deps.anthropic!;
    const editing = setup.document !== null;
    const clientTools = new Set(documentTools(setup.document).map(tool => tool.name));
    return sseResponse(async (emit) => {
      const appended: ConversationMessage[] = [...t.leading];
      const briefEvent = () => emit({ event: 'brief', data: { brief: store.getBrief(), title: store.getTitle(), path: store.getPath(), estimatedClass: store.getBrief()?.estimatedClass ?? null } });
      if (t.pathChanged) briefEvent();
      // The kind follows the path once an open conversation settles (help conversations fall under the 30-day retention).
      const persist = () => db.conversationAppend(id, user.id, appended, store.getBrief(), store.getTitle(), store.getPath(),
        conversation.path === 'open' && store.getPath() !== 'open' ? kindOf(store.getPath()) : null);
      // An issue created during the turn is recorded even when the model fails afterwards (never silently lost).
      const recordPending = async (): Promise<void> => {
        if (!store.pendingFiling) return;
        const { request } = await recordFiling(user, conversation, store.pendingFiling);
        emit({ event: 'filed', data: { request: filedRequestEvent(request) } });
      };
      const generationStarted = performance.now();
      let firstTextMs: number | null = null;
      let result;
      try {
        result = await runTurn({
          client: anthropic, model: setup.model, system: setup.system, tools: setup.tools, handlers: t.handlers, messages: setup.messages,
          clientTools, resume: setup.resume,
          // A turn that can edit the document plans multi-step geometry; help and intake stay short.
          effort: editing ? 'medium' : 'low', maxTokens: editing ? 16_000 : 4096, maxToolRounds: editing ? DOCUMENT_TOOL_ROUNDS : 8,
          onText: (delta) => {
            firstTextMs ??= Math.round(performance.now() - generationStarted);
            emit({ event: 'text', data: { delta } });
          },
          onToolCall: (call: ToolCallEvent) => {
            appended.push({ role: 'tool', name: call.name, toolUseId: call.id, input: call.input, output: call.result.content.slice(0, 8000), at: now().toISOString() });
            if (store.changed) { store.changed = false; briefEvent(); }
          },
        });
      } catch (error) {
        // A failed model call still keeps the requester's message, the tool calls and the brief the panel already shows
        // (the message budget was spent); the next turn then continues from them.
        try { await persist(); } catch (saveError) { deps.log?.(`turn ${id}: save after failure: ${saveError instanceof Error ? saveError.message : String(saveError)}`); }
        try { await recordPending(); } catch (fileError) { deps.log?.(`turn ${id}: record after failure: ${fileError instanceof Error ? fileError.message : String(fileError)}`); }
        throw error;
      }
      const generationMs = Math.round(performance.now() - generationStarted);
      const reason = store.ended();
      // A turn that also ended the conversation (filed, start over) does not wait for the editor: the calls are dropped.
      const suspended = result.stop === 'client_tools' && !reason ? result.pending : null;
      const turn: SuspendedTurn | null = suspended && setup.document ? {
        model: setup.model, system: setup.system, tools: setup.tools, context: setup.context, historyLength: setup.historyLength,
        appended: result.appended, pending: suspended, rounds: result.rounds, document: setup.document,
      } : null;
      const cue = turn?.pending.calls.find(call => call.name === 'ui_highlight')?.input as { instruction?: unknown } | undefined;
      const replyText = result.text.trim() || typeof cue?.instruction !== 'string' ? result.text : cue.instruction.slice(0, 400);
      if (replyText !== result.text) emit({ event: 'text', data: { delta: replyText } });
      appended.push({ role: 'assistant', text: replyText, at: now().toISOString(), ...(turn ? { turn } : {}) });
      let saved: Conversation;
      try { saved = conversationFromRow(await persist()); } catch (error) { throw httpErrorOf(error); }
      if (store.getBrief() || store.getTitle()) briefEvent();
      if (reason === 'filed') await recordPending();
      else if (reason === 'added' && store.added) {
        emit({ event: 'added', data: { request: filedRequestEvent(store.added) } });
        try { await db.conversationClose(id, user.id, 'closed'); } catch (error) { deps.log?.(`turn ${id}: close after Add me: ${error instanceof Error ? error.message : String(error)}`); }
      } else if (reason === 'start_over' || reason === 'abusive') {
        // The requester asked to start over;: abusive content ends the conversation. Either way it is discarded.
        try { await db.conversationClose(id, user.id, 'discarded'); } catch (error) { deps.log?.(`turn ${id}: close (${reason}): ${error instanceof Error ? error.message : String(error)}`); }
      }
      deps.log?.(`turn ${id}: model=${setup.model} stop=${result.stop} rounds=${result.rounds} firstTextMs=${firstTextMs ?? 'none'} generationMs=${generationMs} in=${result.usage.inputTokens} out=${result.usage.outputTokens} cacheRead=${result.usage.cacheReadTokens}${reason ? ` ended=${reason}` : ''}`);
      if (turn) emit({ event: 'tool_request', data: { calls: turn.pending.calls } });
      emit({ event: 'done', data: { messageCount: saved.messageCount, limitReached: saved.messageCount >= config.limits.messagesPerConversation, ended: reason !== null,
        ...(reason ? { reason } : {}), ...(turn ? { awaitingTools: true } : {}) } });
    });
  };

  /** A new requester message: one agent turn, with document tools when the browser offers them. */
  const message = async (req: Request, id: string): Promise<Response> => {
    // The body is read while the session is checked; an unauthorized request still answers unauthorized first.
    const [who, parsed] = await Promise.allSettled([session(req), parseBody(req, messageSchema)]);
    if (who.status === 'rejected') throw who.reason;
    if (parsed.status === 'rejected') throw parsed.reason;
    const user = who.value, body = parsed.value;
    const userDb = deps.userDb(req);
    // Everything the turn needs before the model starts, at once: one database round trip of waiting instead of five.
    const loading = loadConversation(id, user);
    const [loaded, rate, account, issues] = await Promise.allSettled([
      loading,
      enforceRate(db, user.id, config.limits.messagesPerMinute),
      accountContext(user, userDb),
      loading.then(conversation => {
        const path = conversation.path === 'open' && body.intent ? body.intent : conversation.path;
        // Help and initial routing need no tracker snapshot. Duplicate lookup stays available on demand.
        return path === 'help' || path === 'open' ? [] : openIssues();
      }),
    ]);
    // Failures are reported in the order the checks used to run one by one, so a response never depends on timing.
    if (loaded.status === 'rejected') throw loaded.reason;
    const conversation = loaded.value;
    if (conversation.status !== 'open') throw new HttpError('invalid', 'The conversation is closed; start a new one.');
    if (conversation.messageCount >= config.limits.messagesPerConversation) throw new HttpError('limit', `This conversation reached its ${config.limits.messagesPerConversation}-message limit. Send the brief as it stands or start over.`);
    if (rate.status === 'rejected') throw rate.reason;
    if (!deps.anthropic) throw new HttpError('unavailable', 'The assistant is not configured (ANTHROPIC_API_KEY missing).');
    if (account.status === 'rejected') throw account.reason;
    if (issues.status === 'rejected') throw issues.reason;
    const document = body.document && documentTools(body.document).length ? body.document : null;
    const base = turnBase(user, conversation, conversation.messageCount + 1, document, account.value, issues.value);
    // A clicked card settles an open conversation's path before the agent runs; the card label is the first message.
    const path: ConversationPath = conversation.path === 'open' && body.intent ? body.intent : conversation.path;
    const store = storeFor(user, userDb, conversation, base, path);
    const ctx: AgentContext = { ...base, path: store.getPath(), brief: store.getBrief(), title: store.getTitle() };
    const agent = agentFor(ctx.path);
    const tools = documentTools(document);
    // A turn still waiting for the editor is closed with error results before the new message, so the transcript stays valid.
    const closers = closeSuspended(conversation.messages, base.now);
    const prior = [...conversation.messages, ...closers];
    const help = path === 'help' || path === 'open'
      ? `\n\n<retrieved_help>\n${retrieveUserHelp(deps.digest, body.text.slice(0, 300), ctx.screen.editor)}\n</retrieved_help>` : '';
    const context = agent.context(ctx) + help;
    return streamTurn({
      user, conversation, store, handlers: agent.handlers(ctx, store), pathChanged: path !== conversation.path,
      leading: [...closers, { role: 'user', text: body.text, at: base.now }],
      setup: {
        model: tools.length ? config.models.document : config.models.conversation,
        system: [agent.system(ctx), USER_HELP_RULES, ...(editableDocument(document) === 'layout' ? [DOCUMENT_RULES(ctx)] : editableDocument(document) === 'model' ? [MODEL_DOCUMENT_RULES(ctx)] : []), ...(document?.guidance ? [GUIDANCE_RULES] : [])].join('\n\n'),
        tools: [...agent.tools(ctx), ...tools], context, historyLength: prior.length, messages: historyOf(prior, context, body.text), document, resume: undefined,
      },
    });
  };

  /** The browser's answers to a suspended turn's document tool calls; the turn continues exactly where it stopped. */
  const toolResults = async (req: Request, id: string): Promise<Response> => {
    const [who, parsed] = await Promise.allSettled([session(req), parseBody(req, toolResultsSchema)]);
    if (who.status === 'rejected') throw who.reason;
    if (parsed.status === 'rejected') throw parsed.reason;
    const user = who.value, body = parsed.value;
    const userDb = deps.userDb(req);
    // As for a new message, the lookups start together and their failures are reported in a fixed order.
    const [loaded, account, issues] = await Promise.allSettled([loadConversation(id, user), accountContext(user, userDb), openIssues()]);
    if (loaded.status === 'rejected') throw loaded.reason;
    const conversation = loaded.value;
    if (conversation.status !== 'open') throw new HttpError('invalid', 'The conversation is closed; start a new one.');
    const last = conversation.messages.at(-1);
    const turn = last?.role === 'assistant' ? last.turn : undefined;
    const opening = turn ? conversation.messages[turn.historyLength] : undefined;
    if (!turn || opening?.role !== 'user') throw new HttpError('invalid', 'No document tool call is waiting in this conversation.');
    const expected = new Set(turn.pending.calls.map(call => call.id));
    const answers = new Map<string, ToolResult>();
    for (const r of body.results) {
      if (!expected.has(r.toolUseId) || answers.has(r.toolUseId)) throw new HttpError('invalid', `Unexpected tool result for ${r.toolUseId}.`);
      answers.set(r.toolUseId, { content: r.content, isError: r.isError });
    }
    if (!deps.anthropic) throw new HttpError('unavailable', 'The assistant is not configured (ANTHROPIC_API_KEY missing).');
    if (account.status === 'rejected') throw account.reason;
    if (issues.status === 'rejected') throw issues.reason;
    const base = turnBase(user, conversation, conversation.messageCount, turn.document, account.value, issues.value);
    const store = storeFor(user, userDb, conversation, base, conversation.path);
    const ctx: AgentContext = { ...base, path: store.getPath(), brief: store.getBrief(), title: store.getTitle() };
    const pending = turn.pending as PendingClientTools;
    // A missed cue is not a conversational event. Persist the result without spending another model round
    // or emitting a follow-up that blames the user for not clicking; current instructions remain in chat.
    const quietCue = pending.calls.length > 0 && pending.calls.every(call => {
      const answer = answers.get(call.id);
      if (call.name !== 'ui_highlight' || !answer || answer.isError) return false;
      try { return ['expired', 'cancelled'].includes((JSON.parse(answer.content) as { status?: string }).status ?? ''); }
      catch { return false; }
    });
    if (quietCue) return sseResponse(async emit => {
      const messages: ConversationMessage[] = pending.calls.map(call => ({ role: 'tool', name: call.name, toolUseId: call.id,
        input: call.input, output: answers.get(call.id)!.content.slice(0, 8000), at: base.now }));
      const saved = conversationFromRow(await db.conversationAppend(id, user.id, messages, store.getBrief(), store.getTitle(), store.getPath(), null));
      emit({ event: 'done', data: { messageCount: saved.messageCount, limitReached: saved.messageCount >= config.limits.messagesPerConversation, ended: false } });
    });
    return streamTurn({
      user, conversation, store, handlers: agentFor(ctx.path).handlers(ctx, store), pathChanged: false,
      leading: pending.calls.map(call => ({ role: 'tool' as const, name: call.name, toolUseId: call.id, input: call.input,
        output: (answers.get(call.id)?.content ?? NOT_ANSWERED).slice(0, 8000), at: base.now })),
      setup: {
        model: turn.model, system: turn.system, tools: turn.tools as Anthropic.Tool[], context: turn.context, historyLength: turn.historyLength,
        messages: historyOf(conversation.messages.slice(0, turn.historyLength), turn.context, opening.text), document: turn.document,
        resume: { appended: [...(turn.appended as Anthropic.MessageParam[]), answerPending(pending, answers)], rounds: turn.rounds },
      },
    });
  };

  /** Over HTTP (fixtures and exit checks): file the stored brief as one issue, then record the request; idempotent per conversation. */
  const file = async (req: Request, id: string): Promise<Response> => {
    const user = await session(req);
    const userDb = deps.userDb(req);
    const conversation = await loadConversation(id, user);
    if (conversation.requestId) {
      try { return json({ request: filedRequestView(requestDetailFromRow(await userDb.getRequest(conversation.requestId))) }); } catch (error) { throw httpErrorOf(error); }
    }
    const prepared = await prepareFiling(user, userDb, conversation, conversation.brief, conversation.title);
    const { request, created } = await recordFiling(user, conversation, prepared);
    return json({ request: filedRequestView(request) }, created ? 201 : 200);
  };
  const addMe = async (req: Request, id: string): Promise<Response> => {
    const user = await session(req);
    const conversation = await loadConversation(id, user);
    const body = await parseBody(req, addMeSchema);
    await enforceRate(db, user.id, config.limits.messagesPerMinute);
    const request = await subscribe(user, body.requestId, body.notes);
    if (conversation.status === 'open') { try { await db.conversationClose(id, user.id, 'closed'); } catch (error) { throw httpErrorOf(error); } }
    return json({ request: filedRequestView(request) });
  };

  const listRequests = async (req: Request): Promise<Response> => {
    await session(req);
    return json({ requests: await ownRequests(deps.userDb(req)) });
  };
  const getRequest = async (req: Request, id: string): Promise<Response> => {
    await session(req);
    if (!UUID.test(id)) throw new HttpError('not_found', 'Not found.');
    try { return json({ request: requestDetailFromRow(await deps.userDb(req).getRequest(id)) }); } catch (error) { throw httpErrorOf(error, 'not_found'); }
  };
  const withdraw = async (req: Request, id: string): Promise<Response> => {
    await session(req);
    if (!UUID.test(id)) throw new HttpError('not_found', 'Not found.');
    try { return json({ request: requestDetailFromRow(await deps.userDb(req).withdraw(id)) }); } catch (error) {
      const e = httpErrorOf(error, 'not_found');
      throw e.code === 'invalid' ? new HttpError('invalid', 'Withdraw is only available while the request is Submitted and no build has started.') : e;
    }
  };
  const reply = async (req: Request, id: string): Promise<Response> => {
    const user = await session(req);
    if (!UUID.test(id)) throw new HttpError('not_found', 'Not found.');
    const body = await parseBody(req, replySchema);
    // Replies are relayed to the tracker, so they share the per-minute message budget.
    await enforceRate(db, user.id, config.limits.messagesPerMinute);
    try { const r = await deps.userDb(req).reply(id, body.text); return json({ ok: true, request: requestFromRow(r.request) }); } catch (error) { throw httpErrorOf(error, 'not_found'); }
  };

  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    const path = routePath(req.url);
    const m = req.method;
    try {
      if (path === '/health' && m === 'GET') return await health();
      if (path === '/me' && m === 'GET') return await me(req);
      if (path === '/conversations/open' && m === 'GET') return await listOpen(req);
      if (path === '/conversations' && m === 'POST') return await start(req);
      let r = /^\/conversations\/([^/]+)(?:\/(messages|tool-results|brief|file|add-me|discard))?$/.exec(path);
      if (r) {
        const [, id, action] = r as unknown as [string, string, string | undefined];
        if (!action && m === 'GET') return await get(req, id);
        if (action === 'messages' && m === 'POST') return await message(req, id);
        if (action === 'tool-results' && m === 'POST') return await toolResults(req, id);
        if (action === 'brief' && m === 'POST') return await setBrief(req, id);
        if (action === 'file' && m === 'POST') return await file(req, id);
        if (action === 'add-me' && m === 'POST') return await addMe(req, id);
        if (action === 'discard' && m === 'POST') return await discard(req, id);
      }
      r = /^\/conversations\/([^/]+)\/attachments(?:\/([^/]+)(\/complete)?)?$/.exec(path);
      if (r) {
        const [, id, attachmentId] = r as unknown as [string, string, string | undefined];
        if (attachmentId && !r[3] && m === 'DELETE') {
          const user = await session(req); await loadConversation(id, user);
          if (!UUID.test(attachmentId)) throw new HttpError('not_found', 'Not found.');
          try { await db.attachmentRemove(id, attachmentId, user.id); } catch (error) { throw httpErrorOf(error); }
          return json({ ok: true });
        }
        if (!attachmentId && m === 'POST') return await addAttachment(req, id);
        if (!attachmentId && m === 'GET') return await listAttachments(req, id);
        if (attachmentId && r[3] && m === 'POST') return await completeAttachment(req, id, attachmentId);
      }
      r = /^\/attachments\/([^/]+)$/.exec(path);
      if (r && m === 'GET') return await getAttachment(req, r[1]!);
      if (path === '/requests' && m === 'GET') return await listRequests(req);
      r = /^\/requests\/([^/]+)(?:\/(withdraw|reply))?$/.exec(path);
      if (r) {
        const [, id, action] = r as unknown as [string, string, string | undefined];
        if (!action && m === 'GET') return await getRequest(req, id);
        if (action === 'withdraw' && m === 'POST') return await withdraw(req, id);
        if (action === 'reply' && m === 'POST') return await reply(req, id);
      }
      throw new HttpError('not_found', `No route ${m} ${path}.`);
    } catch (error) {
      if (!(error instanceof HttpError)) deps.log?.(`unhandled ${m} ${path}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      return errorResponse(error);
    }
  };
}
