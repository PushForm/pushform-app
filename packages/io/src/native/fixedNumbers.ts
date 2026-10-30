// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { NativeChunkError } from './chunks';

/** Small, fixed-size numeric tuples in metadata. Large geometry uses streamed columns. */
export function encodeNativeNumbers(values: readonly number[], count: number): Uint8Array {
  if (!Number.isInteger(count) || count < 0 || count > 16 || values.length !== count) throw new NativeChunkError('Invalid native numeric tuple');
  const bytes = new Uint8Array(count * 8), view = new DataView(bytes.buffer);
  for (let i = 0; i < count; i++) {
    if (!Number.isFinite(values[i])) throw new NativeChunkError('Nonfinite native numeric tuple');
    view.setFloat64(i * 8, values[i]!, true);
  }
  return bytes;
}
export function decodeNativeNumbers(bytes: Uint8Array, count: number): number[] {
  if (!Number.isInteger(count) || count < 0 || count > 16 || bytes.byteLength !== count * 8) throw new NativeChunkError('Invalid native numeric tuple');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), values: number[] = [];
  for (let i = 0; i < count; i++) {
    const value = view.getFloat64(i * 8, true);
    if (!Number.isFinite(value)) throw new NativeChunkError('Nonfinite native numeric tuple'); values.push(value);
  }
  return values;
}
