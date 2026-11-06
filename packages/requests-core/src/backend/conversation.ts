// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Tracker, TrackerIssue } from '../adapters/tracker.ts';
import { TrackerError } from '../adapters/tracker.ts';
import { briefSchema, completeness, emptyBriefFor, type Brief, type DeclineReason, type Path } from '../agents/brief.ts';
import { acknowledgeContent, ReplyOpening, startAcknowledgment, type Acknowledgment, type RunningAcknowledgment } from '../agents/acknowledge.ts';
import { answerPending, runTurn, type RoundPhase, warmPrompt, type AnthropicLike, type WarmClient, type WarmUsage, type ClientToolCall, type PendingClientTools, type ToolCallEvent, type ToolHandler, type ToolResult } from '../agents/client.ts';
import { retrieveUserHelp, USER_HELP_RULES } from '../agents/digest.ts';
import { GUIDANCE_RULES } from '../guidance.ts';
import { PICTURE_RULES } from '../agents/pictures.ts';
import { DOCUMENT_RULES, MODEL_DOCUMENT_RULES, RENDER_TOOL, documentTools, editableDocument, type DocumentCapability } from '../agents/document.ts';
import { CLONE_RULES, CLONE_TOOL, cloneAnswerOf, handoffBlock, handoffSchema, quietCloneAnswer } from '../clone.ts';
import { PUBLISH_RULES, PUBLISH_TOOL, SAVE_RULES, SAVE_TOOL, publishAnswerOf, quietPublishAnswer } from '../publish.ts';
import { MODEL_TOOLS, modelRenderSchema, modelRenderViewName, modelRenderViews } from '@pushform/extension-protocol';
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
import type { Conversation, ConversationKind, ConversationMessage, ConversationPath, MessagePicture, Eligibility, Kind, PanelScreen, Request as PipelineRequest, RequestDetail, SuspendedTurn } from '../domain/types.ts';
import { creditsExhaustedMessage, usagePathOf, usageOfRound, type CreditSummary } from './credits.ts';
import { CORS_HEADERS, enforceRate, errorResponse, HttpError, httpErrorOf, json, lookupRoles, validateSession, type SessionUser, type SessionValidator } from './auth.ts';
import { blockStatus, messageStatus, NEXT_STEP, resumeStatus, statusSender, type StatusLine, type StatusPick } from './status.ts';
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
/** Pictures one message may carry, and the largest picture sent to the model (the model API's own per-image limit). */
export const PICTURES_PER_MESSAGE = 5;
export const PICTURE_MAX_BYTES = 5 * 1024 * 1024;
/** A picture's bytes as the model receives them. */
export interface PictureData { mime: string; data: string }
/** Bound on one document tool result the browser returns. */
export const TOOL_RESULT_MAX_CHARS = 200_000;
/** Model rounds a document turn may use across all its requests (with render review: `limits.documentToolRoundsWithReview`). */
export const DOCUMENT_TOOL_ROUNDS = 12;

/**
 * How a turn runs, by the document it was sent with: one with a document open plans multi-step geometry and gets more
 * output and rounds; help and intake stay short. All run at low effort: the model still thinks where a build needs it,
 * but hidden reasoning was most of an editing turn's output and the requester waits for every token of it. A turn that
 * edits a 3D model gets the most output, so a large batch is never cut off mid-build; requests stream, so the limit
 * costs nothing until it is used.
 */
export function turnSettings(document: DocumentCapability | null): { effort: 'low' | 'medium'; maxTokens: number; maxToolRounds: number } {
  if (document === null) return { effort: 'low', maxTokens: 4096, maxToolRounds: 8 };
  return { effort: 'low', maxTokens: editableDocument(document) === 'model' ? MODEL_EDIT_MAX_TOKENS : 16_000, maxToolRounds: DOCUMENT_TOOL_ROUNDS };
}
/** Output limit of one request of a 3D-model editing turn. */
export const MODEL_EDIT_MAX_TOKENS = 32_000;
const agentForPath = (path: ConversationPath): ConversationAgent => (path === 'open' ? openAgent : path === 'help' ? helpAgent : path === 'problem' ? problemAgent : intakeAgent);
/**
 * The model, system prompt and tools of a turn: they depend only on the path and the open document, never on the
 * account, so every conversation in the same state shares one prompt-cache prefix. Turns and warm-ups both use this.
 */
export function turnPrompt(models: Config['models'], ctx: AgentContext, document: DocumentCapability | null): { model: string; system: string; tools: Anthropic.Tool[] } {
  const agent = agentForPath(ctx.path);
  const tools = documentTools(document);
  const editable = editableDocument(document);
  return {
    model: tools.length ? models.document : models.conversation,
    system: [agent.system(ctx), USER_HELP_RULES, PICTURE_RULES, ...(editable === 'layout' ? [DOCUMENT_RULES(ctx)] : editable === 'model' ? [MODEL_DOCUMENT_RULES(ctx)] : []), ...(document?.guidance ? [GUIDANCE_RULES] : []), ...(tools.some(tool => tool.name === SAVE_TOOL) ? [SAVE_RULES] : []), ...(tools.some(tool => tool.name === PUBLISH_TOOL) ? [PUBLISH_RULES] : []),
      ...(tools.some(tool => tool.name === CLONE_TOOL) ? [CLONE_RULES] : [])].join('\n\n'),
    tools: [...agent.tools(ctx), ...tools],
  };
}
/**
 * What a new conversation's first message offers, by what the tab has open: nothing (Home), a model with editing and
 * UI guidance, a Layout document with UI guidance. These are the prefixes `warmChatPrompts` keeps in the cache.
 */
