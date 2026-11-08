// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/**
 * A spans [20, 20]-[60, 40] and B [100, 100]-[140, 120]; C at [150, 20]-[170, 40] is locked; D is hidden, and E sits on a
 * hidden layer. Grid snapping is off.
 */
function setup() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}),
  });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout(), pageId = tab.activePageId;
  tab.doc.undoStack.transact('No grid snapping', (draft) => { draft.settings.grid.snap = false; });
  const rectangle = (first: [number, number], second: [number, number]) =>
    tab.commands.execute('layout.rectangle.add', { pageId, kind: 'rectangle', first, second }) as number;
  const a = rectangle([20, 20], [60, 40]), b = rectangle([100, 100], [140, 120]), c = rectangle([150, 20], [170, 40]);
  const d = rectangle([20, 150], [40, 170]);
  tab.commands.execute('layout.shape.setLocked', { pageId, entityIds: [c], locked: true });
  tab.commands.execute('layout.shape.setHidden', { pageId, entityIds: [d], hidden: true });
  const firstLayer = tab.doc.state.activeLayerId;
  const layer = tab.commands.execute('layout.layer.add', { name: 'Hidden' }) as number;
  const e = rectangle([200, 150], [220, 170]);
  tab.commands.execute('layout.layer.setVisible', { layerId: layer, visible: false });
  tab.commands.execute('layout.layer.activate', { layerId: firstLayer });
  render(<LayoutWorkspace tab={tab} session={session} />);
  const canvas = screen.getByLabelText('Page 1 canvas');
  const at = (x: number, y: number) => ({ pointerId: 1, clientX: x * 3, clientY: y * 3 });
  const press = (x: number, y: number) => fireEvent.pointerDown(canvas, { button: 0, ...at(x, y) });
  const release = (x: number, y: number) => fireEvent.pointerUp(canvas, at(x, y));
  const click = (x: number, y: number) => { press(x, y); release(x, y); };
  /** Presses Cmd+A, or Ctrl+A, and says whether the browser's own select-all was stopped. */
  const selectAll = (modifier: 'metaKey' | 'ctrlKey' = 'metaKey', target: Element | Window = window) => {
    const event = createEvent.keyDown(target, { key: 'a', code: 'KeyA', [modifier]: true });
    fireEvent(target, event);
    return event.defaultPrevented;
  };
  const note = () => document.querySelector('.pf-form-note')!.textContent;
  const points = (id: number) => tab.doc.state.pages.get(pageId)!.entities.get(id)?.points;
  const dispose = () => { cleanup(); session.dispose(); app.dispose(); };
  return { tab, pageId, a, b, c, d, e, canvas, press, release, click, selectAll, note, points, dispose };
}

it('selects every visible object on the page, locked ones too, with Cmd+A or Ctrl+A, and adds no undo step', () => {
  const { tab, a, b, c, d, e, click, selectAll, note, points, dispose } = setup();
  const version = tab.doc.version;
  expect(selectAll()).toBe(true);
  // A, B and the locked C; the hidden D and E on the hidden layer stay out.
  expect(note()).toBe('3 objects selected');
  expect(screen.getByLabelText('Selected objects bounds')).toBeTruthy();
  expect(tab.doc.version).toBe(version);
  click(250, 190);
  expect(note()).toContain('Nothing selected');
  expect(selectAll('ctrlKey')).toBe(true);
  expect(note()).toBe('3 objects selected');
  // Delete erases what was selected and can be erased; the locked, hidden and hidden-layer objects remain.
  fireEvent.keyDown(window, { key: 'Delete' });
  expect(points(a)).toBeUndefined(); expect(points(b)).toBeUndefined();
  expect(points(c)).toBeDefined(); expect(points(d)).toBeDefined(); expect(points(e)).toBeDefined();
  act(() => { tab.commands.execute('edit.undo'); });
  // With nothing left to select, the selection is cleared.
  act(() => { tab.commands.execute('layout.shape.setHidden', { pageId: tab.activePageId, entityIds: [a, b, c], hidden: true }); });
  selectAll();
  expect(note()).toContain('Nothing selected');
  dispose();
});

it('switches a drawing tool to Select and drops its unfinished shape', () => {
  const { tab, pageId, canvas, click, selectAll, note, dispose } = setup();
  fireEvent.keyDown(window, { key: 'r', code: 'KeyR' });
  expect(canvas.getAttribute('data-tool')).toBe('rectangle');
  click(200, 60);
  selectAll();
  expect(canvas.getAttribute('data-tool')).toBe('select');
  expect(screen.getByRole('button', { name: 'Select' }).getAttribute('aria-pressed')).toBe('true');
  expect(note()).toBe('3 objects selected');
  const count = tab.doc.state.pages.get(pageId)!.entityOrder.length;
  click(230, 80);
  expect(tab.doc.state.pages.get(pageId)!.entityOrder.length).toBe(count);
  dispose();
});

it('keeps Move active, ends a pending move, and lets the next two clicks move everything that can move', () => {
  const { a, b, c, canvas, click, selectAll, note, points, dispose } = setup();
  fireEvent.keyDown(window, { key: 'm', code: 'KeyM' });
  click(40, 30);
  expect(screen.queryByLabelText('Move distance preview')).not.toBeNull();
  selectAll();
  expect(canvas.getAttribute('data-tool')).toBe('move');
  expect(screen.queryByLabelText('Move distance preview')).toBeNull();
  expect(note()).toBe('3 objects selected');
  click(250, 190); click(260, 195);
  expect(points(a)![0]).toEqual([30, 25]);
  expect(points(b)![0]).toEqual([110, 105]);
  expect(points(c)![0]).toEqual([150, 20]);
  dispose();
});

it('selects nothing in a field or during a drag, and only answers Cmd+A or Ctrl+A alone', () => {
  const { press, release, selectAll, note, dispose } = setup();
  // In a field the key is left to the field, which selects its own text.
  const field = document.querySelector<HTMLInputElement>('input:not([type=checkbox]):not([type=radio])')!;
  expect(field).toBeTruthy();
  expect(selectAll('metaKey', field)).toBe(false);
  expect(note()).toContain('Nothing selected');
  // During a selection box drag nothing changes, and the page's text is not selected either.
  press(250, 190);
  expect(selectAll()).toBe(true);
  expect(note()).toContain('Nothing selected');
  release(250, 190);
  // Shift, Alt or another letter is not Select All.
  fireEvent.keyDown(window, { key: 'a', code: 'KeyA', metaKey: true, shiftKey: true });
  fireEvent.keyDown(window, { key: 'å', code: 'KeyA', metaKey: true, altKey: true });
  expect(note()).toContain('Nothing selected');
  dispose();
});
