// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import { createAngularDimension, createLayoutDocument, createLayoutOffset, createLinearDimension } from '@pushform/layout';
import { decodeLayoutDocument, encodeLayoutDocument, layoutJson, parseLayoutManifest } from './layoutFile';

describe('.pfl file', () => {
  it('retains detached model identities and last measurements, and rejects malformed attachments', () => {
    const doc = createLayoutDocument(), pageId = doc.state.pageOrder[0]!;
    doc.undoStack.transact('Model dimension', draft => {
      const page = draft.pages.get(pageId)!, id = draft.meta.nextId++;
      page.entities.set(id, { id, kind: 'dimension', layerId: draft.activeLayerId, closed: false,
        points: [[0, 0], [40, 0], [0, 20]], dimension: { ...createLinearDimension(), cachedValueMm: 2000, detached: true },
        modelAnnotation: { status: 'detached', attachments: [100, 101].map(vertexId => ({ viewportId: 999,
          source: { referenceId: 7 }, modelGuid: 'original-model', anchor: { kind: 'sketchVertex', path: [], id: vertexId as never } })) } });
      page.entityOrder.push(id);
    });
    const reopened = decodeLayoutDocument(encodeLayoutDocument(doc));
    const entity = [...reopened.state.pages.get(pageId)!.entities.values()][0]!;
    expect(entity.modelAnnotation).toEqual([...doc.state.pages.get(pageId)!.entities.values()][0]!.modelAnnotation);
    expect(entity.dimension).toMatchObject({ cachedValueMm: 2000, detached: true });
    const json = layoutJson(doc.state);
    expect(() => parseLayoutManifest(json.replace('"viewportId":999', '"viewportId":-1'))).toThrow('invalid state');
    expect(() => parseLayoutManifest(json.replace('"modelGuid":"original-model"', '"modelGuid":null'))).toThrow('invalid state');
    expect(() => parseLayoutManifest(json.replace('"path":[]', '"path":["wrong"]'))).toThrow('invalid state');
  });
  it('rejects malformed preserved model archive records before installing a document', () => {
    const doc = createLayoutDocument();
    doc.undoStack.transact('Preservation fixture', draft => {
      draft.modelArchives = new Map([['archive', { format: 'sketchup-layout', archiveBase64: 'UEs=',
        models: new Map([['model', { internalTarget: 'ref/model.skp', externalTarget: null }]]),
        viewports: new Map([['viewport', { modelReferenceId: 'model', entityIds: [3] }]]) }]]);
    });
    const valid = layoutJson(doc.state);
    expect(parseLayoutManifest(valid).modelArchives?.size).toBe(1);
    expect(() => parseLayoutManifest(valid.replace('UEs=', 'not base64!'))).toThrow('invalid state');
    expect(() => parseLayoutManifest(valid.replace('"entityIds":[3]', '"entityIds":[-1]'))).toThrow('invalid state');
    expect(() => parseLayoutManifest(valid.replace('"internalTarget":"ref/model.skp"', '"internalTarget":42'))).toThrow('invalid state');
  });
  it('saves and reopens page-number fields, rejecting malformed ones', () => {
    const doc = createLayoutDocument();
    doc.undoStack.transact('Numbering fixture', draft => {
      draft.pageNumberFields = new Map([['PageNumber', { startPageId: draft.pageOrder[0]!, startNumber: 0, style: 'upper-roman' }]]);
    });
    const json = layoutJson(doc.state);
    expect([...parseLayoutManifest(json).pageNumberFields!]).toEqual([['PageNumber', { startPageId: doc.state.pageOrder[0], startNumber: 0, style: 'upper-roman' }]]);
    expect([...decodeLayoutDocument(encodeLayoutDocument(doc)).state.pageNumberFields!.keys()]).toEqual(['PageNumber']);
    expect(() => parseLayoutManifest(json.replace('"upper-roman"', '"cursive"'))).toThrow('invalid state');
    expect(() => parseLayoutManifest(json.replace('"startNumber":0', '"startNumber":1.5'))).toThrow('invalid state');
  });
  it('offsets the original OffsetTest.pfl paths beyond their tiny rounded corners', () => {
    const bytes = readFileSync(new URL('../../testing/assets/layout/OffsetTest.pfl', import.meta.url));
    const doc = decodeLayoutDocument(bytes);
    const before = layoutJson(doc.state);
    const page = doc.state.pages.get(doc.state.pageOrder[0]!)!;
    expect(doc.state.pageOrder).toHaveLength(2);
    expect(page.entityOrder).toEqual([4, 19]);
    for (const id of [4, 19]) {
      const source = page.entities.get(id)!;
      expect(source.points).toHaveLength(36);
      for (const shape of [source, { ...source, points: [...source.points].reverse() }]) {
        const inset = createLayoutOffset(shape, -11);
        expect(inset.closed).toBe(true);
        expect(inset.points).toHaveLength(4);
        for (const axis of [0, 1] as const) {
          expect(Math.min(...inset.points.map(p => p[axis])))
            .toBeCloseTo(Math.min(...source.points.map(p => p[axis])) + 11, 6);
          expect(Math.max(...inset.points.map(p => p[axis])))
            .toBeCloseTo(Math.max(...source.points.map(p => p[axis])) - 11, 6);
        }
        expect(createLayoutOffset(shape, 11).closed).toBe(true);
        expect(() => createLayoutOffset(shape, -60)).toThrow('collapses');
      }
    }
    expect(layoutJson(doc.state)).toBe(before);
  });

  it('round-trips pages, layers, and path geometry in a zip archive', () => {
    const doc = createLayoutDocument();
    const pageId = doc.addPage('Detail');
    doc.undoStack.transact('Draw', (draft) => {
      const page = draft.pages.get(pageId)!;
      page.entities.set(4, {
        id: 4,
        kind: 'path',
        layerId: draft.activeLayerId,
        points: [
          [10, 15],
          [110, 15],
        ],
        closed: false,
        style: { strokeColor: '#123456', strokeWeightPt: 0.5, strokeDashMm: [4, 2, 1, 2], fillColor: null },
      });
      page.entityOrder.push(4);
      draft.meta.nextId = 5;
    });
    const copy = decodeLayoutDocument(encodeLayoutDocument(doc));
    expect(layoutJson(copy.state)).toBe(layoutJson(doc.state));
    expect(copy.state.pages.get(pageId)?.entities.get(4)?.points).toEqual([
      [10, 15],
      [110, 15],
    ]);
  });

  it('rejects invalid archives without creating a document', () => {
    expect(() => decodeLayoutDocument(new Uint8Array([1, 2, 3]))).toThrow('Invalid .pfl archive');
  });

  it('accepts solid strokes and rejects malformed dash patterns', () => {
    const doc = createLayoutDocument(), pageId = doc.state.pageOrder[0]!;
    for (const pattern of [undefined, [], [4, 2], [4], [4, -2], [0, 2], [Infinity, 2]]) {
      doc.undoStack.transact('Dash fixture', draft => {
        const page = draft.pages.get(pageId)!;
        page.entities.set(3, { id: 3, kind: 'path', layerId: draft.activeLayerId,
          points: [[0, 0], [100, 0]], closed: false,
          style: { strokeColor: '#000000', strokeWeightPt: 1, fillColor: null,
            ...(pattern ? { strokeDashMm: pattern } : {}) } });
        page.entityOrder = [3]; draft.meta.nextId = 4;
      });
      const read = () => decodeLayoutDocument(encodeLayoutDocument(doc));
      if (pattern === undefined || pattern.length === 0 || pattern[0] === 4 && pattern[1] === 2) expect(read).not.toThrow();
      else expect(read).toThrow('invalid state');
    }
  });

  it('keeps a compound path\'s open contours and rejects ones that name no contour', () => {
    const doc = createLayoutDocument(), pageId = doc.state.pageOrder[0]!;
    for (const [contourStarts, openContours, valid] of [[[0, 4], [1], true], [[0, 4], [2], false], [undefined, [0], false], [[0, 4], [1, 0], false]] as const) {
      doc.undoStack.transact('Contour fixture', draft => {
        const page = draft.pages.get(pageId)!;
        page.entities.set(3, { id: 3, kind: 'path', layerId: draft.activeLayerId, closed: true,
          points: [[0, 0], [40, 0], [40, 40], [0, 40], [10, 10], [30, 10]],
          ...(contourStarts ? { contourStarts: [...contourStarts] } : {}), openContours: [...openContours] });
        page.entityOrder = [3]; draft.meta.nextId = 4;
      });
      const read = () => decodeLayoutDocument(encodeLayoutDocument(doc));
      if (valid) expect(read().state.pages.get(pageId)!.entities.get(3)!.openContours).toEqual([1]);
      else expect(read).toThrow('invalid state');
    }
  });

  it('rejects unsupported versions and inconsistent state versions', () => {
    const state = JSON.parse(layoutJson(createLayoutDocument().state)) as {
      format: string; version: number; state: { meta: { formatVersion: number } };
    };
    const archive = () => zipSync({ 'layout.json': strToU8(JSON.stringify(state)) });
    state.version = 2;
    expect(() => decodeLayoutDocument(archive())).toThrow('Unsupported Layout version: 2');
    state.version = 0;
    expect(() => decodeLayoutDocument(archive())).toThrow('Unsupported Layout version: 0');
    state.version = 1;
    state.state.meta.formatVersion = 2;
    expect(() => decodeLayoutDocument(archive())).toThrow('version does not match its manifest');
  });
});

