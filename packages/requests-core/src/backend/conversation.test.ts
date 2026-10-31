// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { TrackerError } from '../adapters/tracker.ts';
import { fakeAnthropic, type ScriptedTurn } from '../agents/fakeAnthropic.ts';
import { loadConfig } from '../config/load.ts';
import { SAMPLE_CONFIG_INPUT } from '../config/sample.ts';
import type { ConversationMessage } from '../domain/types.ts';
import { attachmentSection, closeSuspended, createConversationHandler, formatBytes, historyOf, issueSummaryOf, parseSse, requestIdOfIssue, routePath, type ConversationDeps } from './conversation.ts';
import { ServiceDb, UserDb } from './db.ts';
import { ALICE, ATTACHMENT_ID, attachmentRow, CONVERSATION_ID, conversationRow, FakeRpc, FakeSessions, FakeStorage, FakeTracker, myRoles, REQUEST_ID, requestRow, sqlError, TOKEN, type RpcScript } from './fakes.ts';

const config = loadConfig(SAMPLE_CONFIG_INPUT);
const BRIEF = { kind: 'feature', problem: 'I cannot lock the inference direction', workaround: null, desired: 'Hold Shift to lock it', acceptance: [], mustNotChange: null, area: 'Modeling', importance: null, estimatedClass: 'C3' };

interface Harness { handler: (req: Request) => Promise<Response>; service: FakeRpc; user: FakeRpc; tracker: FakeTracker; authHeaders: string[]; deps: ConversationDeps }
function harness(over: { service?: Record<string, RpcScript>; user?: Record<string, RpcScript>; turns?: ScriptedTurn[]; deps?: Partial<ConversationDeps> } = {}): Harness {
  const service = new FakeRpc({
    fr_conversation_start: (p) => conversationRow({ kind: p['p_kind'] as string, path: p['p_path'] as string, screen: p['p_screen'] }),
    fr_conversation_get: conversationRow(), fr_conversation_list_open: [conversationRow({ title: 'Lock inference' })],
    fr_conversation_append: (p) => conversationRow({ messages: p['p_messages'], message_count: (p['p_messages'] as unknown[]).filter(m => (m as { role: string }).role === 'user').length, brief: p['p_brief'], title: p['p_title'] as string | null }),
    fr_conversation_close: (p) => conversationRow({ status: p['p_status'] as string, closed_at: 't' }), fr_rate_check: true, fr_request_count_open: 0,
    fr_request_file: (p) => requestRow({ issue_id: p['p_issue_id'] as string, issue_key: p['p_issue_key'] as string, issue_url: p['p_issue_url'] as string, title: p['p_title'] as string, eligibility: p['p_eligibility'] as string }),
    fr_attachment_list: [], fr_attachment_bind: { request_id: REQUEST_ID, removed: [] },
    fr_request_add_me: requestRow(), fr_outbox_enqueue: 'ob-1', ...over.service,
  }, 'service');
  const user = new FakeRpc({ fr_my_roles: myRoles(), fr_list_my_requests: [requestRow()], fr_get_request: requestRow(), fr_withdraw: requestRow({ requester_state: 'Withdrawn', state: 'Canceled' }), fr_reply: { ok: true, outbox_id: 'o', request: requestRow() }, ...over.user }, 'user');
  const tracker = new FakeTracker();
  const authHeaders: string[] = [];
  const deps: ConversationDeps = {
    config, db: new ServiceDb(service), userDb: (req) => { authHeaders.push(req.headers.get('authorization') ?? ''); return new UserDb(user); }, auth: new FakeSessions(), tracker,
    anthropic: fakeAnthropic(over.turns ?? [{ text: ['Hello'] }]), digest: [], backendUrl: 'https://p.supabase.co/functions/v1/fr-conversation', now: () => new Date('2026-10-23T10:30:00Z'), openIssuesTtlSeconds: 0, ...over.deps,
  };
  return { handler: createConversationHandler(deps), service, user, tracker, authHeaders, deps };
}
const call = (handler: Harness['handler'], method: string, path: string, body?: unknown, auth: string | null = `Bearer ${TOKEN}`) =>
  handler(new Request(`http://x${path}`, { method, headers: { ...(auth ? { Authorization: auth } : {}), 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }));
const status = async (res: Response, code: number, errorCode?: string) => {
  expect(res.status).toBe(code);
  const json = await res.json() as { error?: { code: string } };
  if (errorCode) expect(json.error?.code).toBe(errorCode);
  return json as Record<string, unknown>;
};

describe('routing, CORS and auth', () => {
  it('strips the function prefix, answers OPTIONS, 401 without a session and 404 for unknown routes', async () => {
    expect(routePath('https://p.supabase.co/functions/v1/fr-conversation/conversations/abc/messages')).toBe('/conversations/abc/messages');
    expect(routePath('http://x/me')).toBe('/me');
    const { handler } = harness();
    const opt = await handler(new Request('http://x/me', { method: 'OPTIONS' }));
    expect(opt.status).toBe(204); expect(opt.headers.get('access-control-allow-origin')).toBe('*'); expect(opt.headers.get('access-control-allow-headers')).toContain('apikey');
    await status(await call(handler, 'GET', '/me', undefined, null), 401, 'unauthorized');
    await status(await call(handler, 'GET', '/me', undefined, 'Bearer unknown'), 401, 'unauthorized');
    await status(await call(handler, 'GET', '/nothing'), 404, 'not_found');
    await status(await call(handler, 'POST', '/me'), 404, 'not_found');
  });
  it('GET /health needs no auth, validates the tracker state names and works without a tracker', async () => {
    const h = harness();
    expect(await (await call(h.handler, 'GET', '/health', undefined, null)).json()).toEqual({ ok: true, config: 'valid', host: 'pushform' });
    h.tracker.stateNames = h.tracker.stateNames.filter(s => s !== 'Triage');
    const bad = await call(h.handler, 'GET', '/fr-conversation/health', undefined, null);
    expect(bad.status).toBe(503);
    expect(await bad.json()).toMatchObject({ ok: false, config: 'invalid', errors: [expect.stringContaining('tracker.states.triage')] });
    h.tracker.projectNames = ['Something else'];
    expect(await (await call(h.handler, 'GET', '/health', undefined, null)).json()).toMatchObject({ errors: expect.arrayContaining([expect.stringContaining('tracker.project: project "Customer Features" does not exist')]) });
    const none = harness({ deps: { tracker: null } });
    expect((await call(none.handler, 'GET', '/health', undefined, null)).status).toBe(200);
  });
  it('GET /me reads roles through the user-scoped RPC carrying the session header, never the service RPC', async () => {
    const h = harness({ user: { fr_my_roles: myRoles({ roles: [{ role: 'builder', org_id: null }], effective: 'builder', open_requests: 2 }) } });
    const me = await status(await call(h.handler, 'GET', '/me'), 200);
    expect(me).toEqual({ email: ALICE.email, roles: [{ role: 'builder', orgId: null }], effective: 'builder', filingDisabled: false, buildsDisabled: false, trialsDisabled: false, openRequests: 2, limits: { openRequestsPerAccount: 5, messagesPerConversation: 30 } });
    expect(h.user.calls.map(c => c.name)).toEqual(['fr_my_roles']); expect(h.service.calls).toEqual([]); expect(h.authHeaders).toEqual([`Bearer ${TOKEN}`]);
  });
});

describe('conversations', () => {
  it.each(['help', 'open'] as const)('prefetches bounded current-editor help on %s without waiting for the tracker', async path => {
    const h = harness({ service: { fr_conversation_get: conversationRow({ path, screen: { editor: 'layout', build: { version: 'v', commit: 'c' }, browser: 'test', os: 'test' } }) }, deps: { digest: [
      { path: 'docs/help/layout/images.md', heading: 'Import images', anchor: 'import', text: 'Import PNG images using Import in the toolbar.' },
      { path: 'docs/help/modeling/images.md', heading: 'Import images', anchor: 'import', text: 'WRONG_EDITOR PNG images.' },
      { path: 'specs/layout.md', heading: 'Import images', anchor: 'import', text: 'INTERNAL PNG images.' },
    ] } });
    let searches = 0;
    h.tracker.searchOpen = async () => { searches += 1; throw new Error('tracker offline'); };
    const res = await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'import PNG images' });
    expect(parseSse(await res.text()).at(-1)?.event).toBe('done');
    expect(searches).toBe(0);
    const params = (h.deps.anthropic as ReturnType<typeof fakeAnthropic>).calls[0]!;
    const content = String(params.messages.at(-1)?.content);
    expect(content).toContain('<retrieved_help>\nImport images\nImport PNG images using Import in the toolbar.');
    expect(content).not.toMatch(/WRONG_EDITOR|INTERNAL/);
    expect(content.split('<retrieved_help>')[1]!.split('</retrieved_help>')[0]!.trim().length).toBeLessThanOrEqual(5200);
    const persisted = h.service.named('fr_conversation_append')[0]!.params['p_messages'];
    expect(JSON.stringify(persisted)).not.toContain('<retrieved_help>');
  });

  it('delivers the first text chunk before the model finishes or the transcript is saved', async () => {
    const scripted = fakeAnthropic([{ text: ['First ', 'step.'] }]);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const h = harness({ deps: { anthropic: { messages: { stream(params) {
      const stream = scripted.messages.stream(params);
      return { [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](), finalMessage: async () => { await held; return stream.finalMessage(); } };
    } } } } });
    const response = await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'Help' });
    const reader = response.body!.getReader();
    try {
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('"delta":"First "');
      expect(h.service.named('fr_conversation_append')).toHaveLength(0);
    } finally { release(); }
    while (!(await reader.read()).done) { /* consume the rest */ }
    expect(h.service.named('fr_conversation_append')).toHaveLength(1);
  });

  it('starts a conversation with a validated screen and lists open ones', async () => {
    const h = harness();
    const screen = { editor: 'model', documentType: 'model', build: { version: '0.3.0', commit: 'abc123' }, browser: 'Chrome 141', os: 'macOS 15' };
    const res = await call(h.handler, 'POST', '/conversations', { kind: 'intake', path: 'problem', screen });
    const body = await status(res, 201) as { conversation: Record<string, unknown> };
    expect(body.conversation).toMatchObject({ id: CONVERSATION_ID, kind: 'intake', path: 'problem', status: 'open', messages: [], messageCount: 0, requestId: null, screen });
    expect(h.service.named('fr_conversation_start')[0]).toEqual({ name: 'fr_conversation_start', params: { p_host: 'pushform', p_owner: ALICE.id, p_email: ALICE.email, p_kind: 'intake', p_path: 'problem', p_screen: screen } });
    await status(await call(h.handler, 'POST', '/conversations', { kind: 'help', path: 'feature', screen }), 400, 'invalid');
    await status(await call(h.handler, 'POST', '/conversations', { kind: 'help', path: 'help', screen: { editor: 'desk' } }), 400, 'invalid');
    const open = await status(await call(h.handler, 'GET', '/conversations/open'), 200);
    expect(open).toEqual({ conversations: [{ id: CONVERSATION_ID, kind: 'intake', path: 'feature', title: 'Lock inference', updatedAt: '2026-10-23T10:00:00Z', messageCount: 0 }] });
  });
  it('gets, edits the brief, and discards; another account’s conversation reads as not found', async () => {
    const h = harness({ service: { fr_conversation_get: conversationRow({ brief: BRIEF }) } });
    const got = await status(await call(h.handler, 'GET', `/conversations/${CONVERSATION_ID}`), 200) as { conversation: Record<string, unknown> };
    expect(got.conversation['id']).toBe(CONVERSATION_ID);
    // The browser cannot set the estimated class; the stored one (C3) carries forward whatever the body says.
    const edited = await status(await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/brief`, { brief: { ...BRIEF, estimatedClass: 'C1' }, title: 'Lock inference with Shift' }), 200) as { conversation: Record<string, unknown> };
    expect(edited.conversation['brief']).toEqual(BRIEF); expect(edited.conversation['title']).toBe('Lock inference with Shift');
    expect(h.service.named('fr_conversation_append')[0]!.params).toEqual({ p_id: CONVERSATION_ID, p_owner: ALICE.id, p_messages: [], p_brief: BRIEF, p_title: 'Lock inference with Shift', p_path: 'feature' });
    const fresh = harness();
    await call(fresh.handler, 'POST', `/conversations/${CONVERSATION_ID}/brief`, { brief: { ...BRIEF, estimatedClass: 'C1' } });
    expect((fresh.service.named('fr_conversation_append')[0]!.params['p_brief'] as { estimatedClass: string | null }).estimatedClass).toBeNull();
    await status(await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/brief`, { brief: { ...BRIEF, problem: 'x'.repeat(4001) } }), 400, 'invalid');
    await status(await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/brief`, { brief: { kind: 'feature', nope: 1 } }), 400, 'invalid');
    expect(await status(await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/discard`), 200)).toEqual({ ok: true });
    expect(h.service.named('fr_conversation_close')[0]!.params).toEqual({ p_id: CONVERSATION_ID, p_owner: ALICE.id, p_status: 'discarded' });
    const other = harness({ service: { fr_conversation_get: () => sqlError('fr_forbidden') } });
    await status(await call(other.handler, 'GET', `/conversations/${CONVERSATION_ID}`), 404, 'not_found');
    await status(await call(other.handler, 'GET', '/conversations/not-a-uuid'), 404, 'not_found');
  });
});

