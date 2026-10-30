// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { parseBrief } from '../agents/brief.ts';
import { configHash } from '../config/load.ts';
import type { Config } from '../config/schema.ts';
import type {
  Brief, ChangeClass, Conversation, ConversationKind, ConversationMessage, ConversationPath, ConversationStatus, Eligibility, Kind, PanelScreen,
  Request, RequestDetail, RequesterState, Role, RoleGrant, SuspendedTurn, Treatment,
} from '../domain/types.ts';

/**
 * Typed wrappers around the SQL functions of `supabase/migrations/20261023120000_feature_requests.sql` and its fr_* follow-ups.
 * The database is reached through a minimal `Rpc` so tests inject a fake and this package never imports
 * `@supabase/supabase-js`: the Deno wrappers build the clients and wrap them with `rpcFromClient`.
 */
export interface Rpc {
  rpc(name: string, params: Record<string, unknown>): Promise<unknown>;
  /** Optional read of one table (service role only; RLS keeps browsers out): rows of `columns` where `column in values`. */
  selectIn?(table: string, columns: string, column: string, values: readonly string[]): Promise<Record<string, unknown>[]>;
}

export type DbErrorCode = 'auth' | 'forbidden' | 'invalid' | 'limit' | 'duplicate' | 'unavailable';
export class DbError extends Error {
  constructor(readonly code: DbErrorCode, message: string, override readonly cause?: unknown) { super(message); this.name = 'DbError'; }
}
/** Map a PostgREST error (`fr_auth`, `fr_forbidden`, `fr_invalid`, `fr_limit`, permission denied) to a `DbError`. */
export function dbErrorOf(error: unknown): DbError {
  if (error instanceof DbError) return error;
  const e = error as { message?: unknown; code?: unknown } | null;
  const message = typeof e?.message === 'string' ? e.message : String(error);
  const code = typeof e?.code === 'string' ? e.code : '';
  if (/\bfr_auth\b/.test(message)) return new DbError('auth', 'Sign in to continue.', error);
  if (/\bfr_forbidden\b/.test(message) || /permission denied/i.test(message) || code === '42501') return new DbError('forbidden', 'Not allowed.', error);
  if (/\bfr_limit\b/.test(message)) return new DbError('limit', 'A limit was reached.', error);
  if (/\bfr_duplicate\b/.test(message) || code === '23505') return new DbError('duplicate', 'Already recorded.', error);
  if (/\bfr_invalid\b/.test(message) || code === '23514' || code === '22P02') return new DbError('invalid', 'The request is invalid.', error);
  return new DbError('unavailable', 'The database is unavailable.', error);
}
/** The slice of a supabase-js client `rpcFromClient` needs (structural, so the import stays in the Deno wrapper). */
type PostgrestResult = { data: unknown; error: { message: string; code?: string | null } | null };
export interface PostgrestLike {
  rpc(name: string, params?: Record<string, unknown>): PromiseLike<PostgrestResult>;
  from?(table: string): { select(columns: string): { in(column: string, values: readonly string[]): PromiseLike<PostgrestResult> } };
}
export function rpcFromClient(client: PostgrestLike): Rpc {
  const run = async (call: () => PromiseLike<PostgrestResult>): Promise<unknown> => {
    let result: PostgrestResult;
    try { result = await call(); } catch (error) { throw dbErrorOf(error); }
    if (result.error) throw dbErrorOf(result.error);
    return result.data;
  };
  const rpc: Rpc = { rpc: (name, params) => run(() => client.rpc(name, params)) };
  if (client.from) {
    const from = client.from.bind(client);
    rpc.selectIn = async (table, columns, column, values) => (await run(() => from(table).select(columns).in(column, values)) as Record<string, unknown>[] | null) ?? [];
  }
  return rpc;
}

/* ---------- row shapes as the SQL functions return them (snake_case) ---------- */