it('round-trips detached dimension caches and rejects invalid numeric styles', () => {
  const doc = createLayoutDocument();
  const pageId = doc.state.pageOrder[0]!;
  doc.undoStack.transact('Dimension fixture', (draft) => {
    const page = draft.pages.get(pageId)!;
    page.entities.set(3, { id: 3, kind: 'dimension', layerId: draft.activeLayerId,
      points: [[0, 0], [100, 0], [50, 10]], closed: false,
      dimension: { ...createLinearDimension(), cachedValueMm: 100, detached: true,
        anchors: [{ entityId: 99, pointIndex: 0, pointCount: 2 }, null] } });
    page.entityOrder.push(3); draft.meta.nextId = 4;
  });
  const reopened = decodeLayoutDocument(encodeLayoutDocument(doc));
  expect(reopened.state.pages.get(pageId)!.entities.get(3)!.dimension).toMatchObject({ cachedValueMm: 100, detached: true });
  doc.undoStack.transact('Invalid fixture', (draft) => { draft.pages.get(pageId)!.entities.get(3)!.dimension!.precision = 99; });
  expect(() => decodeLayoutDocument(encodeLayoutDocument(doc))).toThrow('invalid state');
});

it('round-trips dimension scale and length formats and rejects invalid ones', () => {
  const doc = createLayoutDocument();
  const pageId = doc.state.pageOrder[0]!;
  const style = { format: 'architectural', units: 'inch', precision: 4, scale: 1 / 48, showDashes: false } as const;
  doc.undoStack.transact('Dimension fixture', (draft) => {
    const page = draft.pages.get(pageId)!;
    page.entities.set(3, { id: 3, kind: 'dimension', layerId: draft.activeLayerId, points: [[0, 0], [100, 0], [50, 10]], closed: false,
      dimension: { ...createLinearDimension(), ...style, cachedValueMm: 100 } });
    page.entityOrder.push(3); draft.meta.nextId = 4;
  });
  expect(decodeLayoutDocument(encodeLayoutDocument(doc)).state.pages.get(pageId)!.entities.get(3)!.dimension).toMatchObject(style);
  const invalid: Record<string, unknown>[] = [{ scale: 0 }, { scale: -1 }, { scale: Number.NaN }, { format: 'metric' }, { units: 'yd' }, { showDashes: 'no' }];
  for (const patch of invalid) {
    doc.undoStack.transact('Invalid fixture', (draft) => { Object.assign(draft.pages.get(pageId)!.entities.get(3)!.dimension!, patch); });
    expect(() => decodeLayoutDocument(encodeLayoutDocument(doc)), JSON.stringify(patch)).toThrow('invalid state');
    doc.undoStack.undo();
  }
  // Scale and feet-and-inch formats belong to linear dimensions only.
  doc.undoStack.transact('Angular fixture', (draft) => {
    const page = draft.pages.get(pageId)!;
    page.entities.set(4, { id: 4, kind: 'angular-dimension', layerId: draft.activeLayerId, points: [[0, 0], [10, 0], [0, 10], [5, 5]], closed: false,
      angularDimension: { ...createAngularDimension(), cachedAngleDeg: 90, ...{ scale: 2 } } });
    page.entityOrder.push(4); draft.meta.nextId = 5;
  });
  expect(() => decodeLayoutDocument(encodeLayoutDocument(doc))).toThrow('invalid state');
});

