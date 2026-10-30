// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';
import { expect, it } from 'vitest';
import { createLayoutTable } from '@pushform/layout';
import { encodeNativeLayoutTableHeader, decodeNativeLayoutTableHeader, encodeNativeLayoutTableCell, decodeNativeLayoutTableCell, assembleNativeLayoutTable, streamNativeLayoutTableRecords } from './layoutTable';
const root = protobuf.parse(readFileSync(new URL('./layoutTable.proto', import.meta.url), 'utf8')).root;
const headerSchema = root.lookupType('pushform.native.LayoutTableHeader'), cellSchema = root.lookupType('pushform.native.LayoutTableCell');
function fixture() {
  const value = createLayoutTable(2, 2); value.rows = [1.25, 2.75]; value.columns = [2, 1];
  value.merges = [{ row: 0, column: 0, rowSpan: 1, columnSpan: 2 }];
  value.rowEdges = [{ strokeColor: '#123456', strokeWeightPt: 1.5, strokeDashMm: [-0, 2.5] }];
  value.columnEdges = [{ strokeColor: 'transparent', strokeWeightPt: 2, strokeDashMm: [] }];
  value.cells[0]!.text.content = 'Merged heading'; value.cells[1]!.text.content = 'Retained covered text';
  value.cells[2]!.fillColor = null; value.cells[3]!.fillColor = ''; value.cells[3]!.rotationDeg = 270;
  return value;
}
it('preserves merged and covered cells, line styles and the published Protobuf layout', () => {
  const source = fixture(), { cells, ...header } = source;
  const hb = encodeNativeLayoutTableHeader(header);
  expect(Array.from(headerSchema.encode(headerSchema.decode(hb)).finish())).toEqual(Array.from(hb));
  const records = cells.map((cell, index) => {
    const bytes = encodeNativeLayoutTableCell(index, cell);
    expect(Array.from(cellSchema.encode(cellSchema.decode(bytes)).finish())).toEqual(Array.from(bytes));
    return decodeNativeLayoutTableCell(bytes);
  });
  const next = assembleNativeLayoutTable(decodeNativeLayoutTableHeader(hb).value, records);
  expect(next.value).toEqual(source); expect(next.cellExtensions.size).toBe(0);
  expect(Object.is(next.value.rowEdges![0]!.strokeDashMm![0], -0)).toBe(true);
});
it('preserves absent, undefined and empty optional values without defaulting', () => {
  for (const state of ['absent', 'undefined', 'empty']) {
    const { cells, ...header } = createLayoutTable(1, 1), c = cells[0]!;
    if (state !== 'absent') {
      Object.defineProperty(header, 'rowEdges', { value: state === 'undefined' ? undefined : [], enumerable: true });
      Object.defineProperty(c, 'fillColor', { value: state === 'undefined' ? undefined : '', enumerable: true });
      Object.defineProperty(c, 'rotationDeg', { value: state === 'undefined' ? undefined : 90, enumerable: true });
    }
    const nextHeader = decodeNativeLayoutTableHeader(encodeNativeLayoutTableHeader(header)).value;
    const nextCell = decodeNativeLayoutTableCell(encodeNativeLayoutTableCell(0, c)).value;
    expect(nextHeader).toEqual(header); expect(nextCell).toEqual(c);
    expect(Object.hasOwn(nextHeader, 'rowEdges')).toBe(state !== 'absent');
    expect(Object.hasOwn(nextCell, 'rotationDeg')).toBe(state !== 'absent');
  }
});
it('owns extension bytes and retains cell and nested text sidecars through assembly', () => {
  const { cells, ...header } = fixture(), fields = [new Uint8Array([0x98, 6, 7])];
  const he = new Map(['', 'merges/0', 'rowEdges', 'rowEdges/0'].map(k => [k, fields]));
  const ce = new Map([['', fields], ['fillColor', fields]]), te = new Map([['', fields]]);
  const hb = encodeNativeLayoutTableHeader(header, he), hd = decodeNativeLayoutTableHeader(hb); hb.fill(0);
  const records = cells.map((cell, i) => {
    const bytes = encodeNativeLayoutTableCell(i, cell, i === 2 ? ce : new Map(), i === 2 ? te : new Map());
    const record = decodeNativeLayoutTableCell(bytes); bytes.fill(0); return record;
  });
  const assembled = assembleNativeLayoutTable(hd.value, records);
  assembled.value.cells[2]!.text.content = 'Updated';
  const ext = assembled.cellExtensions.get(2)!;
  const next = decodeNativeLayoutTableCell(encodeNativeLayoutTableCell(2, assembled.value.cells[2]!, ext.extensions, ext.textExtensions));
  expect(next.extensions).toEqual(ce); expect(next.textExtensions).toEqual(te);
  expect(decodeNativeLayoutTableHeader(encodeNativeLayoutTableHeader(hd.value, hd.extensions)).extensions).toEqual(he);
});
it('streams 10,000 cells exceeding a single metadata record without a whole-table encoding', () => {
  const source = createLayoutTable(100, 100); let largest = 0, total = 0;
  for (const cell of source.cells) cell.text.content = 'A'.repeat(200);
  const stream = streamNativeLayoutTableRecords(source), first = stream.next();
  expect(first.done).toBe(false); expect(first.value!.kind).toBe('header');
  const header = decodeNativeLayoutTableHeader(first.value!.bytes).value;
  function* records() {
    for (const { kind, bytes } of stream) {
      expect(kind).toBe('cell'); largest = Math.max(largest, bytes.length); total += bytes.length;
      yield decodeNativeLayoutTableCell(bytes);
    }
  }
  const next = assembleNativeLayoutTable(header, records());
  expect(next.value).toEqual(source); expect(total).toBeGreaterThan(1024 * 1024); expect(largest).toBeLessThan(512);
});
it('stops cell serialization when cancelled between records', () => {
  const controller = new AbortController(), stream = streamNativeLayoutTableRecords(fixture(), undefined, controller.signal);
  expect(stream.next().value!.kind).toBe('header'); controller.abort(); expect(() => stream.next()).toThrow();
});
it('rejects invalid dimensions, merges, cell ownership, styles and ambiguous wrappers', () => {
  const { cells, ...header } = fixture();
  for (const patch of [{ rows: [0, 1] }, { rows: new Array(2) }, { merges: [...header.merges, ...header.merges] },
    { rowEdges: [] }, { rowEdges: [{ strokeColor: '#000', strokeWeightPt: Infinity }] }]) {
    expect(() => encodeNativeLayoutTableHeader({ ...header, ...patch })).toThrow();
  }
  const records = cells.map((cell, i) => decodeNativeLayoutTableCell(encodeNativeLayoutTableCell(i, cell)));
  expect(() => assembleNativeLayoutTable(header, records.slice(1))).toThrow();
  expect(() => assembleNativeLayoutTable(header, records.slice(0, 3))).toThrow();
  expect(() => assembleNativeLayoutTable(header, [...records, records[0]!])).toThrow();
  const base = cellSchema.toObject(cellSchema.decode(encodeNativeLayoutTableCell(0, cells[0]!)));
  for (const patch of [{ rotation: 4 }, { index: 10000 }, { fillColor: { state: 0, value: '' } }, { fillColor: { state: 2 } }]) {
    expect(() => decodeNativeLayoutTableCell(cellSchema.encode({ ...base, ...patch }).finish())).toThrow();
  }
});