describe('POST /conversations/:id/messages (SSE)', () => {
  const turns: ScriptedTurn[] = [
    { toolUses: [{ id: 't1', name: 'update_brief', input: { section: 'problem', text: 'I cannot lock the inference direction' } }, { id: 't2', name: 'search_open_issues', input: { query: 'lock inference' } }] },
    { text: ['Noted', '. FRQ-101 "Lock inference with Shift" looks like the same request. Shall I add you to it?'] },
  ];
  it('streams brief, text and done in order, then persists both sides plus the tool calls', async () => {
    const h = harness({ turns });
    await h.tracker.createIssue({ title: 'Lock inference with Shift', body: 'b', kind: 'feature', labels: ['feature'] });
    h.service.tables['fr_requests'] = [{ id: REQUEST_ID, issue_id: 'iss-1', host_id: 'pushform' }];
    const res = await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'I want to lock the inference direction' });
    expect(res.status).toBe(200); expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = parseSse(await res.text());
    expect(events.map(e => e.event)).toEqual(['brief', 'text', 'text', 'brief', 'done']);
    expect(events[0]!.data).toMatchObject({ brief: { kind: 'feature', problem: 'I cannot lock the inference direction' }, title: null, path: 'feature', estimatedClass: null });
    expect(events[1]!.data).toEqual({ delta: 'Noted' });
    expect(events[4]!.data).toEqual({ messageCount: 1, limitReached: false, ended: false });
    // Rate check first, roles and own requests through the user RPC, the owner-only open count, then one append with user, tool, tool, assistant.
    expect(h.service.calls.map(c => c.name)).toEqual(['fr_conversation_get', 'fr_rate_check', 'fr_request_count_open', 'fr_conversation_append']);
    expect(h.user.calls.map(c => c.name).sort()).toEqual(['fr_list_my_requests', 'fr_my_roles']);
    const append = h.service.named('fr_conversation_append')[0]!.params;
    const messages = append['p_messages'] as ConversationMessage[];
    expect(messages.map(m => m.role)).toEqual(['user', 'tool', 'tool', 'assistant']);
    expect(messages[0]).toEqual({ role: 'user', text: 'I want to lock the inference direction', at: '2026-10-23T10:30:00.000Z' });
    expect(messages[1]).toMatchObject({ role: 'tool', name: 'update_brief', toolUseId: 't1' });
    expect(messages[2]).toMatchObject({ role: 'tool', name: 'search_open_issues', output: expect.stringContaining('FRQ-101 (issue_id iss-1, feature, Triage, filed in-app)') });
    expect(messages[3]).toMatchObject({ role: 'assistant', text: expect.stringContaining('Noted. FRQ-101') });
    expect(append['p_brief']).toMatchObject({ problem: 'I cannot lock the inference direction' }); expect(append['p_path']).toBe('feature');
    // The model saw the stable system prompt, the volatile context in the user message, and the framed requester text.
    const anthropic = h.deps.anthropic as ReturnType<typeof fakeAnthropic>;
    const first = anthropic.calls[0]!;
    expect(first.model).toBe('claude-haiku-5-5');
    expect((first.system as { text: string }[])[0]!.text).not.toContain(ALICE.email);
    const userMessage = first.messages[0]!.content as string;
    expect(userMessage).toContain('account_email: alice@example.com'); expect(userMessage).toContain('FRQ-101');
    expect(userMessage).toContain('<requester_message>\nI want to lock the inference direction\n</requester_message>');
    // A message body may no longer ask for a filing: the agent files from the chat.
    expect(first.messages[0]!.content).not.toContain('fileRequested');
  });
  it('add_me after a yes subscribes at once, emits added, closes the conversation and ends the turn', async () => {
    const h = harness({ turns: [
      { toolUses: [{ id: 't1', name: 'add_me', input: { issueId: 'iss-1', notes: 'Also on Layout pages' } }] },
      { text: ['Done: I added you to FRQ-123. Your next message starts a new conversation.'] },
    ] });
    await h.tracker.createIssue({ title: 'Lock inference with Shift', body: 'b', kind: 'feature', labels: ['feature'] });
    h.service.tables['fr_requests'] = [{ id: REQUEST_ID, issue_id: 'iss-1', host_id: 'pushform' }];
    const events = parseSse(await (await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'yes, add me' })).text());
    expect(events.map(e => e.event)).toEqual(['text', 'brief', 'added', 'done']);
    expect(events[2]!.data).toEqual({ request: { id: REQUEST_ID, issueKey: 'FRQ-123', issueUrl: 'https://linear.app/pushform/issue/FRQ-123', title: 'Lock inference with Shift', requesterState: 'Submitted', eligibility: 'none' } });
    expect(events[3]!.data).toEqual({ messageCount: 1, limitReached: false, ended: true, reason: 'added' });
    expect(h.service.named('fr_request_add_me')[0]!.params).toEqual({ p_host: 'pushform', p_request: REQUEST_ID, p_owner: ALICE.id, p_email: ALICE.email, p_notes: 'Also on Layout pages' });
    // The transcript, including the closing text, is saved before the conversation closes.
    const names = h.service.calls.map(c => c.name);
    expect(names.indexOf('fr_conversation_append')).toBeLessThan(names.indexOf('fr_conversation_close'));
    expect(h.service.named('fr_conversation_close')[0]!.params['p_status']).toBe('closed');
    const tool = (h.service.named('fr_conversation_append')[0]!.params['p_messages'] as ConversationMessage[])[1] as { output: string };
    expect(tool.output).toContain('Added the requester to FRQ-123');
    // A request that is gone surfaces as a tool error the agent relays; the conversation stays open.
    const gone = harness({ service: { fr_request_add_me: () => sqlError('fr_invalid') }, turns: [{ toolUses: [{ id: 't1', name: 'add_me', input: { issueId: 'iss-1', notes: '' } }] }, { text: ['That request is closed now; let us continue with yours.'] }] });
    await gone.tracker.createIssue({ title: 'Lock inference with Shift', body: 'b', kind: 'feature', labels: ['feature'] });
    gone.service.tables['fr_requests'] = [{ id: REQUEST_ID, issue_id: 'iss-1', host_id: 'pushform' }];
    const ge = parseSse(await (await call(gone.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'yes' })).text());
    expect(ge.map(e => e.event)).toEqual(['text', 'brief', 'done']); expect(ge[2]!.data).toMatchObject({ ended: false });
    expect(((gone.service.named('fr_conversation_append')[0]!.params['p_messages'] as ConversationMessage[])[1] as { output: string }).output).toContain('no longer accepts new subscribers');
    expect(gone.service.named('fr_conversation_close')).toEqual([]);
  });
  describe('request_file from the chat', () => {
    const ready = conversationRow({ brief: BRIEF, title: 'Lock inference with Shift' });
    const fileTurns: ScriptedTurn[] = [
      { toolUses: [{ id: 't1', name: 'request_file', input: { confirmation: 'yes, send it' } }] },
      { text: ['Filed as FRQ-101. A maintainer reviews it and you get email updates.'] },
    ];
    it('creates the issue during the turn, appends the closing text, records the request, then emits filed and done ended', async () => {
      const h = harness({ service: { fr_conversation_get: ready }, turns: fileTurns });
      const events = parseSse(await (await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'yes, send it' })).text());
      expect(events.map(e => e.event)).toEqual(['text', 'brief', 'filed', 'done']);
      expect(events[2]!.data).toEqual({ request: { id: REQUEST_ID, issueKey: 'FRQ-101', issueUrl: 'https://linear.app/pushform/issue/FRQ-101', title: 'Lock inference with Shift', requesterState: 'Submitted', eligibility: 'none' } });
      expect(events[3]!.data).toEqual({ messageCount: 1, limitReached: false, ended: true, reason: 'filed' });
      expect(h.tracker.created).toHaveLength(1);
      expect(h.tracker.created[0]).toMatchObject({ title: 'Lock inference with Shift', kind: 'feature', labels: ['feature', 'area:modeling', 'source:in-app', ] });
      // The transcript (user, tool, assistant) is appended before fr_request_file closes the conversation; the comment follows.
      const names = h.service.calls.map(c => c.name);
      expect(names.slice(names.indexOf('fr_conversation_append'))).toEqual(['fr_conversation_append', 'fr_request_file', 'fr_attachment_bind', 'fr_outbox_enqueue']);
      const messages = h.service.named('fr_conversation_append')[0]!.params['p_messages'] as ConversationMessage[];
      expect(messages.map(m => m.role)).toEqual(['user', 'tool', 'assistant']);
      expect((messages[1] as { output: string }).output).toContain('Filed FRQ-101 "Lock inference with Shift"');
      expect((messages[1] as { output: string }).output).toContain('ordinary ticket');
      expect(messages[2]).toMatchObject({ role: 'assistant', text: expect.stringContaining('Filed as FRQ-101') });
      expect(h.service.named('fr_request_file')[0]!.params).toMatchObject({ p_conversation: CONVERSATION_ID, p_owner: ALICE.id, p_title: 'Lock inference with Shift', p_brief: BRIEF, p_issue_key: 'FRQ-101', p_eligibility: 'none' });
      expect(h.service.named('fr_conversation_close')).toEqual([]);
      // The model never saw a File request instruction, and request_file was among its tools.
      const first = (h.deps.anthropic as ReturnType<typeof fakeAnthropic>).calls[0]!;
      expect((first.tools as { name: string }[]).map(t => t.name)).toContain('request_file');
      expect((first.system as { text: string }[])[0]!.text).not.toContain('File request button');
    });
    it('files once per turn: a second request_file returns the same issue, and the title set in the turn is used', async () => {
      const h = harness({ service: { fr_conversation_get: conversationRow({ brief: BRIEF }) }, turns: [
        { toolUses: [{ id: 't0', name: 'propose_title', input: { title: 'Lock inference direction with Shift' } }, { id: 't1', name: 'request_file', input: { confirmation: 'yes' } }, { id: 't2', name: 'request_file', input: { confirmation: 'yes' } }] },
        { text: ['Filed as FRQ-101.'] },
      ] });
      const events = parseSse(await (await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'yes' })).text());
      expect(events.map(e => e.event)).toEqual(['brief', 'text', 'brief', 'filed', 'done']);
      expect(h.tracker.created).toHaveLength(1); expect(h.service.named('fr_request_file')).toHaveLength(1);
      expect(h.service.named('fr_request_file')[0]!.params['p_title']).toBe('Lock inference direction with Shift');
      const messages = h.service.named('fr_conversation_append')[0]!.params['p_messages'] as ConversationMessage[];
      expect((messages[3] as { output: string }).output).toContain('Filed FRQ-101');
    });
    it('surfaces a tracker failure as a tool error the agent relays, keeps the brief and leaves the conversation open', async () => {
      const h = harness({ service: { fr_conversation_get: ready }, turns: [
        { toolUses: [{ id: 't1', name: 'request_file', input: { confirmation: 'yes' } }] },
        { text: ['Sorry, filing failed: the tracker could not be reached. Your brief is kept; say "send it" to try again.'] },
      ] });
      h.tracker.failCreate = new TrackerError('unavailable', 'Could not reach Linear.');
      const events = parseSse(await (await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'yes' })).text());
      expect(events.map(e => e.event)).toEqual(['text', 'brief', 'done']);
      expect(events[2]!.data).toEqual({ messageCount: 1, limitReached: false, ended: false });
      const tool = (h.service.named('fr_conversation_append')[0]!.params['p_messages'] as ConversationMessage[])[1] as { output: string };
      expect(tool.output).toContain('Filing failed: Could not reach Linear.');
      expect(tool.output).toContain('they can confirm again');
      expect(h.service.named('fr_request_file')).toEqual([]); expect(h.service.named('fr_conversation_close')).toEqual([]);
      // Completeness and the open-request limit are reported the same way, before any issue exists.
      const limit = harness({ service: { fr_conversation_get: ready, fr_request_count_open: 5 }, turns: [{ toolUses: [{ id: 't1', name: 'request_file', input: { confirmation: 'yes' } }] }, { text: ['You have five open requests.'] }] });
      await (await call(limit.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'yes' })).text();
      expect(limit.tracker.created).toEqual([]);
      expect(((limit.service.named('fr_conversation_append')[0]!.params['p_messages'] as ConversationMessage[])[1] as { output: string }).output).toContain('limit is 5');
      const empty = harness({ service: { fr_conversation_get: conversationRow({ brief: { ...BRIEF, problem: null, desired: null } }) }, turns: [{ toolUses: [{ id: 't1', name: 'request_file', input: { confirmation: 'yes' } }] }, { text: ['I need the problem or the desired behavior first.'] }] });
      await (await call(empty.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'send it' })).text();
      expect(empty.tracker.created).toEqual([]);
      expect(((empty.service.named('fr_conversation_append')[0]!.params['p_messages'] as ConversationMessage[])[1] as { output: string }).output).toContain('the Problem or the Desired behavior');
    });
    it('still records an issue created in the turn when the model fails afterwards, and cancels it when the record fails', async () => {
      const h = harness({ service: { fr_conversation_get: ready }, turns: [{ toolUses: [{ id: 't1', name: 'request_file', input: { confirmation: 'yes' } }] }] }); // no closing turn: the model call throws
      const events = parseSse(await (await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'yes' })).text());
      expect(events.map(e => e.event)).toEqual(['filed', 'error']);
      expect(h.service.calls.map(c => c.name).slice(-4)).toEqual(['fr_conversation_append', 'fr_request_file', 'fr_attachment_bind', 'fr_outbox_enqueue']);
      const raced = harness({ service: { fr_conversation_get: ready, fr_request_file: () => sqlError('fr_limit') }, turns: fileTurns });
      const re = parseSse(await (await call(raced.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'yes' })).text());
      expect(re.map(e => e.event)).toEqual(['text', 'brief', 'error']);
      expect(re[2]!.data).toMatchObject({ code: 'limit' });
      expect(raced.tracker.states).toEqual([{ issueId: 'iss-1', stateName: 'Canceled' }]);
    });
  });
  it('start_over discards the conversation after the closing text is saved and ends the turn with its reason', async () => {
    const h = harness({ turns: [{ toolUses: [{ id: 't1', name: 'start_over', input: { reason: 'asked to start over' } }] }, { text: ['Dropped. Your next message starts fresh.'] }] });
    const events = parseSse(await (await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'start over please' })).text());
    expect(events.map(e => e.event)).toEqual(['text', 'brief', 'done']);
    expect(events[2]!.data).toEqual({ messageCount: 1, limitReached: false, ended: true, reason: 'start_over' });
    const names = h.service.calls.map(c => c.name);
    expect(names.slice(names.indexOf('fr_conversation_append'))).toEqual(['fr_conversation_append', 'fr_conversation_close']);
    expect(h.service.named('fr_conversation_close')[0]!.params).toEqual({ p_id: CONVERSATION_ID, p_owner: ALICE.id, p_status: 'discarded' });
    expect(((h.service.named('fr_conversation_append')[0]!.params['p_messages'] as ConversationMessage[])[2] as { text: string }).text).toContain('Dropped');
    // The help path has it too.
    const help = harness({ service: { fr_conversation_get: conversationRow({ kind: 'help', path: 'help' }) }, turns: [{ toolUses: [{ id: 't1', name: 'start_over', input: { reason: 'r' } }] }, { text: ['Fresh start.'] }] });
    const he = parseSse(await (await call(help.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'start over' })).text());
    expect(he.map(e => e.event)).toEqual(['text', 'done']); expect(he[1]!.data).toMatchObject({ ended: true, reason: 'start_over' });
    expect(help.service.named('fr_conversation_close')[0]!.params['p_status']).toBe('discarded');
  });
  it('keeps the requester message, tool calls and brief when the model call fails, then reports the error', async () => {
    const h = harness({ turns: [{ toolUses: [{ id: 't1', name: 'update_brief', input: { section: 'problem', text: 'saved anyway' } }] }] }); // no second turn: the next call throws
    const events = parseSse(await (await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'hi' })).text());
    expect(events.map(e => e.event)).toEqual(['brief', 'error']);
    const append = h.service.named('fr_conversation_append')[0]!.params;
    expect((append['p_messages'] as ConversationMessage[]).map(m => m.role)).toEqual(['user', 'tool']);
    expect(append['p_brief']).toMatchObject({ problem: 'saved anyway' });
  });
  it('ends the conversation on abusive content: closes it and tells the panel', async () => {
    const h = harness({ turns: [{ toolUses: [{ id: 't1', name: 'decline', input: { reason: 'abusive' } }] }, { text: ['I cannot file this.'] }] });
    const events = parseSse(await (await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'abuse' })).text());
    expect(events.map(e => e.event)).toEqual(['text', 'brief', 'done']);
    expect(events[2]!.data).toEqual({ messageCount: 1, limitReached: false, ended: true, reason: 'abusive' });
    expect(h.service.named('fr_conversation_close')[0]!.params).toEqual({ p_id: CONVERSATION_ID, p_owner: ALICE.id, p_status: 'discarded' });
    const polite = harness({ turns: [{ toolUses: [{ id: 't1', name: 'decline', input: { reason: 'off_topic' } }] }, { text: ['Not for this product.'] }] });
    await call(polite.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'zebra' });
    expect(polite.service.named('fr_conversation_close')).toEqual([]);
  });
  it('rate limits every requester-initiated write, not only messages', async () => {
    const h = harness({ service: { fr_rate_check: false } });
    const screen = { editor: 'model', build: { version: '0.3.0', commit: 'abc123' }, browser: 'Chrome 141', os: 'macOS 15' };
    await status(await call(h.handler, 'POST', '/conversations', { kind: 'intake', path: 'feature', screen }), 429, 'rate_limited');
    await status(await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/brief`, { brief: BRIEF }), 429, 'rate_limited');
    await status(await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/add-me`, { requestId: REQUEST_ID, notes: '' }), 429, 'rate_limited');
    await status(await call(h.handler, 'POST', `/requests/${REQUEST_ID}/reply`, { text: 'again' }), 429, 'rate_limited');
    expect(h.service.calls.filter(c => c.name !== 'fr_rate_check' && c.name !== 'fr_conversation_get')).toEqual([]);
    expect(h.user.named('fr_reply')).toEqual([]);
  });
  it('answers 429 when the rate check fails, 409 at the message limit, 400 for empty text, and 404 for other accounts', async () => {
    const limited = harness({ service: { fr_rate_check: false } });
    const res = await call(limited.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'hi' });
    await status(res, 429, 'rate_limited'); expect(res.headers.get('retry-after')).toBe('60');
    expect(limited.service.named('fr_conversation_append')).toEqual([]);
    const full = harness({ service: { fr_conversation_get: conversationRow({ message_count: 30 }) } });
    await status(await call(full.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'hi' }), 409, 'limit');
    await status(await call(full.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: '' }), 400, 'invalid');
    // A filed conversation is complete: the next message needs a new conversation.
    const closed = harness({ service: { fr_conversation_get: conversationRow({ status: 'filed', request_id: REQUEST_ID, closed_at: 't' }) } });
    await status(await call(closed.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'hi' }), 400, 'invalid');
    expect(closed.service.named('fr_conversation_append')).toEqual([]);
    const other = harness({ service: { fr_conversation_get: () => sqlError('fr_forbidden') } });
    await status(await call(other.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'hi' }), 404, 'not_found');
  });
  it('a help conversation switches paths from the chat after a yes: the brief event carries the new path and the row is saved on it', async () => {
    const h = harness({ service: { fr_conversation_get: conversationRow({ kind: 'help', path: 'help' }) }, turns: [{ toolUses: [{ id: 't1', name: 'switch_path', input: { to: 'feature', reason: 'not specified' } }] }, { text: ['Switched. What are you trying to do?'] }] });
    const events = parseSse(await (await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'yes, request it' })).text());
    expect(events.map(e => e.event)).toEqual(['brief', 'text', 'brief', 'done']);
    expect(events[0]!.data).toMatchObject({ path: 'feature', brief: { kind: 'feature' } });
    expect(h.service.named('fr_conversation_append')[0]!.params).toMatchObject({ p_path: 'feature', p_brief: { kind: 'feature' } });
  });
  it('uses the help agent on the help path, reports persistence failures as an error event, and marks the limit on the last message', async () => {
    const help = harness({ service: { fr_conversation_get: conversationRow({ kind: 'help', path: 'help' }), fr_conversation_append: conversationRow({ message_count: 30 }) }, turns: [{ text: ['Shift locks it.'] }] });
    const events = parseSse(await (await call(help.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'How do I lock inference?' })).text());
    expect(events.map(e => e.event)).toEqual(['text', 'done']);
    expect(events[1]!.data).toEqual({ messageCount: 30, limitReached: true, ended: false });
    const system = (help.deps.anthropic as ReturnType<typeof fakeAnthropic>).calls[0]!.system as { text: string }[];
    expect(system[0]!.text).toContain('Help assistant');
    const failing = harness({ service: { fr_conversation_append: () => sqlError('fr_limit') } });
    const failed = parseSse(await (await call(failing.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'hi' })).text());
    expect(failed.map(e => e.event)).toEqual(['text', 'error']);
    expect(failed[1]!.data).toMatchObject({ code: 'limit' });
  });
  it('rebuilds the model history from stored messages with tool calls grouped into tool_use/tool_result pairs', () => {
    const stored: ConversationMessage[] = [
      { role: 'user', text: 'first', at: 't' },
      { role: 'tool', name: 'search_docs', toolUseId: 'a', input: { query: 'x' }, output: 'found', at: 't' },
      { role: 'tool', name: 'update_brief', toolUseId: 'b', input: {}, output: 'ok', at: 't' },
      { role: 'assistant', text: 'reply', at: 't' },
      { role: 'user', text: 'second', at: 't' },
    ];
    const history = historyOf(stored, '<context>c</context>', 'third');
    expect(history.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user']);
    expect(history[1]!.content).toEqual([{ type: 'tool_use', id: 'a', name: 'search_docs', input: { query: 'x' } }, { type: 'tool_use', id: 'b', name: 'update_brief', input: {} }]);
    expect(history[2]!.content).toEqual([{ type: 'tool_result', tool_use_id: 'a', content: 'Earlier help passages omitted. Search user help again if needed.' }, { type: 'tool_result', tool_use_id: 'b', content: 'ok' }]);
    expect(history[5]!.content).toEqual([{ type: 'text', text: '(continued)' }]);
    expect(history[6]!.content).toBe('<context>c</context>\n\n<requester_message>\nthird\n</requester_message>');
    expect(historyOf([], 'ctx', 'hi')).toHaveLength(1);
  });
});

