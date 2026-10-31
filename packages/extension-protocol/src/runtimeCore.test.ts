// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { TokenBucket, isHostMessage, measureMessage } from './runtimeCore.ts';

const small = { bytes: 1000, nodes: 100, depth: 4 };

describe('measureMessage', () => {
  it('estimates strings, numbers, keys and binary data', () => {
    expect(measureMessage('abcd')).toBe(8);
    expect(measureMessage({ ab: 1 })).toBe(4 + 8);
    expect(measureMessage(new Uint8Array(300))).toBe(300);
    expect(measureMessage(new Map([['k', [true, null]]]))).toBe(2 + 1 + 1);
  });

  it('refuses values over the byte, node or depth bound', () => {
    expect(measureMessage('x'.repeat(501), small)).toBeNull();
    expect(measureMessage(Array.from({ length: 101 }, () => 0), small)).toBeNull();
    expect(measureMessage({ a: { b: { c: { d: { e: 1 } } } } }, small)).toBeNull();
    expect(measureMessage({ a: { b: { c: { d: 1 } } } }, small)).not.toBeNull();
  });

  it('counts a shared or cyclic object once and refuses functions and symbols', () => {
    const shared = { s: 'x'.repeat(100) };
    expect(measureMessage([shared, shared, shared], small)).toBe(2 + 200);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(measureMessage(cycle)).toBe(8);
    expect(measureMessage({ f: () => 1 })).toBeNull();
    expect(measureMessage([Symbol('s')])).toBeNull();
  });
});

describe('isHostMessage', () => {
  it('accepts the host message shapes and rejects others', () => {
    expect(isHostMessage({ type: 'invoke', invocation: 1, contribution: 'a.b.c', params: {}, document: 'doc_1' })).toBe(true);
    expect(isHostMessage({ type: 'invoke', invocation: 1, contribution: 'a.b.c', document: 7 })).toBe(false);
    expect(isHostMessage({ type: 'response', id: 3, ok: false, error: { code: 'cancelled', message: '' } })).toBe(true);
    expect(isHostMessage({ type: 'response', id: -1, ok: true })).toBe(false);
    expect(isHostMessage({ type: 'eval', code: '1' })).toBe(false);
    expect(isHostMessage(null)).toBe(false);
  });
});

describe('TokenBucket', () => {
  it('allows a burst, then refills at its rate up to the burst', () => {
    const bucket = new TokenBucket(10, 100, 0);
    expect(bucket.take(10, 0)).toBe(true);
    expect(bucket.take(1, 0)).toBe(false);
    expect(bucket.wait(1, 0)).toBe(10);
    expect(bucket.take(1, 10)).toBe(true);
    expect(bucket.take(5, 1000)).toBe(true);
    expect(bucket.take(6, 1000)).toBe(false);
    expect(bucket.wait(5, 1000)).toBe(0);
  });

  it('takes nothing when it cannot take all, and ignores time going backwards', () => {
    const bucket = new TokenBucket(4, 1, 100);
    expect(bucket.take(5, 100)).toBe(false);
    expect(bucket.take(4, 50)).toBe(true);
    expect(bucket.take(1, 60)).toBe(false);
  });
});
