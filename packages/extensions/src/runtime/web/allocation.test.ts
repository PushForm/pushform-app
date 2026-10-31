// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { installAllocationLimit } from './allocation';

const MiB = 1024 * 1024;

/**
 * A fresh JavaScript realm, as each extension worker is: the limit changes its built-ins for good, so every test gets
 * its own. The registry is one the test collects by hand.
 */
function limited(budget: number) {
  const scope = runInNewContext('this') as Record<string, unknown>;
  const held: { target: WeakRef<object>; bytes: number }[] = [];
  let release: (bytes: number) => void = () => {};
  const limit = installAllocationLimit(scope, budget, (r) => {
    release = r;
    return { register: (target, bytes) => { held.push({ target: new WeakRef(target), bytes }); } };
  });
  const collect = (target: object) => {
    const entry = held.find((h) => h.target.deref() === target);
    if (entry) { release(entry.bytes); held.splice(held.indexOf(entry), 1); }
  };
  return { scope: scope as unknown as typeof globalThis, limit, collect };
}

describe('installAllocationLimit', () => {
  it('reserves typed array and buffer sizes before allocating, and refuses past the budget', () => {
    const { scope, limit } = limited(MiB);
    const first = new scope.Uint8Array(600 * 1024);
    expect(limit.live()).toBe(600 * 1024);
    expect(() => new scope.Float64Array(100 * 1024)).toThrow(/limit\.exceeded/);
    expect(() => new scope.ArrayBuffer(2 * MiB)).toThrow(RangeError);
    expect(limit.live()).toBe(600 * 1024);
    expect(first instanceof scope.Uint8Array).toBe(true);
    expect(first.length).toBe(600 * 1024);
  });

  it('returns bytes when buffers are collected', () => {
    const { scope, limit, collect } = limited(MiB);
    const big = new scope.Uint8Array(900 * 1024);
    expect(() => new scope.Uint8Array(200 * 1024)).toThrow(RangeError);
    collect(big.buffer);
    expect(limit.live()).toBe(0);
    expect(new scope.Uint8Array(200 * 1024).length).toBe(200 * 1024);
  });

  it('counts array-likes, iterables, slices and resizable maxima, but not views over counted memory', () => {
    const { scope, limit } = limited(MiB);
    new scope.Int32Array([1, 2, 3, 4]);
    expect(limit.live()).toBe(16);
    new scope.Uint8Array(new Set([1, 2, 3]));
    expect(limit.live()).toBe(19);
    const buffer = new scope.ArrayBuffer(1000);
    new scope.Uint8Array(buffer, 10, 100);
    expect(limit.live()).toBe(1019);
    buffer.slice(0, 500);
    expect(limit.live()).toBe(1519);
    const resizable = new (scope.ArrayBuffer as unknown as new (n: number, o: { maxByteLength: number }) => ArrayBuffer)(10, { maxByteLength: 2000 });
    expect(resizable.byteLength).toBe(10);
    expect(limit.live()).toBe(3519);
    expect(() => new (scope.ArrayBuffer as unknown as new (n: number, o: { maxByteLength: number }) => ArrayBuffer)(1, { maxByteLength: 2 * MiB })).toThrow(RangeError);
  });

  it('refuses copies that would go over, and cannot be undone', () => {
    const { scope } = limited(MiB);
    const half = new scope.Uint8Array(600 * 1024);
    expect(() => half.slice()).toThrow(RangeError);
    expect(() => half.map((v) => v)).toThrow(RangeError);
    expect(() => { (scope as unknown as Record<string, unknown>).Uint8Array = Uint8Array; }).toThrow(TypeError);
  });

  it('counts a copy of a buffer the platform made, once', () => {
    const { scope, limit } = limited(MiB);
    const platform = new TextEncoder().encode('x'.repeat(1000));
    const Uint8 = scope.Uint8Array as unknown as { prototype: { slice: (this: Uint8Array) => Uint8Array } };
    Uint8.prototype.slice.call(platform);
    expect(limit.live()).toBe(1000);
  });
});
