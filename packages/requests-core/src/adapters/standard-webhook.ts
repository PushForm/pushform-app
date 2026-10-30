// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { headerOf, type HeadersLike } from './signature.ts';

/**
 * Standard Webhooks (https://www.standardwebhooks.com) signature verification, as Supabase Auth HTTP hooks sign their
 * calls: headers `webhook-id`, `webhook-timestamp` (Unix seconds) and `webhook-signature` (space-separated
 * `v1,<base64 HMAC-SHA256>` entries); the signed content is `${id}.${timestamp}.${body}`; the key is the base64 secret
 * after the `v1,` prefix and the optional `whsec_` marker. Svix, which signs Resend's webhooks, uses the same
 * scheme with `svix-id`, `svix-timestamp` and `svix-signature`: pass `'svix'` as the header prefix. Web Crypto only, so it
 * runs in Deno and Node tests.
 */
export const STANDARD_WEBHOOK_TOLERANCE_S = 5 * 60;
export type StandardWebhookCheck = { ok: true; id: string } | { ok: false; reason: 'secret' | 'headers' | 'timestamp' | 'signature' };

/** The raw key bytes of a Supabase hook secret (`v1,whsec_<base64>`, `whsec_<base64>` or bare base64). */
export function standardWebhookKey(secret: string): Uint8Array<ArrayBuffer> | null {
  const text = secret.trim().replace(/^v1,/, '').replace(/^whsec_/, '');
  if (!text) return null;
  try {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch { return null; }
}
function base64Of(bytes: ArrayBuffer): string {
  let binary = '';
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary);
}
function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
/** `v1,<base64>` of HMAC-SHA256(key, `${id}.${timestamp}.${body}`). */
export async function signStandardWebhook(secret: string, id: string, timestamp: number | string, body: string): Promise<string> {
  const key = standardWebhookKey(secret);
  if (!key) throw new Error('The webhook secret is not base64.');
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `v1,${base64Of(await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(`${id}.${timestamp}.${body}`)))}`;
}
/** Verify one delivery; the timestamp must be within `toleranceS` of `nowMs` in either direction. */
export async function verifyStandardWebhook(body: string, headers: HeadersLike, secret: string, nowMs: number, toleranceS = STANDARD_WEBHOOK_TOLERANCE_S,
  headerPrefix: 'webhook' | 'svix' = 'webhook'): Promise<StandardWebhookCheck> {
  if (!standardWebhookKey(secret)) return { ok: false, reason: 'secret' };
  const id = headerOf(headers, `${headerPrefix}-id`), timestamp = headerOf(headers, `${headerPrefix}-timestamp`), signatures = headerOf(headers, `${headerPrefix}-signature`);
  if (!id || !timestamp || !signatures || !/^\d+$/.test(timestamp)) return { ok: false, reason: 'headers' };
  if (Math.abs(Math.floor(nowMs / 1000) - Number(timestamp)) > toleranceS) return { ok: false, reason: 'timestamp' };
  const expected = await signStandardWebhook(secret, id, timestamp, body);
  const matched = signatures.split(/\s+/).some(entry => entry.startsWith('v1,') && timingSafeEqual(entry, expected));
  return matched ? { ok: true, id } : { ok: false, reason: 'signature' };
}
