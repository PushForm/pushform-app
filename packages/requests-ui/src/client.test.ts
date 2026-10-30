// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it, vi } from 'vitest';
import { RequestsClient, RequestsError, parseEventStream, type StreamEvent } from './client';
import { BASE, fakeBackend, filedTurn, makeFiledRequest, sseResponse } from './fakeBackend';

const client = (backend = fakeBackend(), token: string | null = 'jwt-token'): RequestsClient =>
  new RequestsClient({ baseUrl: `${BASE}/`, apikey: 'sb_publishable_test', getToken: async () => token, fetch: backend.fetch });
const collect = async (events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => { const out: StreamEvent[] = []; for await (const event of events) out.push(event); return out; };
const screen = { editor: 'home', build: { version: '1', commit: 'abc' }, browser: 'b', os: 'o' } as const;

describe('RequestsClient', () => {
  it('sends the bearer token and apikey on every call and strips the trailing slash of the base URL', async () => {
    const backend = fakeBackend();
    const me = await client(backend).me();
    expect(me.email).toBe('artist@example.com');
    expect(me.limits).toEqual({ openRequestsPerAccount: 5, messagesPerConversation: 30 });
    expect(backend.calls[0]).toMatchObject({ method: 'GET', path: '/me', headers: { authorization: 'Bearer jwt-token', apikey: 'sb_publishable_test' } });
  });
  it('fails with unauthorized before any network call when there is no session token', async () => {
    const backend = fakeBackend();
    await expect(client(backend, null).me()).rejects.toMatchObject({ code: 'unauthorized' });
    expect(backend.calls).toHaveLength(0);
  });
  it('maps JSON error envelopes, HTTP statuses and network failures to RequestsError codes', async () => {
    const backend = fakeBackend();
    const api = client(backend);
    await expect(api.getConversation('missing')).rejects.toMatchObject({ code: 'not_found', status: 404, message: 'No such conversation.' });
    const error = await api.startConversation({ kind: 'intake', path: 'nope' as never, screen }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(RequestsError);
    expect(error).toMatchObject({ code: 'invalid', status: 400 });
    const statusOnly = new RequestsClient({ baseUrl: BASE, apikey: 'k', getToken: async () => 'jwt-token', fetch: async () => new Response('gateway', { status: 502 }) });
    await expect(statusOnly.me()).rejects.toMatchObject({ code: 'tracker_unavailable', status: 502 });
    const offline = new RequestsClient({ baseUrl: BASE, apikey: 'k', getToken: async () => 'jwt-token', fetch: async () => { throw new TypeError('Failed to fetch'); } });
    await expect(offline.me()).rejects.toMatchObject({ code: 'network' });
  });
  it('streams typed events from the message endpoint, including filed and added, and skips offer and duplicate', async () => {
    const backend = fakeBackend({ turns: [[
      { event: 'text', data: { delta: 'Hello ' } }, { event: 'text', data: { delta: 'there' } },
      { event: 'brief', data: { brief: { kind: 'feature', problem: 'p', workaround: null, desired: null, acceptance: [], mustNotChange: null, area: null, importance: null, estimatedClass: null }, title: 'T', path: 'feature', estimatedClass: null } },
      { event: 'duplicate', data: { issueKey: 'CUS-7', title: 'Existing', requestId: 'req-7', notes: 'me too' } },
      { event: 'offer', data: { kind: 'switch_path', data: { to: 'problem' } } },
      { event: 'added', data: { request: { id: 'req-7', issue_key: 'CUS-7', issue_url: null, title: 'Existing', requester_state: 'Under review' } } },
      ...filedTurn(makeFiledRequest({ issueKey: 'CUS-12' }), 2),
    ]] });
    const api = client(backend);
    const conversation = await api.startConversation({ kind: 'intake', path: 'feature', screen });
    const events = await collect(api.sendMessage(conversation.id, 'hi'));
    expect(events.map(event => event.type)).toEqual(['text', 'text', 'brief', 'added', 'filed', 'text', 'done']);
    expect(events[2]).toMatchObject({ type: 'brief', title: 'T', path: 'feature' });
    expect(events[3]).toEqual({ type: 'added', request: { id: 'req-7', issueKey: 'CUS-7', issueUrl: null, title: 'Existing', requesterState: 'Under review', eligibility: null } });
    expect(events[4]).toEqual({ type: 'filed', request: { id: 'req-1', issueKey: 'CUS-12', issueUrl: 'https://linear.app/pushform/issue/CUS-12', title: 'Mirror tool', requesterState: 'Submitted', eligibility: 'gated' } });
    expect(events[6]).toEqual({ type: 'done', messageCount: 2, limitReached: false, ended: true, reason: null, awaitingTools: false });
    expect(backend.calls.at(-1)).toMatchObject({ method: 'POST', path: `/conversations/${conversation.id}/messages`, body: { text: 'hi' } });
    expect(backend.conversations.get(conversation.id)).toMatchObject({ status: 'filed', requestId: 'req-1' });
  });
  it('reads the start_over reason of a done event', async () => {
    const events = await collect(parseEventStream(sseResponse([{ event: 'done', data: { messageCount: 4, limitReached: false, ended: true, reason: 'start_over' } }]).body!));
    expect(events).toEqual([{ type: 'done', messageCount: 4, limitReached: false, ended: true, reason: 'start_over', awaitingTools: false }]);
  });
  it('passes an abort signal to the stream request so a closed panel can cancel the turn', async () => {
    let seen: AbortSignal | null | undefined;
    const backend = fakeBackend();
    const api = new RequestsClient({ baseUrl: BASE, apikey: 'k', getToken: async () => 'jwt-token', fetch: (input, init) => { seen = init?.signal; return backend.fetch(input, init); } });
    const conversation = await api.startConversation({ kind: 'intake', path: 'feature', screen });
    expect(seen).toBeFalsy();
    const controller = new AbortController();
    await collect(api.sendMessage(conversation.id, 'hi', { signal: controller.signal }));
    expect(seen).toBe(controller.signal);
  });
  it('starts an open conversation and sends the intent of a clicked card in the message body', async () => {
    const backend = fakeBackend();
    const api = client(backend);
    const conversation = await api.startConversation({ kind: 'intake', path: 'open', screen });
    expect(conversation.path).toBe('open');
    expect(backend.calls.at(-1)).toMatchObject({ method: 'POST', path: '/conversations', body: { kind: 'intake', path: 'open' } });
    const events = await collect(api.sendMessage(conversation.id, 'Report a problem', { intent: 'problem' }));
    expect(backend.calls.at(-1)).toMatchObject({ method: 'POST', path: `/conversations/${conversation.id}/messages`, body: { text: 'Report a problem', intent: 'problem' } });
    expect(events.find(event => event.type === 'brief')).toMatchObject({ type: 'brief', path: 'problem' });
    expect(backend.conversations.get(conversation.id)?.path).toBe('problem');
    await collect(api.sendMessage(conversation.id, 'plain'));
    expect(backend.calls.at(-1)?.body).toEqual({ text: 'plain' });
  });
  it('lists open conversations and reads one back with its messages', async () => {
    const backend = fakeBackend();
    const api = client(backend);
    const conversation = await api.startConversation({ kind: 'intake', path: 'open', screen });
    await collect(api.sendMessage(conversation.id, 'hello'));
    expect((await api.listOpenConversations()).map(item => item.id)).toEqual([conversation.id]);
    const read = await api.getConversation(conversation.id);
    expect(read.messages.map(message => message.role)).toEqual(['user', 'assistant']);
    expect(read.messageCount).toBe(1);
    expect(backend.calls.slice(-2).map(call => `${call.method} ${call.path}`)).toEqual(['GET /conversations/open', `GET /conversations/${conversation.id}`]);
  });
});

describe('parseEventStream', () => {
  it('handles events split across chunks, CRLF line ends, multi-line data and a missing final blank line', async () => {
    const encoder = new TextEncoder();
    const chunks = ['event: te', 'xt\r\ndata: {"del', 'ta":"a"}\r\n\r\nevent: done\ndata: {"messageCount":\ndata: 3,"limitReached":true}'];
    const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); } });
    const events = await collect(parseEventStream(stream));
    expect(events).toEqual([{ type: 'text', delta: 'a' }, { type: 'done', messageCount: 3, limitReached: true, ended: false, reason: null, awaitingTools: false }]);
  });
  it('parses a document tool request and a done that waits for the editor', async () => {
    const turn = sseResponse([{ event: 'tool_request', data: { calls: [{ id: 'c1', name: 'layout_get_document', input: {} }] } },
      { event: 'done', data: { messageCount: 1, limitReached: false, ended: false, awaitingTools: true } }], 'whole');
    expect(await collect(parseEventStream(turn.body!))).toEqual([
      { type: 'tool_request', calls: [{ id: 'c1', name: 'layout_get_document', input: {} }] },
      { type: 'done', messageCount: 1, limitReached: false, ended: false, reason: null, awaitingTools: true },
    ]);
  });
  it('reads the type from the data payload when the event line is absent and skips unknown events', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(encoder.encode('data: {"type":"text","delta":"x"}\n\nevent: ping\ndata: {}\n\ndata: not json\n\n')); controller.close();
    } });
    const events = await collect(parseEventStream(stream));
    expect(events).toEqual([{ type: 'text', delta: 'x' }, { type: 'error', code: 'unknown', message: 'The server sent an unreadable event.' }]);
    expect((await collect(parseEventStream(sseResponse([{ event: 'done', data: { messageCount: 1, limitReached: false } }], 'whole').body!)))).toHaveLength(1);
  });
});

