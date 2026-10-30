// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createLayoutDocument } from '@pushform/layout';
import { layoutContentIdentity } from './layoutIdentity';
import { encodeNativeLayoutFile, decodeNativeLayoutFile } from './layoutFile';

it('matches native save/open without retaining a JSON baseline', async () => {
  const doc = createLayoutDocument();
  doc.transact('fields', d => { d.customFields.set('a', 'one'); d.customFields.set('b', 'two'); });
  const saved = layoutContentIdentity(doc.state), bytes = await encodeNativeLayoutFile(doc.state);
  const restored = await decodeNativeLayoutFile({ size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) });
  expect(layoutContentIdentity(restored)).toBe(saved);
  expect(saved).toMatch(/^pf-layout-v1-sha256:[a-f0-9]{64}$/);
  expect(saved.length).toBe(84);
  doc.transact('bookkeeping', d => { d.meta.nextId += 100; d.customFields = new Map([...d.customFields].reverse()); });
  expect(layoutContentIdentity(doc.state)).toBe(saved);
});

it('tracks exact numbers, presence, asset strings and authored order', () => {
  const base = createLayoutDocument().state;
  const saved = layoutContentIdentity(base);
  for (const edit of [
    (d: typeof base) => { d.defaultStyle.fillColor = null; },
    (d: typeof base) => { Object.defineProperty(d, 'modelArchives', { value: undefined, enumerable: true }); },
    (d: typeof base) => { d.pages.get(d.pageOrder[0]!)!.margin.top = -0; },
    (d: typeof base) => { d.customFields.set('asset', 'data:large-string\ud800'); },
    (d: typeof base) => { d.pageOrder.push(d.pageOrder[0]!); },
  ]) {
    const state = structuredClone(base); edit(state);
    expect(layoutContentIdentity(state)).not.toBe(saved);
  }
});

it('restores the saved identity after undo despite allocator advancement', () => {
  const doc = createLayoutDocument(), saved = layoutContentIdentity(doc.state);
  const tx = doc.transact('edit', d => { d.meta.nextId += 10; d.pages.get(d.pageOrder[0]!)!.name = 'Changed'; });
  expect(layoutContentIdentity(doc.state)).not.toBe(saved);
  doc.applyPatches(tx.inversePatches, tx.patches, 'undo', 'edit');
  expect(layoutContentIdentity(doc.state)).toBe(saved);
});