export interface SqlHistoryEntry { at: string; requester_state: string; note: string | null }
/** A problem report's attachment: a screenshot the requester chose, or a copy of the active document. */
export type AttachmentKind = 'screenshot' | 'document';
export interface SqlAttachmentRow {
  id: string; conversation_id: string | null; request_id: string | null; storage_path: string; size: number; uploaded_by: string;
  kind: AttachmentKind; name: string; mime: string; uploaded_at: string | null; created_at: string;
}
export interface SqlAttachmentView { id: string; kind: AttachmentKind; name: string; mime: string; size: number; storage_path: string }
export interface SqlRequestRow {
  id: string; issue_key: string | null; issue_url: string | null; title: string; kind: string; state: string; requester_state: string;
  estimated_class: string | null; eligibility: string; trial_url: string | null; created_at: string; updated_at: string; history: SqlHistoryEntry[];
  brief?: unknown; issue_id?: string; requester_email?: string; requester_id?: string; withdrawn?: boolean; conversation_id?: string | null;
  host_id?: string; org_id?: string | null; transcript_available?: boolean;
}
export interface SqlConversationRow {
  id: string; host_id: string; org_id: string | null; owner_id: string; account_email: string; kind: string; path: string; status: string;
  title: string | null; brief: unknown; messages?: unknown; message_count: number; request_id: string | null; screen: unknown;
  started_at: string; updated_at: string; closed_at: string | null;
}
export interface SqlMyRoles {
  email: string; roles: { role: string; org_id: string | null }[]; effective: string;
  filing_disabled: boolean; builds_disabled: boolean; trials_disabled: boolean; open_requests: number;
  limits: { openRequestsPerAccount: number; messagesPerConversation: number };
}
export interface SqlOutboxRow {
  id: string; kind: string; target: string; payload: Record<string, unknown>; request_id: string | null; attempts: number;
  next_at: string; claimed_at: string | null; sent_at: string | null; failed_at: string | null; last_error: string | null; created_at: string;
}
/** `app_events` counts usage events past 180 days; absent before that migration. */
export interface SqlRetention { help_conversations: number; conversations: number; feedback: number; attachments: string[]; outbox: number; message_log: number; app_events?: number }
export interface SqlTrackerEventResult {
  applied: boolean; duplicate?: boolean; reason?: string; kind?: string; state?: string; requester_state?: string; emails?: number;
  relayed?: boolean; changed?: boolean; estimated_class?: string; eligibility?: string;
  /** F3: the Canceled branch cancels the runs and marks the request's trials `destroying`; the backend dispatches a destroy for each with that status. */
  canceled_runs?: number; destroying_trials?: SqlTrialRow[] | null;
}
/** Event shape `fr_tracker_event` accepts; `delivery_id` makes a redelivery a no-op. */
export type SqlTrackerEvent =
  | { kind: 'state'; state_name: string; actor: string; delivery_id: string; note?: string | null }
  | { kind: 'comment'; body: string; actor: string; delivery_id: string }
  | { kind: 'label'; labels: string[]; actor: string; delivery_id: string };

/* ---------- build runs (F2, migration 20261024070000_fr_runs) ---------- */

export type RunStatus = 'queued' | 'dispatched' | 'running' | 'waiting' | 'approved' | 'canceled' | 'finished';
export type RunPhase = 'design' | 'implement';
export type RunOutcome = 'pull_request' | 'needs_human' | 'failed' | 'canceled';
/** The request fields `fr_run_json` nests under `request`. */
export interface SqlRunRequest {
  id: string; host_id: string; org_id: string | null; issue_id: string; issue_key: string | null; issue_url: string | null; title: string; kind: string;
  state: string; eligibility: string; estimated_class: string | null; requester_email: string; branch: string | null; pr_number: number | null;
  pr_url: string | null; rounds: number; withdrawn: boolean;
}
/** `fr_run_json`: the `fr_runs` row (`round` is 1-based) plus its request; every run function returns this shape. */
export interface SqlRunRow {
  id: string; request_id: string; host_id: string; round: number; status: RunStatus; phase: RunPhase | null; outcome: string | null;
  created_at?: string; started_at: string | null; ended_at: string | null; dispatched_at?: string | null; heartbeat_at?: string | null; canceled_at?: string | null;
  note?: string | null; note_classes?: string[] | null; summary?: string | null; pr_number?: number | null; pr_url?: string | null;
  limitations?: string | null; trial_script?: string | null; workflow_url?: string | null; queue_position?: number | null;
  wall_seconds?: number | null; tokens_in?: number | null; tokens_out?: number | null; classes_touched?: string[] | null;
  request: SqlRunRequest;
}
export interface SqlRunNoteResult { next: 'implement' | 'wait' | 'stop'; run: SqlRunRow; emails?: number }
/** F3: `trials` are the request's live or deploying trials the cancel marked `destroying`; the backend dispatches their destroy. */
export interface SqlRunCancelResult { canceled: number; runs: SqlRunRow[]; trials?: SqlTrialRow[] | null }

/* ---------- trials (F3, migration 20261024110000_fr_trials) ---------- */

