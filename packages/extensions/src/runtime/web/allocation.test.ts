// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { admitHostMessages, installAllocationLimit, type AllocationLimit } from './allocation';

const MiB = 1024 * 1024;

/**
 * A fresh JavaScript realm, as each extension worker is: the limit changes its built-ins for good, so every test gets
 * its own. The registry is one the test collects by hand.
 */
function limited(budget: number, extra: Record<string, unknown> = {}) {
  const scope = runInNewContext('this') as Record<string, unknown>;
  Object.assign(scope, extra);
  const held: { target: WeakRef<object>; bytes: number; token?: object }[] = [];
  let release: (bytes: number) => void = () => {};
  const limit = installAllocationLimit(scope, budget, (r) => {
    release = r;
    return {
      register: (target, bytes, token) => { held.push({ target: new WeakRef(target), bytes, ...(token ? { token } : {}) }); },
      unregister: (token) => {
        const index = held.findIndex((h) => h.token === token);
        if (index < 0) return false;
        held.splice(index, 1);
        return true;
      },
    };
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
    // Assignment must run inside the worker realm; Node's VM global proxy can silently ignore outside writes.
    expect(() => scope.eval('"use strict"; Uint8Array = null')).toThrow(/read only|Cannot assign/);
    expect(Object.getOwnPropertyDescriptor(scope, 'Uint8Array')).toMatchObject({ writable: false, configurable: false });
  });

  it('counts a copy of a buffer the platform made, once', () => {
    const { scope, limit } = limited(MiB);
    const platform = new TextEncoder().encode('x'.repeat(1000));
    const Uint8 = scope.Uint8Array as unknown as { prototype: { slice: (this: Uint8Array) => Uint8Array } };
    Uint8.prototype.slice.call(platform);
    expect(limit.live()).toBe(1000);
  });
});

