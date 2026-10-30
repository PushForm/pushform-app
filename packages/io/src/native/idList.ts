// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import protobuf from 'protobufjs/minimal';
import { NativeChunkError } from './chunks';
const fail = (): never => { throw new NativeChunkError('Invalid native packed ID list'); };
/** One canonical packed Protobuf uint32 occurrence; order and duplicates are preserved. */
export function encodeNativeIds(ids: readonly number[]): Uint8Array {
  const writer = protobuf.Writer.create();
  for (const id of ids) {
    if (!Number.isInteger(id) || id < 0 || id > 0xffff_ffff) return fail(); writer.uint32(id);
    if (writer.len > 1024 * 1024) return fail();
  }
  return new Uint8Array(writer.finish());
}
export function decodeNativeIds(bytes: Uint8Array | undefined): number[] {
  if (!bytes) return [];
  if (bytes.length > 1024 * 1024) return fail();
  const reader = protobuf.Reader.create(bytes), ids: number[] = [];
  while (reader.pos < reader.len) {
    let value = 0, done = false;
    for (let i = 0; i < 5; i++) {
      if (reader.pos >= reader.len) return fail(); const byte = reader.buf[reader.pos++]!;
      if (i === 4 && byte > 15) return fail(); value += (byte & 127) * 2 ** (7 * i);
      if (!(byte & 128)) { done = true; break; }
    }
    if (!done) return fail(); ids.push(value);
  }
  return ids;
}
