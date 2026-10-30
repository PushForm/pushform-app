// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Tracker, TrackerEvent, TrackerIssue, TrackerIssueInput, WebhookInput } from '../adapters/tracker.ts';
import { TrackerError } from '../adapters/tracker.ts';
import type { SessionUser, SessionValidator } from './auth.ts';
import type { AttachmentStorage } from './conversation.ts';
import { DbError, type Rpc, type SqlAttachmentRow, type SqlConversationRow, type SqlMyRoles, type SqlRequestRow, type SqlTrialRow } from './db.ts';

/** Test doubles for the backend handlers: a scripted Rpc, an in-memory tracker, and a session validator. Not exported from the package. */
export interface RpcCall { name: string; params: Record<string, unknown> }
export type RpcHandler = (params: Record<string, unknown>, call: number) => unknown;
/** A scripted value, or a handler computing one from the params and the ordinal of this call. */
export type RpcScript = RpcHandler | object | string | number | boolean | null;
export class FakeRpc implements Rpc {
  readonly calls: RpcCall[] = [];
  readonly selects: { table: string; column: string; values: readonly string[] }[] = [];
  tables: Record<string, Record<string, unknown>[]> = {};
  constructor(readonly handlers: Record<string, RpcScript> = {}, readonly label = 'rpc') {}
  async rpc(name: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ name, params });
    if (!(name in this.handlers)) throw new DbError('unavailable', `${this.label}: no handler for ${name}`);
    const h = this.handlers[name];
    const value = typeof h === 'function' ? (h as RpcHandler)(params, this.calls.filter(c => c.name === name).length) : h;
    return value instanceof Promise ? value : value;
  }
  async selectIn(table: string, _columns: string, column: string, values: readonly string[]): Promise<Record<string, unknown>[]> {
    this.selects.push({ table, column, values });
    return (this.tables[table] ?? []).filter(r => values.includes(String(r[column])));
  }
  named(name: string): RpcCall[] { return this.calls.filter(c => c.name === name); }
}
/** Raise the SQL error names the functions use (`fr_auth`, `fr_forbidden`, `fr_invalid`, `fr_limit`). */
export function sqlError(name: 'fr_auth' | 'fr_forbidden' | 'fr_invalid' | 'fr_limit' | 'fr_duplicate' | 'permission denied for function fr_x'): never {
  throw new DbError(name === 'fr_auth' ? 'auth' : name === 'fr_limit' ? 'limit' : name === 'fr_invalid' ? 'invalid' : name === 'fr_duplicate' ? 'duplicate' : 'forbidden', name);
}

export const ALICE: SessionUser = { id: '11111111-1111-4111-8111-111111111111', email: 'alice@example.com' };
export const TOKEN = 'jwt-alice';
export class FakeSessions implements SessionValidator {
  constructor(readonly users: Record<string, SessionUser> = { [TOKEN]: ALICE }) {}
  async getUser(token: string): Promise<SessionUser | null> { return this.users[token] ?? null; }
}

export const CONVERSATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const REQUEST_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export function conversationRow(over: Partial<SqlConversationRow> = {}): SqlConversationRow {
  return {
    id: CONVERSATION_ID, host_id: 'pushform', org_id: null, owner_id: ALICE.id, account_email: ALICE.email, kind: 'intake', path: 'feature', status: 'open',
    title: null, brief: null, messages: [], message_count: 0, request_id: null,
    screen: { editor: 'model', documentType: 'model', build: { version: '0.3.0', commit: 'abc123' }, browser: 'Chrome 141', os: 'macOS 15' },
    started_at: '2026-10-23T10:00:00Z', updated_at: '2026-10-23T10:00:00Z', closed_at: null, ...over,
  };
}
export const ATTACHMENT_ID = '44444444-4444-4444-8444-444444444444';
export function attachmentRow(over: Partial<SqlAttachmentRow> = {}): SqlAttachmentRow {
  return {
    id: ATTACHMENT_ID, request_id: null, conversation_id: CONVERSATION_ID, storage_path: `${ALICE.id}/${CONVERSATION_ID}/a-shot.png`, size: 2048,
    uploaded_by: ALICE.id, kind: 'screenshot', name: 'shot.png', mime: 'image/png', uploaded_at: '2026-10-23T10:20:00Z', created_at: '2026-10-23T10:19:00Z', ...over,
  };
}
/** The `fr-attachments` bucket in memory: objects are their sizes. */
export class FakeStorage implements AttachmentStorage {
  async read(path: string): Promise<Blob> {
    const size = this.objects.get(path);
    if (size === undefined) throw new Error('missing image');
    return new Blob([new Uint8Array(size)]);
  }
  readonly objects = new Map<string, number>();
  readonly removed: string[] = [];
  async uploadUrl(path: string): Promise<string> { return `https://storage.test/upload/${path}?token=t`; }
  async size(path: string): Promise<number | null> { return this.objects.get(path) ?? null; }
  async downloadUrl(path: string, seconds: number): Promise<string> { return `https://storage.test/sign/${path}?expires=${seconds}`; }
  async remove(paths: readonly string[]): Promise<void> { for (const p of paths) { this.objects.delete(p); this.removed.push(p); } }
}
export function requestRow(over: Partial<SqlRequestRow> = {}): SqlRequestRow {
  return {
    id: REQUEST_ID, issue_key: 'FRQ-123', issue_url: 'https://linear.app/pushform/issue/FRQ-123', title: 'Lock inference with Shift', kind: 'feature', state: 'Triage',
    requester_state: 'Submitted', estimated_class: 'C3', eligibility: 'none', trial_url: null, created_at: '2026-10-23T10:05:00Z', updated_at: '2026-10-23T10:05:00Z',
    history: [{ at: '2026-10-23T10:05:00Z', requester_state: 'Submitted', note: 'Filed' }],
    brief: { kind: 'feature', problem: 'I cannot lock the inference direction', workaround: null, desired: 'Hold Shift to lock it', acceptance: [], mustNotChange: null, area: 'Modeling', importance: null, estimatedClass: 'C3' },
    issue_id: 'iss-1', requester_email: ALICE.email, requester_id: ALICE.id, withdrawn: false, conversation_id: CONVERSATION_ID, host_id: 'pushform', org_id: null, transcript_available: true,
    ...over,
  };
}
export function myRoles(over: Partial<SqlMyRoles> = {}): SqlMyRoles {
  return { email: ALICE.email, roles: [], effective: 'user', filing_disabled: false, builds_disabled: false, trials_disabled: false, open_requests: 0, limits: { openRequestsPerAccount: 5, messagesPerConversation: 30 }, ...over };
}

