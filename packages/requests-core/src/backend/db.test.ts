// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/load.ts';
import { SAMPLE_CONFIG_INPUT } from '../config/sample.ts';
import { conversationFromRow, DbError, dbErrorOf, meFromRow, messagesFromRows, requestDetailFromRow, requestFromRow, rpcFromClient, ServiceDb, UserDb } from './db.ts';
import { conversationRow, FakeRpc, myRoles, requestRow } from './fakes.ts';

const config = loadConfig(SAMPLE_CONFIG_INPUT);

describe('error mapping', () => {
  it('maps the SQL error names and PostgREST codes to DbError codes', () => {
    expect(dbErrorOf({ message: 'fr_auth', code: '42501' }).code).toBe('auth');
    expect(dbErrorOf({ message: 'fr_forbidden', code: '42501' }).code).toBe('forbidden');
    expect(dbErrorOf({ message: 'permission denied for function fr_outbox_claim', code: '42501' }).code).toBe('forbidden');
    expect(dbErrorOf({ message: 'fr_invalid', code: '23514' }).code).toBe('invalid');
    expect(dbErrorOf({ message: 'fr_limit', code: 'P0001' }).code).toBe('limit');
    expect(dbErrorOf({ message: 'fr_duplicate', code: '23505' }).code).toBe('duplicate');
    expect(dbErrorOf({ message: 'invalid input syntax for type uuid', code: '22P02' }).code).toBe('invalid');
    expect(dbErrorOf(new TypeError('fetch failed')).code).toBe('unavailable');
    const same = new DbError('limit', 'x'); expect(dbErrorOf(same)).toBe(same);
  });
  it('wraps a supabase-js style client: data on success, DbError on error, table reads through from()', async () => {
    const seen: unknown[] = [];
    const client = {
      rpc: async (name: string, params?: Record<string, unknown>) => { seen.push([name, params]); return name === 'bad' ? { data: null, error: { message: 'fr_limit', code: 'P0001' } } : { data: { ok: true }, error: null }; },
      from: (table: string) => ({ select: (columns: string) => ({ in: async (column: string, values: readonly string[]) => { seen.push([table, columns, column, values]); return { data: [{ id: 'r1' }], error: null }; } }) }),
    };
    const rpc = rpcFromClient(client);
    expect(await rpc.rpc('fr_x', { a: 1 })).toEqual({ ok: true });
    await expect(rpc.rpc('bad', {})).rejects.toMatchObject({ code: 'limit' });
    expect(await rpc.selectIn?.('fr_requests', 'id', 'issue_id', ['i1'])).toEqual([{ id: 'r1' }]);
    expect(seen).toEqual([['fr_x', { a: 1 }], ['bad', {}], ['fr_requests', 'id', 'issue_id', ['i1']]]);
    expect(rpcFromClient({ rpc: client.rpc }).selectIn).toBeUndefined();
  });
});

describe('row conversion', () => {
  it('maps request rows to the camelCase contract', () => {
    const r = requestFromRow(requestRow());
    expect(r).toMatchObject({ id: requestRow().id, issueKey: 'FRQ-123', requesterState: 'Submitted', estimatedClass: 'C3', eligibility: 'none', trialUrl: null });
    expect(r.history).toEqual([{ at: '2026-10-23T10:05:00Z', requesterState: 'Submitted', note: 'Filed' }]);
    const d = requestDetailFromRow(requestRow());
    expect(d.brief?.kind).toBe('feature'); expect(d.transcriptAvailable).toBe(true);
    const { transcript_available: _t, ...noTranscript } = requestRow({ brief: { nonsense: true } });
    expect(requestDetailFromRow(noTranscript)).toMatchObject({ brief: null, transcriptAvailable: false });
  });
  it('maps conversation rows, dropping malformed messages and defaulting the screen', () => {
    const c = conversationFromRow(conversationRow({ messages: [{ role: 'user', text: 'hi', at: 't' }, { role: 'tool', name: 'search_docs', toolUseId: '1', input: { q: 'x' }, output: 'o', at: 't' }, { role: 'bogus' }, 42] }));
    expect(c.messages).toHaveLength(2);
    expect(c.screen).toEqual({ editor: 'model', documentType: 'model', build: { version: '0.3.0', commit: 'abc123' }, browser: 'Chrome 141', os: 'macOS 15' });
    expect(conversationFromRow(conversationRow({ screen: null })).screen).toBeNull();
    expect(messagesFromRows('nope')).toEqual([]);
  });
  it('maps fr_my_roles and takes the limits from the config, not the SQL defaults', () => {
    const me = meFromRow(myRoles({ roles: [{ role: 'maintainer', org_id: null }], effective: 'maintainer', limits: { openRequestsPerAccount: 99, messagesPerConversation: 99 } }), config);
    expect(me).toMatchObject({ effective: 'maintainer', roles: [{ role: 'maintainer', orgId: null }], limits: { openRequestsPerAccount: 5, messagesPerConversation: 30 } });
  });
});