describe('open conversations (chat-first, the path comes from the first message)', () => {
  const screen = { editor: 'home', build: { version: '0.3.0', commit: 'abc123' }, browser: 'Chrome 141', os: 'macOS 15' };
  const openRow = conversationRow({ kind: 'intake', path: 'open', screen });
  it('starts with path open (kind intake) and returns it unchanged from GET and the open list', async () => {
    const h = harness({ service: { fr_conversation_get: openRow, fr_conversation_list_open: [openRow] } });
    const started = await status(await call(h.handler, 'POST', '/conversations', { kind: 'intake', path: 'open', screen }), 201) as { conversation: Record<string, unknown> };
    expect(started.conversation).toMatchObject({ kind: 'intake', path: 'open', status: 'open' });
    expect(h.service.named('fr_conversation_start')[0]!.params).toMatchObject({ p_kind: 'intake', p_path: 'open' });
    await status(await call(h.handler, 'POST', '/conversations', { kind: 'help', path: 'open', screen }), 400, 'invalid');
    const got = await status(await call(h.handler, 'GET', `/conversations/${CONVERSATION_ID}`), 200) as { conversation: Record<string, unknown> };
    expect(got.conversation['path']).toBe('open');
    const open = await status(await call(h.handler, 'GET', '/conversations/open'), 200) as { conversations: Record<string, unknown>[] };
    expect(open.conversations[0]).toMatchObject({ kind: 'intake', path: 'open' });
  });
  it('a clicked card (intent) settles the path and kind before the agent runs, announces it as a brief event, and runs that path’s agent', async () => {
    const h = harness({ service: { fr_conversation_get: openRow }, turns: [{ text: ['Shift locks it.'] }] });
    const events = parseSse(await (await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'Get help', intent: 'help' })).text());
    expect(events.map(e => e.event)).toEqual(['brief', 'text', 'done']);
    expect(events[0]!.data).toEqual({ brief: null, title: null, path: 'help', estimatedClass: null });
    expect((h.deps.anthropic as ReturnType<typeof fakeAnthropic>).calls[0]!.system).toEqual([expect.objectContaining({ text: expect.stringContaining('Help assistant') })]);
    expect(h.service.named('fr_conversation_append')[0]!.params).toMatchObject({ p_path: 'help', p_kind: 'help' });
    expect((h.service.named('fr_conversation_append')[0]!.params['p_messages'] as ConversationMessage[])[0]).toMatchObject({ role: 'user', text: 'Get help' });
    // A filing card: the path is set, the kind stays intake (sent explicitly), and the brief for that path is created.
    const problem = harness({ service: { fr_conversation_get: openRow }, turns: [{ text: ['What went wrong?'] }] });
    const pe = parseSse(await (await call(problem.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'Report a problem', intent: 'problem' })).text());
    expect(pe[0]).toMatchObject({ event: 'brief', data: { path: 'problem', brief: { kind: 'problem', steps: [] } } });
    expect((problem.deps.anthropic as ReturnType<typeof fakeAnthropic>).calls[0]!.system).toEqual([expect.objectContaining({ text: expect.stringContaining('problem path') })]);
    expect(problem.service.named('fr_conversation_append')[0]!.params).toMatchObject({ p_path: 'problem', p_kind: 'intake', p_brief: { kind: 'problem' } });
    await status(await call(problem.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'x', intent: 'open' }), 400, 'invalid');
  });
  it('ignores intent once a path is set and sends no kind', async () => {
    const h = harness({ turns: [{ text: ['Noted.'] }] });
    const events = parseSse(await (await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'hi', intent: 'help' })).text());
    expect(events.map(e => e.event)).toEqual(['text', 'brief', 'done']);
    expect(events[1]!.data).toMatchObject({ path: 'feature' });
    const append = h.service.named('fr_conversation_append')[0]!.params;
    expect(append['p_path']).toBe('feature'); expect(append).not.toHaveProperty('p_kind');
    expect((h.deps.anthropic as ReturnType<typeof fakeAnthropic>).calls[0]!.system).toEqual([expect.objectContaining({ text: expect.stringContaining('feature path') })]);
  });
  it('runs the open agent for a typed first message: its switch_path emits the path, and the saved row gets the kind', async () => {
    const h = harness({ service: { fr_conversation_get: openRow }, turns: [
      { toolUses: [{ id: 't1', name: 'switch_path', input: { to: 'problem', reason: 'a crash' } }] },
      { toolUses: [{ id: 't2', name: 'update_brief', input: { section: 'happened', text: 'It crashes on push/pull' } }] },
      { text: ['What did you do, step by step?'] },
    ] });
    const events = parseSse(await (await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'It crashes on push/pull' })).text());
    expect(events.map(e => e.event)).toEqual(['brief', 'brief', 'text', 'brief', 'done']);
    expect(events[0]!.data).toMatchObject({ path: 'problem', brief: { kind: 'problem', happened: null } });
    expect(events[1]!.data).toMatchObject({ path: 'problem', brief: { happened: 'It crashes on push/pull' } });
    const anthropic = h.deps.anthropic as ReturnType<typeof fakeAnthropic>;
    expect(anthropic.calls[0]!.system).toEqual([expect.objectContaining({ text: expect.stringContaining('has not chosen a path yet') })]);
    expect((anthropic.calls[0]!.tools as { name: string }[]).map(t => t.name)).toContain('switch_path');
    expect(anthropic.calls[0]!.messages[0]!.content).toContain('path: open');
    const append = h.service.named('fr_conversation_append')[0]!.params;
    expect(append).toMatchObject({ p_path: 'problem', p_kind: 'intake', p_brief: { kind: 'problem', happened: 'It crashes on push/pull' } });
    expect((append['p_messages'] as ConversationMessage[]).map(m => m.role)).toEqual(['user', 'tool', 'tool', 'assistant']);
    // Settling on help saves kind help so the 30-day retention applies.
    const help = harness({ service: { fr_conversation_get: openRow }, turns: [{ toolUses: [{ id: 't1', name: 'switch_path', input: { to: 'help', reason: 'a question' } }] }, { text: ['Shift locks it.'] }] });
    const he = parseSse(await (await call(help.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'how do I lock inference?' })).text());
    expect(he.map(e => e.event)).toEqual(['brief', 'text', 'done']);
    expect(he[0]!.data).toEqual({ brief: null, title: null, path: 'help', estimatedClass: null });
    expect(help.service.named('fr_conversation_append')[0]!.params).toMatchObject({ p_path: 'help', p_kind: 'help', p_brief: null });
  });
  it('keeps the path open, sends no kind and emits no brief event when the open agent only asks the three-way question', async () => {
    const h = harness({ service: { fr_conversation_get: openRow }, turns: [{ text: ['Do you want help, to report a problem, or to request a feature?'] }] });
    const events = parseSse(await (await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'tables' })).text());
    expect(events.map(e => e.event)).toEqual(['text', 'done']);
    const append = h.service.named('fr_conversation_append')[0]!.params;
    expect(append['p_path']).toBe('open'); expect(append['p_brief']).toBeNull(); expect(append).not.toHaveProperty('p_kind');
  });
});

