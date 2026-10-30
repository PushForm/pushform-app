// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Brief, ConversationPath, IntentPath, Me } from './client';

/**
 * Test double for the `fr-conversation` HTTP contract: an in-memory store behind a `fetch` function,
 * with agent turns scripted as SSE event lists. Used by the component and client tests only.
 */
export interface FakeTurn { readonly event: string; readonly data: Record<string, unknown> }
interface FakeConversation {
  id: string; kind: string; path: ConversationPath; status: string; title: string | null; brief: Brief | null;
  messages: { role: string; text: string; at: string }[]; messageCount: number; requestId: string | null; updatedAt: string;
}
export interface FakeBackendOptions {
  readonly me?: Partial<Me> | undefined;
  /**
   * Scripted agent turns, consumed in order. A turn containing a `filed` or `added` event marks the conversation filed
   * or closed; `done` with `ended: true` and `reason: 'start_over'` discards it, as the real backend does.
   */
  readonly turns?: FakeTurn[][] | undefined;
  readonly openConversations?: FakeConversation[] | undefined;
}
export const BASE = 'https://example.test/functions/v1/fr-conversation';
/** Where the fake hands out signed upload URLs. */
export const STORAGE_ORIGIN = 'https://storage.example.test';
/** What the fake agent answers when an intent card arrives and no turn is scripted. */
export const FAKE_OPENER: Record<IntentPath, string> = {
  help: 'What do you need help with?',
  problem: 'What did you do, and what happened?',
  feature: 'What are you trying to do?',
};

export function sseResponse(turn: readonly FakeTurn[], chunking: 'whole' | 'split' = 'split'): Response {
  const encoder = new TextEncoder();
  const text = turn.map(item => `event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`).join('');
  const parts = chunking === 'whole' ? [text] : text.match(/[\s\S]{1,17}/g) ?? [];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { for (const part of parts) controller.enqueue(encoder.encode(part)); controller.close(); },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const failure = (status: number, code: string, message: string): Response => json({ error: { code, message } }, status);

/** The `request` payload of a `filed` or `added` event. */
export function makeFiledRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'req-1', issueKey: 'CUS-12', issueUrl: 'https://linear.app/pushform/issue/CUS-12', title: 'Mirror tool', requesterState: 'Submitted', eligibility: 'gated', ...overrides };
}
/** Events that end a turn after the agent filed: the `filed` line, the closing text, and `done` with `ended: true`. */
export function filedTurn(request: Record<string, unknown> = makeFiledRequest(), messageCount = 3): FakeTurn[] {
  return [{ event: 'filed', data: { request } }, { event: 'text', data: { delta: `Filed as ${String(request['issueKey'])}. You will get an email shortly.` } },
    { event: 'done', data: { messageCount, limitReached: false, ended: true } }];
}