describe('typed wrappers name every SQL parameter', () => {
  it('ServiceDb', async () => {
    const rpc = new FakeRpc({
      fr_apply_config: { host: {}, granted: [] }, fr_conversation_start: conversationRow(), fr_conversation_get: conversationRow(), fr_conversation_list_open: [],
      fr_conversation_append: conversationRow(), fr_conversation_close: conversationRow(), fr_rate_check: true, fr_request_count_open: 2, fr_request_file: requestRow(),
      fr_request_add_me: requestRow(), fr_tracker_event: { applied: true }, fr_outbox_enqueue: 'o1', fr_outbox_claim: [], fr_outbox_done: null, fr_outbox_fail: null,
      fr_retention_sweep: { attachments: [] }, fr_record_event: 'e1', fr_eligibility: 'gated',
      fr_trial_request: {}, fr_trial_admit: [], fr_trial_healthy: { previous: [] }, fr_trial_destroy_request: { dispatch: true }, fr_trial_destroyed: {}, fr_trial_sweep: { reminders: 0, expiring: [] },
      fr_trial_allowed: true, fr_trial_allow_list: { emails: [], domains: [] }, fr_auth_hook_allowed: false, fr_trials_for_run: null, fr_trial_requeue: null,
    });
    const db = new ServiceDb(rpc);
    await db.applyConfig(config);
    await db.conversationStart('pushform', 'u', 'E@x.io', 'intake', 'feature', { editor: 'home', build: { version: '1', commit: 'c' }, browser: 'b', os: 'o' });
    await db.conversationGet('c', 'u'); await db.conversationListOpen('pushform', 'u');
    await db.conversationAppend('c', 'u', [{ role: 'user', text: 'x', at: 't' }], null, 'T', 'problem');
    await db.conversationClose('c', 'u', 'discarded'); await db.rateCheck('u', 20); await db.requestCountOpen('u');
    await db.requestFile({ conversationId: 'c', ownerId: 'u', email: 'e', kind: 'feature', title: 'T', brief: { kind: 'feature', problem: 'p', workaround: null, desired: null, acceptance: [], mustNotChange: null, area: null, importance: null, estimatedClass: null }, estimatedClass: null, eligibility: 'none', issueId: 'i', issueKey: 'K', issueUrl: 'U', client: null });
    await db.requestAddMe('pushform', 'r', 'u', 'e', 'notes'); await db.trackerEvent('pushform', 'i', { kind: 'state', state_name: 'Build', actor: 'm@x.io', delivery_id: 'd1' });
    await db.outboxEnqueue('tracker_comment', 'i', { body: 'b' }, 'r'); await db.outboxClaim(50); await db.outboxDone('o1'); await db.outboxFail('o1', 'x'.repeat(5000));
    await db.retentionSweep(); await db.recordEvent('pushform', null, 'github', 'github.pull_request_merged', {}); await db.eligibility('pushform', null, 'e', 'C3');
    // F3 trial functions, with the parameter names the brief fixes.
    await db.trialRequest('pushform', 'r', 'sha1', true, 'github-actions'); await db.trialAdmit('pushform'); await db.trialHealthy('t', 'https://u', 'app', null, '2026-10-27T00:00:00.000Z');
    await db.trialDestroyRequest('t', 'merged'); await db.trialDestroyed('t', 'expired'); await db.trialSweep('pushform'); await db.trialAllowed('t', 'e@x.io'); await db.trialAllowList('t');
    await db.authHookAllowed('pushform', 'e@x.io'); await db.trialForRun('run'); await db.trialRequeue('t', 'x'.repeat(5000));
    const names = rpc.calls.map(c => c.name);
    expect(names).toEqual(['fr_apply_config', 'fr_conversation_start', 'fr_conversation_get', 'fr_conversation_list_open', 'fr_conversation_append', 'fr_conversation_close', 'fr_rate_check', 'fr_request_count_open', 'fr_request_file', 'fr_request_add_me', 'fr_tracker_event', 'fr_outbox_enqueue', 'fr_outbox_claim', 'fr_outbox_done', 'fr_outbox_fail', 'fr_retention_sweep', 'fr_record_event', 'fr_eligibility',
      'fr_trial_request', 'fr_trial_admit', 'fr_trial_healthy', 'fr_trial_destroy_request', 'fr_trial_destroyed', 'fr_trial_sweep', 'fr_trial_allowed', 'fr_trial_allow_list', 'fr_auth_hook_allowed', 'fr_trials_for_run', 'fr_trial_requeue']);
    expect(rpc.named('fr_trial_requeue')[0]!.params).toEqual({ p_trial: 't', p_error: 'x'.repeat(4000) });
    expect(rpc.named('fr_trial_request')[0]!.params).toEqual({ p_host: 'pushform', p_request: 'r', p_sha: 'sha1', p_needs_branch: true, p_actor: 'github-actions' });
    expect(rpc.named('fr_trial_healthy')[0]!.params).toEqual({ p_trial: 't', p_url: 'https://u', p_access_app_id: 'app', p_data_branch: null, p_expires_at: '2026-10-27T00:00:00.000Z' });
    expect(rpc.named('fr_trial_destroy_request')[0]!.params).toEqual({ p_trial: 't', p_reason: 'merged' });
    expect(rpc.named('fr_trial_destroyed')[0]!.params).toEqual({ p_trial: 't', p_reason: 'expired' });
    expect(rpc.named('fr_trial_sweep')[0]!.params).toEqual({ p_host: 'pushform' });
    expect(rpc.named('fr_trial_allowed')[0]!.params).toEqual({ p_trial: 't', p_email: 'e@x.io' });
    expect(rpc.named('fr_trial_allow_list')[0]!.params).toEqual({ p_trial: 't' });
    expect(rpc.named('fr_auth_hook_allowed')[0]!.params).toEqual({ p_host: 'pushform', p_email: 'e@x.io' });
    expect(rpc.named('fr_trials_for_run')[0]!.params).toEqual({ p_run: 'run' });
    const apply = rpc.named('fr_apply_config')[0]!.params;
    expect(apply).toMatchObject({ p_host: 'pushform', p_name: 'PushForm', p_default_role: 'user', p_admins: ['owner@example.com'], p_maintainers: ['team@example.com'] });
    expect(typeof apply['p_config_hash']).toBe('string'); expect((apply['p_config_hash'] as string).length).toBe(64); expect(apply['p_config']).toEqual(config);
    expect(rpc.named('fr_conversation_append')[0]!.params).toEqual({ p_id: 'c', p_owner: 'u', p_messages: [{ role: 'user', text: 'x', at: 't' }], p_brief: null, p_title: 'T', p_path: 'problem' });
    // p_kind travels only when a kind is given (an open conversation settling on help), so the six-argument SQL call stays in use otherwise.
    await db.conversationAppend('c', 'u', [], null, null, 'help', 'help');
    expect(rpc.named('fr_conversation_append')[1]!.params).toEqual({ p_id: 'c', p_owner: 'u', p_messages: [], p_brief: null, p_title: null, p_path: 'help', p_kind: 'help' });
    expect(Object.keys(rpc.named('fr_request_file')[0]!.params)).toEqual(['p_conversation', 'p_owner', 'p_email', 'p_kind', 'p_title', 'p_brief', 'p_estimated_class', 'p_eligibility', 'p_issue_id', 'p_issue_key', 'p_issue_url', 'p_client']);
    expect(rpc.named('fr_tracker_event')[0]!.params).toEqual({ p_host: 'pushform', p_issue_id: 'i', p_event: { kind: 'state', state_name: 'Build', actor: 'm@x.io', delivery_id: 'd1' } });
    expect((rpc.named('fr_outbox_fail')[0]!.params['p_error'] as string).length).toBe(4000);
  });
  it('UserDb', async () => {
    const rpc = new FakeRpc({ fr_my_roles: myRoles(), fr_list_my_requests: [requestRow()], fr_get_request: requestRow(), fr_withdraw: requestRow(), fr_reply: { ok: true, outbox_id: 'o', request: requestRow() }, fr_grant_role: {}, fr_revoke_role: {}, fr_set_disabled: {} });
    const db = new UserDb(rpc);
    await db.myRoles('pushform'); await db.listMyRequests('pushform'); await db.getRequest('r'); await db.withdraw('r'); await db.reply('r', 'hello');
    await db.grantRole('pushform', null, 'x@y.io', 'builder'); await db.revokeRole('pushform', null, 'x@y.io', 'builder'); await db.setDisabled('pushform', null, 'filing', true);
    expect(rpc.calls.map(c => c.name)).toEqual(['fr_my_roles', 'fr_list_my_requests', 'fr_get_request', 'fr_withdraw', 'fr_reply', 'fr_grant_role', 'fr_revoke_role', 'fr_set_disabled']);
    expect(rpc.named('fr_reply')[0]!.params).toEqual({ p_id: 'r', p_text: 'hello' });
    expect(rpc.named('fr_set_disabled')[0]!.params).toEqual({ p_host: 'pushform', p_org: null, p_part: 'filing', p_disabled: true });
  });
  it('resolves request ids of issues through the optional table read, scoped to the host', async () => {
    const rpc = new FakeRpc({});
    rpc.tables['fr_requests'] = [{ id: 'r1', issue_id: 'iss-1', host_id: 'pushform' }, { id: 'r2', issue_id: 'iss-2', host_id: 'other' }];
    const map = await new ServiceDb(rpc).requestsByIssueIds('pushform', ['iss-1', 'iss-2', 'iss-3']);
    expect([...map.entries()]).toEqual([['iss-1', 'r1']]);
    expect(rpc.selects).toEqual([{ table: 'fr_requests', column: 'issue_id', values: ['iss-1', 'iss-2', 'iss-3'] }]);
    expect((await new ServiceDb({ rpc: async () => null }).requestsByIssueIds('pushform', ['iss-1'])).size).toBe(0);
  });
  it('reads trials by status and the destroy-dispatched events through the optional table read', async () => {
    const rpc = new FakeRpc({});
    rpc.tables['fr_trials'] = [{ id: 't1', request_id: 'r1', status: 'destroying', host_id: 'pushform' }, { id: 't2', request_id: 'r2', status: 'destroying', host_id: 'other' }, { id: 't3', request_id: 'r3', status: 'live', host_id: 'pushform' }];
    rpc.tables['fr_events'] = [{ request_id: 'r1', kind: 'trial.destroy_dispatched', payload: { trial_id: 't1' } }, { request_id: 'r1', kind: 'trial.destroy_dispatched', payload: { trial_id: 'older' } }, { request_id: 'r1', kind: 'other', payload: { trial_id: 't1' } }];
    const db = new ServiceDb(rpc);
    const destroying = await db.trialsByStatus('pushform', ['destroying']);
    expect(destroying.map(t => t.id)).toEqual(['t1']);
    expect([...await db.trialsWithEvent('trial.destroy_dispatched', destroying)]).toEqual(['t1']);
    expect((await db.trialsWithEvent('trial.destroy_dispatched', [])).size).toBe(0);
    expect(rpc.selects).toEqual([{ table: 'fr_trials', column: 'status', values: ['destroying'] }, { table: 'fr_events', column: 'request_id', values: ['r1'] }]);
    const plain = new ServiceDb({ rpc: async () => null });
    expect(await plain.trialsByStatus('pushform', ['destroying'])).toEqual([]);
    expect((await plain.trialsWithEvent('x', [{ id: 't', request_id: 'r' }])).size).toBe(0);
  });
});
