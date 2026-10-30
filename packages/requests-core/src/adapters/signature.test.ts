// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { headerOf, hexOf, hmacSha256Hex, timingSafeEqualHex } from './signature.ts';

describe('signature helpers', () => {
  it('computes the RFC 4231 test vector', async () => {
    expect(await hmacSha256Hex('key', 'The quick brown fox jumps over the lazy dog')).toBe('f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
  });
  it('compares digests without regard to case and rejects different lengths', () => {
    expect(timingSafeEqualHex('ABCD', 'abcd')).toBe(true);
    expect(timingSafeEqualHex('abcd', 'abce')).toBe(false);
    expect(timingSafeEqualHex('abcd', 'abcd0')).toBe(false);
    expect(timingSafeEqualHex('', '')).toBe(true);
  });
  it('reads headers from Headers, records and get-like objects', () => {
    expect(headerOf(new Headers({ 'Linear-Signature': 'abc' }), 'linear-signature')).toBe('abc');
    expect(headerOf({ 'X-Hub-Signature-256': 'sha256=1' }, 'x-hub-signature-256')).toBe('sha256=1');
    expect(headerOf({ get: (n: string) => (n === 'a' ? 'b' : null) }, 'a')).toBe('b');
    expect(headerOf({}, 'missing')).toBeNull();
    expect(headerOf(undefined, 'missing')).toBeNull();
  });
  it('encodes bytes as lowercase hex', () => { expect(hexOf(new Uint8Array([0, 15, 255]))).toBe('000fff'); });
});
