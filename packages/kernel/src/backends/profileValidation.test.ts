// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it } from 'vitest';
import { planeBasis } from '@pushform/core';
import { KernelClient } from '../client/KernelClient';
import { InlineBackend } from './InlineBackend';
import { encodeRequest } from './nativeWire';
import type { ExtrudeSketchRequest } from '../protocol';

let client: KernelClient | undefined;
afterEach(() => client?.dispose());
const square = [[0, 0], [2, 0], [2, 2], [0, 2]];
const request = (polygon: number[][][]): ExtrudeSketchRequest => ({
  type: 'extrudeSketch', basis: planeBasis([0, 0, 0], [0, 0, 1]),
  polygon, distance: 0.1, nextFaceId: 0,
});

it.each([
  [[[0, 0], [2, 2], [0, 2], [3, 0]]],
  [square, [[3, 3], [4, 3], [4, 4], [3, 4]]],
  [square, [[0, 0.5], [1, 0.5], [1, 1], [0, 1]]],
  [square, [[0.2, 0.2], [1.8, 0.2], [1.8, 1.8], [0.2, 1.8]], [[0.5, 0.5], [1, 0.5], [1, 1], [0.5, 1]]],
  [[[0, 0], [2, 0], [2, 0], [2, 2], [0, 2]]],
].map(polygon => ({ polygon })))('rejects malformed strict profiles through the actual WASM wire: %j', async ({ polygon }) => {
  client = new KernelClient(new InlineBackend());
  const { type: _type, ...input } = request(polygon);
  await expect(client.extrudeSketch({ ...input, validateProfile: true })).rejects.toMatchObject({ code: 'InvalidInput' });
  const valid = await client.extrudeSketch({ ...input, polygon: [square], validateProfile: true });
  expect(valid.components).toHaveLength(1);
  expect(valid.components[0]!.props.volume).toBeCloseTo(0.4);
});

it('keeps existing request bytes unchanged unless strict validation is requested', () => {
  const input = request([square]), old = encodeRequest(input);
  expect(encodeRequest({ ...input, validateProfile: false })).toEqual(old);
  const strict = encodeRequest({ ...input, validateProfile: true });
  expect(strict.slice(0, -4)).toEqual(old);
  expect(new DataView(strict.buffer, strict.byteOffset + strict.length - 4, 4).getUint32(0, true)).toBe(1);
});
