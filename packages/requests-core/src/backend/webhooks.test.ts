// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import * as fx from '../adapters/linear.fixtures.ts';
import { LinearTracker } from '../adapters/linear.ts';
import { hmacSha256Hex } from '../adapters/signature.ts';
import { loadConfig } from '../config/load.ts';
import { SAMPLE_CONFIG_INPUT } from '../config/sample.ts';
import { ServiceDb } from './db.ts';
import { FakeRpc, trialRow } from './fakes.ts';
import { actorOf, createLinearWebhookHandler, sqlEventOf } from './webhooks.ts';

const config = loadConfig(SAMPLE_CONFIG_INPUT);
const noFetch: typeof fetch = async () => { throw new Error('no network in tests'); };
const linear = new LinearTracker({ token: 'lin_api_x', tracker: config.tracker, webhookSecret: fx.WEBHOOK_SECRET, fetch: noFetch, now: () => fx.WEBHOOK_AT + 5_000 });

async function signed(payload: unknown, secret = fx.WEBHOOK_SECRET, extra: Record<string, string> = {}): Promise<Request> {
  const body = JSON.stringify(payload);
  return new Request('http://x/fr-webhook-linear', { method: 'POST', body, headers: { 'content-type': 'application/json', 'linear-signature': await hmacSha256Hex(secret, body), 'linear-delivery': 'dlv-1', ...extra } });
}

describe('Linear webhook', () => {
  it('rejects a bad signature, a stale timestamp and non-POST requests', async () => {
    const rpc = new FakeRpc({ fr_tracker_event: { applied: true }, fr_webhook_rejected: null });
    const handler = createLinearWebhookHandler({ db: new ServiceDb(rpc), config, tracker: linear });
    expect((await handler(await signed(fx.ISSUE_STATE_WEBHOOK, 'wrong-secret'))).status).toBe(401);
    expect((await handler(await signed({ ...fx.ISSUE_STATE_WEBHOOK, webhookTimestamp: fx.WEBHOOK_AT - 120_000 }))).status).toBe(401);
    expect((await handler(new Request('http://x/fr-webhook-linear'))).status).toBe(400);
    // Each rejection is recorded for the admin console; nothing is applied.
    expect(rpc.calls).toEqual([
      { name: 'fr_webhook_rejected', params: { p_host: 'pushform', p_source: 'linear', p_reason: 'invalid or stale signature' } },
      { name: 'fr_webhook_rejected', params: { p_host: 'pushform', p_source: 'linear', p_reason: 'invalid or stale signature' } }]);
  });
  it('still answers 401 when recording the rejection fails', async () => {
    const rpc = new FakeRpc({});
    const handler = createLinearWebhookHandler({ db: new ServiceDb(rpc), config, tracker: linear });
    expect((await handler(await signed(fx.ISSUE_STATE_WEBHOOK, 'wrong-secret'))).status).toBe(401);
  });
  it('applies a state change through fr_tracker_event with the delivery id (idempotent on retry)', async () => {
    const rpc = new FakeRpc({ fr_tracker_event: (_p, n) => (n === 1 ? { applied: true, kind: 'state', state: 'Canceled', requester_state: 'Declined', emails: 1 } : { applied: false, duplicate: true }) });
    const handler = createLinearWebhookHandler({ db: new ServiceDb(rpc), config, tracker: linear });
    const res = await handler(await signed(fx.ISSUE_STATE_WEBHOOK));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, results: [{ issueId: 'iss-1', kind: 'state', result: { applied: true, state: 'Canceled' } }] });
    expect(rpc.calls[0]).toEqual({ name: 'fr_tracker_event', params: { p_host: 'pushform', p_issue_id: 'iss-1', p_event: { kind: 'state', state_name: 'Canceled', actor: 'testers@pushform.io', delivery_id: 'dlv-1:state' } } });
    const again = await handler(await signed(fx.ISSUE_STATE_WEBHOOK));
    expect(await again.json()).toMatchObject({ results: [{ result: { duplicate: true } }] });
  });
  it('applies state and label events of one payload, relays comments, and answers 200 for ignored events', async () => {
    const rpc = new FakeRpc({ fr_tracker_event: { applied: true } });
    const handler = createLinearWebhookHandler({ db: new ServiceDb(rpc), config, tracker: linear });
    await handler(await signed(fx.ISSUE_STATE_AND_LABEL_WEBHOOK));
    expect(rpc.calls.map(c => (c.params['p_event'] as { kind: string }).kind)).toEqual(['state', 'label']);
    await handler(await signed(fx.COMMENT_WEBHOOK));
    const comment = rpc.calls[2]!.params['p_event'] as Record<string, unknown>;
    expect(comment['kind']).toBe('comment'); expect(typeof comment['body']).toBe('string'); expect(comment['delivery_id']).toBe('dlv-1');
    const ignored = await handler(await signed(fx.ISSUE_TITLE_WEBHOOK));
    expect(await ignored.json()).toEqual({ ok: true, ignored: true });
    expect(rpc.calls).toHaveLength(3);
  });
  it('never starts automation when a legacy database response mentions trials', async () => {
    const rpc = new FakeRpc({ fr_tracker_event: { applied: true, destroying_trials: [trialRow()] } });
    const handler = createLinearWebhookHandler({ db: new ServiceDb(rpc), config, tracker: linear });
    expect((await handler(await signed(fx.ISSUE_STATE_WEBHOOK))).status).toBe(200);
    expect(rpc.calls.map(call => call.name)).toEqual(['fr_tracker_event']);
  });
  it('answers 5xx when the database fails so Linear retries the delivery', async () => {
    const rpc = new FakeRpc({});
    const handler = createLinearWebhookHandler({ db: new ServiceDb(rpc), config, tracker: linear });
    expect((await handler(await signed(fx.ISSUE_STATE_WEBHOOK))).status).toBe(503);
  });
  it('builds SQL events with the actor email, falling back to the name or the integration', () => {
    expect(actorOf({ id: null, name: 'Maint', email: 'M@x.io', type: 'user' })).toBe('M@x.io');
    expect(actorOf({ id: null, name: 'Maint', email: null, type: 'user' })).toBe('Maint');
    expect(actorOf({ id: null, name: null, email: null, type: 'integration' })).toBe('integration');
    expect(sqlEventOf({ kind: 'label', issueId: 'i', issueKey: null, labels: ['class:C2'], previousLabels: null, actor: { id: null, name: null, email: null, type: 'unknown' }, deliveryId: 'd', at: 't' }))
      .toEqual({ kind: 'label', labels: ['class:C2'], actor: 'tracker', delivery_id: 'd' });
  });
});