it('round-trips label attachments and rejects invalid vertex references', () => {
  const doc = createLayoutDocument(), pageId = doc.state.pageOrder[0]!;
  doc.undoStack.transact('Label fixture', draft => {
    const page = draft.pages.get(pageId)!;
    page.entities.set(3, { id: 3, kind: 'path', layerId: 1, points: [[10, 10], [20, 10]], closed: false });
    page.entities.set(4, { id: 4, kind: 'label', layerId: 1, points: [[60, 20], [110, 40], [10, 10], [40, 30]], closed: false,
      labelAnchor: { entityId: 3, pointIndex: 0, pointCount: 2 },
      text: { content: 'Attached', fontFamily: 'Arial', fontSizePt: 12, color: '#222222', bold: false, italic: false,
        underline: false, align: 'left', vertical: 'middle', bounded: true, leader: 'elbow', endpoint: 'arrow' } });
    page.entityOrder.push(3, 4); draft.meta.nextId = 5;
  });
  expect(decodeLayoutDocument(encodeLayoutDocument(doc)).state.pages.get(pageId)!.entities.get(4)?.labelAnchor)
    .toEqual({ entityId: 3, pointIndex: 0, pointCount: 2 });
  for (const anchor of [{ entityId: 3, pointIndex: -1, pointCount: 2 }, { entityId: 3, pointIndex: 2, pointCount: 2 },
    { entityId: 4, pointIndex: 0, pointCount: 2 }, { entityId: 3, pointIndex: 0, pointCount: 0 }]) {
    doc.undoStack.transact('Invalid attachment', draft => { draft.pages.get(pageId)!.entities.get(4)!.labelAnchor = anchor; });
    expect(() => decodeLayoutDocument(encodeLayoutDocument(doc))).toThrow('invalid state');
  }
});

