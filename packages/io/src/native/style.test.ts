// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';
import type { StyleId, ImageId } from '@pushform/core';
import { createDefaultStyle } from '@pushform/model';
import { describe, expect, it } from 'vitest';
import { decodeNativeStyle, encodeNativeStyle } from './style';
const root = protobuf.loadSync(fileURLToPath(new URL('./style.proto', import.meta.url))).resolveAll(), schema = root.lookupType('pushform.native.Style');
describe('native style adapter', () => {
  it('round trips real default styles, optional settings and ordered watermarks', () => {
    for (const quality of ['absent', undefined, 'faster', 'medium', 'nicer'] as const) for (const byTag of ['absent', undefined, false, true] as const) {
      const value = createDefaultStyle(1 as StyleId);
      if (quality !== 'absent') value.faces.transparencyQuality = quality;
      if (byTag !== 'absent') value.modeling.colorByTag = byTag;
      value.watermarks = [{ imageId: 3 as ImageId, position: 'overlay', opacity: 0.5 }, { imageId: 2 as ImageId, position: 'background', opacity: 1 }];
      const bytes = encodeNativeStyle(value), decoded = decodeNativeStyle(bytes);
      expect(decoded.value).toEqual(value);
      expect(Object.hasOwn(decoded.value.faces, 'transparencyQuality')).toBe(quality !== 'absent');
      expect(Object.hasOwn(decoded.value.modeling, 'colorByTag')).toBe(byTag !== 'absent');
      expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
    }
    const plain = createDefaultStyle(1 as StyleId); expect(decodeNativeStyle(encodeNativeStyle(plain)).value).toEqual(plain);
  });
  it('preserves unknown fields on repeated watermark records after an opacity edit', () => {
    const future = protobuf.Root.fromJSON(root.toJSON()); future.lookupType('pushform.native.Watermark').add(new protobuf.Field('extra', 90, 'bytes')); future.resolveAll();
    const newer = future.lookupType('pushform.native.Style'), value = createDefaultStyle(1 as StyleId);
    value.watermarks = [{ imageId: 2 as ImageId, position: 'overlay', opacity: 1 }];
    const wire = newer.decode(encodeNativeStyle(value)) as unknown as { watermarks: { extra: Uint8Array }[] };
    wire.watermarks[0]!.extra = new Uint8Array([7, 8]); const bytes = newer.encode(wire).finish(), decoded = decodeNativeStyle(bytes); bytes.fill(0);
    decoded.value.watermarks[0]!.opacity = 0.5;
    const restored = newer.decode(encodeNativeStyle(decoded.value, decoded.extensions)) as unknown as { watermarks: { opacity: number; extra: Uint8Array }[] };
    expect(restored.watermarks[0]!.opacity).toBe(0.5); expect(Array.from(restored.watermarks[0]!.extra)).toEqual([7, 8]);
  });
  it('rejects unsupported modes and malformed optional wrappers', () => {
    const wire = schema.decode(encodeNativeStyle(createDefaultStyle(1 as StyleId))) as unknown as { faces: { mode: number; transparencyQuality?: object } };
    wire.faces.mode = 99; expect(() => decodeNativeStyle(schema.encode(wire).finish())).toThrow();
    wire.faces.mode = 1; wire.faces.transparencyQuality = {}; expect(() => decodeNativeStyle(schema.encode(wire).finish())).toThrow();
  });
});