export type TrialStatus = 'pending' | 'deploying' | 'live' | 'destroying' | 'destroyed' | 'failed';
export type TrialDataKind = 'fixed' | 'supabase-branch';
/** The allow list of a trial: the requester unless eligibility is `none`, plus the configured trusted domains. */
export interface SqlTrialAllow { emails: string[]; domains: string[] }
/**
 * `fr_trial_json`, which every `fr_trial_*` function returns: the `fr_trials` row in snake_case (`to_jsonb`) plus `request`
 * (the request fields in the `fr_run_json` shape), `run` (the run's id, round, status and texts) and `allow`. Only `id`,
 * `request_id`, `run_id`, `status`, `alias`, `url`, `data_kind`, `data_branch`, `access_app_id`, `round`, `sha` and `allow`
 * are read by the backend; the rest is passed through to logs and events.
 */
export interface SqlTrialRow {
  id: string; request_id: string; run_id: string | null; host_id?: string; status: TrialStatus;
  alias: string | null; url: string | null; data_kind: TrialDataKind | null; data_branch: string | null; access_app_id: string | null;
  round: number | null; sha: string | null; requested_by?: string | null; created_at?: string; healthy_at?: string | null; expires_at: string | null;
  verdict_at?: string | null; destroyed_at?: string | null; reminder_sent_at?: string | null; destroy_reason?: string | null; dispatched_at?: string | null;
  /** F0 columns kept by the table: `reason` mirrors `destroy_reason`; `access_policy_id` is unused (the Access application id is `access_app_id`). */
  reason?: string | null; access_policy_id?: string | null;
  allow?: SqlTrialAllow | null;
  request?: SqlRunRequest | null;
  run?: { id: string; round: number; status: string; outcome?: string | null; pr_number?: number | null; pr_url?: string | null; summary?: string | null; limitations?: string | null; trial_script?: string | null } | null;
}
/** `fr_trial_request`: the trial, `created` false when the request's pending trial was returned as is. */
export interface SqlTrialRequestResult extends SqlTrialRow { created?: boolean; queued?: boolean }
/** `fr_trial_healthy`: the trial now `live`, plus `previous`, the request's live trials it replaced, now `destroying` (the backend dispatches each destroy), and the emails queued. */
export interface SqlTrialHealthyResult extends SqlTrialRow { previous?: SqlTrialRow[] | null; emails?: number }
/** `fr_trial_destroy_request`: the trial; `dispatch` false when nothing was deployed (a pending trial is destroyed at once) or a destroy was already requested. */
export interface SqlTrialDestroyRequestResult extends SqlTrialRow { dispatch?: boolean }
/** `fr_deploy_pending`: a merged request that has not shipped, with its pull request's merge commit. */
export interface SqlDeployPending { request_id: string; issue_key: string | null; merge_commit: string }
/** `fr_deploy_shipped`: whether this report shipped the request, and the issue to move to Done. */
export interface SqlDeployShipped {
  shipped: boolean; reason?: 'already_shipped' | 'canceled'; issue_id: string; issue_key?: string | null; previous_state?: string; emails?: number;
}
/** `fr_trial_sweep`: how many Reminder emails were queued and the live trials just marked `destroying` by expiry or the verdict grace. */
export interface SqlTrialSweepResult { reminders: number; expiring: SqlTrialRow[] }
/** Boundaries as `fr_run_boundaries` builds them (the requester's automatic ceiling; maintainers use the maintainer ceiling). */
export interface SqlRunBoundaries { treatments: Record<ChangeClass, Treatment>; ceiling: ChangeClass; size: { maxFiles: number; maxLines: number }; paths: Partial<Record<ChangeClass, string[]>> }
export interface SqlRunForBranch extends SqlRunRow { design_review_approved: boolean; boundaries: SqlRunBoundaries }
/**
 * `fr_run_payload`: the dispatch payload (brief §Dispatch payload) in camelCase, with `body` null (the backend fills it from
 * the tracker) and without `token` and `jobsUrl`, which the backend adds.
 */
export interface SqlRunPayload {
  runId: string; requestId: string; hostId: string; status: RunStatus; outcome?: string | null; issueKey: string | null; issueId: string; issueUrl: string | null;
  title: string; body: string | null; kind: string; branch: string; defaultBranch: string; round: number; phase: RunPhase; boundaries: SqlRunBoundaries;
  checks: string[]; instructionsFile: string; budget: { wallClockMinutes: number; usd: number }; models: { build: string }; designNote: string | null; feedback: unknown[];
}

/* ---------- camelCase views (HTTP contract) ---------- */

