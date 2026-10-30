// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { openLayoutFile } from '@pushform/io';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function setup() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}),
  });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout(), pageId = tab.activePageId;
  tab.commands.execute('layout.style.setDefault', { fillColor: '#ffffff' });
  const id = tab.commands.execute('layout.shape.add', { pageId, points: [[10, 10], [50, 10], [50, 40], [10, 40]], closed: true }) as number;
  render(<LayoutWorkspace tab={tab} session={session} />);
  const canvas = screen.getByLabelText('Page 1 canvas');
  const click = (x: number, y: number): void => {
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: x * 3, clientY: y * 3 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: x * 3, clientY: y * 3 });
  };
  const entity = () => tab.doc.state.pages.get(pageId)!.entities.get(id)!;
  const dispose = (): void => { session.dispose(); app.dispose(); };
  return { app, session, tab, pageId, id, canvas, click, entity, dispose };
}

it('selects an object and scales it with handles in one undoable operation', async () => {
  const { session, tab, canvas, click, entity, dispose } = setup();
  expect(canvas.getAttribute('data-tool')).toBe('select');
  click(30, 25);
  expect(screen.getByLabelText('Selected object bounds')).toBeTruthy();
  const handle = screen.getByRole('button', { name: 'Scale bottom right' });
  const version = tab.doc.version;
  fireEvent.pointerDown(handle, { button: 0, pointerId: 2, clientX: 150, clientY: 120 });
  fireEvent.pointerMove(handle, { pointerId: 2, clientX: 210, clientY: 165 });
  expect(tab.doc.version).toBe(version);
  fireEvent.pointerUp(handle, { pointerId: 2, clientX: 210, clientY: 165 });
  expect(entity().points).toEqual([[10, 10], [70, 10], [70, 55], [10, 55]]);
  expect(entity().style!.fillColor).toBe('#ffffff');
  act(() => { tab.commands.execute('edit.undo'); });
  expect(entity().points[2]).toEqual([50, 40]);
  act(() => { tab.commands.execute('edit.redo'); });
  const reopened = (await openLayoutFile((await session.saveLayoutBytes(tab.id))));
  expect(reopened.state.pages.get(tab.activePageId)!.entities.get(entity().id)).toEqual(entity());
  // Cancelling a resize never commits it on pointer-up.
  const cancelHandle = screen.getByRole('button', { name: 'Scale bottom right' });
  fireEvent.pointerDown(cancelHandle, { button: 0, pointerId: 3, clientX: 210, clientY: 165 });
  fireEvent.pointerMove(cancelHandle, { pointerId: 3, clientX: 240, clientY: 180 });
  fireEvent.keyDown(window, { key: 'Escape' });
  fireEvent.pointerUp(cancelHandle, { pointerId: 3, clientX: 240, clientY: 180 });
  expect(entity().points[2]).toEqual([70, 55]);
  dispose();
});

it('double-clicks into vertex editing and moves or deletes vertices without moving the object', () => {
  const { tab, canvas, click, entity, dispose } = setup();
  click(30, 25);
  fireEvent.doubleClick(canvas, { clientX: 90, clientY: 75 });
  expect(screen.queryByLabelText('Selected object bounds')).toBeNull();
  expect(screen.getByRole('button', { name: 'Done editing path' })).toBeTruthy();
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 2, clientX: 30, clientY: 30 });
  fireEvent.pointerMove(canvas, { pointerId: 2, clientX: 45, clientY: 45 });
  fireEvent.pointerUp(canvas, { pointerId: 2, clientX: 45, clientY: 45 });
  expect(entity().points).toEqual([[15, 15], [50, 10], [50, 40], [10, 40]]);
  fireEvent.keyDown(window, { key: 'Delete' });
  expect(entity().points).toEqual([[50, 10], [50, 40], [10, 40]]);
  click(50, 10);
  fireEvent.keyDown(window, { key: 'Delete' });
  expect(entity().points).toEqual([[50, 40], [10, 40]]);
  expect(entity().closed).toBe(false);
  act(() => { tab.commands.execute('edit.undo'); });
  expect(entity().closed).toBe(true);
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.getByLabelText('Selected object bounds')).toBeTruthy();
  dispose();
});

