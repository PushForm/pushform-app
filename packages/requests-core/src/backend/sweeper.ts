// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { errorResponse, hasJobsSecret, HttpError, json } from './auth.ts';
import type { ServiceDb, SqlRetention } from './db.ts';
import { deliver, outboxItemOf, OutboxPayloadError, type DeliveryDeps } from './outbox.ts';

/** Mail/tracker retries and private-data retention only. Customer build/trial queues are retired. */
export interface SweeperDeps extends DeliveryDeps {
  db: ServiceDb;
  storage?: { remove(paths: string[]): Promise<void> } | null | undefined;
  jobsSecret: string;
  claimLimit?: number | undefined;
  log?: ((message: string) => void) | undefined;
}
export interface SweepResult {
  claimed: number; sent: number; skipped: number; failed: number;
  failures: { id: string; kind: string; error: string }[];
  retention: SqlRetention | null;
  attachmentsRemoved: number;
}
export const SWEEPER_CLAIM_LIMIT = 50;
const PARK_ERROR_PREFIX = 'permanent: ';
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

export async function sweep(deps: SweeperDeps): Promise<SweepResult> {
  const result: SweepResult = {
    claimed: 0, sent: 0, skipped: 0, failed: 0, failures: [],
    retention: null, attachmentsRemoved: 0,
  };
  const rows = await deps.db.outboxClaim(deps.claimLimit ?? SWEEPER_CLAIM_LIMIT);
  result.claimed = rows.length;
  for (const row of rows) {
    const item = outboxItemOf(row);
    try {
      const outcome = await deliver(item, deps);
      await deps.db.outboxDone(item.id);
      if (outcome.outcome === 'sent') result.sent += 1; else { result.skipped += 1; deps.log?.(`outbox ${item.id} skipped: ${outcome.reason}`); }
    } catch (error) {
      const message = errorText(error);
      // A payload the adapters cannot interpret never succeeds; its error is marked so the parked row is easy to find.
      const text = error instanceof OutboxPayloadError ? `${PARK_ERROR_PREFIX}${message}` : message;
      result.failed += 1; result.failures.push({ id: item.id, kind: item.kind, error: text });
      await deps.db.outboxFail(item.id, text);
    }
  }
  try {
    result.retention = await deps.db.retentionSweep();
    const paths = result.retention.attachments;
    if (paths.length && deps.storage) { await deps.storage.remove(paths); result.attachmentsRemoved = paths.length; }
  } catch (error) {
    deps.log?.(`retention sweep failed: ${errorText(error)}`);
  }
  return result;
}

/** `POST` (or `GET`) with the jobs secret runs one pass; anything else is 401. */
export function createSweeperHandler(deps: SweeperDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method === 'OPTIONS') return json({ ok: true });
    if (!hasJobsSecret(req, deps.jobsSecret)) return errorResponse(new HttpError('unauthorized', 'The sweeper needs the jobs secret.'));
    try { return json({ ok: true, ...(await sweep(deps)) }); } catch (error) { return errorResponse(error); }
  };
}
