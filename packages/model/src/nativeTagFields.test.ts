// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createDocument } from './Document';

it('removes empty tag payload sidecars without losing an optional envelope flag', () => {
  const doc = createDocument(), id = doc.state.defaultTagId;
  doc.transact('future tag', d => {
    d.tags.get(id)!.dashes = null;
    d.nativeTagUnknownFields = {
      tags: new Map([[id, { required: false, extensions: new Map([['dashes.null', [new Uint8Array([0xa0, 6, 1])]]]) }]]),
      folders: new Map(),
    };
  });
  const before = doc.state;
  const change = doc.transact('dash', d => { d.tags.get(id)!.dashes = 'dash'; });
  expect(doc.state.nativeTagUnknownFields!.tags.get(id)).toEqual({ required: false });
  expect(doc.transact('no-op', () => {}).patches).toEqual([]);
  doc.applyPatches(change.inversePatches, change.patches, 'undo', 'dash');
  expect(doc.state).toEqual(before);
});