export interface MeView {
  email: string; roles: RoleGrant[]; effective: Role; filingDisabled: boolean; buildsDisabled: boolean; trialsDisabled: boolean;
  openRequests: number; limits: { openRequestsPerAccount: number; messagesPerConversation: number };
}
export interface OpenConversationView { id: string; kind: ConversationKind; path: ConversationPath; title: string | null; updatedAt: string; messageCount: number }

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const asRecord = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
export function requestFromRow(row: SqlRequestRow): Request {
  return {
    id: row.id, issueKey: row.issue_key ?? '', issueUrl: row.issue_url ?? '', title: row.title, kind: row.kind as Kind, state: row.state,
    requesterState: row.requester_state as RequesterState, estimatedClass: (row.estimated_class as ChangeClass | null) ?? null,
    eligibility: row.eligibility as Eligibility, trialUrl: row.trial_url ?? null, createdAt: row.created_at, updatedAt: row.updated_at,
    history: (row.history ?? []).map(h => ({ at: h.at, requesterState: h.requester_state as RequesterState, note: h.note ?? null })),
  };
}
export function requestDetailFromRow(row: SqlRequestRow): RequestDetail {
  return { ...requestFromRow(row), brief: parseBrief(row.brief), transcriptAvailable: row.transcript_available ?? false };
}
/** Stored messages are validated loosely: anything that is not a known shape is dropped rather than failing the whole conversation. */
export function messagesFromRows(value: unknown): ConversationMessage[] {
  if (!Array.isArray(value)) return [];
  const out: ConversationMessage[] = [];
  for (const m of value) {
    const r = asRecord(m); if (!r) continue;
    if (r['role'] === 'user' && typeof r['text'] === 'string') out.push({ role: 'user', text: r['text'], at: str(r['at']) });
    else if (r['role'] === 'assistant' && typeof r['text'] === 'string') {
      const turn = asRecord(r['turn']);
      out.push({ role: 'assistant', text: r['text'], at: str(r['at']), ...(turn ? { turn: turn as unknown as SuspendedTurn } : {}) });
    }
    else if (r['role'] === 'tool' && typeof r['name'] === 'string') out.push({ role: 'tool', name: r['name'], toolUseId: str(r['toolUseId']), input: r['input'], output: str(r['output']), at: str(r['at']) });
  }
  return out;
}
export function screenFromRow(value: unknown): PanelScreen | null {
  const r = asRecord(value); if (!r) return null;
  const build = asRecord(r['build']);
  const editor = r['editor'] === 'home' || r['editor'] === 'model' || r['editor'] === 'layout' ? r['editor'] : 'home';
  const screen: PanelScreen = { editor, build: { version: str(build?.['version']), commit: str(build?.['commit']) }, browser: str(r['browser']), os: str(r['os']) };
  if (typeof r['documentType'] === 'string') screen.documentType = r['documentType'];
  return screen;
}
export function conversationFromRow(row: SqlConversationRow): Conversation {
  return {
    id: row.id, kind: row.kind as ConversationKind, path: row.path as ConversationPath, status: row.status as ConversationStatus, title: row.title ?? null,
    brief: parseBrief(row.brief), messages: messagesFromRows(row.messages), messageCount: row.message_count, requestId: row.request_id ?? null,
    screen: screenFromRow(row.screen), startedAt: row.started_at, updatedAt: row.updated_at,
  };
}
export function meFromRow(row: SqlMyRoles, config: Config): MeView {
  return {
    email: row.email, roles: row.roles.map(r => ({ role: r.role as RoleGrant['role'], orgId: r.org_id ?? null })), effective: row.effective as Role,
    filingDisabled: row.filing_disabled, buildsDisabled: row.builds_disabled, trialsDisabled: row.trials_disabled, openRequests: row.open_requests,
    limits: { openRequestsPerAccount: config.limits.openRequestsPerAccount, messagesPerConversation: config.limits.messagesPerConversation },
  };
}

/* ---------- service-role functions ---------- */

export interface FileRequestInput {
  conversationId: string; ownerId: string; email: string; kind: Kind; title: string; brief: Brief; estimatedClass: ChangeClass | null;
  eligibility: Eligibility; issueId: string; issueKey: string; issueUrl: string; client: Record<string, unknown> | null;
}
/** Functions the pipeline backend calls with the service-role key; accounts arrive as explicit parameters. */
export class ServiceDb {
  constructor(readonly rpc: Rpc) {}
  private call<T>(name: string, params: Record<string, unknown>): Promise<T> { return this.rpc.rpc(name, params) as Promise<T>; }

