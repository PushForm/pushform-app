// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/load.ts';
import { SAMPLE_CONFIG_INPUT } from '../config/sample.ts';
import * as fx from './linear.fixtures.ts';
import { linearAuthorization, LinearTracker, parseLinearWebhook } from './linear.ts';
import { hmacSha256Hex } from './signature.ts';
import { TrackerError } from './tracker.ts';

interface Call { query: string; variables: Record<string, unknown>; headers: Record<string, string> }
/** A fake fetch answering GraphQL operations from the recorded fixtures by operation name. */
function fakeLinear(responses: Record<string, unknown | ((vars: Record<string, unknown>) => unknown)>, status = 200) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    calls.push({ query: body.query, variables: body.variables, headers: Object.fromEntries(Object.entries(init?.headers as Record<string, string>)) });
    const name = /^(?:query|mutation) (\w+)/.exec(body.query)?.[1] ?? '';
    const response = responses[name];
    if (response === undefined) throw new Error(`unexpected operation ${name}`);
    const payload = typeof response === 'function' ? (response as (v: Record<string, unknown>) => unknown)(body.variables) : response;
    return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, fetchImpl };
}
const tracker = loadConfig(SAMPLE_CONFIG_INPUT).tracker;
const make = (fetchImpl: typeof fetch, token = 'lin_api_abc', extra: Partial<ConstructorParameters<typeof LinearTracker>[0]> = {}) =>
  new LinearTracker({ token, tracker, fetch: fetchImpl, webhookSecret: fx.WEBHOOK_SECRET, now: () => fx.WEBHOOK_AT + 1000, ...extra });

