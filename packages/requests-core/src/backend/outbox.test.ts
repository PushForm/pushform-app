// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { MemoryMail } from '../adapters/mail.ts';
import { loadConfig } from '../config/load.ts';
import { SAMPLE_CONFIG_INPUT } from '../config/sample.ts';
import { deliver, mailViewOf, outboxItemOf, OutboxPayloadError, type DeliveryDeps, type OutboxItem } from './outbox.ts';
import { FakeTracker, requestRow } from './fakes.ts';

const config = loadConfig(SAMPLE_CONFIG_INPUT);
const item = (kind: OutboxItem['kind'], payload: Record<string, unknown>, target = 'iss-1'): OutboxItem => ({ id: 'ob-1', kind, target, payload, requestId: requestRow().id, attempts: 0 });
function deps(over: Partial<DeliveryDeps> = {}): DeliveryDeps & { mail: MemoryMail; tracker: FakeTracker } {
  return { tracker: new FakeTracker(), mail: new MemoryMail(), config, appUrl: 'https://app.pushform.io/', ...over } as DeliveryDeps & { mail: MemoryMail; tracker: FakeTracker };
}
const email = (template: string, extra: Record<string, unknown> = {}, request = requestRow()) => item('email', { template, to: 'alice@example.com', host_id: 'pushform', request, ...extra }, 'alice@example.com');

describe('email rows', () => {
  it('renders the Filed email from the embedded request json and sends it to the row target', async () => {
    const d = deps();
    const out = await deliver(email('filed'), d);
    expect(out).toEqual({ outcome: 'sent', id: 'mem-1' });
    const sent = d.mail.sent[0]!;
    expect(sent.to).toBe('alice@example.com');
    expect(sent.subject).toBe('[FRQ-123] Filed: Lock inference with Shift');
    expect(sent.text).not.toContain(requestRow().issue_url);
    expect(sent.text).toContain('FRQ-123');
    expect(sent.text).not.toContain('/requests/');
    expect(sent.text).toContain('support@pushform.io');
    expect(sent.text).toContain('Hold Shift to lock it');
    expect(sent.headers).toEqual({ 'X-Entity-Ref-ID': 'ob-1', 'X-Request-Id': requestRow().id });
  });
  it('maps the SQL template names: relayed comments carry the body, shipped its version', async () => {
    const d = deps();
    await deliver(email('relayed', { comment: 'Could you share the file?', actor: 'maint@pushform.io' }), d);
    await deliver(email('withdrawn'), d);
    await deliver(email('shipped', { version: '0.4.0' }), d);
    expect(d.mail.sent.map(m => m.subject)).toEqual([
      '[FRQ-123] Message from the team: Lock inference with Shift',
      '[FRQ-123] Withdrawn: Lock inference with Shift',
    ]);
    expect(d.mail.sent[0]!.text).toContain('> Could you share the file?');
    expect(d.mail.sent).toHaveLength(2);
  });
  it('skips trial emails for eligible:none requesters and parks rows with bad payloads', async () => {
    const d = deps();
    const trial = { url: 'https://t', summary: 's', leftOut: [], expiresAt: '2026-10-26T10:00:00Z', now: '2026-10-23T10:00:00Z', script: [], round: 1 };
    expect(await deliver(email('ready_to_try', { trial }), d)).toEqual({ outcome: 'skipped', reason: 'Customer automation notification is retired.' });
    expect(await deliver(email('ready_to_try', { trial }, requestRow({ eligibility: 'auto' })), d)).toMatchObject({ outcome: 'skipped' });
    expect(await deliver(email('nonsense'), d)).toMatchObject({ outcome: 'skipped' });
    await expect(deliver(email('relayed'), d)).rejects.toBeInstanceOf(OutboxPayloadError);
    await expect(deliver(item('email', { template: 'filed', to: 'x' }), d)).rejects.toBeInstanceOf(OutboxPayloadError);
    await expect(deliver(email('filed'), deps({ mail: null }))).rejects.toThrow(/RESEND_API_KEY/);
    expect(mailViewOf(email('filed').payload, d).view.hostName).toBe('PushForm');
  });
});

describe('tracker rows', () => {
  it('tracker_state resolves the config state key and posts the comment (withdraw)', async () => {
    const d = deps();
    await deliver(item('tracker_state', { issue_id: 'iss-1', host_id: 'pushform', state: 'canceled', comment: 'Withdrawn by requester alice@example.com' }), d);
    expect(d.tracker.states).toEqual([{ issueId: 'iss-1', stateName: 'Canceled' }]);
    expect(d.tracker.comments).toEqual([{ issueId: 'iss-1', body: 'Withdrawn by requester alice@example.com' }]);
    await deliver(item('tracker_state', { state: 'Build' }), d);
    expect(d.tracker.states).toHaveLength(1);
    await expect(deliver(item('tracker_state', { state: 'nowhere' }), d)).rejects.toBeInstanceOf(OutboxPayloadError);
    await expect(deliver(item('tracker_state', { state: 'canceled' }), deps({ tracker: null }))).rejects.toThrow(/LINEAR_TOKEN/);
  });
  it('posts ordinary comments but suppresses obsolete label and worker actions', async () => {
    const d = deps();
    const issue = await d.tracker.createIssue({ title: 't', body: 'b', kind: 'feature', labels: ['feature', 'source:in-app', 'class:C3', 'eligible:gated'] });
    expect(await deliver(item('tracker_comment', { issue_id: issue.id, body: 'Requester reply from alice@example.com:\n\nhello' }), d)).toEqual({ outcome: 'sent', id: 'cmt-1' });
    await deliver(item('tracker_label', { issue_id: issue.id, add: ['eligible:auto'], remove: ['eligible:gated', 'eligible:none'] }), d);
    expect(d.tracker.labelSets).toEqual([]);
    expect(await deliver(item('tracker_labels', { issue_id: 'missing', add: ['x'], remove: [] }), d)).toMatchObject({ outcome: 'skipped' });
    await expect(deliver(item('tracker_comment', {}), d)).rejects.toBeInstanceOf(OutboxPayloadError);
    expect(await deliver(item('dispatch', {}), d)).toMatchObject({ outcome: 'skipped' });
    await expect(deliver(item('bogus' as OutboxItem['kind'], {}), d)).rejects.toBeInstanceOf(OutboxPayloadError);
  });
  it('converts claimed rows to items', () => {
    const it = outboxItemOf({ id: 'o', kind: 'email', target: 't', payload: { a: 1 }, request_id: null, attempts: 3, next_at: 'n', claimed_at: null, sent_at: null, failed_at: null, last_error: null, created_at: 'c' });
    expect(it).toEqual({ id: 'o', kind: 'email', target: 't', payload: { a: 1 }, requestId: null, attempts: 3 });
  });
});
