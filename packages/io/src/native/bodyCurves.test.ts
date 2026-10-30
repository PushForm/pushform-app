// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';
import type { CurveId, Id } from '@pushform/core';
import type { Curve, EdgeKey } from '@pushform/model';
import { describe, expect, it } from 'vitest';
import { streamNativeBodyCurves, readNativeBodyCurves, validateNativeBodyCurveEdges, encodeNativeBodyCurvesReference, decodeNativeBodyCurvesReference } from './bodyCurves';
import type { NativeBodyCurvesReference } from './bodyCurves';
import { NativeEdgeIndex, parseNativeEdgeKey } from './edgeKey';
import { NativeColumnReader, NativeColumnBudget } from './columns';
import { encodeNativeChunks } from './chunks';
import { describeNativeChunk } from './chunkDescriptor';
import { writeNativeContainer, openNativeContainer } from './container';
const schema = protobuf.parse(readFileSync(new URL('./bodyCurves.proto', import.meta.url), 'utf8')).root.lookupType('pushform.native.BodyCurves');
function fixture(): Map<CurveId, Curve> {
  return new Map((['arc', 'circle', 'polygon', 'freehand'] as const).map((kind, i) => {
    const id = (3 - i) as CurveId;
    return [id, { id, kind, center: [1e10, -0, 3], normal: [0, 0, 1], radius: 2, startAngle: -0, endAngle: Math.PI,
      segments: i === 3 ? 0 : i + 3, edgeRefs: i === 3 ? [] : ['1:3:2', '0:1:0', '1:3:2'] }];
  }));
}
async function stored(curves = fixture()) {
  let id = 1, ref: NativeBodyCurvesReference | undefined;
  async function* records() {
    ref = yield* streamNativeBodyCurves(curves, () => id++, { pageBytes: 32 });
    for await (const chunk of encodeNativeChunks([encodeNativeBodyCurvesReference(ref)])) yield { descriptor: describeNativeChunk(0xffff_ffff, 1, 1, true, chunk), data: chunk.data };
  }
  const parts: Uint8Array[] = [], result = await writeNativeContainer({ kind: 1, root: 0xffff_ffff }, records(), { write: async bytes => { parts.push(bytes.slice()); } });
  const bytes = new Uint8Array(result.storedBytes); let at = 0; for (const part of parts) { bytes.set(part, at); at += part.length; }
  const opened = await openNativeContainer({ size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) }, () => true);
  return { opened, ref: ref!, curves };
}
describe('packed body curves', () => {
  it('preserves every curve kind, exact parameters, source order and repeated edge references', async () => {
    const { opened, ref, curves } = await stored(), budget = new NativeColumnBudget(452);
    const packed = await readNativeBodyCurves(ref, new NativeColumnReader(opened, budget));
    expect(budget.usedBytes).toBe(452); expect(packed.ids).toEqual(new Uint32Array([3, 2, 1, 0]));
    expect(packed.kinds).toEqual(new Uint8Array([0, 1, 2, 3])); expect(packed.offsets).toEqual(new Uint32Array([0, 3, 6, 9, 9]));
    let row = 0; for (const curve of curves.values()) {
      expect(Array.from(packed.geometry.subarray(row * 9, row * 9 + 9))).toEqual([...curve.center, ...curve.normal, curve.radius, curve.startAngle, curve.endAngle]);
      expect(packed.segments[row]).toBe(curve.segments);
      expect(Array.from(packed.edgeKeys.subarray(packed.offsets[row]! * 3, packed.offsets[row + 1]! * 3))).toEqual(curve.edgeRefs.flatMap(ref => parseNativeEdgeKey(ref as EdgeKey))); row++;
    }
    expect(() => validateNativeBodyCurveEdges(packed, new NativeEdgeIndex(new Uint32Array([1, 3, 2, 0, 0, 0, 1, 0, 0, 0]), new NativeColumnBudget()))).not.toThrow();
    expect(() => validateNativeBodyCurveEdges(packed, new NativeEdgeIndex(new Uint32Array(), new NativeColumnBudget()))).toThrow();
    const bytes = encodeNativeBodyCurvesReference(ref); expect(decodeNativeBodyCurvesReference(bytes)).toEqual(ref);
    expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
    ref.unknownFields.push(new Uint8Array([0x98, 6, 7])); expect(decodeNativeBodyCurvesReference(encodeNativeBodyCurvesReference(ref))).toEqual(ref);
  });
  it('rejects unsupported kind codes and descending decoded offsets', async () => {
    const { opened, ref } = await stored();
    for (const column of ['kinds', 'offsets', 'edgeKeys'] as const) {
      const reader = new NativeColumnReader({ entries: opened.entries, read: async entry => {
        const bytes = await opened.read(entry);
        if (entry.descriptor.id === ref.columns[column][0]) {
          if (column === 'kinds') bytes[0] = 4;
          else new DataView(bytes.buffer, bytes.byteOffset).setUint32(4, column === 'offsets' ? 9 : 1, true);
        }
        return bytes;
      } }, new NativeColumnBudget());
      await expect(readNativeBodyCurves(ref, reader)).rejects.toThrow();
    }
  });
  it('rejects numeric edge IDs in body curves and supports empty tables', async () => {
    const curves = fixture(); curves.get(3 as CurveId)!.edgeRefs = [1 as Id]; await expect(stored(curves)).rejects.toThrow();
    const { opened, ref } = await stored(new Map()), budget = new NativeColumnBudget(4), packed = await readNativeBodyCurves(ref, new NativeColumnReader(opened, budget));
    expect(packed.offsets).toEqual(new Uint32Array([0])); expect(packed.ids.length).toBe(0); expect(budget.usedBytes).toBe(4);
  });
});