describe('POST /conversations/:id/file', () => {
  const filed = conversationRow({ brief: BRIEF, title: 'Lock inference with Shift' });
  it('creates the issue with labels, records the request, queues the transcript link, and answers with the issue key', async () => {
    const h = harness({ service: { fr_conversation_get: filed }, user: { fr_my_roles: myRoles({ effective: 'builder', roles: [{ role: 'builder', org_id: null }] }) } });
    const res = await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/file`, {});
    const body = await status(res, 201) as { request: Record<string, unknown> };
    expect(body.request).toMatchObject({ id: REQUEST_ID, issueKey: 'FRQ-101', issueUrl: 'https://linear.app/pushform/issue/FRQ-101', title: 'Lock inference with Shift', requesterState: 'Submitted', eligibility: 'none' });
    expect(h.tracker.created[0]).toMatchObject({ title: 'Lock inference with Shift', kind: 'feature', labels: ['feature', 'area:modeling', 'source:in-app', ] });
    expect(h.tracker.created[0]!.body).toContain('## Problem\n\nI cannot lock the inference direction');
    expect(h.tracker.created[0]!.body).toContain(`- Transcript: https://p.supabase.co/functions/v1/fr-conversation/conversations/${CONVERSATION_ID}`);
    expect(h.tracker.created[0]!.body).toContain('- Client: 0.3.0 (abc123)');
    const file = h.service.named('fr_request_file')[0]!.params;
    expect(file).toMatchObject({ p_conversation: CONVERSATION_ID, p_owner: ALICE.id, p_email: ALICE.email, p_kind: 'feature', p_title: 'Lock inference with Shift', p_brief: BRIEF, p_estimated_class: 'C3', p_eligibility: 'none', p_issue_id: 'iss-1', p_issue_key: 'FRQ-101', p_client: { version: '0.3.0', build: 'abc123', editor: 'model', browser: 'Chrome 141', os: 'macOS 15' } });
    expect(h.service.named('fr_outbox_enqueue')[0]!.params).toMatchObject({ p_kind: 'tracker_comment', p_target: 'iss-1', p_request: REQUEST_ID, p_payload: { body: `Filed as request ${REQUEST_ID}. Transcript: https://p.supabase.co/functions/v1/fr-conversation/requests/${REQUEST_ID}` } });
    expect(h.service.calls.map(c => c.name)).toEqual(['fr_conversation_get', 'fr_request_count_open', 'fr_attachment_list', 'fr_request_file', 'fr_attachment_bind', 'fr_outbox_enqueue']);
  });
  it('is idempotent: a conversation that already filed returns its request without touching the tracker', async () => {
    const h = harness({ service: { fr_conversation_get: conversationRow({ status: 'filed', request_id: REQUEST_ID, closed_at: 't' }) } });
    const body = await status(await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/file`, {}), 200) as { request: Record<string, unknown> };
    expect(body.request).toMatchObject({ id: REQUEST_ID, issueKey: 'FRQ-123' });
    expect(h.tracker.created).toEqual([]); expect(h.user.calls.map(c => c.name)).toEqual(['fr_get_request']); expect(h.service.named('fr_request_file')).toEqual([]);
  });
  it('refuses an empty brief, disabled filing, and the open-request limit before creating anything', async () => {
    const empty = harness({ service: { fr_conversation_get: conversationRow({ brief: { ...BRIEF, problem: null, desired: null } }) } });
    await status(await call(empty.handler, 'POST', `/conversations/${CONVERSATION_ID}/file`, {}), 400, 'invalid');
    const none = harness({ service: { fr_conversation_get: conversationRow() } });
    await status(await call(none.handler, 'POST', `/conversations/${CONVERSATION_ID}/file`, {}), 400, 'invalid');
    const disabled = harness({ service: { fr_conversation_get: filed }, user: { fr_my_roles: myRoles({ filing_disabled: true }) } });
    await status(await call(disabled.handler, 'POST', `/conversations/${CONVERSATION_ID}/file`, {}), 403, 'forbidden');
    const limit = harness({ service: { fr_conversation_get: filed, fr_request_count_open: 5 } });
    await status(await call(limit.handler, 'POST', `/conversations/${CONVERSATION_ID}/file`, {}), 409, 'limit');
    for (const h of [empty, none, disabled, limit]) { expect(h.tracker.created).toEqual([]); expect(h.service.named('fr_request_file')).toEqual([]); }
  });
  it('fails with config_invalid when a configured state name is missing in the team, before creating the issue', async () => {
    const h = harness({ service: { fr_conversation_get: filed } });
    h.tracker.stateNames = h.tracker.stateNames.filter(s => s !== 'Triage');
    const body = await status(await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/file`, {}), 500, 'config_invalid') as { error: { details: string[] } };
    expect(body.error.details[0]).toMatch(/tracker.states.triage: state "Triage" does not exist/);
    expect(h.tracker.created).toEqual([]);
  });
  it('answers tracker_unavailable on Linear failure and keeps the brief; a failed record cancels the issue', async () => {
    const down = harness({ service: { fr_conversation_get: filed } });
    down.tracker.failCreate = new TrackerError('unavailable', 'Could not reach Linear.');
    await status(await call(down.handler, 'POST', `/conversations/${CONVERSATION_ID}/file`, {}), 502, 'tracker_unavailable');
    expect(down.service.named('fr_request_file')).toEqual([]); expect(down.service.named('fr_conversation_close')).toEqual([]);
    const missing = harness({ service: { fr_conversation_get: filed }, deps: { tracker: null } });
    await status(await call(missing.handler, 'POST', `/conversations/${CONVERSATION_ID}/file`, {}), 502, 'tracker_unavailable');
    const raced = harness({ service: { fr_conversation_get: filed, fr_request_file: () => sqlError('fr_limit') } });
    await status(await call(raced.handler, 'POST', `/conversations/${CONVERSATION_ID}/file`, {}), 409, 'limit');
    expect(raced.tracker.states).toEqual([{ issueId: 'iss-1', stateName: 'Canceled' }]); expect(raced.tracker.comments[0]!.body).toMatch(/Canceled by the pipeline/);
  });
  it('cancels its own issue when a concurrent filing of the same conversation was recorded first', async () => {
    const h = harness({ service: { fr_conversation_get: filed, fr_request_file: requestRow({ issue_id: 'iss-earlier', issue_key: 'FRQ-100' }) } });
    const body = await status(await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/file`, {}), 200) as { request: Record<string, unknown> };
    expect(body.request).toMatchObject({ id: REQUEST_ID, issueKey: 'FRQ-100' });
    expect(h.tracker.states).toEqual([{ issueId: 'iss-1', stateName: 'Canceled' }]);
    expect(h.tracker.comments[0]).toMatchObject({ issueId: 'iss-1', body: expect.stringMatching(/duplicate of FRQ-100/) });
    expect(h.service.named('fr_outbox_enqueue')).toEqual([]);
  });
  it('computes eligibility from the effective role, the class and the builds switch', async () => {
    const user = harness({ service: { fr_conversation_get: filed } });
    await call(user.handler, 'POST', `/conversations/${CONVERSATION_ID}/file`, {});
    expect(user.service.named('fr_request_file')[0]!.params['p_eligibility']).toBe('none');
    const gated = harness({ service: { fr_conversation_get: conversationRow({ brief: { ...BRIEF, estimatedClass: 'C5' } }) }, user: { fr_my_roles: myRoles({ effective: 'maintainer' }) } });
    await call(gated.handler, 'POST', `/conversations/${CONVERSATION_ID}/file`, {});
    expect(gated.service.named('fr_request_file')[0]!.params['p_eligibility']).toBe('none');
    const off = harness({ service: { fr_conversation_get: filed }, user: { fr_my_roles: myRoles({ effective: 'admin', builds_disabled: true }) } });
    await call(off.handler, 'POST', `/conversations/${CONVERSATION_ID}/file`, {});
    expect(off.service.named('fr_request_file')[0]!.params['p_eligibility']).toBe('none');
  });
});

describe('problem-report attachments', () => {
  const problem = conversationRow({ path: 'problem', kind: 'problem' });
  const shot = { kind: 'screenshot', name: 'shot.png', mime: 'image/png', size: 2048 };
  const withStorage = (over: Parameters<typeof harness>[0] = {}) => {
    const storage = new FakeStorage();
    return { ...harness({ ...over, service: { fr_conversation_get: problem, fr_attachment_add: (p) => attachmentRow({ storage_path: p['p_path'] as string, uploaded_at: null }), ...over.service }, deps: { storage, ...over.deps } }), storage };
  };
  it('reserves an attachment on an open problem report and answers with an upload URL under the owner and conversation', async () => {
    const h = withStorage();
    const body = await status(await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/attachments`, shot), 200) as { attachment: Record<string, unknown>; uploadUrl: string };
    expect(body.attachment).toEqual({ id: ATTACHMENT_ID, kind: 'screenshot', name: 'shot.png', size: 2048 });
    const add = h.service.named('fr_attachment_add')[0]!.params;
    expect(add).toMatchObject({ p_conversation: CONVERSATION_ID, p_owner: ALICE.id, p_kind: 'screenshot', p_name: 'shot.png', p_mime: 'image/png', p_size: 2048 });
    expect(add['p_path']).toMatch(new RegExp(`^${ALICE.id}/${CONVERSATION_ID}/[0-9a-f-]{36}-shot\\.png$`));
    expect(body.uploadUrl).toBe(`https://storage.test/upload/${add['p_path'] as string}?token=t`);
    expect(h.service.named('fr_rate_check')).toHaveLength(1);
    await status(await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/attachments`, { kind: 'document', name: 'plan.pfm', mime: 'application/octet-stream', size: 9000 }), 400, 'invalid');
  });
  it('refuses other paths, closed conversations, wrong types and sizes, the per-report limit, and a missing bucket', async () => {
    const feature = withStorage({ service: { fr_conversation_get: conversationRow() } });
    await status(await call(feature.handler, 'POST', `/conversations/${CONVERSATION_ID}/attachments`, shot), 200);
    const closed = withStorage({ service: { fr_conversation_get: conversationRow({ path: 'problem', status: 'filed', closed_at: 't' }) } });
    await status(await call(closed.handler, 'POST', `/conversations/${CONVERSATION_ID}/attachments`, shot), 400, 'invalid');
    const h = withStorage();
    await status(await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/attachments`, { ...shot, mime: 'image/svg+xml' }), 400, 'invalid');
    await status(await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/attachments`, { ...shot, kind: 'document' }), 400, 'invalid');
    await status(await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/attachments`, { ...shot, size: 26_214_401 }), 400, 'invalid');
    await status(await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/attachments`, { ...shot, name: 'a\u0007b.png' }), 400, 'invalid');
    expect(h.service.named('fr_attachment_add')).toEqual([]);
    const full = withStorage({ service: { fr_attachment_add: () => sqlError('fr_limit') } });
    await status(await call(full.handler, 'POST', `/conversations/${CONVERSATION_ID}/attachments`, shot), 409, 'limit');
    const none = harness({ service: { fr_conversation_get: problem } });
    await status(await call(none.handler, 'POST', `/conversations/${CONVERSATION_ID}/attachments`, shot), 503, 'unavailable');
  });
  it('completes an upload only when the stored object has the confirmed size, and only for its uploader', async () => {
    const h = withStorage({ service: { fr_attachment_complete: attachmentRow() } });
    const pending = attachmentRow({ uploaded_at: null });
    h.service.tables['fr_attachments'] = [{ ...pending }];
    const complete = () => call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/attachments/${ATTACHMENT_ID}/complete`, {});
    await status(await complete(), 400, 'invalid');
    h.storage.objects.set(pending.storage_path, 1000);
    await status(await complete(), 400, 'invalid');
    h.storage.objects.set(pending.storage_path, 2048);
    expect((await status(await complete(), 200))['attachment']).toEqual({ id: ATTACHMENT_ID, kind: 'screenshot', name: 'shot.png', size: 2048 });
    expect(h.service.named('fr_attachment_complete')[0]!.params).toEqual({ p_id: ATTACHMENT_ID, p_owner: ALICE.id });
    h.service.tables['fr_attachments'] = [{ ...attachmentRow({ uploaded_by: '99999999-9999-4999-8999-999999999999' }) }];
    await status(await complete(), 404, 'not_found');
    await status(await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/attachments/nope/complete`, {}), 404, 'not_found');
  });
  it('lists the uploaded attachments without their storage paths', async () => {
    const h = withStorage({ service: { fr_attachment_list: [attachmentRow(), attachmentRow({ id: 'b', kind: 'document', name: 'plan.pfm', size: 3_500_000 })] } });
    const body = await status(await call(h.handler, 'GET', `/conversations/${CONVERSATION_ID}/attachments`), 200);
    expect(body['attachments']).toEqual([{ id: ATTACHMENT_ID, kind: 'screenshot', name: 'shot.png', size: 2048 }, { id: 'b', kind: 'document', name: 'plan.pfm', size: 3_500_000 }]);
  });
  it('GET /attachments/:id hands the requester or a maintainer a short-lived link through the user-scoped RPC, and anyone else not found', async () => {
    const view = { id: ATTACHMENT_ID, kind: 'screenshot', name: 'shot.png', mime: 'image/png', size: 2048, storage_path: 'p/q/r.png' };
    const h = withStorage({ user: { fr_attachment_get: view } });
    expect(await status(await call(h.handler, 'GET', `/attachments/${ATTACHMENT_ID}`), 200)).toEqual({ attachment: { id: ATTACHMENT_ID, kind: 'screenshot', name: 'shot.png', size: 2048 }, url: 'https://storage.test/sign/p/q/r.png?expires=300' });
    expect(h.user.named('fr_attachment_get')[0]!.params).toEqual({ p_id: ATTACHMENT_ID });
    expect(h.service.named('fr_attachment_get')).toEqual([]);
    const other = withStorage({ user: { fr_attachment_get: () => sqlError('fr_forbidden') } });
    await status(await call(other.handler, 'GET', `/attachments/${ATTACHMENT_ID}`), 404, 'not_found');
    await status(await call(h.handler, 'GET', `/attachments/${ATTACHMENT_ID}`, undefined, null), 401, 'unauthorized');
  });
  it('filing a problem report links its attachments in the issue, binds them to the request and removes uploads never finished', async () => {
    const h = withStorage({ service: {
      fr_conversation_get: conversationRow({ path: 'problem', kind: 'problem', brief: BRIEF, title: 'Push/Pull leaves a hole' }),
      fr_attachment_list: [attachmentRow(), attachmentRow({ id: 'b', kind: 'document', name: 'plan.pfm', size: 3_500_000 })],
      fr_attachment_bind: { request_id: REQUEST_ID, removed: ['x/y/z.png'] },
    } });
    h.storage.objects.set(attachmentRow().storage_path, 2048);
    await status(await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/file`, {}), 201);
    expect(h.tracker.created[0]!.body).toContain('![shot.png](https://uploads.linear.app/image-1)');
    expect(h.tracker.uploadedImages).toEqual([{ name: 'shot.png', mime: 'image/png', size: 2048 }]);
    expect(h.tracker.created[0]!.body).toContain('Document copy: plan.pfm');
    expect(h.service.calls.map(c => c.name)).toEqual(['fr_conversation_get', 'fr_request_count_open', 'fr_attachment_list', 'fr_request_file', 'fr_attachment_bind', 'fr_outbox_enqueue']);
    expect(h.storage.removed).toEqual(['x/y/z.png']);
  });
  it('keeps a ticket unfiled when an image is missing or cannot reach Linear', async () => {
    const h = withStorage({ service: {
      fr_conversation_get: conversationRow({ path: 'feature', brief: BRIEF, title: 'Mirror' }),
      fr_attachment_list: [attachmentRow()],
    } });
    let response = await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/file`, {});
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(h.tracker.created).toHaveLength(0); expect(h.service.named('fr_request_file')).toHaveLength(0);
    h.storage.objects.set(attachmentRow().storage_path, 2048);
    h.tracker.uploadImage = async () => { throw new Error('Linear unavailable'); };
    response = await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/file`, {});
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(h.tracker.created).toHaveLength(0); expect(h.service.named('fr_request_file')).toHaveLength(0);
  });
  it('formats sizes and leaves the section out when nothing is attached', () => {
    expect([512, 2048, 20_000, 3_500_000].map(formatBytes)).toEqual(['512 B', '2.0 KB', '20 KB', '3.3 MB']);
    expect(attachmentSection([], 'https://b')).toBe('');
  });
});

