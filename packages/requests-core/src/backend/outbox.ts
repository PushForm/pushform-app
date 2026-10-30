// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Mail } from '../adapters/mail.ts';
import type { Tracker } from '../adapters/tracker.ts';
import type { Config } from '../config/schema.ts';
import type { LinearStateKey } from '../domain/types.ts';
import { receivesTemplate, renderMail, type MailTemplatePayload, type RequestMailView, type TrialMailData } from '../mail/templates.ts';
import { requestDetailFromRow, type SqlOutboxRow, type SqlRequestRow } from './db.ts';

/**
 * Outbox delivery: rows the SQL functions queue are delivered to the mail and tracker
 * adapters here. Kinds follow the `fr_outbox.kind` check constraint; `tracker_labels` is accepted as a
 * spelling of `tracker_label`. Historical worker, label and preview-state deliveries are suppressed.
 */
export type OutboxKind = 'email' | 'tracker_comment' | 'tracker_state' | 'tracker_label' | 'tracker_labels' | 'dispatch' | 'storage_remove';
export interface OutboxItem { id: string; kind: OutboxKind; target: string; payload: Record<string, unknown>; requestId: string | null; attempts: number }
export function outboxItemOf(row: SqlOutboxRow): OutboxItem {
  return { id: row.id, kind: row.kind as OutboxKind, target: row.target, payload: row.payload ?? {}, requestId: row.request_id ?? null, attempts: row.attempts };
}

export interface DeliveryDeps {
  storage?: { remove(paths: string[]): Promise<void> } | null | undefined;
  tracker: Tracker | null;
  mail: Mail | null;
  config: Config;
  /** Product URL retained for historical mail-view compatibility; customer notifications show plain ticket references. */
  appUrl: string;
  /** Override of `renderMail`, for tests. */
  render?: typeof renderMail | undefined;
}
export type DeliveryOutcome = { outcome: 'sent'; id: string | null } | { outcome: 'skipped'; reason: string };
/** A delivery failure that must not be retried (bad payload); the sweeper parks the row at once. */
export class OutboxPayloadError extends Error { constructor(message: string) { super(message); this.name = 'OutboxPayloadError'; } }

/** SQL email templates (`fr_queue_email`) to the renderer's names. */
const EMAIL_TEMPLATES: Record<string, MailTemplatePayload['template']> = {
  filed: 'filed', withdrawn: 'withdrawn', shipped: 'shipped', relayed: 'relayed_comment', relayed_comment: 'relayed_comment',
  ready_to_try: 'ready_to_try', updated_trial: 'updated_trial', reminder: 'reminder', expired: 'expired',
};
const str = (v: unknown): string | null => (typeof v === 'string' && v.length ? v : null);

/** Build the mail view of an email row: the embedded request json plus the recipient. */
export function mailViewOf(payload: Record<string, unknown>, deps: Pick<DeliveryDeps, 'config' | 'appUrl'>): { view: RequestMailView; template: MailTemplatePayload } {
  const to = str(payload['to']);
  const request = payload['request'] as SqlRequestRow | undefined;
  const name = str(payload['template']);
  const template = name ? EMAIL_TEMPLATES[name] : undefined;
  if (!to || !request || typeof request !== 'object' || !template) throw new OutboxPayloadError('email payload needs to, request and a known template');
  const detail = requestDetailFromRow(request);
  const view: RequestMailView = {
    issueKey: detail.issueKey || detail.id.slice(0, 8), title: detail.title, kind: detail.kind, eligibility: detail.eligibility, requesterEmail: to, brief: detail.brief,
    requestUrl: detail.issueUrl ?? deps.appUrl, hostName: deps.config.name, maintainersAddress: deps.config.mail.replyTo,
  };
  let data: MailTemplatePayload;
  switch (template) {
    case 'relayed_comment': { const body = str(payload['comment']) ?? str(payload['body']); if (!body) throw new OutboxPayloadError('relayed email has no comment'); data = { template, body }; break; }
    case 'shipped': data = { template, version: str(payload['version']) }; break;
    case 'ready_to_try': case 'updated_trial': case 'reminder': {
      const trial = payload['trial'] as TrialMailData | undefined;
      if (!trial || typeof trial !== 'object') throw new OutboxPayloadError(`${template} email has no trial data`);
      data = { template, trial } as MailTemplatePayload; break;
    }
    default: data = { template } as MailTemplatePayload;
  }
  return { view, template: data };
}

