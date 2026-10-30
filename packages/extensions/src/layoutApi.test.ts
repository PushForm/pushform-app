// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { createLayoutRegistry } from '@pushform/commands';
import { LAYOUT_TOOLS, type LayoutBatchResult } from '@pushform/extension-protocol';
import { createLayoutDocument, type LayoutDocument } from '@pushform/layout';
import { LayoutApiFailure, LayoutDocumentApi, runLayoutTool } from './layoutApi';

function setup(selected: number[] = []): { doc: LayoutDocument; api: LayoutDocumentApi; pageId: number } {
  const doc = createLayoutDocument();
  const { commands } = createLayoutRegistry(doc);
  const pageId = doc.state.pageOrder[0]!;
  return { doc, api: new LayoutDocumentApi(doc, commands, { activePageId: () => pageId, selectedEntityIds: () => selected }, 'AI Chat'), pageId };
}
function failure(run: () => unknown): LayoutApiFailure {
  try { run(); } catch (error) { if (error instanceof LayoutApiFailure) return error; throw error; }
  throw new Error('expected a LayoutApiFailure');
}
const objectCount = (doc: LayoutDocument): number => [...doc.state.pages.values()].reduce((n, page) => n + page.entities.size, 0);

describe('LayoutDocumentApi reads', () => {
  it('captures the revision, pages, layers, the shown page and the selection', () => {
    const { api, pageId } = setup([7]);
    const snapshot = api.getDocument();
    expect(snapshot).toMatchObject({ apiVersion: 1, revision: 0, units: 'mm', activePageId: pageId, selectedEntityIds: [7],
      pages: [{ id: pageId, name: 'Page 1', index: 0, widthMm: 297, heightMm: 210, objectCount: 0 }],
      layers: [{ name: 'Layer 1', visible: true, locked: false, shared: false, active: true }] });
  });

  it('lists objects in paint order with bounds, text and table cells, paged', () => {
    const { api, pageId } = setup();
    api.apply({ expectedRevision: 0, label: 'Seed', operations: [
      { op: 'add_rectangle', pageId, x: 10, y: 20, width: 30, height: 40 },
      { op: 'add_text', pageId, x: 50, y: 20, width: 60, height: 10, content: 'Hello' },
      { op: 'add_table', pageId, x: 10, y: 80, width: 40, height: 20, rows: 2, columns: 2, cells: [['a', 'b'], ['c']] },
    ] });
    const first = api.listObjects({ pageId: null, kinds: null, entityIds: null, offset: null, limit: 2 });
    expect(first.total).toBe(3);
    expect(first.next).toBe(2);
    expect(first.objects[0]).toMatchObject({ kind: 'path', closed: true, bounds: { x: 10, y: 20, width: 30, height: 40 }, pointCount: 4 });
    expect(first.objects[1]).toMatchObject({ kind: 'text', text: { content: 'Hello', fontSizePt: 10 } });
    const rest = api.listObjects({ pageId, kinds: ['table'], entityIds: null, offset: null, limit: null });
    expect(rest.objects[0]?.table).toEqual({ rows: 2, columns: 2, cells: [['a', 'b'], ['c', '']] });
  });

  it('rejects an unknown page', () => {
    const { api } = setup();
    expect(failure(() => api.listObjects({ pageId: 999, kinds: null, entityIds: null, offset: null, limit: null })).error.code).toBe('invalid_reference');
  });
});