describe('regional invocation', () => {
  it('pins every call to the configured region with forceFunctionRegion, and adds nothing without one', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => { urls.push(String(input)); return new Response(JSON.stringify({ conversations: [] }), { status: 200 }); }) as typeof fetch;
    const pinned = new RequestsClient({ baseUrl: 'https://x.test/functions/v1/fr-conversation/', apikey: 'k', getToken: async () => 't', region: 'us-east-1', fetch: fetchImpl });
    await pinned.listOpenConversations();
    const plain = new RequestsClient({ baseUrl: 'https://x.test/functions/v1/fr-conversation', apikey: 'k', getToken: async () => 't', fetch: fetchImpl });
    await plain.listOpenConversations();
    expect(urls[0]).toBe('https://x.test/functions/v1/fr-conversation/conversations/open?forceFunctionRegion=us-east-1');
    expect(urls[1]).toBe('https://x.test/functions/v1/fr-conversation/conversations/open');
  });
});

 it('downloads a fresh private preview with CORS and without forwarding the session to storage', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ url: 'https://storage.example/private?token=short-lived' })))
    .mockResolvedValueOnce(new Response('png', { headers: { 'Content-Type': 'image/png' } }));
  const c = new RequestsClient({ baseUrl: BASE, apikey: 'public', getToken: async () => 'jwt-token', fetch });
  const blob = await c.attachmentBlob('image-1');
  expect(blob.type).toBe('image/png');
  expect(blob.size).toBe(3);
  expect(fetch.mock.calls[1]).toEqual(['https://storage.example/private?token=short-lived', { mode: 'cors', credentials: 'omit' }]);
 });
