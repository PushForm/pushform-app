// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';
import type { CurveId, Id } from '@pushform/core';
import type { Curve } from '@pushform/model';
import { describe, expect, it } from 'vitest';
import { streamNativeSketchCurves, readNativeSketchCurves, validateNativeSketchCurveEdges, encodeNativeSketchCurvesReference, decodeNativeSketchCurvesReference } from './sketchCurves';
import type { NativeSketchCurvesReference } from './sketchCurves';
import { NativeColumnReader, NativeColumnBudget } from './columns';
import { encodeNativeChunks } from './chunks';
import { describeNativeChunk } from './chunkDescriptor';
import { writeNativeContainer, openNativeContainer } from './container';
const schema = protobuf.parse(readFileSync(new URL('./sketchCurves.proto', import.meta.url), 'utf8')).root.lookupType('pushform.native.SketchCurves');
function fixture(): Map<CurveId, Curve> {
  return new Map((['arc', 'circle', 'polygon', 'freehand'] as const).map((kind, i) => {
    const id = (3 - i) as CurveId;
    return [id, { id, kind, center: [1e10, -0, 3], normal: [0, 0, 1], radius: 2, startAngle: -0, endAngle: Math.PI,
      segments: i === 3 ? 0 : i + 3, edgeRefs: i === 3 ? [] : [3, 1, 3] as Id[] }];
  }));
}
async function stored(curves = fixture()) {
  let id = 1, ref: NativeSketchCurvesReference | undefined;
  async function* records() {
    ref = yield* streamNativeSketchCurves(curves, () => id++, { pageBytes: 32 });
    for await (const chunk of encodeNativeChunks([encodeNativeSketchCurvesReference(ref)])) yield { descriptor: describeNativeChunk(0xffff_ffff, 1, 1, true, chunk), data: chunk.data };
  }
  const parts: Uint8Array[] = [], result = await writeNativeContainer({ kind: 1, root: 0xffff_ffff }, records(), { write: async bytes => { parts.push(bytes.slice()); } });
  const bytes = new Uint8Array(result.storedBytes); let at = 0; for (const part of parts) { bytes.set(part, at); at += part.length; }
  const opened = await openNativeContainer({ size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) }, () => true);
  return { opened, ref: ref!, curves };
}
describe('packed sketch curves', () => {
  it('preserves every curve kind, exact parameters, source order and repeated edge references', async () => {
    const { opened, ref, curves } = await stored(), budget = new NativeColumnBudget(380);
    const packed = await readNativeSketchCurves(ref, new NativeColumnReader(opened, budget));
    expect(budget.usedBytes).toBe(380); expect(packed.ids).toEqual(new Uint32Array([3, 2, 1, 0]));
    expect(packed.kinds).toEqual(new Uint8Array([0, 1, 2, 3])); expect(packed.offsets).toEqual(new Uint32Array([0, 3, 6, 9, 9]));
    let row = 0; for (const curve of curves.values()) {
      expect(Array.from(packed.geometry.subarray(row * 9, row * 9 + 9))).toEqual([...curve.center, ...curve.normal, curve.radius, curve.startAngle, curve.endAngle]);
      expect(packed.segments[row]).toBe(curve.segments);
      expect(Array.from(packed.edgeIds.subarray(packed.offsets[row], packed.offsets[row + 1]))).toEqual(curve.edgeRefs); row++;
    }
    expect(() => validateNativeSketchCurveEdges(packed, id => id === 1 || id === 3)).not.toThrow();
    expect(() => validateNativeSketchCurveEdges(packed, () => false)).toThrow();
    const bytes = encodeNativeSketchCurvesReference(ref); expect(decodeNativeSketchCurvesReference(bytes)).toEqual(ref);
    expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
    ref.unknownFields.push(new Uint8Array([0x98, 6, 7])); expect(decodeNativeSketchCurvesReference(encodeNativeSketchCurvesReference(ref))).toEqual(ref);
  });
  it('rejects unsupported kind codes and descending decoded offsets', async () => {
    const { opened, ref } = await stored();
    for (const column of ['kinds', 'offsets'] as const) {
      const reader = new NativeColumnReader({ entries: opened.entries, read: async entry => {
        const bytes = await opened.read(entry);
        if (entry.descriptor.id === ref.columns[column][0]) {
          if (column === 'kinds') bytes[0] = 4; else new DataView(bytes.buffer, bytes.byteOffset).setUint32(4, 9, true);
        }
        return bytes;
      } }, new NativeColumnBudget());
      await expect(readNativeSketchCurves(ref, reader)).rejects.toThrow();
    }
  });
  it('rejects body edge keys in sketch curves and supports empty tables', async () => {
    const curves = fixture(); curves.get(3 as CurveId)!.edgeRefs = ['1:2:0']; await expect(stored(curves)).rejects.toThrow();
    const { opened, ref } = await stored(new Map()), budget = new NativeColumnBudget(4), packed = await readNativeSketchCurves(ref, new NativeColumnReader(opened, budget));
    expect(packed.offsets).toEqual(new Uint32Array([0])); expect(packed.ids.length).toBe(0); expect(budget.usedBytes).toBe(4);
  });
});
