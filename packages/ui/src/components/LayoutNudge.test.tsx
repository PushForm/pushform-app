// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { openLayoutFile } from '@pushform/io';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function setup() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}) });
  const app = createApp({ demo: false, expose: false }), session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout(), pageId = tab.activePageId;
  const id = tab.commands.execute('layout.shape.add', { pageId, points: [[10, 10], [50, 10], [50, 40], [10, 40]], closed: true }) as number;
  render(<LayoutWorkspace tab={tab} session={session} />);
  const canvas = screen.getByLabelText('Page 1 canvas');
  const click = (x: number, y: number, shiftKey = false) => {
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: x * 3, clientY: y * 3, shiftKey });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: x * 3, clientY: y * 3, shiftKey });
  };
  const entity = (entityId = id) => tab.doc.state.pages.get(pageId)!.entities.get(entityId)!;
  return { tab, session, pageId, id, canvas, click, entity, dispose: () => { cleanup(); session.dispose(); app.dispose(); } };
}

it('nudges 0.2 mm in every direction, keeps the selection, and supports undo/redo and persistence', async () => {
  const { tab, session, pageId, id, click, entity, dispose } = setup();
  click(30, 25);
  const cases = [['ArrowRight', 10.2, 10], ['ArrowDown', 10.2, 10.2], ['ArrowLeft', 10, 10.2], ['ArrowUp', 10, 10]] as const;
  for (const [key, x, y] of cases) {
    const event = createEvent.keyDown(window, { key }); fireEvent(window, event);
    expect(event.defaultPrevented).toBe(true);
    expect(entity().points[0]![0]).toBeCloseTo(x); expect(entity().points[0]![1]).toBeCloseTo(y);
    expect(screen.getByLabelText('Selected object bounds')).toBeTruthy();
  }
  act(() => { tab.commands.execute('edit.undo'); });
  expect(entity().points[0]![1]).toBeCloseTo(10.2);
  act(() => { tab.commands.execute('edit.redo'); });
  expect(entity().points[0]![1]).toBeCloseTo(10);
  expect((await openLayoutFile((await session.saveLayoutBytes(tab.id)))).state.pages.get(pageId)?.entities.get(id)).toEqual(entity());
  dispose();
});

it('moves a multiple selection together, ignores locked/hidden objects, and does not snap nudges to the grid', () => {
  const { tab, pageId, id, click, entity, dispose } = setup();
  let second = 0, layer = 0;
  act(() => {
    layer = tab.commands.execute('layout.layer.add', { name: 'Other' }) as number;
    second = tab.commands.execute('layout.shape.add', { pageId, points: [[70, 10], [90, 10], [90, 40], [70, 40]], closed: true }) as number;
    tab.doc.undoStack.transact('Enable grid snapping', draft => { draft.settings.grid.snap = true; });
  });
  click(30, 25); click(80, 25, true);
  fireEvent.keyDown(window, { key: 'ArrowRight' });
  expect(entity().points[0]![0]).toBeCloseTo(10.2); expect(entity(second).points[0]![0]).toBeCloseTo(70.2);
  act(() => { tab.commands.execute('edit.undo'); });
  expect(entity().points[0]![0]).toBe(10); expect(entity(second).points[0]![0]).toBe(70);
  act(() => { tab.commands.execute('layout.shape.setLocked', { pageId, entityIds: [id], locked: true }); });
  fireEvent.keyDown(window, { key: 'ArrowDown' });
  expect(entity().points[0]![1]).toBe(10); expect(entity(second).points[0]![1]).toBeCloseTo(10.2);
  act(() => { tab.commands.execute('layout.layer.setVisible', { layerId: layer, visible: false }); });
  const version = tab.doc.version;
  fireEvent.keyDown(window, { key: 'ArrowDown' });
  expect(tab.doc.version).toBe(version);
  dispose();
});

it('supports held-key repeat and keeps associated dimensions attached while their source moves', () => {
  const { tab, pageId, id, click, entity, dispose } = setup();
  let dimension = 0;
  act(() => {
    dimension = tab.commands.execute('layout.dimension.add', { pageId, points: [[10, 10], [50, 10], [30, 5]],
      anchors: [0, 1].map(pointIndex => ({ entityId: id, pointIndex, pointCount: 4 })) }) as number;
  });
  click(30, 25);
  for (let index = 0; index < 3; index++) fireEvent.keyDown(window, { key: 'ArrowRight', repeat: index > 0 });
  expect(entity().points[0]![0]).toBeCloseTo(10.6);
  expect(entity(dimension).points[0]![0]).toBeCloseTo(10.6);
  expect(entity(dimension).dimension?.detached).toBe(false);
  expect(entity(dimension).dimension?.cachedValueMm).toBeCloseTo(40);
  dispose();
});

it('preserves arrow-key behavior in text editing, fields, other tools, vertex editing and presentation', () => {
  const { tab, canvas, click, entity, dispose } = setup();
  click(30, 25);
  const original = entity().points;
  for (const modifier of ['shiftKey', 'ctrlKey', 'metaKey', 'altKey']) fireEvent.keyDown(window, { key: 'ArrowRight', [modifier]: true });
  expect(entity().points).toEqual(original);
  fireEvent.doubleClick(canvas, { clientX: 90, clientY: 75 });
  fireEvent.keyDown(window, { key: 'ArrowRight' }); expect(entity().points).toEqual(original);
  fireEvent.keyDown(window, { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
  fireEvent.keyDown(window, { key: 'ArrowRight' }); expect(entity().points).toEqual(original);
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  fireEvent.click(screen.getByRole('button', { name: 'Presentation mode' }));
  fireEvent.keyDown(window, { key: 'ArrowRight' }); expect(entity().points).toEqual(original);
  fireEvent.keyDown(window, { key: 'Escape' });
  fireEvent.paste(window, { clipboardData: { getData: (type: string) => type === 'text/plain' ? 'Text box' : '', items: [], files: [] } });
  const text = [...tab.doc.state.pages.get(tab.activePageId)!.entities.values()].find(e => e.text)!;
  fireEvent.keyDown(window, { key: 'ArrowRight' });
  const moved = tab.doc.state.pages.get(tab.activePageId)!.entities.get(text.id)!;
  expect(moved.points[0]![0]).toBeCloseTo(text.points[0]![0] + 0.2);
  fireEvent.doubleClick(canvas, { clientX: 148.7 * 3, clientY: 105 * 3 });
  const editor = screen.getByRole('textbox', { name: 'Edit text on page' });
  const version = tab.doc.version;
  fireEvent.keyDown(editor, { key: 'ArrowLeft' }); expect(tab.doc.version).toBe(version);
  dispose();
});