describe('routes around the budget', () => {
  type BufferWith = ArrayBuffer & { transfer(length?: number): ArrayBuffer; transferToFixedLength(length?: number): ArrayBuffer; detached: boolean };

  it('keeps the original ArrayBuffer constructor out of reach of the prototype chain', () => {
    const { scope } = limited(MiB);
    const parent = Object.getPrototypeOf(scope.ArrayBuffer) as unknown;
    expect(parent).toBe(Object.getPrototypeOf(scope.Object));
    expect(() => new (parent as ArrayBufferConstructor)(2 * MiB)).toThrow(TypeError);
  });

  it('keeps the original ArrayBuffer constructor out of reach through a buffer', () => {
    const { scope } = limited(MiB);
    const Original = new scope.Uint8Array(1).buffer.constructor as ArrayBufferConstructor;
    expect(Original).toBe(scope.ArrayBuffer);
    expect(() => new Original(2 * MiB)).toThrow(RangeError);
  });

  it('keeps the original typed array constructors out of reach of the prototype chain', () => {
    const { scope } = limited(MiB);
    const parent = Object.getPrototypeOf(scope.Uint8Array) as Uint8ArrayConstructor;
    expect(() => new parent(2 * MiB)).toThrow(/constructable/);
    expect(new scope.Float32Array(1).constructor).toBe(scope.Float32Array);
    expect(() => new (new scope.Float32Array(1).constructor as Float32ArrayConstructor)(MiB)).toThrow(RangeError);
    expect(() => (parent as unknown as { from(this: unknown, v: unknown): unknown }).from.call(parent, [1])).toThrow(/constructable|constructor/);
  });

  it('keeps the replacements working as the built-ins do', () => {
    const { scope, limit } = limited(MiB);
    expect(new scope.Uint8Array(4) instanceof scope.Uint8Array).toBe(true);
    expect(scope.ArrayBuffer.isView(new scope.Uint8Array(1))).toBe(true);
    expect(() => (scope.Uint8Array as unknown as () => unknown)()).toThrow(TypeError);
    expect(scope.Uint8Array.from([1, 2, 3]).length).toBe(3);
    expect(scope.Int16Array.of(1, 2).byteLength).toBe(4);
    expect(scope.Uint8Array.name).toBe('Uint8Array');
    expect(scope.Uint8Array.BYTES_PER_ELEMENT).toBe(1);
    expect(Array.from(new scope.Uint8Array([300, 1]))).toEqual([44, 1]);
    const Big = scope.BigInt64Array as unknown as new (v: unknown) => ArrayLike<bigint>;
    expect(Array.from(new Big([1n, 2n]))).toEqual([1n, 2n]);
    expect(() => new Big([1])).toThrow(TypeError);
    // The last one failed while filling: its buffer counts until it is collected.
    expect(limit.live()).toBe(4 + 1 + 3 + 4 + 2 + 16 + 8);
    const Sub = runInNewContext('(U) => class extends U {}', scope)(scope.Uint8Array) as Uint8ArrayConstructor;
    const sub = new Sub(1000);
    expect(sub instanceof Sub && sub instanceof scope.Uint8Array).toBe(true);
    expect(sub.subarray(1) instanceof Sub).toBe(true);
    expect(limit.live()).toBe(1038);
    expect(() => new Sub(MiB)).toThrow(RangeError);
  });

  it('counts the new length of ArrayBuffer.prototype.transfer, and frees the source at once', () => {
    const { scope, limit } = limited(MiB);
    const buffer = new scope.ArrayBuffer(8) as BufferWith;
    expect(() => buffer.transfer(2 * MiB)).toThrow(RangeError);
    const moved = buffer.transfer(600 * 1024) as BufferWith;
    expect(buffer.detached).toBe(true);
    expect(limit.live()).toBe(600 * 1024);
    expect(() => moved.transferToFixedLength(2 * MiB)).toThrow(RangeError);
    // A buffer may be moved at its full size: the source's share is given back.
    const again = moved.transferToFixedLength();
    expect(again.byteLength).toBe(600 * 1024);
    expect(limit.live()).toBe(600 * 1024);
    const resizable = new (scope.ArrayBuffer as unknown as new (n: number, o: { maxByteLength: number }) => BufferWith)(8, { maxByteLength: 1000 });
    resizable.transfer(10);
    expect(limit.live()).toBe(600 * 1024 + 1000);
  });

  it('counts copies that resolve to the platform\'s own constructor', () => {
    const { scope, limit } = limited(MiB);
    const buffer = new scope.ArrayBuffer(400 * 1024);
    Object.defineProperty(buffer, 'constructor', { value: undefined });
    buffer.slice();
    expect(limit.live()).toBe(800 * 1024);
    expect(() => buffer.slice()).toThrow(RangeError);
    const array = new scope.Uint8Array(100);
    const Species = runInNewContext('(U) => class extends U { static get [Symbol.species]() { return undefined; } }', scope)(scope.Uint8Array) as Uint8ArrayConstructor;
    const odd = new Species(100);
    odd.slice();
    odd.map((v) => v);
    expect(limit.live()).toBe(800 * 1024 + 400);
    (array as unknown as { toReversed(): unknown }).toReversed();
    (array as unknown as { toSorted(): unknown }).toSorted();
    (array as unknown as { with(i: number, v: number): unknown }).with(0, 1);
    expect(limit.live()).toBe(800 * 1024 + 700);
  });

  it('cannot be misled by objects that only look like buffers, or by changed built-ins', () => {
    const { scope, limit } = limited(MiB);
    const fake = Object.create(scope.ArrayBuffer.prototype) as object;
    Object.defineProperty(fake, 'length', { value: 2 * MiB });
    expect(() => new scope.Uint8Array(fake as ArrayBuffer)).toThrow(RangeError);
    let reads = 0;
    const shifty = { get length() { return reads++ === 0 ? 1 : 2 * MiB; } };
    // The length is read once to refuse early and once to copy; the copy is what is counted.
    expect(() => new scope.Uint8Array(shifty as ArrayLike<number>)).toThrow(RangeError);
    let maxReads = 0;
    const options = { get maxByteLength() { return maxReads++ === 0 ? 16 : 2 * MiB; } };
    expect((new (scope.ArrayBuffer as unknown as new (n: number, o: unknown) => ArrayBuffer)(8, options) as unknown as { maxByteLength: number }).maxByteLength).toBe(16);
    const before = limit.live();
    runInNewContext(`Object.defineProperty(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength', { get() { return 0; } });
      Object.defineProperty(ArrayBuffer.prototype, 'byteLength', { get() { return 0; } });
      Array.prototype[Symbol.iterator] = function* () { yield* new Array(600 * 1024).fill(0); };
      WeakMap.prototype.has = () => true;`, scope);
    expect(() => new scope.Uint8Array(2 * MiB)).toThrow(RangeError);
    // Whatever the changed iterator yields is what is counted.
    const made = new scope.Uint8Array(runInNewContext('[1, 2, 3, 4]', scope) as number[]);
    expect(made.length).toBeGreaterThan(0);
    expect(limit.live() - before).toBe(made.length);
  });

  it('counts the buffers inside a value that arrives from outside', () => {
    const { scope, limit } = limited(MiB);
    const message = { type: 'response', result: { data: new Uint8Array(1000), list: [new ArrayBuffer(10), new DataView(new ArrayBuffer(5))], map: new Map([['k', new Uint16Array(4)]]), set: new Set([new Float64Array(2)]) } };
    limit.admit(message);
    expect(limit.live()).toBe(1000 + 10 + 5 + 8 + 16);
    limit.admit(message);
    expect(limit.live()).toBe(1039);
    expect(() => limit.admit({ big: new Uint8Array(2 * MiB) })).toThrow(RangeError);
    limit.admit({ big: new Uint8Array(2 * MiB) }, true);
    expect(limit.live()).toBe(1039 + 2 * MiB);
    expect(() => new scope.Uint8Array(1)).toThrow(RangeError);
  });

  it('counts structuredClone copies, and frees what it transfers', () => {
    const { scope, limit } = limited(MiB, { structuredClone: (value: unknown, options?: StructuredSerializeOptions) => structuredClone(value, options) });
    const clone = scope.structuredClone as typeof structuredClone;
    const buffer = new scope.Uint8Array(400 * 1024);
    clone({ buffer });
    expect(limit.live()).toBe(800 * 1024);
    expect(() => clone([buffer])).toThrow(RangeError);
    expect(limit.live()).toBe(800 * 1024);
    const moved = clone(buffer, { transfer: [buffer.buffer] });
    expect(moved.byteLength).toBe(400 * 1024);
    expect(limit.live()).toBe(800 * 1024);
  });

  it('removes what cannot be counted, for good', () => {
    const stub = () => function Stub() {};
    const { scope } = limited(MiB, { MessageChannel: stub(), BroadcastChannel: stub(), Response: stub(), OffscreenCanvas: stub(), postMessage: stub() });
    const globals = scope as unknown as Record<string, unknown>;
    for (const name of ['MessageChannel', 'BroadcastChannel', 'Response', 'OffscreenCanvas', 'postMessage']) expect(globals[name]).toBeUndefined();
    expect(() => Object.defineProperty(scope, 'MessageChannel', { value: stub() })).toThrow(TypeError);
  });
});