describe('add-me and requests', () => {
  it('POST /add-me records interest through fr_request_add_me and closes the conversation', async () => {
    const h = harness();
    const body = await status(await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/add-me`, { requestId: REQUEST_ID, notes: 'Me too, on Layout' }), 200) as { request: Record<string, unknown> };
    expect(body.request['issueKey']).toBe('FRQ-123');
    expect(h.service.named('fr_request_add_me')[0]!.params).toEqual({ p_host: 'pushform', p_request: REQUEST_ID, p_owner: ALICE.id, p_email: ALICE.email, p_notes: 'Me too, on Layout' });
    expect(h.service.named('fr_conversation_close')[0]!.params['p_status']).toBe('closed');
    await status(await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/add-me`, { requestId: 'nope' }), 400, 'invalid');
    const gone = harness({ service: { fr_request_add_me: () => sqlError('fr_invalid') } });
    await status(await call(gone.handler, 'POST', `/conversations/${CONVERSATION_ID}/add-me`, { requestId: REQUEST_ID, notes: '' }), 400, 'invalid');
  });
  it('/requests routes run through the user-scoped RPC so RLS applies', async () => {
    const h = harness();
    const list = await status(await call(h.handler, 'GET', '/requests'), 200) as { requests: Record<string, unknown>[] };
    expect(list.requests[0]).toMatchObject({ id: REQUEST_ID, issueKey: 'FRQ-123', requesterState: 'Submitted' });
    const one = await status(await call(h.handler, 'GET', `/requests/${REQUEST_ID}`), 200) as { request: Record<string, unknown> };
    expect(one.request).toMatchObject({ id: REQUEST_ID, transcriptAvailable: true, brief: BRIEF });
    const withdrawn = await status(await call(h.handler, 'POST', `/requests/${REQUEST_ID}/withdraw`), 200) as { request: Record<string, unknown> };
    expect(withdrawn.request['requesterState']).toBe('Withdrawn');
    const replied = await status(await call(h.handler, 'POST', `/requests/${REQUEST_ID}/reply`, { text: 'Chrome 141 on macOS' }), 200);
    expect(replied).toMatchObject({ ok: true, request: { id: REQUEST_ID } });
    expect(h.user.calls.map(c => c.name)).toEqual(['fr_list_my_requests', 'fr_get_request', 'fr_withdraw', 'fr_reply']);
    expect(h.user.named('fr_reply')[0]!.params).toEqual({ p_id: REQUEST_ID, p_text: 'Chrome 141 on macOS' });
    expect(h.authHeaders.every(a => a === `Bearer ${TOKEN}`)).toBe(true);
    await status(await call(h.handler, 'POST', `/requests/${REQUEST_ID}/reply`, { text: '' }), 400, 'invalid');
    expect(h.service.calls.filter(c => c.name !== 'fr_rate_check')).toEqual([]);
    await status(await call(h.handler, 'GET', '/requests/not-a-uuid'), 404, 'not_found');
  });
  it('maps withdraw and lookup failures to readable errors', async () => {
    const h = harness({ user: { fr_withdraw: () => sqlError('fr_invalid'), fr_get_request: () => sqlError('fr_forbidden') } });
    const res = await call(h.handler, 'POST', `/requests/${REQUEST_ID}/withdraw`);
    const body = await status(res, 400, 'invalid') as { error: { message: string } };
    expect(body.error.message).toMatch(/Submitted and no build has started/);
    await status(await call(h.handler, 'GET', `/requests/${REQUEST_ID}`), 404, 'not_found');
  });
});

