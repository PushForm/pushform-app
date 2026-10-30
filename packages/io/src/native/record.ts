// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import protobuf from 'protobufjs/minimal';
import { NativeChunkError } from './chunks';

export type NativeScalar = number | string | boolean | Uint8Array | Uint8Array[];
export type NativeFieldKind = 'uint32' | 'uint53' | 'double' | 'bool' | 'string' | 'bytes';
export interface NativeField { id: number; kind: NativeFieldKind; required: boolean; repeated?: boolean }
export type NativeRecordSchema = Readonly<Record<string, NativeField>>;
export interface NativeRecord { fields: Record<string, NativeScalar>; unknownFields: Uint8Array[] }
const LIMIT = 1024 * 1024;
const fail = (): never => { throw new NativeChunkError('Invalid native metadata record'); };
const wire = (kind: NativeFieldKind): number => kind === 'double' ? 1 : kind === 'bytes' || kind === 'string' ? 2 : 0;
function uint(reader: protobuf.Reader, max: number): number {
  let value = 0;
  for (let i = 0; i < 8; i++) {
    if (reader.pos >= reader.len) return fail(); const byte = reader.buf[reader.pos++]!;
    value += (byte & 127) * 2 ** (i * 7);
    if (!Number.isSafeInteger(value) || value > max) return fail();
    if (!(byte & 128)) return value;
  }
  return fail();
}

/** Static field tables, no runtime code generation. Nested records use bytes fields. */
export class NativeRecordCodec {
  readonly #ids = new Map<number, [string, NativeField]>();
  constructor(private readonly schema: NativeRecordSchema) {
    for (const [name, field] of Object.entries(schema)) {
      if (!Number.isInteger(field.id) || field.id < 1 || field.id > 0x1fff_ffff || this.#ids.has(field.id) ||
          (field.id >= 19000 && field.id <= 19999) || (field.repeated && (field.kind !== 'bytes' || field.required))) fail();
      this.#ids.set(field.id, [name, field]);
    }
  }
  decode(bytes: Uint8Array): NativeRecord {
    if (bytes.length > LIMIT) return fail();
    const reader = protobuf.Reader.create(bytes), fields: Record<string, NativeScalar> = Object.create(null) as Record<string, NativeScalar>;
    const unknownFields: Uint8Array[] = [];
    try {
      while (reader.pos < reader.len) {
        const start = reader.pos, tag = uint(reader, 0xffff_ffff), id = tag >>> 3, type = tag & 7, known = this.#ids.get(id);
        if (!id || ![0, 1, 2, 5].includes(type)) return fail();
        if (!known) {
          reader.skipType(type); if (reader.pos > reader.len) return fail();
          unknownFields.push(new Uint8Array(bytes.subarray(start, reader.pos))); continue;
        }
        const [name, field] = known;
        if ((!field.repeated && Object.hasOwn(fields, name)) || type !== wire(field.kind)) return fail();
        if (field.repeated) {
          const length = uint(reader, LIMIT); if (length > reader.len - reader.pos) return fail();
          const values = (fields[name] ??= []) as Uint8Array[]; if (values.length >= 65536) return fail();
          values.push(new Uint8Array(bytes.subarray(reader.pos, reader.pos + length))); reader.pos += length; continue;
        }
        switch (field.kind) {
          case 'uint32': fields[name] = uint(reader, 0xffff_ffff); break;
          case 'uint53': fields[name] = uint(reader, Number.MAX_SAFE_INTEGER); break;
          case 'bool': { const value = uint(reader, 1); fields[name] = value === 1; break; }
          case 'double': fields[name] = reader.double(); break;
          case 'bytes': case 'string': {
            const length = uint(reader, LIMIT); if (length > reader.len - reader.pos) return fail();
            const data = bytes.subarray(reader.pos, reader.pos + length); reader.pos += length;
            fields[name] = field.kind === 'bytes' ? new Uint8Array(data) : new TextDecoder('utf-8', { fatal: true }).decode(data); break;
          }
        }
      }
    } catch { return fail(); }
    for (const [name, field] of Object.entries(this.schema)) if (field.required && !Object.hasOwn(fields, name)) return fail();
    return { fields, unknownFields };
  }
  encode(record: NativeRecord): Uint8Array {
    const writer = protobuf.Writer.create();
    for (const [name, field] of Object.entries(this.schema)) {
      if (!Object.hasOwn(record.fields, name)) { if (field.required) return fail(); continue; }
      const value = record.fields[name]!;
      if (field.repeated) {
        if (!Array.isArray(value) || value.length > 65536) return fail();
        for (const item of value) {
          if (!(item instanceof Uint8Array)) return fail(); writer.uint32((field.id << 3) | 2).bytes(item);
          if (writer.len > LIMIT) return fail();
        }
        continue;
      }
      writer.uint32((field.id << 3) | wire(field.kind));
      switch (field.kind) {
        case 'uint32': case 'uint53':
          if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > (field.kind === 'uint32' ? 0xffff_ffff : Number.MAX_SAFE_INTEGER)) return fail();
          if (field.kind === 'uint32') writer.uint32(value); else writer.uint64(value); break;
        case 'bool': if (typeof value !== 'boolean') return fail(); writer.bool(value); break;
        case 'double': if (typeof value !== 'number') return fail(); writer.double(value); break;
        case 'string': if (typeof value !== 'string') return fail(); writer.string(value); break;
        case 'bytes': if (!(value instanceof Uint8Array)) return fail(); writer.bytes(value); break;
      }
      if (writer.len > LIMIT) return fail();
    }
    for (const name of Object.keys(record.fields)) if (!Object.hasOwn(this.schema, name)) return fail();
    const known = writer.finish(); let length = known.length;
    for (const field of record.unknownFields) {
      if (!field.length || this.#ids.has(uint(protobuf.Reader.create(field), 0xffff_ffff) >>> 3)) return fail();
      length += field.length; if (length > LIMIT) return fail();
    }
    const result = new Uint8Array(length); result.set(known); let at = known.length;
    for (const field of record.unknownFields) { result.set(field, at); at += field.length; }
    const decoded = this.decode(result);
    const present = Object.keys(record.fields).filter(name => !this.schema[name]!.repeated || (record.fields[name] as Uint8Array[]).length);
    if (Object.keys(decoded.fields).length !== present.length) return fail();
    for (const name of present) if (this.schema[name]!.repeated &&
      (decoded.fields[name] as Uint8Array[]).length !== (record.fields[name] as Uint8Array[]).length) return fail();
    return result;
  }
}
