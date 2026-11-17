// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createScaleDrawingState } from '@pushform/layout';
import { writeNativeLayout } from './layoutWriter';
import { readNativeLayout } from './layoutReader';
import { nativeLayoutState } from './layoutState';
import { layoutContentIdentity } from './layoutIdentity';

it('preserves Drawing mode and linked view placement through a native round trip', async () => {
  const state = createScaleDrawingState(), page = state.pages.get(state.pageOrder[0]!)!;
  state.meta.nextId = 6;
  page.entities.set(4, { id: 4, kind: 'path', layerId: 1, groupId: 3, locked: true, closed: false, points: [[10, 20], [130, 20]],
    drawingView: { sourceGuid: 'source-guid', sourceName: 'Studio', sourcePageId: 2, denominator: 50, x: 10, y: 20, rotation: 0 } });
  page.entityOrder.push(4);
  const parts: Uint8Array[] = [];
  await writeNativeLayout(state, { write: async bytes => { parts.push(bytes.slice()); } });
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0;
  for (const part of parts) { bytes.set(part, at); at += part.length; }
  const packed = await readNativeLayout({ size: bytes.length, read: async (at, length) => bytes.subarray(at, at + length) });
  const reopened = nativeLayoutState(packed);
  expect(reopened.settings.drawing).toBe(true);
  expect(reopened.pages.get(page.id)!.entities.get(4)?.drawingView).toEqual(page.entities.get(4)!.drawingView);
  expect(layoutContentIdentity(reopened)).toBe(layoutContentIdentity(state));
  const changed = createScaleDrawingState();
  const before = layoutContentIdentity(changed); delete changed.settings.drawing;
  expect(layoutContentIdentity(changed)).not.toBe(before);
});