export const TRIAL_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
export const RUN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
/** A trial json row as `fr_trial_*` return it (snake_case, with the allow list). */
export function trialRow(over: Partial<SqlTrialRow> = {}): SqlTrialRow {
  return {
    id: TRIAL_ID, request_id: REQUEST_ID, run_id: RUN_ID, host_id: 'pushform', status: 'pending', alias: 'frq-frq-123-lock-inference', url: null, data_kind: 'fixed', data_branch: null,
    access_app_id: null, round: 1, sha: 'abc123def4567890', expires_at: null, destroy_reason: null, dispatched_at: null, allow: { emails: [ALICE.email], domains: ['pushform.io'] }, ...over,
  };
}

/** An in-memory tracker with configurable state names and failure modes. */
export class FakeTracker implements Tracker {
  issues: TrackerIssue[] = [];
  comments: { issueId: string; body: string }[] = [];
  states: { issueId: string; stateName: string }[] = [];
  labelSets: { issueId: string; labels: string[] }[] = [];
  created: TrackerIssueInput[] = [];
  stateNames = ['Triage', 'Build', 'Design review', 'In Progress', 'In Trial', 'Needs Human', 'Ready for Review', 'Done', 'Canceled'];
  projectNames = ['Customer Features', 'Defects'];
  failCreate: TrackerError | null = null;
  verify = true;
  private seq = 0;
  uploadedImages: { name: string; mime: string; size: number }[] = [];
  async uploadImage(name: string, mime: string, bytes: Blob): Promise<string> {
    this.uploadedImages.push({ name, mime, size: bytes.size });
    return `https://uploads.linear.app/image-${this.uploadedImages.length}`;
  }
  async createIssue(input: TrackerIssueInput): Promise<TrackerIssue> {
    if (this.failCreate) throw this.failCreate;
    this.created.push(input);
    const n = ++this.seq;
    const issue: TrackerIssue = { id: `iss-${n}`, key: `FRQ-${100 + n}`, url: `https://linear.app/pushform/issue/FRQ-${100 + n}`, title: input.title, state: 'Triage', labels: [...input.labels], body: input.body };
    this.issues.push(issue);
    return issue;
  }
  async addComment(issueId: string, body: string): Promise<{ id: string }> { this.comments.push({ issueId, body }); return { id: `cmt-${this.comments.length}` }; }
  async setState(issueId: string, stateName: string): Promise<void> {
    if (!this.stateNames.includes(stateName)) throw new TrackerError('invalid', `Linear state "${stateName}" does not exist`);
    this.states.push({ issueId, stateName });
  }
  async setLabels(issueId: string, labels: readonly string[]): Promise<void> {
    this.labelSets.push({ issueId, labels: [...labels] });
    const issue = this.issues.find(i => i.id === issueId); if (issue) issue.labels = [...labels];
  }
  async getIssue(issueId: string): Promise<TrackerIssue | null> { return this.issues.find(i => i.id === issueId) ?? null; }
  async searchOpen(query: string): Promise<TrackerIssue[]> { const q = query.toLowerCase(); return this.issues.filter(i => !q || i.title.toLowerCase().includes(q)); }
  async listStateNames(): Promise<string[]> { return [...this.stateNames]; }
  async listProjectNames(): Promise<string[]> { return [...this.projectNames]; }
  async verifyWebhook(_input: WebhookInput): Promise<boolean> { return this.verify; }
  parseWebhook(_input: WebhookInput): TrackerEvent | null { return null; }
}
