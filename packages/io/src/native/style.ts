// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { StyleId } from '@pushform/core';
import type { Style, EdgeStyle, FaceStyle, BackgroundStyle, ModelingColors } from '@pushform/model';
import { NativeRecordCodec } from './record';
import type { NativeField, NativeFieldKind, NativeScalar } from './record';
import { NativeChunkError } from './chunks';
const f = (id: number, kind: NativeFieldKind, required = true): NativeField => ({ id, kind, required });
const root = new NativeRecordCodec({ id: f(1, 'uint32'), name: f(2, 'string'), description: f(3, 'string'), edges: f(4, 'bytes'), faces: f(5, 'bytes'), background: f(6, 'bytes'), modeling: f(7, 'bytes'),
  watermarks: { ...f(8, 'bytes', false), repeated: true } } satisfies Record<keyof Style, NativeField>);
const edges = new NativeRecordCodec({ edges: f(1, 'bool'), profiles: f(2, 'bool'), profileWidth: f(3, 'double'), depthCue: f(4, 'bool'), depthCueLevels: f(5, 'uint32'), extension: f(6, 'bool'),
  extensionLength: f(7, 'double'), endpoints: f(8, 'bool'), endpointLength: f(9, 'double'), jitter: f(10, 'bool'), backEdges: f(11, 'bool'), color: f(12, 'bytes'), colorMode: f(13, 'uint32') } satisfies Record<keyof EdgeStyle, NativeField>);
