// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { parseLinearWebhook } from '../adapters/linear.ts';
import type { Tracker, TrackerActor, TrackerEvent } from '../adapters/tracker.ts';
import type { Config } from '../config/schema.ts';
import { errorResponse, HttpError, json } from './auth.ts';
import { type ServiceDb, type SqlTrackerEvent, type SqlTrackerEventResult } from './db.ts';

/**
 * Webhook receivers (architecture §3.1). Both verify the signature themselves: these functions run
 * without Supabase's JWT check because Linear and GitHub carry no Supabase session.
 */
export interface LinearWebhookDeps {
  db: ServiceDb;
  config: Config;
  /** Only `verifyWebhook` is used; events are parsed with `parseLinearWebhook` so one payload can yield state and label events. */
  tracker: Pick<Tracker, 'verifyWebhook'>;
  log?: ((message: string) => void) | undefined;
}
/** The actor string `fr_tracker_event` compares with the requester email: the email when known, else the name. */
export function actorOf(actor: TrackerActor): string { return actor.email ?? actor.name ?? (actor.type === 'integration' ? 'integration' : 'tracker'); }
export function sqlEventOf(event: TrackerEvent): SqlTrackerEvent {
  switch (event.kind) {
    case 'state': return { kind: 'state', state_name: event.stateName, actor: actorOf(event.actor), delivery_id: event.deliveryId };
    case 'comment': return { kind: 'comment', body: event.body, actor: actorOf(event.actor), delivery_id: event.deliveryId };
    case 'label': return { kind: 'label', labels: event.labels, actor: actorOf(event.actor), delivery_id: event.deliveryId };
  }
}

/** The admin console lists rejected deliveries; recording one never changes the 401. */
async function recordRejection(deps: { db: ServiceDb; config: Config; log?: ((message: string) => void) | undefined }, source: 'linear' | 'github', reason: string): Promise<void> {
  try { await deps.db.webhookRejected(deps.config.host, source, reason); } catch (error) {
    deps.log?.(`fr_webhook_rejected(${source}) failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface LinearWebhookResult { issueId: string; kind: TrackerEvent['kind']; result: SqlTrackerEventResult }
/** Verify, parse, and apply every event of one Linear delivery through `fr_tracker_event`; ignored payloads answer 200. */
export async function handleLinearWebhook(req: Request, deps: LinearWebhookDeps): Promise<Response> {
  if (req.method !== 'POST') return errorResponse(new HttpError('invalid', 'Webhooks are POST requests.'));
  const body = await req.text();
  const input = { body, headers: req.headers };
  if (!(await deps.tracker.verifyWebhook(input))) {
    await recordRejection(deps, 'linear', 'invalid or stale signature');
    return errorResponse(new HttpError('unauthorized', 'The webhook signature is invalid or stale.'));
  }
  const events = parseLinearWebhook(input);
  if (events.length === 0) return json({ ok: true, ignored: true });
  const results: LinearWebhookResult[] = [];
  try {
    for (const event of events) {
      const result = await deps.db.trackerEvent(deps.config.host, event.issueId, sqlEventOf(event));
      results.push({ issueId: event.issueId, kind: event.kind, result });
      deps.log?.(`linear ${event.kind} ${event.issueKey ?? event.issueId}: ${JSON.stringify({ ...result, destroying_trials: result.destroying_trials?.length })}`);
    }
  } catch (error) {
    // A failed apply must make Linear retry the delivery; the delivery id keeps a retry idempotent.
    return errorResponse(error);
  }
  return json({ ok: true, results });
}
export function createLinearWebhookHandler(deps: LinearWebhookDeps): (req: Request) => Promise<Response> { return (req) => handleLinearWebhook(req, deps); }
