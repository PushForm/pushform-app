// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { MemoryMail } from '../adapters/mail.ts';
import { loadConfig } from '../config/load.ts';
import { SAMPLE_CONFIG_INPUT } from '../config/sample.ts';
import { ServiceDb, type SqlOutboxRow } from './db.ts';
import { FakeRpc, FakeTracker, requestRow } from './fakes.ts';
import { createSweeperHandler, sweep, type SweeperDeps } from './sweeper.ts';

const config = loadConfig(SAMPLE_CONFIG_INPUT);
const row = (id: string, kind: string, payload: Record<string, unknown>, target = 'iss-1'): SqlOutboxRow =>
  ({ id, kind, target, payload, request_id: requestRow().id, attempts: 0, next_at: 'n', claimed_at: null, sent_at: null, failed_at: null, last_error: null, created_at: 'c' });

function setup(rows: SqlOutboxRow[], over: Partial<SweeperDeps> = {}) {
  const rpc = new FakeRpc({ fr_outbox_claim: rows, fr_outbox_done: null, fr_outbox_fail: null, fr_retention_sweep: { help_conversations: 1, conversations: 0, feedback: 0, attachments: ['r1/a.png', 'r1/b.png'], outbox: 2, message_log: 5 } });
  const removed: string[][] = [];
  const deps: SweeperDeps = { db: new ServiceDb(rpc), tracker: new FakeTracker(), mail: new MemoryMail(), config, appUrl: 'https://app.pushform.io', jobsSecret: 'jobs-secret', storage: { remove: async (p) => { removed.push(p); } }, ...over };
  return { rpc, deps, removed, mail: deps.mail as MemoryMail };
}

describe('sweep', () => {
  it('retries image cleanup after storage failure without marking the outbox row delivered', async () => {
    let unavailable = true;
    const { deps, rpc } = setup([row('remove-image', 'storage_remove', { path: 'owner/conversation/image.png' })], {
      storage: { remove: async () => { if (unavailable) throw new Error('Storage unavailable'); } },
    });
    expect(await sweep(deps)).toMatchObject({ failed: 1, sent: 0 });
    expect(rpc.named('fr_outbox_done')).toHaveLength(0);
    expect(rpc.named('fr_outbox_fail')[0]?.params['p_id']).toBe('remove-image');
    unavailable = false;
    expect(await sweep(deps)).toMatchObject({ failed: 0, sent: 1 });
    expect(rpc.named('fr_outbox_done')[0]?.params['p_id']).toBe('remove-image');
  });
  it('claims up to 50 rows, delivers each, marks done or fail with the error text, then runs retention', async () => {
    const { rpc, deps, removed, mail } = setup([
      row('o1', 'email', { template: 'filed', to: 'alice@example.com', request: requestRow() }, 'alice@example.com'),
      row('o2', 'tracker_comment', { issue_id: 'iss-1', body: 'hello' }),
      row('o3', 'tracker_state', { state: 'nowhere' }),
      row('o4', 'email', { template: 'ready_to_try', to: 'alice@example.com', request: requestRow(), trial: { url: 'u', summary: 's', leftOut: [], expiresAt: 'x', now: 'y', script: [], round: 1 } }, 'alice@example.com'),
      row('o5', 'dispatch', {}),
    ]);
    const result = await sweep(deps);
    expect(rpc.named('fr_outbox_claim')[0]!.params).toEqual({ p_limit: 50 });
    expect(result).toMatchObject({ claimed: 5, sent: 2, skipped: 2, failed: 1, attachmentsRemoved: 2 });
    expect(result.failures.map(f => f.id)).toEqual(['o3']);
    expect(result.failures[0]!.error).toMatch(/^permanent: tracker_state payload/);
    expect(rpc.named('fr_outbox_done').map(c => c.params['p_id'])).toEqual(['o1', 'o2', 'o4', 'o5']);
    expect(rpc.named('fr_outbox_fail').map(c => c.params['p_id'])).toEqual(['o3']);
    expect(mail.sent).toHaveLength(1);
    expect(removed).toEqual([['r1/a.png', 'r1/b.png']]);
    expect(result.retention?.message_log).toBe(5);
    expect(rpc.calls.at(-1)!.name).toBe('fr_retention_sweep');
  });
  it('keeps delivering when retention fails and honours a custom claim limit', async () => {
    const { deps, rpc } = setup([], { claimLimit: 10 });
    rpc.handlers['fr_retention_sweep'] = () => { throw new Error('locked'); };
    const logs: string[] = [];
    const result = await sweep({ ...deps, log: (m) => logs.push(m) });
    expect(result.retention).toBeNull(); expect(rpc.named('fr_outbox_claim')[0]!.params).toEqual({ p_limit: 10 });
    expect(logs.at(-1)).toMatch(/retention sweep failed: locked/);
  });
});

describe('createSweeperHandler', () => {
  it('requires the jobs secret and returns the counts', async () => {
    const { deps } = setup([]);
    const handler = createSweeperHandler(deps);
    const denied = await handler(new Request('http://x/fr-sweeper', { method: 'POST' }));
    expect(denied.status).toBe(401);
    const wrong = await handler(new Request('http://x/fr-sweeper', { method: 'POST', headers: { Authorization: 'Bearer nope' } }));
    expect(wrong.status).toBe(401);
    const ok = await handler(new Request('http://x/fr-sweeper', { method: 'POST', headers: { Authorization: 'Bearer jobs-secret' } }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, claimed: 0, sent: 0, failed: 0, retention: { outbox: 2 } });
  });
});
