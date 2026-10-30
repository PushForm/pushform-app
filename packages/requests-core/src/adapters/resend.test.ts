// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { MemoryMail } from './mail.ts';
import { ResendMail } from './resend.ts';

/** Recorded Resend responses. */
const SENT = { id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' };
const UNAUTHORIZED = { statusCode: 401, message: 'API key is invalid', name: 'validation_error' };
const RATE_LIMITED = { statusCode: 429, message: 'Too many requests', name: 'rate_limit_exceeded' };
const INVALID = { statusCode: 422, message: 'The `to` field must contain a valid email address', name: 'validation_error' };

function fakeResend(status: number, payload: unknown) {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, fetchImpl };
}
const message = { to: 'ada@example.com', subject: '[FRQ-123] Filed: Layout move tool', text: 'Hello', html: '<p>Hello</p>', headers: { 'X-Request-Id': 'r-1' } };
const make = (fetchImpl: typeof fetch) => new ResendMail({ apiKey: 're_test_key', from: 'requests@pushform.io', replyTo: 'support@pushform.io', fetch: fetchImpl });

describe('ResendMail', () => {
  it('posts the message with the sender, reply-to and bearer key', async () => {
    const { calls, fetchImpl } = fakeResend(200, SENT);
    expect(await make(fetchImpl).send(message)).toEqual({ id: SENT.id });
    expect(calls[0]?.url).toBe('https://api.resend.com/emails');
    expect(calls[0]?.headers).toEqual({ Authorization: 'Bearer re_test_key', 'Content-Type': 'application/json' });
    expect(calls[0]?.body).toEqual({
      from: 'requests@pushform.io', to: ['ada@example.com'], reply_to: 'support@pushform.io', subject: message.subject, text: 'Hello', html: '<p>Hello</p>', headers: { 'X-Request-Id': 'r-1' },
    });
  });
  it('accepts several recipients and omits headers when there are none', async () => {
    const { calls, fetchImpl } = fakeResend(200, SENT);
    await make(fetchImpl).send({ to: ['a@example.com', 'b@example.com'], subject: 's', text: 't', html: '<p>t</p>' });
    expect(calls[0]?.body['to']).toEqual(['a@example.com', 'b@example.com']);
    expect('headers' in (calls[0]?.body ?? {})).toBe(false);
  });
  it('maps provider errors to MailError codes', async () => {
    await expect(make(fakeResend(401, UNAUTHORIZED).fetchImpl).send(message)).rejects.toMatchObject({ code: 'auth', message: /API key is invalid/ });
    await expect(make(fakeResend(429, RATE_LIMITED).fetchImpl).send(message)).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(make(fakeResend(422, INVALID).fetchImpl).send(message)).rejects.toMatchObject({ code: 'invalid', message: /valid email address/ });
    await expect(make(fakeResend(500, {}).fetchImpl).send(message)).rejects.toMatchObject({ code: 'unavailable', message: /500/ });
    await expect(make(fakeResend(200, {}).fetchImpl).send(message)).rejects.toMatchObject({ code: 'unavailable' });
    const failing: typeof fetch = async () => { throw new TypeError('fetch failed'); };
    await expect(make(failing).send(message)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(make(fakeResend(200, SENT).fetchImpl).send({ ...message, to: [] })).rejects.toMatchObject({ code: 'invalid' });
  });
  it('MemoryMail records messages for tests', async () => {
    const mail = new MemoryMail();
    expect(await mail.send(message)).toEqual({ id: 'mem-1' });
    expect(mail.sent).toEqual([message]);
  });
});
