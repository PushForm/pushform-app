// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createDocument, DEFAULT_FOG } from './Document';

const fields = [new Uint8Array([0xa2, 0x06, 0])];

it('drops obsolete optional branches, keeps wrapper fields, and restores them on undo', () => {
  const doc = createDocument();
  doc.transact('fixture', d => {
    d.fog = undefined; d.meta.dimensions = undefined;
    d.nativeSettingsUnknownFields = {
      records: new Map([['fog', fields], ['fog.undefined', fields]]),
      meta: new Map([['dimensions', fields], ['dimensions.undefined', fields]]), shadows: new Map(),
    };
  });
  const before = doc.state;
  const edit = doc.transact('settings', d => {
    d.fog = { ...DEFAULT_FOG, color: [...DEFAULT_FOG.color] }; d.meta.dimensions = { fontSizePt: 12, arrow: 'closed', align: 'screen' };
  });
  expect([...doc.state.nativeSettingsUnknownFields!.records.keys()]).toEqual(['fog']);
  expect([...doc.state.nativeSettingsUnknownFields!.meta.keys()]).toEqual(['dimensions']);
  doc.applyPatches(edit.inversePatches, edit.patches, 'undo', 'settings');
  expect(doc.state).toEqual(before);
  doc.transact('delete', d => { delete d.fog; delete d.meta.dimensions; });
  expect(doc.state.nativeSettingsUnknownFields).toBeUndefined();
});

it('reconciles only the final outer transaction and leaves failed transactions untouched', () => {
  const doc = createDocument();
  doc.transact('fixture', d => {
    d.fog = { ...DEFAULT_FOG, color: [...DEFAULT_FOG.color] };
    d.nativeSettingsUnknownFields = { records: new Map(), meta: new Map(), shadows: new Map(), fog: new Map([['', fields]]) };
  });
  const before = doc.state;
  doc.transact('outer', d => {
    doc.transact('nested', nested => { delete nested.fog; });
    d.fog = { ...DEFAULT_FOG, color: [...DEFAULT_FOG.color] };
  });
  expect(doc.state.nativeSettingsUnknownFields).toBe(before.nativeSettingsUnknownFields);
  const unchanged = doc.state;
  expect(() => doc.transact('failed', d => { delete d.fog; throw new Error('abort'); })).toThrow('abort');
  expect(doc.state).toBe(unchanged);
  expect(doc.transact('no-op', () => {}).patches).toEqual([]);
});
