// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { meshBox } from '@pushform/core';
import { InlineBackend } from '../backends/InlineBackend';
import { KernelClient } from './KernelClient';
import { square, topRegion } from '../test/helpers';

describe('KernelClient', () => {
  it('coalesces rapid previews: only the last resolves as current', async () => {
    const client = new KernelClient(new InlineBackend());
    const body = { bodyId: 1, version: 1 };
    await client.ensureBody(body.bodyId, body.version, meshBox([0, 0, 0], [1, 1, 1]));
    const distances = [0.1, 0.2, 0.3, 0.4, 0.5];
    const results = await Promise.all(
      distances.map((distance) =>
        client.coalesced('pp:1', () =>
          client.pushPull({ body, region: topRegion([0.5, 0.5, 1], square(0, 0, 0.2), 1, false), distance, mode: 'merge', preview: true, nextFaceId: 6 }),
        ),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(['superseded', 'superseded', 'superseded', 'superseded', 'current']);
    const last = results[4]!;
    if (last.status !== 'current') throw new Error('unreachable');
    expect(last.value.components[0]!.props.volume).toBeCloseTo(1 + 0.04 * 0.5, 8);
    // The key is idle again: a new call runs immediately and is current.
    const again = await client.coalesced('pp:1', () => client.properties({ body }));
    expect(again.status).toBe('current');
    client.dispose();
  });

  it('propagates errors only from current calls', async () => {
    const client = new KernelClient(new InlineBackend());
    const failing = client.coalesced('k', () => client.properties({ body: { bodyId: 99, version: 1 } }));
    await expect(failing).rejects.toMatchObject({ code: 'BodyNotCached' });
    client.dispose();
  });

  it('ensureBody uploads a version once', async () => {
    const backend = new InlineBackend();
    const client = new KernelClient(backend);
    const runId = await client.ensureBody(7, 1, meshBox([0, 0, 0], [1, 1, 1]));
    expect(await client.ensureBody(7, 1, meshBox([0, 0, 0], [1, 1, 1]))).toBe(runId);
    const ctx = await backend.getContext();
    expect(ctx.cache.size).toBe(1);
    await client.ensureBody(7, 2, meshBox([0, 0, 0], [2, 2, 2]));
    expect(ctx.cache.size).toBe(2);
    expect((await client.release(7)).released).toBe(2);
    client.dispose();
  });
});