export const WARM_DOCUMENTS: readonly (DocumentCapability | null)[] = [
  null,
  { type: 'model', apiVersion: 1, edit: 1, guidance: 1, clone: 1, save: 1, publish: 1 },
  { type: 'layout', apiVersion: 1, guidance: 1, clone: 1, save: 1 },
];
/** A first-message context with no account in it: the prompt does not depend on the account (see `turnPrompt`). */
function warmContext(config: Config, document: DocumentCapability | null): AgentContext {
  return {
    host: config.host, accountEmail: '', roles: [], filingAllowed: true,
    screen: { editor: document?.type ?? 'home', documentType: null, browser: '', os: '' }, build: { version: '', commit: '' }, now: '',
    path: 'open', brief: null, title: null, messageCount: 1, openRequests: [], openRequestCount: 0,
    limits: { openRequestsPerAccount: config.limits.openRequestsPerAccount },
    openIssues: [], digest: [], document,
  };
}
/**
 * Keep the first-message prompts of `WARM_DOCUMENTS` in the prompt cache, so the first message of a conversation does
 * not wait for ~30k tokens of tools and instructions to be processed. Each entry lives an hour and every read restarts
 * it, so calling this every half hour costs one cache write per prompt and cheap reads after that. Failures are
 * logged and skipped: a cold cache only makes the next first message slower.
 */
export async function warmChatPrompts(deps: { anthropic: WarmClient; config: Config; log?: ((message: string) => void) | undefined }): Promise<{ document: string; usage: WarmUsage | null }[]> {
  return Promise.all(WARM_DOCUMENTS.map(async (document) => {
    const label = document ? `${document.type}${document.edit ? '+edit' : ''}${document.guidance ? '+guidance' : ''}` : 'none';
    const prompt = turnPrompt(deps.config.models, warmContext(deps.config, document), document);
    try {
      const usage = await warmPrompt(deps.anthropic, { ...prompt, effort: turnSettings(document).effort });
      deps.log?.(`warm ${label}: model=${prompt.model} cacheWrite=${usage.cacheWrite} cacheRead=${usage.cacheRead} in=${usage.input}`);
      return { document: label, usage };
    } catch (error) {
      deps.log?.(`warm ${label}: failed: ${error instanceof Error ? error.message : String(error)}`);
      return { document: label, usage: null };
    }
  }));
}
/** Pictures one tool result may carry (a render's views), and the longest base64 text of each (1.5 MB). */
export const TOOL_IMAGES_PER_RESULT = 3;
export const TOOL_IMAGE_MAX_CHARS = 1_572_864;
/** What the agent gets for a render past the turn's limit; the browser never sees the call. */
export const RENDER_LIMIT_RESULT = JSON.stringify({ ok: false, error: { code: 'limit_exceeded', message: 'render limit reached; finish and say what you could not verify' } });
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
const startSchema = z.object({ kind: z.enum(['help', 'intake']), path: z.enum(['open', 'help', 'problem', 'feature']), screen: screenSchema,
  /** The saved cloud document the chat is held in, when it has one: deleting the document deletes the chat. */
  documentId: z.uuid().optional() })
  .refine(b => (b.kind === 'help') === (b.path === 'help'), { message: 'kind help pairs with path help; kind intake with open, problem or feature', path: ['path'] });
/** `intent` is the card the requester clicked; it settles an open conversation's path before the agent runs and is ignored once a path is set. */
/** `document` is what the sending tab can edit this turn; absent or null offers no document tools. */
const documentSchema = z.object({ type: z.enum(['layout', 'model']), apiVersion: z.int().min(1), guidance: z.literal(1).optional(), edit: z.literal(1).optional(), clone: z.literal(1).optional(), save: z.literal(1).optional(), publish: z.literal(1).optional() });
/** `attachments` are the ids of uploaded pictures of this conversation sent with the message; a message may be pictures alone. */
const messageSchema = z.object({ text: z.string().max(MESSAGE_MAX_CHARS), intent: z.enum(['help', 'problem', 'feature']).optional(), document: documentSchema.nullable().optional(),
  attachments: z.array(z.uuid()).max(PICTURES_PER_MESSAGE).optional(), handoff: handoffSchema.optional() })
  .refine(b => b.text.trim().length > 0 || (b.attachments?.length ?? 0) > 0, { message: 'A message needs text or a picture.', path: ['text'] });
/** The editor's answers to a suspended turn; a call left out is answered as not run. */
/** `images` are a render's pictures as base64, in view order; only a `model_render` answer may carry them. */
const toolImageSchema = z.object({ mime: z.enum(['image/jpeg', 'image/png']), data: z.string().min(1).max(TOOL_IMAGE_MAX_CHARS).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'base64') });
const toolResultsSchema = z.object({ results: z.array(z.object({ toolUseId: z.string().min(1).max(200), content: z.string().max(TOOL_RESULT_MAX_CHARS), isError: z.boolean().default(false),
  images: z.array(toolImageSchema).max(TOOL_IMAGES_PER_RESULT).optional() })).max(20) });
const linkDocumentSchema = z.object({ documentId: z.uuid().nullable() });
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
/** The view names of a render call, as its placeholder and review line show them. */
export function renderViewNames(input: unknown): string[] {
  const parsed = modelRenderSchema.safeParse(input ?? {});
  return modelRenderViews(parsed.success ? parsed.data : null).map(modelRenderViewName);
}
/** What the stored transcript keeps of a render's pictures: a short note naming the views. */
export function renderPlaceholder(views: readonly string[]): string {
  return `(Render pictures not kept: ${views.join('; ')}.)`;
}

/* ---------- render pictures in a suspended turn ---------- */

/** An image block of a suspended turn whose bytes are kept once, in a `renders` record of the turn's messages. */
const RENDER_REF = 'pf-render:';
type ImageBlock = Anthropic.ImageBlockParam & { source: Anthropic.Base64ImageSource };
/** Each render image block of `appended` with its key `<tool use id>#<index>`, in order. */
function renderBlocks(appended: readonly Anthropic.MessageParam[], visit: (block: ImageBlock, key: string) => Anthropic.ContentBlockParam): Anthropic.MessageParam[] {
  return appended.map(m => {
    if (m.role !== 'user' || typeof m.content === 'string') return m;
    if (!m.content.some(b => b.type === 'tool_result' && Array.isArray(b.content) && b.content.some(c => c.type === 'image'))) return m;
    return { ...m, content: m.content.map(block => {
      if (block.type !== 'tool_result' || !Array.isArray(block.content)) return block;
      let index = 0;
      return { ...block, content: block.content.map(item => (item.type === 'image' && item.source.type === 'base64'
        ? visit(item as ImageBlock, `${block.tool_use_id}#${index++}`) : item)) as Anthropic.ToolResultBlockParam['content'] & unknown[] } as Anthropic.ToolResultBlockParam;
    }) } as Anthropic.MessageParam;
  });
}
/**
 * A suspended turn's rounds as stored: render pictures become references, and the pictures no earlier message of the
 * turn keeps are returned to keep with this one. Each picture is stored once while the turn runs.
 */
