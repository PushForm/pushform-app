// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { decodeNativeWire, encodeNativeWire, nativeWireFrames, NativeWireReader, NATIVE_WIRE_LIMITS } from './wire';
it('preserves binary slices, buffers, undefined, nested arrays and data that resembles wire tags', () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const input = { data: bytes.subarray(1, 3), buffer: bytes.buffer, optional: undefined, nested: [['bytes', 'data'], null] };
  expect(decodeNativeWire(encodeNativeWire(input))).toEqual(input);
  const poison = JSON.parse('{"__proto__":{"polluted":true},"constructor":"data"}') as Record<string, unknown>;
  expect(decodeNativeWire(encodeNativeWire(poison))).toEqual(poison);
  expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
});
it('rejects cycles, unsupported values, malformed binary and forged object entries', () => {
  const cyclic: unknown[] = []; cyclic.push(cyclic);
  for (const input of [cyclic, () => {}, Number.NaN, new Date(), 1n]) expect(() => encodeNativeWire(input)).toThrow();
  for (const input of ['["bytes","!!!!"]', '["bytes","AA=A"]', '["object",["a",1],["a",2]]', '["unknown"]', '{}']) expect(() => decodeNativeWire(input)).toThrow();
});
it('assembles large ordered messages and rejects replay, interleaving and oversized frames', () => {
  const text = encodeNativeWire({ data: 'a'.repeat(NATIVE_WIRE_LIMITS.frameChars * 2 + 19) });
  const frames = [...nativeWireFrames(1, text)], reader = new NativeWireReader();
  expect(frames).toHaveLength(3); expect(reader.push(frames[0]!)).toBeNull(); expect(reader.push(frames[1]!)).toBeNull(); expect(reader.push(frames[2]!)).toBe(text);
  expect(() => reader.push(frames[0]!)).toThrow(/Stale/);
  const next = [...nativeWireFrames(2, text)]; reader.push(next[0]!);
  expect(() => reader.push({ ...next[1]!, id: 3 })).toThrow(/Interleaved/);
  expect(() => new NativeWireReader().push({ ...frames[0]!, data: 'x'.repeat(NATIVE_WIRE_LIMITS.frameChars + 1) })).toThrow();
});

it('keeps non-BMP text intact at native JSON frame boundaries', () => {
  const text = 'a'.repeat(NATIVE_WIRE_LIMITS.frameChars - 1) + String.fromCodePoint(0x1f332) + 'tail';
  const frames = [...nativeWireFrames(1, text)];
  expect(frames[0]!.data.length).toBe(NATIVE_WIRE_LIMITS.frameChars - 1);
  expect(frames.map(frame => frame.data).join('')).toBe(text);
});

it('preserves numeric typed views and DataView without interpreting their bytes as integers', () => {
  const coordinates = new Float64Array([0.125, -4.75]);
  const indices = new Uint32Array([2, 70000]); const view = new DataView(new Uint8Array([1, 2, 3]).buffer);
  const input = { coordinates, indices, view };
  const output = decodeNativeWire(encodeNativeWire(input)) as typeof input;
  expect(output.coordinates).toBeInstanceOf(Float64Array); expect(output.coordinates).toEqual(coordinates);
  expect(output.indices).toBeInstanceOf(Uint32Array); expect(output.indices).toEqual(indices);
  expect(output.view).toBeInstanceOf(DataView); expect(output.view.getUint8(2)).toBe(3);
});
