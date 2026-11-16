// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { runInNewContext } from 'node:vm';
import { gzipSync } from 'fflate';
import { beforeEach, describe, expect, it } from 'vitest';
import { installAllocationLimit } from './allocation';

const MiB = 1024 * 1024;

/**
 * The platform interfaces the budget wraps, taken from Node into a fresh realm. Their prototypes are changed for
 * good, which is why these tests have a file (and so a test environment) of their own; one budget serves them all.
 */
const scope = runInNewContext('this') as Record<string, unknown>;
Object.assign(scope, {
  Blob, File, FormData, ReadableStream, ReadableStreamDefaultReader, ReadableStreamDefaultController,
  CompressionStream, DecompressionStream, TextEncoder, TextEncoderStream,
});
let release: (bytes: number) => void = () => {};
const held: number[] = [];
const limit = installAllocationLimit(scope, 4 * MiB, (r) => {
  release = r;
  return { register: (_target, bytes) => { held.push(bytes); } };
});
// Each test starts with everything collected.
beforeEach(() => { for (const bytes of held.splice(0)) release(bytes); });
const realm = scope as unknown as typeof globalThis;

/** Runs `body` and returns the bytes it left counted. */
async function counted(body: () => unknown): Promise<number> {
  const before = limit.live();
  await body();
  return limit.live() - before;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return total;
    total += value.byteLength;
  }
}

describe('platform routes', () => {
  it('counts a Blob by its size, refusing one built past the budget before it is made', async () => {
    // Parts from outside the realm, so that Node's own Blob code, which copies them in JavaScript, is not counted.
    const part = new Uint8Array(MiB);
    expect(() => new realm.Blob(Array(8).fill(part))).toThrow(/limit\.exceeded/);
    expect(await counted(() => new realm.Blob([part, part.subarray(3)]))).toBe(2 * MiB - 3);
    expect(new realm.Blob([part]).constructor).toBe(realm.Blob);
    expect(Object.getPrototypeOf(realm.File)).toBe(realm.Blob);
    expect(new realm.File(['xy'], 'a.txt').name).toBe('a.txt');
  });

  it('counts what is read from a Blob, its slices and its stream', async () => {
    const blob = new realm.Blob(['x'.repeat(1000)]);
    expect(await counted(async () => expect((await blob.arrayBuffer()).byteLength).toBe(1000))).toBe(1000);
    expect(await counted(async () => (await blob.bytes()).byteLength)).toBe(1000);
    expect(await counted(() => blob.slice(0, 10))).toBe(10);
    expect(await counted(() => readAll(blob.stream()))).toBe(1000);
  });

  it('refuses reading a Blob back when it would not fit', async () => {
    const blob = new realm.Blob([new Uint8Array(2.5 * MiB)]);
    await expect(blob.arrayBuffer()).rejects.toThrow(/limit\.exceeded/);
    expect(limit.live()).toBe(2.5 * MiB);
  });

  it('counts decompressed chunks as they are read, so a small input cannot become a large buffer', async () => {
    const gzip = gzipSync(new Uint8Array(8 * MiB));
    expect(gzip.byteLength).toBeLessThan(64 * 1024);
    const before = limit.live();
    const out = new realm.Blob([gzip]).stream().pipeThrough(new realm.DecompressionStream('gzip'));
    await expect(readAll(out)).rejects.toThrow(/limit\.exceeded/);
    expect(limit.live()).toBeLessThanOrEqual(4 * MiB);
    expect(limit.live() - before).toBeGreaterThan(3 * MiB);
  });

  it('counts TextEncoder output', async () => {
    expect(await counted(() => new realm.TextEncoder().encode('é'.repeat(100)))).toBe(200);
    const encoded = new realm.Blob(['abc']).stream().pipeThrough(new TextDecoderStream()).pipeThrough(new realm.TextEncoderStream());
    expect(await counted(() => readAll(encoded))).toBe(3 + 3);
  });

  it('counts the Blobs a FormData keeps', async () => {
    const form = new realm.FormData();
    const blob = new realm.Blob(['x'.repeat(500)]);
    expect(await counted(() => form.append('file', blob))).toBe(500);
    expect(await counted(() => form.set('text', 'plain'))).toBe(0);
  });

  it('refuses readable byte streams, which move buffers, and keeps ordinary streams working', async () => {
    expect(() => new realm.ReadableStream({ type: 'bytes' })).toThrow(/byte streams/);
    const source = { chunks: ['a', 'b'], pull(controller: ReadableStreamDefaultController<string>) {
      const next = this.chunks.shift();
      if (next === undefined) controller.close(); else controller.enqueue(next);
    } };
    const reader = (new realm.ReadableStream(source) as ReadableStream<string>).getReader();
    expect((await reader.read()).value).toBe('a');
    expect((await reader.read()).value).toBe('b');
    expect((await reader.read()).done).toBe(true);
    expect(new realm.ReadableStream().constructor).toBe(realm.ReadableStream);
  });
});