export function keepRenders(appended: readonly Anthropic.MessageParam[], known: ReadonlySet<string>): { appended: Anthropic.MessageParam[]; renders: Record<string, PictureData> } {
  const renders: Record<string, PictureData> = {};
  const stored = renderBlocks(appended, (block, key) => {
    if (block.source.data.startsWith(RENDER_REF)) return block;
    if (!known.has(key)) renders[key] = { mime: block.source.media_type, data: block.source.data };
    return { ...block, source: { ...block.source, data: `${RENDER_REF}${key}` } };
  });
  return { appended: stored, renders };
}
/** The render pictures the turn's messages keep, gathered for a resume. */
export function turnRenders(messages: readonly ConversationMessage[]): Map<string, PictureData> {
  const out = new Map<string, PictureData>();
  for (const m of messages) if (m.role === 'assistant' && m.turn?.renders) for (const [key, image] of Object.entries(m.turn.renders)) out.set(key, image);
  return out;
}
/** A stored turn's rounds with their render pictures back in place; a picture that is gone becomes a note. */
export function restoreRenders(appended: readonly Anthropic.MessageParam[], renders: ReadonlyMap<string, PictureData>): Anthropic.MessageParam[] {
  return renderBlocks(appended, block => {
    if (!block.source.data.startsWith(RENDER_REF)) return block;
    const image = renders.get(block.source.data.slice(RENDER_REF.length));
    return image ? { ...block, source: { ...block.source, media_type: image.mime as Anthropic.Base64ImageSource['media_type'], data: image.data } }
      : { type: 'text', text: '(A render picture is no longer available.)' };
  });
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
/** Base64 of bytes, in chunks small enough for String.fromCharCode. */
function base64Of(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
/** A message's pictures as model content: each image, or a note where the requester removed it. */
function pictureBlocks(pictures: readonly MessagePicture[] | undefined, images: ReadonlyMap<string, PictureData>): Anthropic.ContentBlockParam[] {
  return (pictures ?? []).map(p => {
    const image = images.get(p.id);
    return image
      ? { type: 'image' as const, source: { type: 'base64' as const, media_type: image.mime as 'image/png' | 'image/jpeg' | 'image/webp', data: image.data } }
      : { type: 'text' as const, text: `(The requester removed the picture "${p.name.replace(/["<>]/g, '')}".)` };
  });
}
/**
 * How much of a conversation the model reads each turn, in characters of text and tool traffic (about 30,000 tokens). A document's chat is kept
 * until it is cleared, so it can grow without bound; everything stays stored and shown, and the model is sent the recent part.
 */
export const MODEL_HISTORY_MAX_CHARS = 120_000;
const sizeOf = (m: ConversationMessage): number => (m.role === 'tool' ? m.name.length + m.output.length + JSON.stringify(m.input ?? null).length : m.text.length);
/**
 * The most recent messages that fit `maxChars`, beginning at a requester message so no reply or tool result is left without its question,
 * and always including the latest requester message and what followed it. `omitted` says older messages were left out.
 */
export function recentHistory(messages: readonly ConversationMessage[], maxChars = MODEL_HISTORY_MAX_CHARS): { messages: readonly ConversationMessage[]; omitted: boolean } {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === 'user') { lastUser = i; break; }
  let total = 0, start = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) { total += sizeOf(messages[i]!); if (total > maxChars) break; start = i; }
  if (lastUser >= 0) start = Math.min(start, lastUser);
  while (start < messages.length && messages[start]!.role !== 'user') start++;
  return start === 0 ? { messages, omitted: false } : { messages: messages.slice(start), omitted: start > 0 };
}
/** The per-turn context, told when earlier messages were left out so the agent asks instead of guessing. */
export const withOmittedNote = (context: string, omitted: boolean): string =>
  omitted ? `${context}\n(Earlier messages in this chat are not shown to you. Ask the requester if you need something from them.)` : context;

export function historyOf(messages: readonly ConversationMessage[], contextBlock: string, latestText: string,
  latestPictures: readonly MessagePicture[] = [], images: ReadonlyMap<string, PictureData> = new Map()): Anthropic.MessageParam[] {
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
    if (m.role === 'user') {
      const text = m.handoff ? `${handoffBlock(m.handoff)}\n\n${frameRequesterText(m.text)}` : frameRequesterText(m.text);
      out.push({ role: 'user', content: m.attachments?.length ? [...pictureBlocks(m.attachments, images), { type: 'text', text }] : text });
    }
    // An acknowledgment restated the request for the requester only: no model ever reads it.
    else if (m.text.trim() && !m.acknowledgment) out.push({ role: 'assistant', content: m.text });
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
  const latest = `${contextBlock}\n\n${frameRequesterText(latestText)}`;
  return [...merged, { role: 'user', content: latestPictures.length ? [...pictureBlocks(latestPictures, images), { type: 'text', text: latest }] : latest }];
}
/** The agent's last reply, for the fast model that restates a new message (acknowledgments excluded). */
export function previousReplyOf(messages: readonly ConversationMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user') return null;
    if (m.role === 'assistant' && !m.acknowledgment && m.text.trim()) return m.text;
  }
  return null;
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
  /** A render call carries `review`: its number among the requester message's allowed reviews, as the backend counts them. */
  | { event: 'tool_request'; data: { calls: (ClientToolCall & { review?: { index: number; limit: number } })[] } }
  | { event: 'error'; data: { code: string; message: string; kind?: string } }
  /** What a turn that edits a 3D model is doing while nothing else is sent (see `status.ts`); never in the transcript or shown to the model. */
  | { event: 'status'; data: StatusLine }
  /** `ended`: the conversation is closed and the next message needs a new one; `reason` says why (filed, added, start_over, or abusive content). */
  | { event: 'done'; data: { messageCount: number; limitReached: boolean; limitMessage?: string; credits?: CreditSummary; ended: boolean; reason?: TurnEndReason; awaitingTools?: boolean } };