describe('admitHostMessages', () => {
  it('counts what the host sends, failing an answer that would not fit and counting anything else anyway', async () => {
    const { limit } = limited(MiB);
    const channel = new MessageChannel();
    let budget: AllocationLimit | null = null;
    const received: unknown[] = [];
    const transport = admitHostMessages({ listen: (_handler: (message: unknown) => void) => () => {} }, channel.port2 as unknown as Parameters<typeof admitHostMessages>[1], () => budget);
    const stop = transport.listen((message) => received.push(message));
    const next = () => new Promise((resolve) => setTimeout(resolve, 20));
    channel.port1.postMessage({ type: 'ping', n: 1 });
    await next();
    budget = limit;
    channel.port1.postMessage({ type: 'response', id: 1, ok: true, result: { data: new Uint8Array(1000) } });
    channel.port1.postMessage({ type: 'response', id: 2, ok: true, result: { data: new Uint8Array(2 * MiB) } });
    channel.port1.postMessage({ type: 'invoke', invocation: 3, params: { data: new Uint8Array(2 * MiB) } });
    await next();
    expect(received[0]).toEqual({ type: 'ping', n: 1 });
    expect((received[1] as { result: { data: Uint8Array } }).result.data.byteLength).toBe(1000);
    expect(received[2]).toMatchObject({ type: 'response', id: 2, ok: false, error: { code: 'limit.exceeded' } });
    expect((received[3] as { type: string }).type).toBe('invoke');
    expect(limit.live()).toBe(1000 + 2 * MiB);
    stop();
    channel.port1.close();
  });
});
