// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { signStandardWebhook, standardWebhookKey, STANDARD_WEBHOOK_TOLERANCE_S, verifyStandardWebhook } from './standard-webhook.ts';

const KEY = btoa('a-32-byte-secret-for-the-hooks!!');
const NOW = Date.parse('2026-10-24T12:00:00Z');
const headers = (id: string, timestamp: number | string, signature: string): Record<string, string> => ({ 'webhook-id': id, 'webhook-timestamp': String(timestamp), 'webhook-signature': signature });

describe('standard webhooks (Supabase Auth hooks)', () => {
  it('reads the key from v1,whsec_<base64>, whsec_<base64> or bare base64 and rejects anything else', () => {
    const bytes = standardWebhookKey(`v1,whsec_${KEY}`)!;
    expect(new TextDecoder().decode(bytes)).toBe('a-32-byte-secret-for-the-hooks!!');
    expect(standardWebhookKey(`whsec_${KEY}`)).toEqual(bytes);
    expect(standardWebhookKey(KEY)).toEqual(bytes);
    expect(standardWebhookKey('')).toBeNull();
    expect(standardWebhookKey('v1,')).toBeNull();
    expect(standardWebhookKey('not base64 at all!')).toBeNull();
  });
  it('signs v1,<base64 HMAC-SHA256(id.timestamp.body)> and verifies it against the known vector', async () => {
    // Vector from the Standard Webhooks reference implementations.
    const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
    const signature = await signStandardWebhook(secret, 'msg_p5jXN8AQM9LWM0D4loKWxJek', 1614265330, '{"test": 2432232314}');
    expect(signature).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
    const check = await verifyStandardWebhook('{"test": 2432232314}', headers('msg_p5jXN8AQM9LWM0D4loKWxJek', 1614265330, signature), `v1,${secret}`, 1614265330_000);
    expect(check).toEqual({ ok: true, id: 'msg_p5jXN8AQM9LWM0D4loKWxJek' });
  });
  it('accepts any matching v1 entry of a space-separated list, within the timestamp tolerance, and names the failure otherwise', async () => {
    const secret = `v1,whsec_${KEY}`;
    const ts = Math.floor(NOW / 1000);
    const body = '{"user":{"email":"alice@example.com"}}';
    const good = await signStandardWebhook(secret, 'msg_1', ts, body);
    expect(await verifyStandardWebhook(body, headers('msg_1', ts, `v1,bm9wZQ== ${good}`), secret, NOW)).toEqual({ ok: true, id: 'msg_1' });
    expect(await verifyStandardWebhook(body, new Headers(headers('msg_1', ts, good)), secret, NOW + (STANDARD_WEBHOOK_TOLERANCE_S - 1) * 1000)).toMatchObject({ ok: true });
    expect(await verifyStandardWebhook(body, headers('msg_1', ts, good), secret, NOW + (STANDARD_WEBHOOK_TOLERANCE_S + 1) * 1000)).toEqual({ ok: false, reason: 'timestamp' });
    expect(await verifyStandardWebhook(body, headers('msg_1', ts, good), secret, NOW - (STANDARD_WEBHOOK_TOLERANCE_S + 1) * 1000)).toEqual({ ok: false, reason: 'timestamp' });
    expect(await verifyStandardWebhook(body + ' ', headers('msg_1', ts, good), secret, NOW)).toEqual({ ok: false, reason: 'signature' });
    expect(await verifyStandardWebhook(body, headers('msg_2', ts, good), secret, NOW)).toEqual({ ok: false, reason: 'signature' });
    expect(await verifyStandardWebhook(body, headers('msg_1', ts, good.replace('v1,', 'v1a,')), secret, NOW)).toEqual({ ok: false, reason: 'signature' });
    expect(await verifyStandardWebhook(body, headers('msg_1', ts, good), `v1,whsec_${btoa('another secret')}`, NOW)).toEqual({ ok: false, reason: 'signature' });
    expect(await verifyStandardWebhook(body, headers('msg_1', 'soon', good), secret, NOW)).toEqual({ ok: false, reason: 'headers' });
    expect(await verifyStandardWebhook(body, { 'webhook-id': 'msg_1' }, secret, NOW)).toEqual({ ok: false, reason: 'headers' });
    expect(await verifyStandardWebhook(body, headers('msg_1', ts, good), '', NOW)).toEqual({ ok: false, reason: 'secret' });
    await expect(signStandardWebhook('', 'm', 1, body)).rejects.toThrow(/not base64/);
  });
  it('verifies Svix deliveries (Resend webhooks) with the svix- headers, and only those, when asked', async () => {
    const secret = `whsec_${KEY}`;
    const ts = Math.floor(NOW / 1000);
    const body = '{"type":"email.received","data":{"email_id":"e1"}}';
    const sig = await signStandardWebhook(secret, 'msg_s', ts, body);
    const svix = { 'svix-id': 'msg_s', 'svix-timestamp': String(ts), 'svix-signature': sig };
    expect(await verifyStandardWebhook(body, svix, secret, NOW, STANDARD_WEBHOOK_TOLERANCE_S, 'svix')).toEqual({ ok: true, id: 'msg_s' });
    expect(await verifyStandardWebhook(body, svix, secret, NOW)).toEqual({ ok: false, reason: 'headers' });
    expect(await verifyStandardWebhook(body, headers('msg_s', ts, sig), secret, NOW, STANDARD_WEBHOOK_TOLERANCE_S, 'svix')).toEqual({ ok: false, reason: 'headers' });
  });
});