export function formatSse(e: SseEvent): string { return `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`; }
/** Parse an SSE body back into events (used by the panel client and tests). */
export function parseSse(text: string): SseEvent[] {
  return text.split('\n\n').filter(chunk => chunk.trim()).map(chunk => {
    const event = /^event: (.*)$/m.exec(chunk)?.[1] ?? 'message';
    const data = chunk.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('\n');
    return { event, data: data ? JSON.parse(data) : {} } as SseEvent;
  });
}
function sseResponse(log: ((message: string) => void) | undefined, run: (emit: (e: SseEvent) => void) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: SseEvent) => { try { controller.enqueue(encoder.encode(formatSse(e))); } catch { /* client went away */ } };
      try { await run(emit); } catch (error) {
        // The client sees only the mapped message, so the underlying failure is logged here.
        if (!(error instanceof HttpError)) log?.(`turn failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
        const e = httpErrorOf(error); emit({ event: 'error', data: { code: e.code, message: e.message, ...(e.kind ? { kind: e.kind } : {}) } }); }
      try { controller.close(); } catch { /* already closed */ }
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', ...CORS_HEADERS } });
}

/* ---------- the handler ---------- */

type TurnBase = Omit<AgentContext, 'path' | 'brief' | 'title'>;
/** What one request of a turn runs: a new turn's first request, or a resume after the editor answered. */
/** When the request arrived and how long each lookup before the model took, for the per-turn latency log. */
interface TurnTiming { received: number; phases: Record<string, number>; toolChars?: number }
/** Resolve as `work` does, recording its duration under `name`. */
function timed<T>(timing: TurnTiming, name: string, work: Promise<T>): Promise<T> {
  const started = performance.now();
  return work.finally(() => { timing.phases[name] = Math.round(performance.now() - started); });
}
interface TurnRun {
  timing: TurnTiming;
  user: SessionUser;
  conversation: Conversation;
  store: DbConversationStore;
  handlers: Record<string, ToolHandler>;
  pathChanged: boolean;
  /** Records saved ahead of the turn's own: the requester message (after any closers), or the editor's answers. */
  leading: ConversationMessage[];
  /** The status line this request opens with, on turns that edit a 3D model, and the last one the turn sent before. */
  status: StatusPick;
  previousStatus?: string | undefined;
  /** A new message's content for the fast model that restates it (see `acknowledge.ts`); resumed requests have none. */
  acknowledge?: Anthropic.ContentBlockParam[] | undefined;
  setup: {
    model: string; system: string; tools: Anthropic.Tool[]; context: string; historyLength: number;
    messages: Anthropic.MessageParam[]; document: DocumentCapability | null;
    resume: { appended: Anthropic.MessageParam[]; rounds: number; reviews: number; renders: ReadonlySet<string> } | undefined;
  };
}
const agentFor = agentForPath;
/** The conversation kind a settled path implies: help conversations are kept 30 days, the two filing paths are intake. */
const kindOf = (path: ConversationPath): ConversationKind => (path === 'help' ? 'help' : 'intake');
const clientOf = (screen: PanelScreen | null): Record<string, unknown> | null => (screen ? { version: screen.build.version, build: screen.build.commit, editor: screen.editor, browser: screen.browser, os: screen.os } : null);

/**
 * A backstop against runaway clients, not a product limit: a chat is kept for each document until it is cleared, and starting one is
 * already rate limited, so using the product never reaches this. The database enforces the same number.
 */
export const OPEN_CONVERSATIONS_LIMIT = 1000;
const OPEN_CONVERSATIONS_MESSAGE = `You have ${OPEN_CONVERSATIONS_LIMIT.toLocaleString('en-US')} open chats. Use Clear Chat in one you no longer need, then try again.`;

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
    const user = await session(req);
    const view = await lookupRoles(deps.userDb(req), config);
    let credits: CreditSummary; try { credits = await db.creditSync(user.id); } catch (error) { throw httpErrorOf(error); }
    return json({ ...view, credits });
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
    let row;
    try { row = await db.conversationStart(config.host, user.id, user.email, body.kind, body.path, screen); }
    catch (error) {
      const e = httpErrorOf(error);
      // The database refuses a twenty-first open conversation; say so, since "a limit was reached" tells nobody what to do.
      throw e.code === 'limit' ? new HttpError('limit', OPEN_CONVERSATIONS_MESSAGE, undefined, 'open_conversations') : e;
    }
    if (body.documentId) {
      // Best effort: the chat works unlinked, and the panel links it again the next time it opens with the document.
      try { await db.conversationSetDocument(row.id, user.id, body.documentId); }
      catch (error) { deps.log?.(`conversation ${row.id}: not linked to its document: ${error instanceof Error ? error.message : String(error)}`); }
    }
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
  /** Links the conversation to a saved document its account owns, or unlinks it with null. */
  const linkDocument = async (req: Request, id: string): Promise<Response> => {
    const user = await session(req);
    const body = await parseBody(req, linkDocumentSchema);
    await loadConversation(id, user);
    try { await db.conversationSetDocument(id, user.id, body.documentId); } catch (error) { throw httpErrorOf(error, 'not_found'); }
    return json({ ok: true });
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

  /* ---------- pictures posted with messages ---------- */

  /** The pictures a new message names: uploaded images of this conversation by this requester, within the model's size limit. */
  const messagePictures = async (conversation: Conversation, userId: string, ids: readonly string[]): Promise<MessagePicture[]> => {
    const unique = [...new Set(ids)];
    if (!db.rpc.selectIn) throw new HttpError('unavailable', 'Pictures are not available right now.');
    const rows = await db.rpc.selectIn('fr_attachments', 'id,conversation_id,uploaded_by,kind,name,mime,size,uploaded_at', 'id', unique);
    return unique.map(id => {
      const row = rows.find(r => r['id'] === id);
      if (!row || row['conversation_id'] !== conversation.id || row['uploaded_by'] !== userId) throw new HttpError('invalid', 'A picture does not belong to this conversation.');
      if (!row['uploaded_at']) throw new HttpError('invalid', `The picture "${String(row['name'])}" has not finished uploading.`);
      if (!(SCREENSHOT_TYPES as readonly string[]).includes(String(row['mime']))) throw new HttpError('invalid', 'Pictures must be PNG, JPEG or WebP images.');
      if (Number(row['size']) > PICTURE_MAX_BYTES) throw new HttpError('invalid', `The picture "${String(row['name'])}" is larger than 5 MB.`);
      return { id, name: String(row['name']), mime: String(row['mime']) };
    });
  };
  /** The bytes of every picture still attached to the conversation among `messages`; removed pictures are left out. */
  const pictureData = async (messages: readonly ConversationMessage[]): Promise<Map<string, PictureData>> => {
    const ids = [...new Set(messages.flatMap(m => (m.role === 'user' ? (m.attachments ?? []).map(p => p.id) : [])))];
    const images = new Map<string, PictureData>();
    if (!ids.length) return images;
    if (!db.rpc.selectIn) throw new HttpError('unavailable', 'Pictures are not available right now.');
    const storage = deps.storage;
    if (!storage?.read) throw new HttpError('unavailable', 'Pictures are not available right now.');
    const rows = await db.rpc.selectIn('fr_attachments', 'id,storage_path,mime,uploaded_at', 'id', ids);
    await Promise.all(rows.filter(r => r['uploaded_at']).map(async row => {
      try {
        const blob = await storage.read!(String(row['storage_path']));
        images.set(String(row['id']), { mime: String(row['mime']), data: base64Of(new Uint8Array(await blob.arrayBuffer())) });
      } catch (error) {
        deps.log?.(`picture ${String(row['id'])} not read: ${error instanceof Error ? error.message : String(error)}`);
        throw new HttpError('unavailable', 'A picture could not be read. Please retry.');
      }
    }));
    return images;
  };
  /** Reserve an attachment and hand back a URL to upload it to; the requester confirmed its name and size first. */
  const addAttachment = async (req: Request, id: string): Promise<Response> => {
    const user = await session(req);
    const conversation = await loadConversation(id, user);
    if (conversation.status !== 'open') throw new HttpError('invalid', 'The conversation is closed.');
    const body = await parseBody(req, attachmentBodySchema);
    const storage = storageOrThrow();
    await enforceRate(db, user.id, config.limits.messagesPerMinute);
    const safe = body.name.replace(/[^A-Za-z0-9._ -]+/g, '_').slice(-120) || 'file';
    const path = `${user.id}/${conversation.id}/${crypto.randomUUID()}-${safe}`;
    let row: SqlAttachmentRow;
    try { row = await db.attachmentAdd(conversation.id, user.id, { kind: body.kind, name: body.name, mime: body.mime, size: body.size, path }); } catch (error) {
      const e = httpErrorOf(error);
      throw e.code === 'limit' ? new HttpError('limit', 'A conversation takes at most 5 pictures.', undefined, 'images') : e;
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
    if (open >= config.limits.openRequestsPerAccount) throw new HttpError('limit', `You already have ${open} open requests; the limit is ${config.limits.openRequestsPerAccount}. Add yourself to an existing request instead.`, undefined, 'open_requests');
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
      messageCount, openRequests, openRequestCount, limits: { openRequestsPerAccount: config.limits.openRequestsPerAccount },
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
    // Render reviews are counted per requester message, across the turn's requests: the count rides in the suspended turn.
    const reviewing = clientTools.has(RENDER_TOOL);
    const reviewLimit = config.limits.renderReviewsPerTurn;
    let reviews = setup.resume?.reviews ?? 0;
    const reviewIndex = new Map<string, number>();
    // Status lines go to turns that can edit a 3D model, whose rounds can think for a minute before any text.
    const statusOn = clientTools.has(MODEL_TOOLS.applyOperations.name);
    return sseResponse(deps.log, async (send) => {
      const status = statusOn ? statusSender(line => send({ event: 'status', data: line }), { previous: t.previousStatus }) : null;
      // Anything else sent restarts the status line's silence clock.
      const emit = (e: SseEvent) => { status?.quiet(); send(e); };
      try { await body(emit, status); } finally { status?.stop(); }
    });
    async function body(emit: (e: SseEvent) => void, status: ReturnType<typeof statusSender> | null): Promise<void> {
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
      const setupMs = Math.round(generationStarted - t.timing.received);
      let firstTextMs: number | null = null;
      // On a new message to a 3D model, a fast model restates the request while this one works; the two share the text stream.
      const opening = new ReplyOpening(delta => emit({ event: 'text', data: { delta } }));
      const ackModel = statusOn && t.acknowledge ? config.models.acknowledge : null;
      let ack: RunningAcknowledgment | null = null;
      let acknowledged: Promise<Acknowledgment> | null = null;
      const say = (delta: string) => { if (opening.agent(delta)) ack?.abort(); };
      // The acknowledgment is kept as its own message straight after the requester's, never in what a model reads.
      const keepAcknowledgment = async (): Promise<Acknowledgment | null> => {
        const a = acknowledged ? await acknowledged : null;
        if (a?.text) appended.splice(t.leading.length, 0, { role: 'assistant', text: a.text, at: now().toISOString(), acknowledgment: true });
        return a;
      };
      // Every model round of the turn is metered as it completes (the credits ledger), so a failed or cut-off turn still
      // pays for the rounds that finished; the last summary tells the client whether the account has credits left.
      const turnKey = crypto.randomUUID();
      let credits = null as CreditSummary | null;
      const usagePath = usagePathOf(conversation.path === 'open' ? store.getPath() : conversation.path, editing);
      const meter = async (callId: string, call: { path: typeof usagePath; model: string; input: number; output: number; cacheRead: number; cacheWrite: number; estimated?: boolean }): Promise<void> => {
        try {
          credits = await db.creditRecord({ callId, ownerId: user.id, turnId: turnKey, conversationId: id, orgId: null, provider: 'anthropic', ...call, estimated: call.estimated === true });
        } catch (error) { deps.log?.(`turn ${id}: usage not recorded (${callId}): ${error instanceof Error ? error.message : String(error)}`); }
      };
      let result;
      try {
        const running = runTurn({
          client: anthropic, model: setup.model, system: setup.system, tools: setup.tools, handlers: t.handlers, messages: setup.messages,
          clientTools, resume: setup.resume,
          // Metering: a round that leaves the account without credits ends the turn after it (nothing is left half applied).
          afterRound: async (stat, round) => { await meter(`${turnKey}:${round}`, { path: usagePath, model: setup.model, ...usageOfRound(stat) }); return credits === null || credits.remaining > 0; },
          // A render past the limit is answered here, so the agent finishes instead of the browser drawing again.
          interceptClientCall: (toolCall) => {
            if (toolCall.name !== RENDER_TOOL) return null;
            if (reviews >= reviewLimit) return { content: RENDER_LIMIT_RESULT, isError: true };
            reviews += 1; reviewIndex.set(toolCall.id, reviews);
            return null;
          },
          // A turn that can edit the document plans multi-step geometry; help and intake stay short. Reviewing a
          // build and fixing what it shows takes more rounds.
          ...turnSettings(setup.document), ...(editing && reviewing ? { maxToolRounds: config.limits.documentToolRoundsWithReview } : {}),
          // Progress notes stay off until the hosted model accepts the progress-update display; requesting it fails editing turns.
          progressUpdates: false,
          ...(status ? { onPhase: (phase: RoundPhase) => {
            if (phase.kind === 'request') status.send(phase.round === 0 ? t.status : NEXT_STEP);
            else { const line = blockStatus(phase); if (line) status.send(line); }
          } } : {}),
          onText: (delta) => {
            firstTextMs ??= Math.round(performance.now() - generationStarted);
            say(delta);
          },
          onToolCall: (call: ToolCallEvent) => {
            if (call.invalidInput !== undefined) deps.log?.(`turn ${id}: ${call.name} input was not valid JSON, asked the model to resend: ${call.invalidInput}`);
            appended.push({ role: 'tool', name: call.name, toolUseId: call.id, input: call.input, output: call.result.content.slice(0, 8000), at: now().toISOString() });
            if (store.changed) { store.changed = false; briefEvent(); }
          },
        });
        if (ackModel && t.acknowledge) {
          opening.begin();
          ack = startAcknowledgment({ client: anthropic, model: ackModel, content: t.acknowledge, onText: delta => opening.opening(delta) });
          acknowledged = ack.done.then(a => { opening.end(); return a; });
        }
        result = await running;
      } catch (error) {
        status?.stop();
        await keepAcknowledgment();
        // A failed model call still keeps the requester's message, the tool calls and the brief the panel already shows
        // (the message budget was spent); the next turn then continues from them.
        try { await persist(); } catch (saveError) { deps.log?.(`turn ${id}: save after failure: ${saveError instanceof Error ? saveError.message : String(saveError)}`); }
        try { await recordPending(); } catch (fileError) { deps.log?.(`turn ${id}: record after failure: ${fileError instanceof Error ? fileError.message : String(fileError)}`); }
        throw error;
      }
      status?.stop();
      const generationMs = Math.round(performance.now() - generationStarted);
      const acknowledgment = await keepAcknowledgment();
      if (acknowledgment && ackModel && (acknowledgment.input || acknowledgment.output)) {
        await meter(`${turnKey}:ack`, { path: 'acknowledge', model: ackModel, input: acknowledgment.input, output: acknowledgment.output, cacheRead: 0, cacheWrite: 0 });
      }
      const reason = store.ended();
      // A turn that also ended the conversation (filed, start over) does not wait for the editor: the calls are dropped.
      const suspended = result.stop === 'client_tools' && !reason ? result.pending : null;
      // Render pictures are kept once while the turn runs: this suspension stores only those no earlier one of the turn keeps.
      const kept = suspended ? keepRenders(result.appended, setup.resume?.renders ?? new Set()) : null;
      const turn: SuspendedTurn | null = suspended && kept && setup.document ? {
        model: setup.model, system: setup.system, tools: setup.tools, context: setup.context, historyLength: setup.historyLength,
        appended: kept.appended, pending: suspended, rounds: result.rounds, document: setup.document,
        ...(reviews ? { reviews } : {}), ...(Object.keys(kept.renders).length ? { renders: kept.renders } : {}),
        ...(status?.last() ? { status: status.last()! } : {}),
      } : null;
      const cue = turn?.pending.calls.find(call => call.name === 'ui_highlight')?.input as { instruction?: unknown } | undefined;
      const replyText = result.text.trim() || typeof cue?.instruction !== 'string' ? result.text : cue.instruction.slice(0, 400);
      if (replyText !== result.text) say(replyText);
      appended.push({ role: 'assistant', text: replyText, at: now().toISOString(), ...(turn ? { turn } : {}) });
      let saved: Conversation;
      const saveStarted = performance.now();
      try { saved = conversationFromRow(await persist()); } catch (error) { throw httpErrorOf(error); }
      const saveMs = Math.round(performance.now() - saveStarted);
      if (store.getBrief() || store.getTitle()) briefEvent();
      if (reason === 'filed') await recordPending();
      else if (reason === 'added' && store.added) {
        emit({ event: 'added', data: { request: filedRequestEvent(store.added) } });
        try { await db.conversationClose(id, user.id, 'closed'); } catch (error) { deps.log?.(`turn ${id}: close after Add me: ${error instanceof Error ? error.message : String(error)}`); }
      } else if (reason === 'start_over' || reason === 'abusive') {
        // The requester asked to start over;: abusive content ends the conversation. Either way it is discarded.
        try { await db.conversationClose(id, user.id, 'discarded'); } catch (error) { deps.log?.(`turn ${id}: close (${reason}): ${error instanceof Error ? error.message : String(error)}`); }
      }
      // New fields follow cacheRead so readers of the older line keep matching. Each round: start/first/total ms and tokens.
      const phases = Object.entries(t.timing.phases).map(([name, ms]) => `${name}:${ms}`).join(',') || 'none';
      const roundLog = result.roundStats.map(r => `${r.startMs}/${r.firstMs ?? '-'}/${r.ms}ms,in${r.input},out${r.output},cr${r.cacheRead},cw${r.cacheWrite}`).join(' ');
      deps.log?.(`turn ${id}: model=${setup.model} stop=${result.stop} rounds=${result.rounds} firstTextMs=${firstTextMs ?? 'none'} generationMs=${generationMs} in=${result.usage.inputTokens} out=${result.usage.outputTokens} cacheRead=${result.usage.cacheReadTokens} cacheWrite=${result.usage.cacheWriteTokens} setupMs=${setupMs} setup=${phases}${t.timing.toolChars !== undefined ? ` toolChars=${t.timing.toolChars}` : ''} saveMs=${saveMs} rounds=[${roundLog}]${reason ? ` ended=${reason}` : ''}`);
      if (acknowledgment) deps.log?.(`acknowledge ${id}: model=${ackModel} outcome=${acknowledgment.outcome} firstMs=${acknowledgment.firstMs ?? 'none'} ms=${acknowledgment.ms} in=${acknowledgment.input} out=${acknowledgment.output} chars=${acknowledgment.text.length}${acknowledgment.error ? ` error=${acknowledgment.error.slice(0, 200)}` : ''}`);
      if (turn) emit({ event: 'tool_request', data: { calls: turn.pending.calls.map(c => {
        const index = reviewIndex.get(c.id);
        return index ? { ...c, review: { index, limit: reviewLimit } } : c;
      }) } });
      const exhausted = credits !== null && credits.remaining <= 0;
      emit({ event: 'done', data: { messageCount: saved.messageCount, limitReached: exhausted, ended: reason !== null,
        ...(exhausted ? { limitMessage: creditsExhaustedMessage(credits!) } : {}), ...(credits ? { credits } : {}),
        ...(reason ? { reason } : {}), ...(turn ? { awaitingTools: true } : {}) } });
    }
  };

  /** A new requester message: one agent turn, with document tools when the browser offers them. */
  const message = async (req: Request, id: string): Promise<Response> => {
    const timing: TurnTiming = { received: performance.now(), phases: {} };
    // The body is read while the session is checked; an unauthorized request still answers unauthorized first.
    const [who, parsed] = await Promise.allSettled([timed(timing, 'auth', session(req)), parseBody(req, messageSchema)]);
    if (who.status === 'rejected') throw who.reason;
    if (parsed.status === 'rejected') throw parsed.reason;
    const user = who.value, body = parsed.value;
    const userDb = deps.userDb(req);
    // Everything the turn needs before the model starts, at once: one database round trip of waiting instead of five.
    const loading = timed(timing, 'load', loadConversation(id, user));
    const [loaded, rate, account, issues, creditState] = await Promise.allSettled([
      loading,
      timed(timing, 'rate', enforceRate(db, user.id, config.limits.messagesPerMinute)),
      timed(timing, 'account', accountContext(user, userDb)),
      loading.then(conversation => {
        const path = conversation.path === 'open' && body.intent ? body.intent : conversation.path;
        // Help and initial routing need no tracker snapshot. Duplicate lookup stays available on demand.
        return path === 'help' || path === 'open' ? [] : timed(timing, 'issues', openIssues());
      }),
      timed(timing, 'credits', db.creditSync(user.id)),
    ]);
    // Failures are reported in the order the checks used to run one by one, so a response never depends on timing.
    if (loaded.status === 'rejected') throw loaded.reason;
    const conversation = loaded.value;
    if (conversation.status !== 'open') throw new HttpError('invalid', 'The conversation is closed; start a new one.');
    // A handoff opens a clone's chat, so it can only be the first message.
    if (body.handoff && conversation.messages.length) throw new HttpError('invalid', 'A handoff can only start a conversation.');
    if (rate.status === 'rejected') throw rate.reason;
    if (!deps.anthropic) throw new HttpError('unavailable', 'The assistant is not configured (ANTHROPIC_API_KEY missing).');
    if (account.status === 'rejected') throw account.reason;
    if (issues.status === 'rejected') throw issues.reason;
    if (creditState.status === 'rejected') throw httpErrorOf(creditState.reason);
    if (creditState.value.remaining <= 0) throw new HttpError('limit', creditsExhaustedMessage(creditState.value), creditState.value, 'credits_exhausted');
    const document = body.document && documentTools(body.document).length ? body.document : null;
    const base = turnBase(user, conversation, conversation.messageCount + 1, document, account.value, issues.value);
    // A clicked card settles an open conversation's path before the agent runs; the card label is the first message.
    const path: ConversationPath = conversation.path === 'open' && body.intent ? body.intent : conversation.path;
    const store = storeFor(user, userDb, conversation, base, path);
    const ctx: AgentContext = { ...base, path: store.getPath(), brief: store.getBrief(), title: store.getTitle() };
    const agent = agentFor(ctx.path);
    // A turn still waiting for the editor is closed with error results before the new message, so the transcript stays valid.
    const closers = closeSuspended(conversation.messages, base.now);
    const prior = [...conversation.messages, ...closers];
    const help = path === 'help' || path === 'open'
      ? `\n\n<retrieved_help>\n${retrieveUserHelp(deps.digest, body.text.slice(0, 300), ctx.screen.editor)}\n</retrieved_help>` : '';
    const context = agent.context(ctx) + help + (body.handoff ? `\n\n${handoffBlock(body.handoff)}` : '');
    const pictures = body.attachments?.length ? await timed(timing, 'pictures', messagePictures(conversation, user.id, body.attachments)) : [];
    const seen = recentHistory(prior);
    const images = await timed(timing, 'images', pictureData([...seen.messages, { role: 'user', text: body.text, at: base.now, attachments: pictures }]));
    return streamTurn({
      timing,
      user, conversation, store, handlers: agent.handlers(ctx, store), pathChanged: path !== conversation.path,
      leading: [...closers, { role: 'user', text: body.text, at: base.now, ...(pictures.length ? { attachments: pictures } : {}), ...(body.handoff ? { handoff: body.handoff } : {}) }],
      status: messageStatus(),
      ...(config.models.acknowledge ? { acknowledge: acknowledgeContent({ text: body.text, pictures: pictures.length, previousReply: previousReplyOf(prior) }) } : {}),
      setup: {
        ...turnPrompt(config.models, ctx, document), context, historyLength: prior.length, messages: historyOf(seen.messages, withOmittedNote(context, seen.omitted), body.text, pictures, images), document, resume: undefined,
      },
    });
  };

  /** The browser's answers to a suspended turn's document tool calls; the turn continues exactly where it stopped. */
  const toolResults = async (req: Request, id: string): Promise<Response> => {
    const timing: TurnTiming = { received: performance.now(), phases: {} };
    const [who, parsed] = await Promise.allSettled([timed(timing, 'auth', session(req)), parseBody(req, toolResultsSchema)]);
    if (who.status === 'rejected') throw who.reason;
    if (parsed.status === 'rejected') throw parsed.reason;
    const user = who.value, body = parsed.value;
    const userDb = deps.userDb(req);
    // As for a new message, the lookups start together and their failures are reported in a fixed order.
    const loading = timed(timing, 'load', loadConversation(id, user));
    const [loaded, account, issues] = await Promise.allSettled([loading, timed(timing, 'account', accountContext(user, userDb)),
      // As for a new message, help and initial routing need no tracker snapshot.
      loading.then(conversation => (conversation.path === 'help' || conversation.path === 'open' ? [] : timed(timing, 'issues', openIssues())))]);
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
      if (r.images?.length && turn.pending.calls.find(c => c.id === r.toolUseId)?.name !== RENDER_TOOL) throw new HttpError('invalid', `Only a ${RENDER_TOOL} result carries pictures.`);
      answers.set(r.toolUseId, { content: r.content, isError: r.isError, ...(r.images?.length ? { images: r.images } : {}) });
    }
    timing.toolChars = body.results.reduce((sum, r) => sum + r.content.length, 0);
    if (!deps.anthropic) throw new HttpError('unavailable', 'The assistant is not configured (ANTHROPIC_API_KEY missing).');
    if (account.status === 'rejected') throw account.reason;
    if (issues.status === 'rejected') throw issues.reason;
    const base = turnBase(user, conversation, conversation.messageCount, turn.document, account.value, issues.value);
    const store = storeFor(user, userDb, conversation, base, conversation.path);
    const ctx: AgentContext = { ...base, path: store.getPath(), brief: store.getBrief(), title: store.getTitle() };
    const pending = turn.pending as PendingClientTools;
    // A missed cue is not a conversational event. Persist the result without spending another model round
    // or emitting a follow-up that blames the user for not clicking; current instructions remain in chat.
    // Likewise a clone made or a clone card cancelled: the work goes on in the clone's own chat, or nothing was asked for;
    // and a publication made or its card cancelled, which the card already reports.
    const quietCue = pending.calls.length > 0 && pending.calls.every(call => {
      const answer = answers.get(call.id);
      if (call.name === CLONE_TOOL) return !!answer && !answer.isError && quietCloneAnswer(cloneAnswerOf(answer.content));
      if (call.name === PUBLISH_TOOL) return !!answer && !answer.isError && quietPublishAnswer(publishAnswerOf(answer.content));
      if (call.name !== 'ui_highlight' || !answer || answer.isError) return false;
      try { return ['expired', 'cancelled', 'dismissed'].includes((JSON.parse(answer.content) as { status?: string }).status ?? ''); }
      catch { return false; }
    });
    if (quietCue) return sseResponse(deps.log, async emit => {
      const messages: ConversationMessage[] = pending.calls.map(call => ({ role: 'tool', name: call.name, toolUseId: call.id,
        input: call.input, output: answers.get(call.id)!.content.slice(0, 8000), at: base.now }));
      const saved = conversationFromRow(await db.conversationAppend(id, user.id, messages, store.getBrief(), store.getTitle(), store.getPath(), null));
      emit({ event: 'done', data: { messageCount: saved.messageCount, limitReached: false, ended: false } });
    });
    const seen = recentHistory(conversation.messages.slice(0, turn.historyLength));
    const history = seen.messages;
    const images = await pictureData([...history, opening]);
    // The render pictures of this turn's earlier suspensions, put back into the rounds the agent saw.
    const renders = turnRenders(conversation.messages.slice(turn.historyLength));
    return streamTurn({
      timing,
      user, conversation, store, handlers: agentFor(ctx.path).handlers(ctx, store), pathChanged: false,
      status: resumeStatus(pending.calls.map(call => ({ name: call.name, isError: answers.get(call.id)?.isError ?? true }))), previousStatus: turn.status,
      // The transcript never keeps a render's pictures: its record names the views in a placeholder instead.
      leading: pending.calls.map(call => {
        const answer = answers.get(call.id);
        const output = (answer?.content ?? NOT_ANSWERED).slice(0, 8000);
        if (!answer?.images?.length) return { role: 'tool' as const, name: call.name, toolUseId: call.id, input: call.input, output, at: base.now };
        const views = renderViewNames(call.input).slice(0, answer.images.length);
        return { role: 'tool' as const, name: call.name, toolUseId: call.id, input: call.input, output: `${output}\n${renderPlaceholder(views)}`, at: base.now, views };
      }),
      setup: {
        model: turn.model, system: turn.system, tools: turn.tools as Anthropic.Tool[], context: turn.context, historyLength: turn.historyLength,
        messages: historyOf(history, withOmittedNote(turn.context, seen.omitted), opening.text, opening.attachments ?? [], images), document: turn.document,
        resume: { appended: [...restoreRenders(turn.appended as Anthropic.MessageParam[], renders), answerPending(pending, answers)], rounds: turn.rounds,
          reviews: turn.reviews ?? 0, renders: new Set(renders.keys()) },
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
      let r = /^\/conversations\/([^/]+)(?:\/(messages|tool-results|brief|file|add-me|discard|document))?$/.exec(path);
      if (r) {
        const [, id, action] = r as unknown as [string, string, string | undefined];
        if (!action && m === 'GET') return await get(req, id);
        if (action === 'messages' && m === 'POST') return await message(req, id);
        if (action === 'tool-results' && m === 'POST') return await toolResults(req, id);
        if (action === 'brief' && m === 'POST') return await setBrief(req, id);
        if (action === 'file' && m === 'POST') return await file(req, id);
        if (action === 'add-me' && m === 'POST') return await addMe(req, id);
        if (action === 'discard' && m === 'POST') return await discard(req, id);
        if (action === 'document' && m === 'POST') return await linkDocument(req, id);
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