it('round-trips nested groups and rejects invalid group ancestry', () => {
  const doc = createLayoutDocument(), pageId = doc.state.pageOrder[0]!;
  doc.undoStack.transact('Nested group fixture', draft => {
    const page = draft.pages.get(pageId)!;
    page.entities.set(3, { id: 3, kind: 'path', layerId: draft.activeLayerId, groupId: 4, nestedGroupIds: [5, 6],
      points: [[0, 0], [100, 0]], closed: false });
    page.entityOrder.push(3); draft.meta.nextId = 7;
  });
  expect(decodeLayoutDocument(encodeLayoutDocument(doc)).state.pages.get(pageId)!.entities.get(3)?.nestedGroupIds).toEqual([5, 6]);
  for (const nested of [[], [4], [5, 5], [-1], [1.5]]) {
    doc.undoStack.transact('Invalid group fixture', draft => { draft.pages.get(pageId)!.entities.get(3)!.nestedGroupIds = nested; });
    expect(() => decodeLayoutDocument(encodeLayoutDocument(doc))).toThrow('invalid state');
  }
  doc.undoStack.transact('Missing outer group fixture', draft => {
    const entity = draft.pages.get(pageId)!.entities.get(3)!;
    delete entity.groupId; entity.nestedGroupIds = [5];
  });
  expect(() => decodeLayoutDocument(encodeLayoutDocument(doc))).toThrow('invalid state');
});