describe('LinearTracker over GraphQL', () => {
  it('uploads images with Linear signed headers and never forwards its API token to storage', async () => {
    const graph = fakeLinear({ ImageUpload: { data: { fileUpload: { success: true, uploadFile: {
      uploadUrl: 'https://storage.test/signed', assetUrl: 'https://uploads.linear.app/image', headers: [{ key: 'x-upload-signature', value: 'signed' }],
    } } } } });
    const puts: RequestInit[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      if (String(url) !== 'https://storage.test/signed') return graph.fetchImpl(url, init);
      puts.push(init!); return new Response(null, { status: 200 });
    };
    const blob = new Blob(['image'], { type: 'image/png' });
    expect(await make(fetchImpl).uploadImage('test.png', 'image/png', blob)).toBe('https://uploads.linear.app/image');
    expect(graph.calls[0]?.variables).toEqual({ contentType: 'image/png', filename: 'test.png', size: 5 });
    expect(puts[0]?.method).toBe('PUT'); expect(puts[0]?.body).toBe(blob);
    const headers = new Headers(puts[0]?.headers);
    expect(headers.get('x-upload-signature')).toBe('signed'); expect(headers.get('Content-Type')).toBe('image/png');
    expect(headers.has('Authorization')).toBe(false);
    await expect(make(async (url, init) => String(url) === 'https://storage.test/signed'
      ? new Response(null, { status: 503 }) : graph.fetchImpl(url, init)).uploadImage('test.png', 'image/png', blob)).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('sends API keys raw and OAuth tokens as Bearer', () => {
    expect(linearAuthorization('lin_api_abc')).toBe('lin_api_abc');
    expect(linearAuthorization('lin_oauth_xyz')).toBe('Bearer lin_oauth_xyz');
  });
  it('creates an issue in the team project in Triage, creating labels that do not exist yet', async () => {
    const created: string[] = [];
    const { calls, fetchImpl } = fakeLinear({
      Team: fx.TEAM_RESPONSE,
      CreateLabel: (vars: Record<string, unknown>) => { const name = (vars['input'] as { name: string }).name; created.push(name); return fx.LABEL_CREATE_RESPONSE(name, `lb-${created.length}`); },
      CreateIssue: fx.ISSUE_CREATE_RESPONSE,
    });
    const issue = await make(fetchImpl).createIssue({ title: 'Layout: move tool', body: '## Kind\n\nFeature', kind: 'feature', labels: ['feature', 'area:layout', 'source:in-app', 'class:C3', 'eligible:gated'] });
    expect(issue).toEqual({ id: 'iss-1', key: 'FRQ-123', url: fx.ISSUE_NODE.url, title: 'Layout: move tool', state: 'Triage', labels: ['feature', 'area:layout', 'source:in-app', 'class:C3', 'eligible:gated'], body: '## Kind\n\nFeature' });
    expect(created).toEqual(['area:layout', 'class:C3', 'eligible:gated']);
    expect(calls[0]?.headers['Authorization']).toBe('lin_api_abc');
    expect(calls[0]?.variables).toEqual({ key: 'FRQ' });
    const create = calls.find(c => c.query.startsWith('mutation CreateIssue'));
    expect(create?.variables['input']).toEqual({ teamId: 'team-frq', projectId: 'pr-customer', stateId: 'st-triage', labelIds: ['lb-feature', 'lb-1', 'lb-source', 'lb-2', 'lb-3'], title: 'Layout: move tool', description: '## Kind\n\nFeature' });
    expect(calls.filter(c => c.query.startsWith('mutation CreateLabel')).map(c => (c.variables['input'] as { teamId: string }).teamId)).toEqual(['team-frq', 'team-frq', 'team-frq']);
  });
  it('resolves the team once and reuses it across calls', async () => {
    const { calls, fetchImpl } = fakeLinear({ Team: fx.TEAM_RESPONSE, UpdateIssue: fx.ISSUE_UPDATE_RESPONSE });
    const t = make(fetchImpl, 'oauth-token');
    await t.setState('iss-1', 'Build');
    await t.setLabels('iss-1', ['feature', 'defect']);
    expect(calls.filter(c => c.query.startsWith('query Team')).length).toBe(1);
    // Without an explicit page size Linear answers 50 nodes, which a team with many labels or projects exceeds.
    for (const connection of ['states', 'labels', 'projects']) expect(calls[0]!.query).toContain(`${connection}(first: 250)`);
    expect(calls[0]?.headers['Authorization']).toBe('Bearer oauth-token');
    expect(calls[1]?.variables).toEqual({ id: 'iss-1', input: { stateId: 'st-build' } });
    expect(calls[2]?.variables).toEqual({ id: 'iss-1', input: { labelIds: ['lb-feature', 'lb-defect'] } });
    expect(await t.listStateNames()).toEqual(['Triage', 'Backlog', 'Build', 'Design review', 'In Progress', 'In Trial', 'Needs Human', 'Ready for Review', 'Done', 'Canceled']);
    expect(await t.listProjectNames()).toEqual(expect.arrayContaining(['Customer Features']));
  });
  it('files problem reports into the configured problem project when it is separate', async () => {
    const { calls, fetchImpl } = fakeLinear({ Team: fx.TEAM_RESPONSE, CreateIssue: fx.ISSUE_CREATE_RESPONSE });
    const separate = { ...tracker, problemDestination: { sameProject: false, project: 'Defects', label: 'defect' } };
    const t = new LinearTracker({ token: 'lin_api_abc', tracker: separate, fetch: fetchImpl });
    await t.createIssue({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: 'Crash', body: 'x', kind: 'problem', labels: ['defect'] });
    expect(calls[1]?.variables['input']).toMatchObject({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    expect((calls[1]?.variables['input'] as { projectId: string }).projectId).toBe('pr-defects');
    await make(fetchImpl).createIssue({ title: 'Crash', body: 'x', kind: 'problem', labels: ['defect'] });
    expect((calls[3]?.variables['input'] as { projectId: string }).projectId).toBe('pr-customer');
  });
  it('rejects unknown states with an error and unknown teams or projects', async () => {
    const { fetchImpl } = fakeLinear({ Team: fx.TEAM_RESPONSE });
    await expect(make(fetchImpl).setState('iss-1', 'Shipped')).rejects.toThrow(/state "Shipped" does not exist in team FRQ/);
    const other = new LinearTracker({ token: 'x', tracker: { ...tracker, project: 'Missing' }, fetch: fetchImpl });
    await expect(other.createIssue({ title: 't', body: 'b', kind: 'feature', labels: [] })).rejects.toThrow(/project "Missing" was not found/);
    const noTeam = new LinearTracker({ token: 'x', tracker, fetch: fakeLinear({ Team: { data: { teams: { nodes: [] }, issueLabels: { nodes: [] } } } }).fetchImpl });
    await expect(noTeam.listStateNames()).rejects.toThrow(/team "FRQ" was not found/);
  });
  it('adds comments, reads issues and treats a missing issue as null', async () => {
    const { calls, fetchImpl } = fakeLinear({ CreateComment: fx.COMMENT_CREATE_RESPONSE, Issue: (vars: Record<string, unknown>) => (vars['id'] === 'iss-1' ? fx.ISSUE_GET_RESPONSE : fx.ISSUE_GET_NOT_FOUND) });
    const t = make(fetchImpl);
    expect(await t.addComment('iss-1', 'Requester:\nHello')).toEqual({ id: 'cmt-1' });
    expect(calls[0]?.variables).toEqual({ input: { issueId: 'iss-1', body: 'Requester:\nHello' } });
    expect((await t.getIssue('iss-1'))?.key).toBe('FRQ-123');
    expect(await t.getIssue('nope')).toBeNull();
  });
  it('searches open issues of the team by text', async () => {
    const { calls, fetchImpl } = fakeLinear({ OpenIssues: fx.ISSUES_SEARCH_RESPONSE });
    const found = await make(fetchImpl).searchOpen('  move tool ');
    expect(found.map(i => i.key)).toEqual(['FRQ-123', 'FRQ-124']);
    expect(calls[0]?.variables['filter']).toEqual({
      team: { key: { eq: 'FRQ' } }, state: { type: { nin: ['completed', 'canceled'] } },
      or: [{ title: { containsIgnoreCase: 'move tool' } }, { description: { containsIgnoreCase: 'move tool' } }],
    });
    await make(fetchImpl).searchOpen('');
    expect(calls[1]?.variables['filter']).toEqual({ team: { key: { eq: 'FRQ' } }, state: { type: { nin: ['completed', 'canceled'] } } });
  });
  it('maps transport, auth, rate limit and GraphQL errors to TrackerError codes', async () => {
    const failing: typeof fetch = async () => { throw new TypeError('fetch failed'); };
    await expect(make(failing).addComment('i', 'b')).rejects.toMatchObject({ code: 'unavailable' });
    const status = (code: number) => (async () => new Response('{}', { status: code })) as typeof fetch;
    await expect(make(status(401)).addComment('i', 'b')).rejects.toMatchObject({ code: 'auth' });
    await expect(make(status(429)).addComment('i', 'b')).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(make(status(503)).addComment('i', 'b')).rejects.toMatchObject({ code: 'unavailable' });
    await expect(make(fakeLinear({ CreateComment: fx.AUTH_ERROR_RESPONSE }).fetchImpl).addComment('i', 'b')).rejects.toMatchObject({ code: 'auth' });
    await expect(make(fakeLinear({ CreateComment: fx.ISSUE_GET_NOT_FOUND }, 400).fetchImpl).addComment('i', 'b')).rejects.toBeInstanceOf(TrackerError);
    await expect(make(fakeLinear({ CreateComment: { data: { commentCreate: { success: false, comment: { id: '' } } } } }).fetchImpl).addComment('i', 'b')).rejects.toMatchObject({ code: 'invalid' });
  });
  it('retries team resolution after a failure instead of caching the rejection', async () => {
    let attempt = 0;
    const fetchImpl: typeof fetch = async (_u, init) => {
      attempt++;
      if (attempt === 1) return new Response('{}', { status: 503 });
      return new Response(JSON.stringify(/UpdateIssue/.test(String(init?.body)) ? fx.ISSUE_UPDATE_RESPONSE : fx.TEAM_RESPONSE), { status: 200 });
    };
    const t = make(fetchImpl);
    await expect(t.setState('iss-1', 'Build')).rejects.toMatchObject({ code: 'unavailable' });
    await expect(t.setState('iss-1', 'Build')).resolves.toBeUndefined();
  });
});

describe('Linear webhooks', () => {
  const signed = async (payload: unknown, secret = fx.WEBHOOK_SECRET) => {
    const body = JSON.stringify(payload);
    return { body, headers: { 'linear-signature': await hmacSha256Hex(secret, body), 'linear-delivery': 'dlv-1' } };
  };
  it('verifies the HMAC and the 60 s timestamp window', async () => {
    const t = make(fakeLinear({}).fetchImpl);
    expect(await t.verifyWebhook(await signed(fx.ISSUE_STATE_WEBHOOK))).toBe(true);
    expect(await t.verifyWebhook(await signed(fx.ISSUE_STATE_WEBHOOK, 'wrong'))).toBe(false);
    expect(await t.verifyWebhook({ body: JSON.stringify(fx.ISSUE_STATE_WEBHOOK), headers: {} })).toBe(false);
    const late = make(fakeLinear({}).fetchImpl, 'lin_api_abc', { now: () => fx.WEBHOOK_AT + 61_000 });
    expect(await late.verifyWebhook(await signed(fx.ISSUE_STATE_WEBHOOK))).toBe(false);
    const early = make(fakeLinear({}).fetchImpl, 'lin_api_abc', { now: () => fx.WEBHOOK_AT - 61_000 });
    expect(await early.verifyWebhook(await signed(fx.ISSUE_STATE_WEBHOOK))).toBe(false);
    const edge = make(fakeLinear({}).fetchImpl, 'lin_api_abc', { now: () => fx.WEBHOOK_AT + 60_000 });
    expect(await edge.verifyWebhook(await signed(fx.ISSUE_STATE_WEBHOOK))).toBe(true);
    const noTimestamp = await signed({ ...fx.ISSUE_STATE_WEBHOOK, webhookTimestamp: undefined });
    expect(await t.verifyWebhook(noTimestamp)).toBe(false);
    const noSecret = new LinearTracker({ token: 'x', tracker, fetch: fakeLinear({}).fetchImpl });
    expect(await noSecret.verifyWebhook(await signed(fx.ISSUE_STATE_WEBHOOK))).toBe(false);
    expect(await t.verifyWebhook({ body: 'not json', headers: { 'linear-signature': await hmacSha256Hex(fx.WEBHOOK_SECRET, 'not json') } })).toBe(false);
  });
  it('parses an issue state change with the actor and the delivery id', async () => {
    const event = make(fakeLinear({}).fetchImpl).parseWebhook(await signed(fx.ISSUE_STATE_WEBHOOK));
    expect(event).toEqual({
      kind: 'state', issueId: 'iss-1', issueKey: 'FRQ-123', stateName: 'Canceled', previousStateName: null,
      actor: { id: 'usr-maint', name: 'Maintainer', email: 'testers@pushform.io', type: 'user' }, deliveryId: 'dlv-1:state', at: '2026-10-23T10:40:00.000Z',
    });
  });
  it('parses a label change', async () => {
    const event = make(fakeLinear({}).fetchImpl).parseWebhook(await signed(fx.ISSUE_LABEL_WEBHOOK));
    expect(event).toMatchObject({ kind: 'label', issueId: 'iss-1', labels: ['feature', 'class:C5', 'eligible:gated'], previousLabels: null, deliveryId: 'dlv-1:label' });
  });
  it('returns both events when state and labels change together, and none for other updates', async () => {
    const events = parseLinearWebhook(await signed(fx.ISSUE_STATE_AND_LABEL_WEBHOOK));
    expect(events.map(e => e.kind)).toEqual(['state', 'label']);
    expect(parseLinearWebhook(await signed(fx.ISSUE_TITLE_WEBHOOK))).toEqual([]);
    expect(parseLinearWebhook(await signed({ ...fx.ISSUE_STATE_WEBHOOK, action: 'create' }))).toEqual([]);
    expect(parseLinearWebhook(await signed({ type: 'Project', action: 'update', data: { id: 'p' } }))).toEqual([]);
    expect(parseLinearWebhook({ body: '{', headers: {} })).toEqual([]);
  });
  it('parses comment creation, falling back to the comment user when there is no actor', async () => {
    const event = make(fakeLinear({}).fetchImpl).parseWebhook(await signed(fx.COMMENT_WEBHOOK));
    expect(event).toEqual({
      kind: 'comment', issueId: 'iss-1', issueKey: 'FRQ-123', commentId: 'cmt-9', body: 'Requester:\nCould you tell us which browser you used?',
      actor: { id: 'usr-maint', name: 'Maintainer', email: 'testers@pushform.io', type: 'user' }, deliveryId: 'dlv-1', at: '2026-10-23T10:41:00.000Z',
    });
    const [fallback] = parseLinearWebhook({ body: JSON.stringify(fx.COMMENT_WEBHOOK_WITHOUT_ACTOR), headers: {} });
    expect(fallback).toMatchObject({ kind: 'comment', commentId: 'cmt-10', actor: { email: 'testers@pushform.io', type: 'user' }, deliveryId: `wh-1:${fx.WEBHOOK_AT + 60_000}:cmt-10` });
  });
});
