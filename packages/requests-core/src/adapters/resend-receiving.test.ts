// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { ResendReceiving } from './resend-receiving.ts';

function fakeFetch(routes: Record<string, { status?: number; body: unknown }>): { fetch: typeof fetch; calls: { url: string; auth: string | null }[] } {
  const calls: { url: string; auth: string | null }[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
    const route = routes[url];
    if (!route) return new Response('{"message":"not found"}', { status: 404 });
    return route.body instanceof Uint8Array ? new Response(route.body as Uint8Array<ArrayBuffer>, { status: route.status ?? 200 })
      : new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
  };
  return { fetch: impl as typeof fetch, calls };
}

describe('ResendReceiving', () => {
  it('fetches a received email with the bearer key and normalizes missing fields', async () => {
    const { fetch, calls } = fakeFetch({ 'https://api.resend.com/emails/receiving/e%201': { body: {
      id: 'e 1', from: 'A <a@x.io>', to: ['testers@pushform.io'], received_for: ['testers@pushform.io'], subject: 'Hi', created_at: '2026-10-27T10:00:00Z',
      message_id: '<m@x>', html: '<p>Hi</p>', text: null, headers: { a: 'b' } } } });
    const email = await new ResendReceiving({ apiKey: 're_test', fetch }).email('e 1');
    expect(email).toEqual({ id: 'e 1', from: 'A <a@x.io>', to: ['testers@pushform.io'], cc: [], received_for: ['testers@pushform.io'], subject: 'Hi',
      created_at: '2026-10-27T10:00:00Z', message_id: '<m@x>', html: '<p>Hi</p>', text: null });
    expect(calls).toEqual([{ url: 'https://api.resend.com/emails/receiving/e%201', auth: 'Bearer re_test' }]);
  });
  it('fetches Inbox messages through their thread and preserves their received time', async () => {
    const url = 'https://api.resend.com/inboxes/inbox%201/threads/thread%201/emails/e1';
    const { fetch, calls } = fakeFetch({ [url]: { body: { id: 'e1', from: 'sender@example.com', to: ['testers@pushform.io'],
      received_at: '2026-10-28T20:00:00Z', text: 'Code 12345678', attachments: [] } } });
    expect(await new ResendReceiving({ apiKey: 'k', fetch }).email('e1', { inboxId: 'inbox 1', threadId: 'thread 1' }))
      .toMatchObject({ created_at: '2026-10-28T20:00:00Z', text: 'Code 12345678', attachmentIds: [] });
    expect(calls).toEqual([{ url, auth: 'Bearer k' }]);
  });
  it('pages through attachments and downloads one', async () => {
    const base = 'https://api.resend.com/emails/receiving/e1/attachments';
    const { fetch } = fakeFetch({
      [`${base}?limit=100`]: { body: { object: 'list', has_more: true, data: [{ id: 'a1', filename: 'x.pdf', content_type: 'application/pdf', size: 3, download_url: 'https://dl/a1' }] } },
      [`${base}?limit=100&after=a1`]: { body: { object: 'list', has_more: false, data: [{ id: 'a2', download_url: 'https://dl/a2' }, { id: 'broken' }] } },
      'https://dl/a1': { body: new Uint8Array([1, 2, 3]) },
    });
    const resend = new ResendReceiving({ apiKey: 'k', fetch });
    expect(await resend.attachments('e1')).toEqual([
      { id: 'a1', filename: 'x.pdf', content_type: 'application/pdf', size: 3, download_url: 'https://dl/a1' },
      { id: 'a2', filename: 'attachment', content_type: 'application/octet-stream', size: 0, download_url: 'https://dl/a2' },
    ]);
    expect([...await resend.download('https://dl/a1')]).toEqual([1, 2, 3]);
    await expect(resend.download('https://dl/missing')).rejects.toThrow(/404/);
  });
  it('names the status and the provider message on failure', async () => {
    const { fetch } = fakeFetch({ 'https://api.resend.com/emails/receiving/e1': { status: 401, body: { message: 'API key is invalid' } } });
    await expect(new ResendReceiving({ apiKey: 'k', fetch }).email('e1')).rejects.toThrow('Resend /emails/receiving/e1 returned 401: API key is invalid');
  });
});