it('round-trips custom object names, accepts older files without them and rejects invalid names', () => {
  const doc = createLayoutDocument(), pageId = doc.state.pageOrder[0]!;
  doc.undoStack.transact('Named fixture', draft => {
    const page = draft.pages.get(pageId)!;
    page.entities.set(3, { id: 3, kind: 'path', layerId: draft.activeLayerId, name: 'Datum', points: [[0, 0], [100, 0]], closed: false });
    page.entities.set(4, { id: 4, kind: 'path', layerId: draft.activeLayerId, points: [[0, 5], [100, 5]], closed: false });
    page.entityOrder.push(3, 4); draft.meta.nextId = 5;
  });
  const read = decodeLayoutDocument(encodeLayoutDocument(doc)).state.pages.get(pageId)!;
  expect(read.entities.get(3)?.name).toBe('Datum');
  expect(read.entities.get(4)).not.toHaveProperty('name');
  doc.undoStack.transact('Longest name fixture', draft => { draft.pages.get(pageId)!.entities.get(3)!.name = 'x'.repeat(100); });
  expect(decodeLayoutDocument(encodeLayoutDocument(doc)).state.pages.get(pageId)!.entities.get(3)?.name).toHaveLength(100);
  for (const name of ['x'.repeat(101), 7, null]) {
    doc.undoStack.transact('Invalid name fixture', draft => { (draft.pages.get(pageId)!.entities.get(3) as { name: unknown }).name = name; });
    expect(() => decodeLayoutDocument(encodeLayoutDocument(doc))).toThrow('invalid state');
  }
});

it('round-trips hidden objects and rejects a non-boolean hidden flag', () => {
  const doc = createLayoutDocument(), pageId = doc.state.pageOrder[0]!;
  doc.undoStack.transact('Hidden fixture', draft => {
    const page = draft.pages.get(pageId)!;
    page.entities.set(3, { id: 3, kind: 'path', layerId: draft.activeLayerId, hidden: true, points: [[0, 0], [100, 0]], closed: false });
    page.entities.set(4, { id: 4, kind: 'path', layerId: draft.activeLayerId, points: [[0, 5], [100, 5]], closed: false });
    page.entityOrder.push(3, 4); draft.meta.nextId = 5;
  });
  const read = decodeLayoutDocument(encodeLayoutDocument(doc)).state.pages.get(pageId)!;
  expect(read.entities.get(3)?.hidden).toBe(true);
  expect(read.entities.get(4)).not.toHaveProperty('hidden');
  doc.undoStack.transact('Invalid hidden fixture', draft => { (draft.pages.get(pageId)!.entities.get(3) as { hidden: unknown }).hidden = 'yes'; });
  expect(() => decodeLayoutDocument(encodeLayoutDocument(doc))).toThrow('invalid state');
});

it('round-trips paper and grid units and rejects unknown units', () => {
  const doc = createLayoutDocument();
  expect(decodeLayoutDocument(encodeLayoutDocument(doc)).state.settings.paperUnits).toBeUndefined();
  doc.undoStack.transact('Units fixture', draft => { draft.settings.paperUnits = 'in'; draft.settings.grid.units = 'in'; });
  const read = decodeLayoutDocument(encodeLayoutDocument(doc)).state.settings;
  expect(read.paperUnits).toBe('in');
  expect(read.grid.units).toBe('in');
  doc.undoStack.transact('Invalid units fixture', draft => { (draft.settings as { paperUnits: unknown }).paperUnits = 'ft'; });
  expect(() => decodeLayoutDocument(encodeLayoutDocument(doc))).toThrow('invalid state');
});