const faces = new NativeRecordCodec({ mode: f(1, 'uint32'), frontColor: f(2, 'bytes'), backColor: f(3, 'bytes'), xrayOpacity: f(4, 'double'), transparencyQuality: f(5, 'bytes', false) } satisfies Record<keyof FaceStyle, NativeField>);
const background = new NativeRecordCodec({ color: f(1, 'bytes'), sky: f(2, 'bool'), skyColor: f(3, 'bytes'), ground: f(4, 'bool'), groundColor: f(5, 'bytes'), groundTransparency: f(6, 'double'), showGroundFromBelow: f(7, 'bool') } satisfies Record<keyof BackgroundStyle, NativeField>);
const modeling = new NativeRecordCodec({ selected: f(1, 'bytes'), locked: f(2, 'bytes'), guides: f(3, 'bytes'), inactiveSection: f(4, 'bytes'), activeSection: f(5, 'bytes'), sectionFill: f(6, 'bytes'), sectionLine: f(7, 'bytes'), sectionLineWidth: f(8, 'double'), sectionFillEnabled: f(9, 'bool'), hiddenGeometry: f(10, 'bool'), guidesVisible: f(11, 'bool'), sectionPlanesVisible: f(12, 'bool'), sectionCutsVisible: f(13, 'bool'), modelAxesVisible: f(14, 'bool'), colorByTag: f(15, 'bytes', false) } satisfies Record<keyof ModelingColors, NativeField>);
const watermark = new NativeRecordCodec({ imageId: f(1, 'uint32'), position: f(2, 'uint32'), opacity: f(3, 'double') } satisfies Record<Exclude<keyof Style['watermarks'][number], 'nativeUnknownFields'>, NativeField>);
const rgb = new NativeRecordCodec({ red: f(1, 'double'), green: f(2, 'double'), blue: f(3, 'double') });
const optionalEnum = new NativeRecordCodec({ undefinedValue: f(1, 'bytes', false), value: f(3, 'uint32', false) });
const optionalBool = new NativeRecordCodec({ undefinedValue: f(1, 'bytes', false), value: f(3, 'bool', false) });
const empty = new NativeRecordCodec({});
export type StyleExtensions = Map<string, Uint8Array[]>;
const fail = (): never => { throw new NativeChunkError('Invalid native style'); };
const sections = {
  edges: { codec: edges, colors: ['color'] }, faces: { codec: faces, colors: ['frontColor', 'backColor'] },
  background: { codec: background, colors: ['color', 'skyColor', 'groundColor'] },
  modeling: { codec: modeling, colors: ['selected', 'locked', 'guides', 'inactiveSection', 'activeSection', 'sectionFill', 'sectionLine'] },
} as const;
const enums: Record<string, readonly string[]> = { 'edges.colorMode': ['allSame', 'byMaterial', 'byAxis'], 'faces.mode': ['wireframe', 'hiddenLine', 'shaded', 'shadedWithTextures', 'monochrome', 'xray'], 'faces.transparencyQuality': ['faster', 'medium', 'nicer'], position: ['background', 'overlay'] };
function code(path: string, value: unknown): number { const result = enums[path]!.indexOf(value as string); if (result < 0) return fail(); return result; }
function label(path: string, value: unknown): string { if (typeof value !== 'number' || !enums[path]![value]) return fail(); return enums[path]![value]!; }
function finiteFields(fields: Record<string, unknown>): void { for (const v of Object.values(fields)) if (typeof v === 'number' && !Number.isFinite(v)) fail(); }
function write(codec: NativeRecordCodec, fields: Record<string, NativeScalar>, path: string, ext: StyleExtensions): Uint8Array {
  finiteFields(fields); return codec.encode({ fields, unknownFields: ext.get(path) ?? [] });
}
function read(codec: NativeRecordCodec, bytes: Uint8Array, path: string, ext: StyleExtensions): Record<string, NativeScalar> {
  const result = codec.decode(bytes); finiteFields(result.fields); if (result.unknownFields.length) ext.set(path, result.unknownFields); return result.fields;
}
export function encodeNativeStyle(value: Style, ext: StyleExtensions = new Map()): Uint8Array {
  const fields: Record<string, NativeScalar> = { id: value.id, name: value.name, description: value.description };
  for (const key of Object.keys(sections) as (keyof typeof sections)[]) {
    const config = sections[key], source = value[key] as unknown as Record<string, unknown>, data = { ...source } as Record<string, NativeScalar>;
    for (const name of config.colors) {
      const c = source[name] as readonly number[]; if (c.length !== 3 || c.some(n => !Number.isFinite(n))) return fail();
      data[name] = write(rgb, { red: c[0]!, green: c[1]!, blue: c[2]! }, `${key}.${name}`, ext);
    }
    for (const name of ['mode', 'colorMode']) if (Object.hasOwn(data, name)) data[name] = code(`${key}.${name}`, source[name]);
    for (const name of ['transparencyQuality', 'colorByTag']) if (Object.hasOwn(source, name)) {
      const path = `${key}.${name}`, v = source[name];
      data[name] = write(name === 'colorByTag' ? optionalBool : optionalEnum, v === undefined
        ? { undefinedValue: write(empty, {}, `${path}.undefined`, ext) } : { value: name === 'colorByTag' ? v as boolean : code(path, v) }, path, ext);
    }
    fields[key] = write(config.codec, data, key, ext);
  }
  fields.watermarks = value.watermarks.map((v, i) => {
    const { nativeUnknownFields, ...known } = v;
    const fields = { ...known, position: code('position', v.position) }; finiteFields(fields);
    return watermark.encode({ fields, unknownFields: nativeUnknownFields ?? ext.get(`watermarks.${i}`) ?? [] });
  });
  return write(root, fields, '', ext);
}
export function decodeNativeStyle(bytes: Uint8Array): { value: Style; extensions: StyleExtensions } {
  const ext: StyleExtensions = new Map(), fields = read(root, bytes, '', ext), parts: Record<string, unknown> = {};
  for (const key of Object.keys(sections) as (keyof typeof sections)[]) {
    const config = sections[key], data: Record<string, unknown> = { ...read(config.codec, fields[key] as Uint8Array, key, ext) };
    for (const name of config.colors) { const c = read(rgb, data[name] as Uint8Array, `${key}.${name}`, ext); data[name] = [c.red, c.green, c.blue]; }
    for (const name of ['mode', 'colorMode']) if (Object.hasOwn(data, name)) data[name] = label(`${key}.${name}`, data[name]);
    for (const name of ['transparencyQuality', 'colorByTag']) if (Object.hasOwn(data, name)) {
      const path = `${key}.${name}`, wrapper = read(name === 'colorByTag' ? optionalBool : optionalEnum, data[name] as Uint8Array, path, ext);
      if (Object.keys(wrapper).length !== 1) return fail();
      if (Object.hasOwn(wrapper, 'undefinedValue')) { read(empty, wrapper.undefinedValue as Uint8Array, `${path}.undefined`, ext); data[name] = undefined; }
      else data[name] = name === 'colorByTag' ? wrapper.value : label(path, wrapper.value);
    }
    parts[key] = data;
  }
  const watermarks = ((fields.watermarks as Uint8Array[] | undefined) ?? []).map((bytes, i) => {
    const data = read(watermark, bytes, `watermarks.${i}`, ext); return { ...data, position: label('position', data.position) } as unknown as Style['watermarks'][number];
  });
  return { value: { id: fields.id as StyleId, name: fields.name as string, description: fields.description as string, ...parts, watermarks } as Style, extensions: ext };
}