describe('LayoutDocumentApi batches', () => {
  it('applies a batch as one labelled undo entry and returns created ids by name', () => {
    const { doc, api, pageId } = setup();
    const result = api.apply({ expectedRevision: 0, label: 'Title block', operations: [
      { op: 'add_rectangle', as: 'frame', pageId, x: 10, y: 10, width: 277, height: 190 },
      { op: 'add_text', as: 'title', pageId, x: 20, y: 180, width: 100, height: 12, content: '<PageName>', bold: true, fontSizePt: 18 },
      { op: 'add_ellipse', pageId, cx: 150, cy: 100, rx: 20, ry: 20 },
      { op: 'add_path', pageId, points: [[0, 0], [10, 0], [10, 10]], closed: true },
      { op: 'add_dimension', pageId, start: [10, 10], end: [287, 10] },
      { op: 'set_style', pageId, entityIds: ['$frame'], strokeColor: '#ff0000', fillColor: null },
      { op: 'set_auto_text', name: 'Client', value: 'ACME' },
    ] });
    expect(result.revision).toBe(1);
    expect(result.label).toBe('AI Chat: Title block');
    expect(Object.keys(result.created)).toEqual(['frame', 'title']);
    const page = doc.state.pages.get(pageId)!;
    expect(page.entities.size).toBe(5);
    expect(page.entities.get(result.created['frame']!)?.style).toMatchObject({ strokeColor: '#ff0000', fillColor: null });
    expect(page.entities.get(result.created['title']!)?.text).toMatchObject({ content: '<PageName>', bold: true, fontSizePt: 18, bounded: true });
    const dimension = [...page.entities.values()].find(e => e.kind === 'dimension')!;
    expect(dimension.dimension?.alignment).toBe('horizontal');
    expect(dimension.points[2]![1]).toBeLessThan(10);
    expect(doc.state.customFields.get('Client')).toBe('ACME');
    expect(doc.undoStack.undo()).toBe(true);
    expect(objectCount(doc)).toBe(0);
    expect(doc.state.customFields.has('Client')).toBe(false);
    expect(doc.undoStack.canUndo).toBe(false);
  });

  it('resolves names across pages and layers created in the same batch', () => {
    const { doc, api } = setup();
    const result = api.apply({ expectedRevision: 0, label: 'Cover', operations: [
      { op: 'add_page', as: 'cover', name: 'Cover' },
      { op: 'add_layer', as: 'notes', name: 'Notes' },
      { op: 'add_text', as: 'heading', pageId: '$cover', x: 20, y: 20, width: 100, height: 20, content: 'Cover' },
      { op: 'move', pageId: '$cover', entityIds: ['$heading'], dx: 5, dy: 0, copy: true },
    ] });
    const cover = doc.state.pages.get(result.created['cover']!)!;
    expect(cover.name).toBe('Cover');
    expect(cover.entities.size).toBe(2);
    expect(cover.entities.get(result.created['heading']!)?.layerId).toBe(result.created['notes']);
    expect(result.results[3]?.ids).toHaveLength(1);
  });

  it('changes nothing when any operation fails, and names the failed operation', () => {
    const { doc, api, pageId } = setup();
    const error = failure(() => api.apply({ expectedRevision: 0, label: 'Broken', operations: [
      { op: 'add_rectangle', pageId, x: 0, y: 0, width: 10, height: 10 },
      { op: 'delete', pageId, entityIds: [999] },
    ] })).error;
    expect(error).toMatchObject({ code: 'operation_failed', operationIndex: 1, revision: 0 });
    expect(error.message).toContain('Nothing was changed');
    expect(objectCount(doc)).toBe(0);
    expect(doc.version).toBe(0);
    expect(doc.undoStack.canUndo).toBe(false);
  });

  it('rejects an unknown local name, a stale revision, invalid input and oversized batches before changing anything', () => {
    const { doc, api, pageId } = setup();
    expect(failure(() => api.apply({ expectedRevision: 0, label: 'x', operations: [{ op: 'delete', pageId, entityIds: ['$missing'] }] })).error)
      .toMatchObject({ code: 'invalid_reference', operationIndex: 0 });
    api.apply({ expectedRevision: 0, label: 'One', operations: [{ op: 'add_rectangle', pageId, x: 0, y: 0, width: 5, height: 5 }] });
    expect(failure(() => api.apply({ expectedRevision: 0, label: 'Two', operations: [{ op: 'add_rectangle', pageId, x: 0, y: 0, width: 5, height: 5 }] })).error)
      .toMatchObject({ code: 'stale_revision', revision: 1 });
    expect(failure(() => api.apply({ expectedRevision: 1, label: 'Bad', operations: [{ op: 'add_rectangle', pageId, x: 0, y: 0, width: -5, height: 5 }] })).error)
      .toMatchObject({ code: 'invalid_operation', operationIndex: 0 });
    const many = Array.from({ length: 201 }, () => ({ op: 'add_rectangle', pageId, x: 0, y: 0, width: 5, height: 5 }));
    expect(failure(() => api.apply({ expectedRevision: 1, label: 'Many', operations: many })).error.code).toBe('limit_exceeded');
    expect(failure(() => api.apply({ expectedRevision: 1, label: 'Cells', operations: [{ op: 'add_table', pageId, x: 0, y: 0, width: 50, height: 50, rows: 100, columns: 100 }] })).error.code).toBe('limit_exceeded');
    expect(objectCount(doc)).toBe(1);
  });
});

describe('runLayoutTool', () => {
  it('returns JSON results and error results without throwing', () => {
    const { api, pageId } = setup();
    const read = runLayoutTool(api, LAYOUT_TOOLS.getDocument.name, {});
    expect(read.isError).toBe(false);
    expect(JSON.parse(read.content).revision).toBe(0);
    const applied = runLayoutTool(api, LAYOUT_TOOLS.applyOperations.name, { expectedRevision: 0, label: 'Box', operations: [{ op: 'add_rectangle', pageId, x: 0, y: 0, width: 5, height: 5 }] });
    expect((JSON.parse(applied.content) as LayoutBatchResult).revision).toBe(1);
    const stale = runLayoutTool(api, LAYOUT_TOOLS.applyOperations.name, { expectedRevision: 0, label: 'Box', operations: [{ op: 'add_rectangle', pageId, x: 0, y: 0, width: 5, height: 5 }] });
    expect(stale.isError).toBe(true);
    expect(JSON.parse(stale.content).error.code).toBe('stale_revision');
    expect(runLayoutTool(api, 'layout_unknown', {}).isError).toBe(true);
  });
});