export function fakeBackend(options: FakeBackendOptions = {}) {
  const calls: { method: string; path: string; body: unknown; headers: Record<string, string> }[] = [];
  const conversations = new Map<string, FakeConversation>((options.openConversations ?? []).map(item => [item.id, item]));
  const turns = [...(options.turns ?? [])];
  let nextId = conversations.size + 1, nextAttachment = 1;
  const attachments = new Map<string, { id: string; kind: 'screenshot' | 'document'; name: string; size: number; uploaded: boolean }[]>();
  const uploads = new Map<string, number>();
  const me: Me = { email: 'artist@example.com', roles: [], effective: 'user', filingDisabled: false, buildsDisabled: false, trialsDisabled: false, openRequests: 0,
    limits: { openRequestsPerAccount: 5, messagesPerConversation: 30 }, ...options.me };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET', path = url.pathname.slice(new URL(BASE).pathname.length) || '/';
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    // The signed upload URL goes straight to storage, with no session.
    if (url.origin === STORAGE_ORIGIN) {
      calls.push({ method, path: url.pathname, body: undefined, headers });
      if (method !== 'PUT' || !(init?.body instanceof Blob)) return failure(400, 'invalid', 'Upload with PUT.');
      uploads.set(url.pathname.split('/').pop() ?? '', init.body.size);
      return json({ Key: url.pathname });
    }
    calls.push({ method, path, body, headers });
    if (headers['authorization'] !== 'Bearer jwt-token') return failure(401, 'unauthorized', 'Sign in required.');
    const segments = path.split('/').filter(Boolean);
    if (method === 'GET' && path === '/me') return json(me);
    if (method === 'GET' && path === '/conversations/open') return json({ conversations: [...conversations.values()].filter(item => item.status === 'open')
      .map(item => ({ id: item.id, kind: item.kind, path: item.path, title: item.title, updatedAt: item.updatedAt, messageCount: item.messageCount })) });
    if (method === 'POST' && path === '/conversations') {
      const input = body as { kind: string; path: ConversationPath };
      if (!['open', 'help', 'problem', 'feature'].includes(input.path)) return failure(400, 'invalid', `Unknown path ${String(input.path)}.`);
      const conversation: FakeConversation = { id: `conv-${nextId++}`, kind: input.kind, path: input.path, status: 'open', title: null, brief: null, messages: [], messageCount: 0, requestId: null, updatedAt: new Date().toISOString() };
      conversations.set(conversation.id, conversation);
      return json({ conversation });
    }
    const conversation = segments[0] === 'conversations' && segments[1] ? conversations.get(segments[1]) : undefined;
    if (segments[0] === 'conversations' && segments[1] && !conversation) return failure(404, 'not_found', 'No such conversation.');
    if (conversation && segments.length === 2 && method === 'GET') return json({ conversation });
    if (conversation && segments[2] === 'messages' && method === 'POST') {
      const { text, intent } = body as { text: string; intent?: IntentPath };
      if (intent !== undefined && !(intent in FAKE_OPENER)) return failure(400, 'invalid', `Unknown intent ${String(intent)}.`);
      conversation.messages.push({ role: 'user', text, at: new Date().toISOString() });
      conversation.messageCount += 1;
      // An intent card sets the path before the agent answers; the unscripted reply then opens on that path.
      if (intent) conversation.path = intent;
      const turn = turns.shift() ?? (intent
        ? [{ event: 'text', data: { delta: FAKE_OPENER[intent] } }, { event: 'brief', data: { brief: conversation.brief, title: conversation.title, path: intent, estimatedClass: null } }, { event: 'done', data: { messageCount: conversation.messageCount, limitReached: false } }]
        : [{ event: 'text', data: { delta: `Echo: ${text}` } }, { event: 'done', data: { messageCount: conversation.messageCount, limitReached: false } }]);
      const reply = turn.filter(item => item.event === 'text').map(item => String(item.data['delta'])).join('');
      if (reply) conversation.messages.push({ role: 'assistant', text: reply, at: new Date().toISOString() });
      for (const item of turn) {
        if (item.event === 'brief') { conversation.brief = (item.data['brief'] as Brief | null) ?? conversation.brief; conversation.title = (item.data['title'] as string | null) ?? conversation.title; if (item.data['path']) conversation.path = item.data['path'] as ConversationPath; }
        if (item.event === 'filed') { conversation.status = 'filed'; conversation.requestId = String((item.data['request'] as Record<string, unknown> | undefined)?.['id'] ?? ''); }
        if (item.event === 'added') conversation.status = 'closed';
        if (item.event === 'done' && item.data['ended'] === true && conversation.status === 'open') conversation.status = item.data['reason'] === 'start_over' ? 'discarded' : 'closed';
      }
      return sseResponse(turn);
    }
    if (conversation && segments[2] === 'attachments') {
      const mine = attachments.get(conversation.id) ?? [];
      attachments.set(conversation.id, mine);
      if (segments.length === 3 && method === 'GET') return json({ attachments: mine.filter(item => item.uploaded).map(({ id, kind, name, size }) => ({ id, kind, name, size })) });
      if (segments.length === 3 && method === 'POST') {
        if (!['feature', 'problem'].includes(conversation.path) || conversation.status !== 'open') return failure(400, 'invalid', 'Attachments belong to open problem reports.');
        if (mine.length >= 5) return failure(409, 'limit', 'A report takes at most 5 attachments.');
        const input = body as { kind: 'screenshot' | 'document'; name: string; mime: string; size: number };
        const item = { id: `att-${nextAttachment++}`, kind: input.kind, name: input.name, size: input.size, uploaded: false };
        mine.push(item);
        return json({ attachment: { id: item.id, kind: item.kind, name: item.name, size: item.size }, uploadUrl: `${STORAGE_ORIGIN}/upload/${item.id}` });
      }
      const item = mine.find(entry => entry.id === segments[3]);
      if (item && method === 'DELETE') { mine.splice(mine.indexOf(item), 1); return json({ ok: true }); }
      if (item && segments[4] === 'complete' && method === 'POST') {
        if (uploads.get(item.id) !== item.size) return failure(400, 'invalid', 'The upload is missing or does not match the confirmed size.');
        item.uploaded = true;
        return json({ attachment: { id: item.id, kind: item.kind, name: item.name, size: item.size } });
      }
    }
    if (conversation && segments[2] === 'discard' && method === 'POST') { conversation.status = 'discarded'; return json({ ok: true }); }
    // The editor's answers resume the turn with the next scripted events.
    if (conversation && segments[2] === 'tool-results' && method === 'POST') {
      const turn = turns.shift();
      if (!turn) return failure(400, 'invalid', 'No document tool call is waiting in this conversation.');
      const reply = turn.filter(item => item.event === 'text').map(item => String(item.data['delta'])).join('');
      if (reply) conversation.messages.push({ role: 'assistant', text: reply, at: new Date().toISOString() });
      return sseResponse(turn);
    }
    return failure(404, 'not_found', `No route ${method} ${path}`);
  };
  return { fetch: fetchImpl, calls, conversations, me, attachments, uploads };
}