it('leaves vertex editing when another object is clicked and protects locked objects', () => {
  const { tab, pageId, id, canvas, click, entity, dispose } = setup();
  let otherId = 0;
  act(() => { otherId = tab.commands.execute('layout.shape.add', { pageId,
    points: [[90, 10], [110, 10], [110, 30], [90, 30]], closed: true }) as number; });
  click(30, 25); fireEvent.doubleClick(canvas, { clientX: 90, clientY: 75 });
  click(100, 20);
  expect(screen.getByText(`Path #${otherId} · 4 points`)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Done editing path' })).toBeNull();
  act(() => { tab.commands.execute('layout.layer.add', { name: 'Other' }); tab.commands.execute('layout.layer.setLocked', { layerId: 1, locked: true }); });
  click(30, 25); fireEvent.doubleClick(canvas, { clientX: 90, clientY: 75 });
  expect(screen.queryByLabelText('Selected object bounds')).toBeNull();
  fireEvent.keyDown(window, { key: 'Delete' });
  expect(entity().id).toBe(id);
  expect(entity().points).toHaveLength(4);
  dispose();
});

it('adds with Ctrl-click, subtracts with Ctrl+Shift-click, and never moves on a modified click', () => {
  const { tab, pageId, id, canvas, click, entity, dispose } = setup();
  const second = tab.commands.execute('layout.shape.add', { pageId, points: [[80, 10], [120, 10], [120, 40], [80, 40]], closed: true }) as number;
  const selected = () => screen.queryByText(/objects selected/)?.textContent ?? null;
  click(30, 25);
  expect(screen.getByLabelText('Selected object bounds')).toBeTruthy();
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 100 * 3, clientY: 25 * 3, ctrlKey: true });
  fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 130 * 3, clientY: 25 * 3, ctrlKey: true });
  fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 130 * 3, clientY: 25 * 3, ctrlKey: true });
  expect(selected()).toMatch(/2 objects selected/);
  expect(tab.doc.state.pages.get(pageId)!.entities.get(second)!.points[0]).toEqual([80, 10]);
  // Ctrl-click on a selected object keeps it selected (add is idempotent).
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 2, clientX: 30 * 3, clientY: 25 * 3, ctrlKey: true });
  fireEvent.pointerUp(canvas, { pointerId: 2, clientX: 30 * 3, clientY: 25 * 3, ctrlKey: true });
  expect(selected()).toMatch(/2 objects selected/);
  // Ctrl+Shift-click removes.
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 3, clientX: 30 * 3, clientY: 25 * 3, ctrlKey: true, shiftKey: true });
  fireEvent.pointerUp(canvas, { pointerId: 3, clientX: 30 * 3, clientY: 25 * 3, ctrlKey: true, shiftKey: true });
  expect(selected()).toBeNull();
  expect(screen.getByLabelText('Selected object bounds')).toBeTruthy();
  // Cmd behaves like Ctrl: Cmd-click adds the now unselected first object back, Cmd+Shift-click removes it again.
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 6, clientX: 30 * 3, clientY: 25 * 3, metaKey: true });
  fireEvent.pointerMove(canvas, { pointerId: 6, clientX: 60 * 3, clientY: 25 * 3, metaKey: true });
  fireEvent.pointerUp(canvas, { pointerId: 6, clientX: 60 * 3, clientY: 25 * 3, metaKey: true });
  expect(selected()).toMatch(/2 objects selected/);
  expect(entity().points[0]).toEqual([10, 10]);
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 7, clientX: 30 * 3, clientY: 25 * 3, metaKey: true, shiftKey: true });
  fireEvent.pointerUp(canvas, { pointerId: 7, clientX: 30 * 3, clientY: 25 * 3, metaKey: true, shiftKey: true });
  expect(selected()).toBeNull();
  // Ctrl+Shift on an unselected object does nothing to the selection.
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 4, clientX: 30 * 3, clientY: 25 * 3, ctrlKey: true, shiftKey: true });
  fireEvent.pointerUp(canvas, { pointerId: 4, clientX: 30 * 3, clientY: 25 * 3, ctrlKey: true, shiftKey: true });
  expect(selected()).toBeNull();
  expect(entity().id).toBe(id);
  expect(entity().points[0]).toEqual([10, 10]);
  dispose();
});

it('Shift+= and Shift+- reorder the editable selection one step', () => {
  const { tab, pageId, id, canvas, click, dispose } = setup();
  const above = tab.commands.execute('layout.shape.add', { pageId, points: [[80, 10], [120, 10], [120, 40], [80, 40]], closed: true }) as number;
  const top = tab.commands.execute('layout.shape.add', { pageId, points: [[150, 10], [190, 10], [190, 40], [150, 40]], closed: true }) as number;
  const order = () => tab.doc.state.pages.get(pageId)!.entityOrder;
  expect(order()).toEqual([id, above, top]);
  click(30, 25);
  const version = tab.doc.version;
  fireEvent.keyDown(window, { key: '+', code: 'Equal', shiftKey: true });
  expect(order()).toEqual([above, id, top]);
  fireEvent.keyDown(window, { key: '+', code: 'Equal', shiftKey: true });
  expect(order()).toEqual([above, top, id]);
  fireEvent.keyDown(window, { key: '_', code: 'Minus', shiftKey: true });
  expect(order()).toEqual([above, id, top]);
  expect(tab.doc.version).toBe(version + 3);
  // A multi-object selection keeps its relative stacking.
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 5, clientX: 100 * 3, clientY: 25 * 3, ctrlKey: true });
  fireEvent.pointerUp(canvas, { pointerId: 5, clientX: 100 * 3, clientY: 25 * 3, ctrlKey: true });
  fireEvent.keyDown(window, { key: '+', code: 'Equal', shiftKey: true });
  expect(order()).toEqual([top, above, id]);
  // One key press with several objects is one undo entry, as from the Arrange menu.
  act(() => { tab.commands.execute('edit.undo'); });
  expect(order()).toEqual([above, id, top]);
  act(() => { tab.commands.execute('edit.redo'); });
  expect(order()).toEqual([top, above, id]);
  fireEvent.keyDown(window, { key: '_', code: 'Minus', shiftKey: true });
  expect(order()).toEqual([above, id, top]);
  // Unmodified = and - and Ctrl+Shift+= are not arrange keys; a locked object stays put.
  fireEvent.keyDown(window, { key: '=', code: 'Equal' });
  fireEvent.keyDown(window, { key: '+', code: 'Equal', shiftKey: true, ctrlKey: true });
  expect(order()).toEqual([above, id, top]);
  act(() => { tab.commands.execute('layout.shape.setLocked', { pageId, entityIds: [id], locked: true }); });
  fireEvent.keyDown(window, { key: '+', code: 'Equal', shiftKey: true });
  expect(order()).toEqual([id, above, top]);
  dispose();
});
