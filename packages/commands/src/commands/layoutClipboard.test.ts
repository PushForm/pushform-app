// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createAngularDimension, createLayoutDocument, createLinearDimension } from '@pushform/layout';
import { createLayoutRegistry } from './layout';

it('pastes a group centered on the active page, preserving geometry/styles with fresh IDs and one undo', () => {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
  const firstId = commands.execute('layout.shape.add', { pageId, points: [[0, 0], [20, 0]], handles: [{ out: [10, 0] }, {}] }) as number;
  const secondId = commands.execute('layout.shape.add', { pageId, points: [[40, 0], [60, 0]] }) as number;
  const source = () => doc.state.pages.get(pageId)!;
  const originals = [source().entities.get(firstId)!, source().entities.get(secondId)!];
  const ids = commands.execute('layout.clipboard.paste', { pageId, entities: originals }) as number[];
  expect(ids).toHaveLength(2); expect(ids).not.toContain(firstId); expect(ids).not.toContain(secondId);
  expect(source().entities.get(ids[0]!)?.points).toEqual([[118.5, 105], [138.5, 105]]);
  expect(source().entities.get(ids[1]!)?.points).toEqual([[158.5, 105], [178.5, 105]]);
  expect(source().entities.get(ids[0]!)?.handles?.[0]?.out).toEqual([128.5, 105]);
  expect(source().entities.get(ids[0]!)?.style).toEqual(originals[0]!.style);
  expect(source().entities.get(firstId)).toEqual(originals[0]);
  commands.execute('edit.undo'); expect(source().entities.size).toBe(2);
  commands.execute('edit.redo'); expect(source().entities.size).toBe(4);
});

it('preserves text rotation, image crop and independent dimension values', () => {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
  const text = { content: 'Styled', fontFamily: 'Arial', fontSizePt: 14, color: '#ff0000', bold: true, italic: false, underline: true,
    align: 'center', vertical: 'middle', bounded: true, rotationDeg: 30, leader: 'none', endpoint: 'none' };
  const entities = [
    { kind: 'text', points: [[0, 0], [20, 10]], closed: false, text },
    { kind: 'image', points: [[30, 0], [50, 0], [50, 10], [30, 10]], closed: true,
      image: { src: 'data:image/png;base64,aGVsbG8=', clip: { points: [[0, 0], [1, 0], [1, 1]] } } },
    { kind: 'dimension', points: [[0, 20], [20, 20], [10, 30]], closed: false,
      dimension: { ...createLinearDimension(), anchors: [{ entityId: 999, pointIndex: 0, pointCount: 2 }, null], cachedValueMm: 20 } },
    { kind: 'angular-dimension', points: [[40, 20], [50, 20], [40, 30], [45, 25]], closed: false,
      angularDimension: { ...createAngularDimension(), cachedAngleDeg: 90, edgeAnchors: [{ entityId: 999 }] } },
  ];
  const ids = commands.execute('layout.clipboard.paste', { pageId, entities }) as number[];
  const pasted = ids.map(id => doc.state.pages.get(pageId)!.entities.get(id)!);
  expect(pasted[0]!.text).toMatchObject(text);
  expect(pasted[1]!.image).toEqual(entities[1]!.image);
  expect(pasted[2]!.dimension).toMatchObject({ anchors: [null, null], cachedValueMm: 20, detached: false });
  expect(pasted[3]!.angularDimension).toMatchObject({ anchors: [null, null, null], cachedAngleDeg: 90, detached: false });
  expect(pasted[3]!.angularDimension?.edgeAnchors).toBeUndefined();
});

it('validates clipboard payloads and layer availability atomically', () => {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
  const image = { kind: 'image', points: [[0, 0], [10, 0], [10, 10], [0, 10]], closed: true, image: { src: 'https://example.com/image.png' } };
  const before = doc.state;
  expect(() => commands.execute('layout.clipboard.paste', { pageId, entities: [image] })).toThrow();
  expect(doc.state).toBe(before);
  const path = { kind: 'path', points: [[0, 0], [20, 10]], closed: false };
  commands.execute('layout.layer.setVisible', { layerId: doc.state.activeLayerId, visible: false });
  const locked = doc.state;
  expect(() => commands.execute('layout.clipboard.paste', { pageId, entities: [path] })).toThrow('unavailable');
  expect(doc.state).toBe(locked);
});

it('pastes at an explicit page position in one undoable edit', () => {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
  const [id] = commands.execute('layout.clipboard.paste', { pageId, position: [80, 50],
    entities: [{ kind: 'path', closed: true, points: [[10, 10], [30, 10], [30, 20], [10, 20]] }] }) as number[];
  expect(doc.state.pages.get(pageId)!.entities.get(id!)!.points).toEqual([[70, 45], [90, 45], [90, 55], [70, 55]]);
  commands.execute('edit.undo'); expect(doc.state.pages.get(pageId)!.entities.size).toBe(0);
});