  /** Upsert the host row with the validated config and its config grants. */
  async applyConfig(config: Config): Promise<{ host: Record<string, unknown>; granted: { email: string; role: string }[] }> {
    return this.call('fr_apply_config', {
      p_host: config.host, p_name: config.name, p_config_hash: await configHash(config), p_default_role: config.roles.defaultRole,
      p_admins: config.roles.admins, p_maintainers: config.roles.maintainers, p_config: config,
    });
  }
  conversationStart(host: string, ownerId: string, email: string, kind: ConversationKind, path: ConversationPath, screen: PanelScreen): Promise<SqlConversationRow> {
    return this.call('fr_conversation_start', { p_host: host, p_owner: ownerId, p_email: email, p_kind: kind, p_path: path, p_screen: screen });
  }
  conversationGet(id: string, ownerId: string): Promise<SqlConversationRow> { return this.call('fr_conversation_get', { p_id: id, p_owner: ownerId }); }
  conversationListOpen(host: string, ownerId: string): Promise<SqlConversationRow[]> { return this.call('fr_conversation_list_open', { p_host: host, p_owner: ownerId }); }
  /**
   * Appends a turn; `brief`, `title`, `path` and `kind` replace the stored values when not null (limit raised as
   * `fr_limit`). `kind` moves a conversation that started open to `help` once the agent settles on help, so the
   * help retention applies; it is sent only when given (migration 20261024060000 added the optional `p_kind`).
   */
  conversationAppend(id: string, ownerId: string, messages: ConversationMessage[], brief: Brief | null, title: string | null, path: ConversationPath | null, kind: ConversationKind | null = null): Promise<SqlConversationRow> {
    return this.call('fr_conversation_append', { p_id: id, p_owner: ownerId, p_messages: messages, p_brief: brief, p_title: title, p_path: path, ...(kind ? { p_kind: kind } : {}) });
  }
  conversationClose(id: string, ownerId: string, status: Exclude<ConversationStatus, 'open'>): Promise<SqlConversationRow> {
    return this.call('fr_conversation_close', { p_id: id, p_owner: ownerId, p_status: status });
  }
  /** Records one message; false when the account sent more than `limit` in the last minute. */
  rateCheck(ownerId: string, limit: number): Promise<boolean> { return this.call('fr_rate_check', { p_owner: ownerId, p_limit: limit }); }
  requestCountOpen(ownerId: string): Promise<number> { return this.call('fr_request_count_open', { p_owner: ownerId }); }
  requestFile(input: FileRequestInput): Promise<SqlRequestRow> {
    return this.call('fr_request_file', {
      p_conversation: input.conversationId, p_owner: input.ownerId, p_email: input.email, p_kind: input.kind, p_title: input.title, p_brief: input.brief,
      p_estimated_class: input.estimatedClass, p_eligibility: input.eligibility, p_issue_id: input.issueId, p_issue_key: input.issueKey,
      p_issue_url: input.issueUrl, p_client: input.client,
    });
  }
  /** Subscribes the account to a request of `host`; the row comes back in the requester-facing shape (no brief, no requester identity). */
  requestAddMe(host: string, requestId: string, ownerId: string, email: string, notes: string): Promise<SqlRequestRow> {
    return this.call('fr_request_add_me', { p_host: host, p_request: requestId, p_owner: ownerId, p_email: email, p_notes: notes });
  }
  trackerEvent(host: string, issueId: string, event: SqlTrackerEvent): Promise<SqlTrackerEventResult> {
    return this.call('fr_tracker_event', { p_host: host, p_issue_id: issueId, p_event: event });
  }
  outboxEnqueue(kind: string, target: string, payload: Record<string, unknown>, requestId: string | null): Promise<string> {
    return this.call('fr_outbox_enqueue', { p_kind: kind, p_target: target, p_payload: payload, p_request: requestId });
  }
  outboxClaim(limit: number): Promise<SqlOutboxRow[]> { return this.call('fr_outbox_claim', { p_limit: limit }); }
  outboxDone(id: string): Promise<void> { return this.call('fr_outbox_done', { p_id: id }); }
  outboxFail(id: string, error: string): Promise<void> { return this.call('fr_outbox_fail', { p_id: id, p_error: error.slice(0, 4000) }); }
  retentionSweep(): Promise<SqlRetention> { return this.call('fr_retention_sweep', {}); }
  /** Record an attachment the owner is about to upload to their open conversation (at most 5). */
  attachmentAdd(conversationId: string, ownerId: string, input: { kind: AttachmentKind; name: string; mime: string; size: number; path: string }): Promise<SqlAttachmentRow> {
    return this.call('fr_attachment_add', { p_conversation: conversationId, p_owner: ownerId, p_kind: input.kind, p_name: input.name, p_mime: input.mime, p_size: input.size, p_path: input.path });
  }
  attachmentRemove(conversationId: string, id: string, ownerId: string): Promise<void> { return this.call('fr_attachment_remove', { p_conversation: conversationId, p_id: id, p_owner: ownerId }); }
  attachmentComplete(id: string, ownerId: string): Promise<SqlAttachmentRow> { return this.call('fr_attachment_complete', { p_id: id, p_owner: ownerId }); }
  attachmentList(conversationId: string): Promise<SqlAttachmentRow[]> { return this.call('fr_attachment_list', { p_conversation: conversationId }); }
  /** Moves a filed conversation's uploaded attachments to its request; returns the paths of ones never uploaded, now removed. */
  attachmentBind(conversationId: string): Promise<{ request_id: string; removed: string[] }> { return this.call('fr_attachment_bind', { p_conversation: conversationId }); }
  recordEvent(host: string, requestId: string | null, actor: string, kind: string, payload: Record<string, unknown>): Promise<string> {
    return this.call('fr_record_event', { p_host: host, p_request: requestId, p_actor: actor, p_kind: kind, p_payload: payload });
  }
  /** A delivery that failed verification; the SQL folds a source's rejections within a minute into one row. */
  webhookRejected(host: string, source: 'linear' | 'github', reason: string): Promise<void> {
    return this.call('fr_webhook_rejected', { p_host: host, p_source: source, p_reason: reason });
  }
  eligibility(host: string, orgId: string | null, email: string, cls: ChangeClass | null): Promise<Eligibility> {
    return this.call('fr_eligibility', { p_host: host, p_org: orgId, p_email: email, p_class: cls });
  }
  /* ----- build runs (F2); thin wrappers so a signature change is a one-line fix ----- */
  /** Create (or return the active) run of a request; sets the branch on the first run and queues the position comment. */
  runEnqueue(host: string, requestId: string, actor: string): Promise<SqlRunRow & { created: boolean }> { return this.call('fr_run_enqueue', { p_host: host, p_request: requestId, p_actor: actor }); }
  /** Approved runs (phase `implement`) then queued runs (phase `design`) within the limits, now `dispatched`; the sweeper sends each. */
  runAdmit(host: string): Promise<SqlRunRow[]> { return this.call('fr_run_admit', { p_host: host }); }
  /** Records the phase start; the SQL queues the comment and the In progress move itself. Status stays canceled/finished when the run ended. */
  runStarted(runId: string, phase: RunPhase, workflowUrl: string | null): Promise<SqlRunRow> { return this.call('fr_run_started', { p_run: runId, p_phase: phase, p_url: workflowUrl }); }
  /** Stores the design note; the SQL queues the comment, the state move and the email and answers what the runner does next. */
  runNote(runId: string, note: string, classes: string[], decision: string): Promise<SqlRunNoteResult> {
    return this.call('fr_run_note', { p_run: runId, p_note: note, p_classes: classes, p_decision: decision });
  }
  /** Records usage and the pull request; the SQL queues the end-of-run comment, Needs human and the email. */
  runFinished(runId: string, input: { outcome: RunOutcome; usage: { inputTokens: number; outputTokens: number; wallSeconds: number }; prNumber: number | null; prUrl: string | null; summary: string | null; limitations: string | null; trialScript: string | null; classes: string[] }): Promise<SqlRunRow & { emails?: number }> {
    return this.call('fr_run_finished', {
      p_run: runId, p_outcome: input.outcome, p_usage: input.usage, p_pr_number: input.prNumber, p_pr_url: input.prUrl, p_summary: input.summary,
      p_limitations: input.limitations, p_trial_script: input.trialScript, p_classes: input.classes,
    });
  }
  /** Records the heartbeat and returns the run status, so runners notice a cancel. */
  runHeartbeat(runId: string): Promise<RunStatus> { return this.call('fr_run_heartbeat', { p_run: runId }); }
  /** Cancel every active run of a request; the caller closes `runs[i].pr_number`. */
  runCancel(requestId: string, reason: string): Promise<SqlRunCancelResult> { return this.call('fr_run_cancel', { p_request: requestId, p_reason: reason }); }
  /** Dispatch failed: back to `queued` with the error on the audit trail. */
  runRequeue(runId: string, error: string): Promise<unknown> { return this.call('fr_run_requeue', { p_run: runId, p_error: error.slice(0, 4000) }); }
  /** Canceled runs whose draft pull request still has to be closed. */
  runsPrToClose(host: string): Promise<SqlRunRow[]> { return this.call('fr_runs_pr_to_close', { p_host: host }); }
  runPrClosed(runId: string): Promise<void> { return this.call('fr_run_pr_closed', { p_run: runId }).then(() => undefined); }
  runForBranch(host: string, branch: string): Promise<SqlRunForBranch | null> { return this.call('fr_run_for_branch', { p_host: host, p_branch: branch }); }
  /** Merged requests that have not shipped yet. */
  deployPending(host: string): Promise<SqlDeployPending[]> { return this.call('fr_deploy_pending', { p_host: host }); }
  /** A production deploy of `commit` contains the request's merge; ships it once. */
  deployShipped(host: string, requestId: string, commit: string, version: string | null): Promise<SqlDeployShipped> {
    return this.call('fr_deploy_shipped', { p_host: host, p_request: requestId, p_commit: commit, p_version: version });
  }
  /** Queue the Build move for `eligible:auto` requests past the 10-minute window; returns how many. */
  approvalSweep(host: string): Promise<number> { return this.call('fr_approval_sweep', { p_host: host }); }
  runPayload(runId: string): Promise<SqlRunPayload> { return this.call('fr_run_payload', { p_run: runId }); }
  /* ----- trials (F3); thin wrappers, parameter names as the brief fixes them ----- */
  /** Create (or return the pending) trial of the request's active run; `needsBranch` asks for a preview data branch within the cap. */
  trialRequest(host: string, requestId: string, sha: string, needsBranch: boolean, actor: string): Promise<SqlTrialRequestResult> {
    return this.call('fr_trial_request', { p_host: host, p_request: requestId, p_sha: sha, p_needs_branch: needsBranch, p_actor: actor });
  }
  /** Pending trials that may dispatch now (branch cap), marked `deploying`; the sweeper dispatches `feature-trial` for each. */
  trialAdmit(host: string): Promise<SqlTrialRow[]> { return this.call('fr_trial_admit', { p_host: host }); }
  /** The deploy job passed its health check: `live`, expiry set, In Trial, Ready to try or Updated trial queued; `previous` lists the live trials to destroy. */
  trialHealthy(trialId: string, url: string, accessAppId: string | null, dataBranch: string | null, expiresAt: string): Promise<SqlTrialHealthyResult> {
    return this.call('fr_trial_healthy', { p_trial: trialId, p_url: url, p_access_app_id: accessAppId, p_data_branch: dataBranch, p_expires_at: expiresAt });
  }
  /** Mark a deployed trial `destroying` with the reason (`expired`, `verdict`, `merged`, `canceled`, `replaced`, `failed`); the caller dispatches the destroy when `dispatch` is true. */
  trialDestroyRequest(trialId: string, reason: string): Promise<SqlTrialDestroyRequestResult> { return this.call('fr_trial_destroy_request', { p_trial: trialId, p_reason: reason }); }
  /** The destroy job reported: `destroyed`, comment on the issue; `expired` without a verdict also moves the issue to Needs Human and queues the Expired email. */
  trialDestroyed(trialId: string, reason: string): Promise<SqlTrialRow> { return this.call('fr_trial_destroyed', { p_trial: trialId, p_reason: reason }); }
  /** A `feature-trial` dispatch failed: back to `pending` with the error on the audit trail (`fr_trial_requeue`, added by the integrator). */
  trialRequeue(trialId: string, error: string): Promise<unknown> { return this.call('fr_trial_requeue', { p_trial: trialId, p_error: error.slice(0, 4000) }); }
  /** Queue reminders for trials expiring within 24 h and mark expired ones (and verdict-grace ones) `destroying`. */
  trialSweep(host: string): Promise<SqlTrialSweepResult> { return this.call('fr_trial_sweep', { p_host: host }); }
  /** Whether `email` may use the trial (allow list or trusted domain). */
  trialAllowed(trialId: string, email: string): Promise<boolean> { return this.call('fr_trial_allowed', { p_trial: trialId, p_email: email }); }
  trialAllowList(trialId: string): Promise<SqlTrialAllow> { return this.call('fr_trial_allow_list', { p_trial: trialId }); }
  /** The data store's auth hook: true for a trusted domain or an address on the allow list of any live or deploying trial of the host. */
  authHookAllowed(host: string, email: string): Promise<boolean> { return this.call('fr_auth_hook_allowed', { p_host: host, p_email: email }); }
  /** The run's current trial (for `GET /jobs/:runId` and the merge branch), or null. */
  trialForRun(runId: string): Promise<SqlTrialRow | null> { return this.call('fr_trials_for_run', { p_run: runId }); }
  /** Trials in `statuses` with the columns the destroy catch-up reads; empty when the Rpc cannot read tables. */
  async trialsByStatus(host: string, statuses: readonly TrialStatus[]): Promise<SqlTrialRow[]> {
    if (!this.rpc.selectIn) return [];
    const rows = await this.rpc.selectIn('fr_trials', 'id,request_id,run_id,status,alias,url,data_kind,data_branch,access_app_id,round,sha,expires_at,destroy_reason,dispatched_at', 'status', statuses);
    return (rows as unknown as (SqlTrialRow & { host_id?: string })[]).filter(r => !r.host_id || r.host_id === host);
  }
  /** Ids of the trials among `trialIds` whose `fr_events` row of `kind` names them in `payload.trial_id`; empty without table access. */
  async trialsWithEvent(kind: string, trials: readonly Pick<SqlTrialRow, 'id' | 'request_id'>[]): Promise<Set<string>> {
    const out = new Set<string>();
    if (!this.rpc.selectIn || trials.length === 0) return out;
    const ids = new Set(trials.map(t => t.id));
    const rows = await this.rpc.selectIn('fr_events', 'request_id,kind,payload', 'request_id', [...new Set(trials.map(t => t.request_id))]);
    for (const r of rows) {
      const trialId = (r['payload'] as { trial_id?: unknown } | null)?.trial_id;
      if (r['kind'] === kind && typeof trialId === 'string' && ids.has(trialId)) out.add(trialId);
    }
    return out;
  }
  /** Runs in `statuses` with the columns the stuck-run check reads; empty when the Rpc cannot read tables. */
  async runsByStatus(host: string, statuses: readonly RunStatus[]): Promise<Omit<SqlRunRow, 'request'>[]> {
    if (!this.rpc.selectIn) return [];
    const rows = await this.rpc.selectIn('fr_runs', 'id,request_id,round,status,phase,started_at,dispatched_at,heartbeat_at,host_id', 'status', statuses);
    return (rows as unknown as Omit<SqlRunRow, 'request'>[]).filter(r => !r.host_id || r.host_id === host);
  }
  /** Pipeline request ids of tracker issues (for Add me); empty when the Rpc cannot read tables. */
  async requestsByIssueIds(host: string, issueIds: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!this.rpc.selectIn || issueIds.length === 0) return out;
    const rows = await this.rpc.selectIn('fr_requests', 'id,issue_id,host_id', 'issue_id', issueIds);
    for (const r of rows) if (r['host_id'] === host && typeof r['id'] === 'string' && typeof r['issue_id'] === 'string') out.set(r['issue_id'], r['id']);
    return out;
  }
}