describe('issue summaries', () => {
  it('derives kind from labels, strips the request details, and finds the request id in the transcript link', () => {
    const body = `## Problem\n\nI cannot lock it\n\n## Request details\n\n- Transcript: https://x/fr-conversation/requests/${REQUEST_ID}\n`;
    const s = issueSummaryOf({ id: 'i', key: 'FRQ-1', url: 'u', title: 'T', state: 'Triage', labels: ['defect', 'area:layout'], body }, config);
    expect(s).toEqual({ id: 'i', key: 'FRQ-1', title: 'T', url: 'u', kind: 'problem', state: 'Triage', requestId: REQUEST_ID, summary: 'Problem I cannot lock it' });
    expect(issueSummaryOf({ id: 'i', key: 'k', url: 'u', title: 't', state: 's', labels: ['ux-change'], body: null }, config).kind).toBe('ux-change');
    expect(requestIdOfIssue('nothing here')).toBeNull();
  });
});

describe('document tools', () => {
  const LAYOUT = { type: 'layout', apiVersion: 1 };
  const getDocument = { id: 'c1', name: 'layout_get_document', input: {} };
  const anthropicOf = (h: Harness) => h.deps.anthropic as ReturnType<typeof fakeAnthropic>;
  const toolNames = (h: Harness, index = 0) => (anthropicOf(h).calls[index]!.tools ?? []).map(t => (t as { name: string }).name);
  /** Run the first request of a document turn and return the stored messages the suspension appended. */
  async function suspended(): Promise<{ h: Harness; stored: ConversationMessage[]; events: ReturnType<typeof parseSse> }> {
    const h = harness({ service: { fr_conversation_get: conversationRow({ kind: 'help', path: 'help' }) }, turns: [{ text: ['Let me look.'], toolUses: [getDocument] }] });
    const events = parseSse(await (await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'Add a title block', document: LAYOUT })).text());
    return { h, stored: h.service.named('fr_conversation_append')[0]!.params['p_messages'] as ConversationMessage[], events };
  }

  it('offers the Layout tools only when the sending tab has a Layout document, on the document model with the document rules', async () => {
    const plain = harness({ service: { fr_conversation_get: conversationRow({ kind: 'help', path: 'help' }) }, turns: [{ text: ['Hi'] }] });
    await (await call(plain.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'hi' })).text();
    expect(toolNames(plain).some(n => n.startsWith('layout_'))).toBe(false);
    expect(anthropicOf(plain).calls[0]!.model).toBe('claude-haiku-5-5');
    const unknown = harness({ turns: [{ text: ['Hi'] }] });
    await (await call(unknown.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'hi', document: { type: 'layout', apiVersion: 99 } })).text();
    expect(toolNames(unknown).some(n => n.startsWith('layout_'))).toBe(false);
    const { h } = await suspended();
    const first = anthropicOf(h).calls[0]!;
    expect(first.model).toBe('claude-sonnet-5-5');
    expect(first.output_config).toEqual({ effort: 'medium' });
    expect(toolNames(h)).toEqual(expect.arrayContaining(['search_docs', 'layout_get_document', 'layout_list_objects', 'layout_apply_operations']));
    expect((first.system as { text: string }[])[0]!.text).toContain('Editing the open document');
    expect((first.system as { text: string }[])[0]!.text).toContain('you change nothing except the open document');
    expect(first.messages[0]!.content).toContain('open_document: layout');
  });

  it('offers the model tools and rules only to a model tab that can edit, and never the Layout tools there', async () => {
    const editable = harness({ service: { fr_conversation_get: conversationRow({ kind: 'help', path: 'help' }) }, turns: [{ text: ['Done.'] }] });
    await (await call(editable.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'Group the shelves', document: { type: 'model', apiVersion: 1, edit: 1 } })).text();
    const first = anthropicOf(editable).calls[0]!;
    expect(first.model).toBe('claude-sonnet-5-5');
    expect(toolNames(editable)).toEqual(expect.arrayContaining(['model_get_document', 'model_query', 'model_apply_operations']));
    expect(toolNames(editable).some(name => name.startsWith('layout_'))).toBe(false);
    const system = (first.system as { text: string }[])[0]!.text;
    expect(system).toContain('Editing the open 3D model');
    expect(system).not.toContain('layout_get_document');
    expect(first.messages[0]!.content).toContain('open_document: model (the model_* tools read and edit it)');
    const operations = (first.tools!.find(tool => 'name' in tool && tool.name === 'model_apply_operations') as { input_schema: { properties: { operations: { items: { oneOf?: unknown[]; anyOf?: unknown[] } } } } }).input_schema.properties.operations.items;
    expect((operations.oneOf ?? operations.anyOf)?.length).toBeGreaterThan(10);
    // Model tabs sent apiVersion 1 for guidance alone before models could be edited.
    const guidanceOnly = harness({ turns: [{ text: ['Hi'] }] });
    await (await call(guidanceOnly.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'hi', document: { type: 'model', apiVersion: 1, guidance: 1 } })).text();
    expect(toolNames(guidanceOnly).some(name => name.startsWith('model_'))).toBe(false);
    expect((anthropicOf(guidanceOnly).calls[0]!.system as { text: string }[])[0]!.text).not.toContain('Editing the open 3D model');
  });

  it('offers private guidance on model tabs and resumes user interaction without a new requester message', async () => {
    const guide = { id: 'g1', name: 'ui_highlight', input: { targets: ['toolbar:line'] } };
    const descriptor = { type: 'model', apiVersion: 1, guidance: 1 };
    const first = harness({ service: { fr_conversation_get: conversationRow({ kind: 'help', path: 'help' }) }, turns: [{ text: ['Click Line.'], toolUses: [guide] }] });
    const events = parseSse(await (await call(first.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'Teach me to draw', document: descriptor })).text());
    expect(toolNames(first)).toEqual(expect.arrayContaining(['ui_list_targets', 'ui_open_sidebar', 'ui_highlight']));
    const definition = anthropicOf(first).calls[0]!.tools!.find(tool => 'name' in tool && tool.name === 'ui_highlight') as { input_schema: { required?: string[] } };
    expect(definition.input_schema.required).toContain('instruction');
    expect(toolNames(first).some(name => name.startsWith('layout_'))).toBe(false);
    expect(events.at(-1)!.data).toMatchObject({ awaitingTools: true });
    const stored = first.service.named('fr_conversation_append')[0]!.params['p_messages'] as ConversationMessage[];
    const resumed = harness({ service: { fr_conversation_get: conversationRow({ kind: 'help', path: 'help', messages: stored, message_count: 1 }) }, turns: [{ text: ['Now click a starting point.'] }] });
    const response = await call(resumed.handler, 'POST', `/conversations/${CONVERSATION_ID}/tool-results`, { results: [{ toolUseId: 'g1', content: '{"status":"interacted","target":"toolbar:line"}', isError: false }] });
    expect(parseSse(await response.text()).map(event => event.event)).toEqual(['text', 'done']);
    const saved = resumed.service.named('fr_conversation_append')[0]!.params['p_messages'] as ConversationMessage[];
    expect(saved.map(message => message.role)).toEqual(['tool', 'assistant']);
    const prompt = (anthropicOf(first).calls[0]!.system as { text: string }[])[0]!.text;
    expect(prompt).toContain('UI guidance:');
    expect(prompt).not.toContain('Editing the open document');
  });

  it('streams and persists a cue instruction in chat even when the model emits only the tool call', async () => {
    const instruction = 'Click Import and choose a PNG or JPEG image for this page.';
    const guide = { id: 'g1', name: 'ui_highlight', input: { targets: ['toolbar:import'], instruction } };
    const h = harness({ service: { fr_conversation_get: conversationRow({ kind: 'help', path: 'help' }) }, turns: [{ toolUses: [guide] }] });
    const response = await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'Show me how to import an image', document: { type: 'layout', apiVersion: 1, guidance: 1 } });
    const events = parseSse(await response.text());
    expect(events.find(event => event.event === 'text')!.data).toEqual({ delta: instruction });
    const stored = h.service.named('fr_conversation_append')[0]!.params['p_messages'] as ConversationMessage[];
    expect(stored.at(-1)).toMatchObject({ role: 'assistant', text: instruction });
  });

  it.each(['expired', 'cancelled'])('records %s guidance quietly without another model call or a follow-up message', async outcome => {
    const guide = { id: 'g1', name: 'ui_highlight', input: { targets: ['toolbar:import'], instruction: 'Click Import and choose a PNG image.' } };
    const first = harness({ service: { fr_conversation_get: conversationRow({ kind: 'help', path: 'help' }) }, turns: [{ text: ['Click Import and choose a PNG image.'], toolUses: [guide] }] });
    await (await call(first.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'Show me how to import an image', document: { type: 'layout', apiVersion: 1, guidance: 1 } })).text();
    const stored = first.service.named('fr_conversation_append')[0]!.params['p_messages'] as ConversationMessage[];
    const next = harness({ service: { fr_conversation_get: conversationRow({ kind: 'help', path: 'help', messages: stored, message_count: 1 }) } });
    const response = await call(next.handler, 'POST', `/conversations/${CONVERSATION_ID}/tool-results`, { results: [{ toolUseId: 'g1', content: JSON.stringify({ status: outcome }), isError: false }] });
    expect(parseSse(await response.text()).map(event => event.event)).toEqual(['done']);
    expect(anthropicOf(next).calls).toHaveLength(0);
    const saved = next.service.named('fr_conversation_append')[0]!.params['p_messages'] as ConversationMessage[];
    expect(saved.map(message => message.role)).toEqual(['tool']);
    expect(closeSuspended([...stored, ...saved], 'later')).toEqual([]);
    expect(saved.at(-1)).not.toHaveProperty('turn');
  });

  it('suspends on a document tool call: saves the round, sends tool_request and done with awaitingTools, and keeps the raw state server-side', async () => {
    const { h, stored, events } = await suspended();
    expect(events.map(e => e.event)).toEqual(['text', 'tool_request', 'done']);
    expect(events[1]!.data).toEqual({ calls: [getDocument] });
    expect(events[2]!.data).toEqual({ messageCount: 1, limitReached: false, ended: false, awaitingTools: true });
    expect(stored.map(m => m.role)).toEqual(['user', 'assistant']);
    const last = stored[1] as Extract<ConversationMessage, { role: 'assistant' }>;
    expect(last.text).toBe('Let me look.');
    expect(last.turn).toMatchObject({ model: 'claude-sonnet-5-5', historyLength: 0, rounds: 1, document: LAYOUT, pending: { calls: [getDocument], results: [], order: ['c1'] } });
    expect(last.turn!.appended).toHaveLength(1);
    const view = harness({ service: { fr_conversation_get: conversationRow({ messages: stored, message_count: 1 }) } });
    const got = await status(await call(view.handler, 'GET', `/conversations/${CONVERSATION_ID}`), 200) as { conversation: { messages: Record<string, unknown>[] } };
    expect(got.conversation.messages[1]).toEqual({ role: 'assistant', text: 'Let me look.', at: '2026-10-23T10:30:00.000Z' });
    expect(h.service.named('fr_conversation_append')).toHaveLength(1);
  });

  it('resumes from the editor answers with the same system prompt, tools and history, then saves the results and the closing text', async () => {
    const { h: first, stored } = await suspended();
    const firstCall = anthropicOf(first).calls[0]!;
    const h = harness({ service: { fr_conversation_get: conversationRow({ kind: 'help', path: 'help', messages: stored, message_count: 1 }) }, turns: [{ text: ['Added a title block.'] }] });
    const res = await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/tool-results`, { results: [{ toolUseId: 'c1', content: '{"revision":3}', isError: false }] });
    const events = parseSse(await res.text());
    expect(events.map(e => e.event)).toEqual(['text', 'done']);
    expect(events[1]!.data).toMatchObject({ limitReached: false, ended: false });
    expect(events[1]!.data).not.toHaveProperty('awaitingTools');
    const resumed = anthropicOf(h).calls[0]!;
    expect(resumed.model).toBe(firstCall.model);
    expect(resumed.system).toEqual(firstCall.system);
    expect(resumed.tools).toEqual(firstCall.tools);
    // The history up to the suspended round is byte-identical, followed by the answer.
    expect(resumed.messages.slice(0, firstCall.messages.length + 1)).toEqual([...firstCall.messages, (stored[1] as { turn: { appended: unknown[] } }).turn.appended[0]]);
    expect(resumed.messages.at(-1)).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '{"revision":3}' }] });
    expect(h.service.calls.map(c => c.name)).not.toContain('fr_rate_check');
    const appended = h.service.named('fr_conversation_append')[0]!.params['p_messages'] as ConversationMessage[];
    expect(appended).toEqual([
      { role: 'tool', name: 'layout_get_document', toolUseId: 'c1', input: {}, output: '{"revision":3}', at: '2026-10-23T10:30:00.000Z' },
      { role: 'assistant', text: 'Added a title block.', at: '2026-10-23T10:30:00.000Z' },
    ]);
  });

  it('rejects results when nothing is waiting or for calls that were not made', async () => {
    const idle = harness();
    await status(await call(idle.handler, 'POST', `/conversations/${CONVERSATION_ID}/tool-results`, { results: [] }), 400, 'invalid');
    const { stored } = await suspended();
    const h = harness({ service: { fr_conversation_get: conversationRow({ messages: stored, message_count: 1 }) } });
    await status(await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/tool-results`, { results: [{ toolUseId: 'other', content: 'x' }] }), 400, 'invalid');
    await status(await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/tool-results`, { results: [{ toolUseId: 'c1', content: 'x' }, { toolUseId: 'c1', content: 'y' }] }), 400, 'invalid');
  });

  it('closes a turn still waiting for the editor when a new message arrives, so the abandoned calls never run', async () => {
    const { stored } = await suspended();
    expect(closeSuspended(stored.slice(0, 1), 't')).toEqual([]);
    const h = harness({ service: { fr_conversation_get: conversationRow({ kind: 'help', path: 'help', messages: stored, message_count: 1 }) }, turns: [{ text: ['Sure.'] }] });
    await (await call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'Never mind', document: LAYOUT })).text();
    const appended = h.service.named('fr_conversation_append')[0]!.params['p_messages'] as ConversationMessage[];
    expect(appended.map(m => m.role)).toEqual(['tool', 'user', 'assistant']);
    expect(appended[0]).toMatchObject({ toolUseId: 'c1', output: 'Not run: the requester sent a new message before the editor answered.' });
    const history = anthropicOf(h).calls[0]!.messages;
    expect(history.some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result' && b.tool_use_id === 'c1'))).toBe(true);
  });
});

describe('turn setup runs in parallel', () => {
  it('starts every lookup before the slowest one answers, and still streams the reply', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const h = harness({ service: { fr_conversation_get: () => held.then(() => conversationRow()) } });
    const pending = call(h.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'Hi' });
    // Let the other lookups start while the conversation load is still waiting.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.service.calls.map(c => c.name)).toEqual(expect.arrayContaining(['fr_conversation_get', 'fr_rate_check', 'fr_request_count_open']));
    expect(h.user.calls.map(c => c.name)).toEqual(expect.arrayContaining(['fr_my_roles', 'fr_list_my_requests']));
    expect(h.service.named('fr_conversation_append')).toEqual([]);
    release();
    const res = await pending;
    const events = parseSse(await res.text()).map(e => e.event);
    expect(events[0]).toBe('text'); expect(events.at(-1)).toBe('done');
  });

  it('reports failures in the order the checks used to run, whatever finishes first', async () => {
    const closed = harness({ service: { fr_conversation_get: conversationRow({ status: 'closed' }), fr_rate_check: false } });
    await status(await call(closed.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'Hi' }), 400, 'invalid');
    const missing = harness({ service: { fr_conversation_get: () => sqlError('fr_forbidden'), fr_rate_check: false } });
    expect((await call(missing.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'Hi' })).status).not.toBe(429);
    const limited = harness({ service: { fr_rate_check: false }, user: { fr_my_roles: () => sqlError('fr_auth') } });
    await status(await call(limited.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, { text: 'Hi' }), 429, 'rate_limited');
    const unauthorized = await call(limited.handler, 'POST', `/conversations/${CONVERSATION_ID}/messages`, 'not json', null);
    await status(unauthorized, 401, 'unauthorized');
  });

  it('runs the host setup alongside the session check and answers 503 when it fails', async () => {
    let calls = 0;
    const ok = harness({ deps: { ready: async () => { calls += 1; } } });
    await status(await call(ok.handler, 'GET', '/me'), 200);
    expect(calls).toBe(1);
    const failing = harness({ deps: { ready: async () => { throw new Error('database down'); } } });
    await status(await call(failing.handler, 'GET', '/me'), 503, 'unavailable');
    expect(failing.user.calls).toEqual([]);
    // Preflight and health never wait for it.
    expect((await failing.handler(new Request('http://x/me', { method: 'OPTIONS' }))).status).toBe(204);
    expect((await call(failing.handler, 'GET', '/health', undefined, null)).status).toBe(200);
  });
});
