// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/** HMAC-SHA256 helpers for webhook verification (Web Crypto only; runs in Node and Deno). */
export function hexOf(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
export async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hexOf(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
}
/** Constant-time comparison of two hex digests; different lengths compare unequal without early exit on content. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const x = a.toLowerCase(), y = b.toLowerCase();
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}
/** Case-insensitive header lookup over a `Headers`, a record, or anything with `get`. */
export type HeadersLike = Headers | Record<string, string | undefined> | { get(name: string): string | null };
export function headerOf(headers: HeadersLike | undefined, name: string): string | null {
  if (!headers) return null;
  if (typeof (headers as { get?: unknown }).get === 'function') return (headers as { get(n: string): string | null }).get(name) ?? null;
  const record = headers as Record<string, string | undefined>;
  const key = Object.keys(record).find(k => k.toLowerCase() === name.toLowerCase());
  return key ? record[key] ?? null : null;
}