async function deliverEmail(item: OutboxItem, deps: DeliveryDeps): Promise<DeliveryOutcome> {
  if (!['filed', 'relayed', 'relayed_comment', 'withdrawn'].includes(String(item.payload['template']))) return { outcome: 'skipped', reason: 'Customer automation notification is retired.' };
  const { view, template } = mailViewOf(item.payload, deps);
  if (!receivesTemplate(view.eligibility, template.template)) return { outcome: 'skipped', reason: `eligible:${view.eligibility} does not receive ${template.template}` };
  if (!deps.mail) throw new Error('No mail adapter is configured (RESEND_API_KEY missing).');
  const rendered = (deps.render ?? renderMail)(view, template);
  const headers: Record<string, string> = { 'X-Entity-Ref-ID': item.id };
  if (item.requestId) headers['X-Request-Id'] = item.requestId;
  const { id } = await deps.mail.send({ to: view.requesterEmail, ...rendered, headers });
  return { outcome: 'sent', id };
}
function requireTracker(deps: DeliveryDeps): Tracker {
  if (!deps.tracker) throw new Error('No tracker adapter is configured (LINEAR_TOKEN missing).');
  return deps.tracker;
}
async function deliverState(item: OutboxItem, deps: DeliveryDeps): Promise<DeliveryOutcome> {
  const tracker = requireTracker(deps);
  const issueId = str(item.payload['issue_id']) ?? item.target;
  const key = str(item.payload['state']);
  const states = deps.config.tracker.states as Record<string, string>;
  const name = key ? (key in states ? states[key as LinearStateKey] : Object.values(states).includes(key) ? key : null) : null;
  if (!name) throw new OutboxPayloadError(`tracker_state payload names no configured state (${key ?? 'missing'})`);
  if (![states['triage'], states['done'], states['canceled']].includes(name)) return { outcome: 'skipped', reason: 'Customer automation is retired.' };
  await tracker.setState(issueId, name);
  const comment = str(item.payload['comment']);
  if (comment) await tracker.addComment(issueId, comment);
  return { outcome: 'sent', id: null };
}
async function deliverComment(item: OutboxItem, deps: DeliveryDeps): Promise<DeliveryOutcome> {
  const tracker = requireTracker(deps);
  const body = str(item.payload['body']);
  if (!body) throw new OutboxPayloadError('tracker_comment payload has no body');
  const { id } = await tracker.addComment(str(item.payload['issue_id']) ?? item.target, body);
  return { outcome: 'sent', id };
}
/** Deliver one claimed row; throws on transient failure (the sweeper records it and backs off). */
export async function deliver(item: OutboxItem, deps: DeliveryDeps): Promise<DeliveryOutcome> {
  switch (item.kind) {
    case 'storage_remove': {
      if (!deps.storage) throw new Error('Storage cleanup is unavailable.');
      const path = str(item.payload['path']);
      if (!path) throw new OutboxPayloadError('storage_remove has no path');
      await deps.storage.remove([path]); return { outcome: 'sent', id: null };
    }
    case 'email': return deliverEmail(item, deps);
    case 'tracker_state': return deliverState(item, deps);
    case 'tracker_comment': return deliverComment(item, deps);
    case 'tracker_label': case 'tracker_labels': return { outcome: 'skipped', reason: 'Customer automation is retired.' };
    case 'dispatch': return { outcome: 'skipped', reason: 'Customer automation is retired.' };
    default: throw new OutboxPayloadError(`unknown outbox kind ${String(item.kind)}`);
  }
}