/* ---------- user-scoped functions (run under RLS as the signed-in account) ---------- */

/** Functions that must run as the account itself, through a client carrying the session's Authorization header. */
export class UserDb {
  constructor(readonly rpc: Rpc) {}
  private call<T>(name: string, params: Record<string, unknown>): Promise<T> { return this.rpc.rpc(name, params) as Promise<T>; }
  myRoles(host: string): Promise<SqlMyRoles> { return this.call('fr_my_roles', { p_host: host }); }
  listMyRequests(host: string): Promise<SqlRequestRow[]> { return this.call('fr_list_my_requests', { p_host: host }); }
  getRequest(id: string): Promise<SqlRequestRow> { return this.call('fr_get_request', { p_id: id }); }
  /** One uploaded attachment, when the session is its requester or a maintainer of its scope. */
  attachmentGet(id: string): Promise<SqlAttachmentView> { return this.call('fr_attachment_get', { p_id: id }); }
  withdraw(id: string): Promise<SqlRequestRow> { return this.call('fr_withdraw', { p_id: id }); }
  reply(id: string, text: string): Promise<{ ok: boolean; outbox_id: string; request: SqlRequestRow }> { return this.call('fr_reply', { p_id: id, p_text: text }); }
  grantRole(host: string, orgId: string | null, email: string, role: string): Promise<Record<string, unknown>> {
    return this.call('fr_grant_role', { p_host: host, p_org: orgId, p_email: email, p_role: role });
  }
  revokeRole(host: string, orgId: string | null, email: string, role: string): Promise<Record<string, unknown>> {
    return this.call('fr_revoke_role', { p_host: host, p_org: orgId, p_email: email, p_role: role });
  }
  setDisabled(host: string, orgId: string | null, part: 'filing' | 'builds' | 'trials' | 'all', disabled: boolean): Promise<Record<string, unknown>> {
    return this.call('fr_set_disabled', { p_host: host, p_org: orgId, p_part: part, p_disabled: disabled });
  }
}
