// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/** Two filled squares side by side above a line, on a page drawn at 3 screen pixels per millimeter. */
function setup() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}),
  });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout(), pageId = tab.activePageId;
  tab.commands.execute('layout.grid.set', { snap: false });
  tab.commands.execute('layout.style.setDefault', { fillColor: '#ffffff' });
  const a = tab.commands.execute('layout.shape.add', { pageId, points: [[10, 10], [30, 10], [30, 30], [10, 30]], closed: true }) as number;
  const b = tab.commands.execute('layout.shape.add', { pageId, points: [[50, 10], [70, 10], [70, 30], [50, 30]], closed: true }) as number;
  const c = tab.commands.execute('layout.shape.add', { pageId, points: [[40, 50], [90, 50]] }) as number;
  render(<LayoutWorkspace tab={tab} session={session} />);
  const canvas = screen.getByLabelText('Page 1 canvas');
  const at = (x: number, y: number, init: Record<string, unknown> = {}) => ({ button: 0, pointerId: 1, clientX: x * 3, clientY: y * 3, ...init });
  const press = (x: number, y: number, init: Record<string, unknown> = {}) => fireEvent.pointerDown(canvas, at(x, y, { buttons: 1, ...init }));
  const drag = (x: number, y: number, init: Record<string, unknown> = {}) => fireEvent.pointerMove(canvas, at(x, y, { buttons: 1, ...init }));
  const release = (x: number, y: number, init: Record<string, unknown> = {}) => fireEvent.pointerUp(canvas, at(x, y, { buttons: 0, ...init }));
  const click = (x: number, y: number, init: Record<string, unknown> = {}): void => { press(x, y, init); release(x, y, init); };
  const key = (value: string, init: Record<string, unknown> = {}) => fireEvent.keyDown(window, { key: value, ...init });
  const choose = (id: string) => act(() => { tab.commands.execute(`tool.${id}`); });
  const exists = (id: number): boolean => tab.doc.state.pages.get(pageId)!.entities.has(id);
  const entities = () => [...tab.doc.state.pages.get(pageId)!.entities.values()];
  const undo = () => act(() => { tab.commands.execute('edit.undo'); });
  const status = (): string => document.querySelector('.pf-layout-footer-spacer')?.textContent ?? '';
  const dispose = (): void => { session.dispose(); app.dispose(); };
  return { tab, pageId, a, b, c, canvas, press, drag, release, click, key, choose, exists, entities, undo, status, dispose };
}

it('E picks the Eraser; a click erases the object under the pointer as one undoable step', () => {
  const { tab, a, b, c, canvas, click, key, exists, undo, status, dispose } = setup();
  key('e', { code: 'KeyE' });
  expect(canvas.getAttribute('data-tool')).toBe('eraser');
  expect(status()).toBe('Click an object to erase it, or drag across objects to erase them all.');
  click(20, 20);
  expect([exists(a), exists(b), exists(c)]).toEqual([false, true, true]);
  undo();
  expect(exists(a)).toBe(true);
  // A click on empty paper erases nothing and adds no undo step; modifiers change nothing.
  const version = tab.doc.version;
  click(150, 150);
  expect(tab.doc.version).toBe(version);
  click(60, 20, { shiftKey: true, altKey: true });
  expect(exists(b)).toBe(false);
  dispose();
});

it('a drag erases everything it passed over on release, and Esc or a cancelled pointer erases nothing', () => {
  const { tab, a, b, c, canvas, press, drag, release, exists, undo, status, dispose } = setup();
  act(() => { tab.commands.execute('tool.eraser'); });
  const version = tab.doc.version;
  press(20, 20);
  expect(status()).toBe('Release to erase 1 object. Esc cancels.');
  drag(60, 20);
  drag(60, 55);
  expect(status()).toBe('Release to erase 3 objects. Esc cancels.');
  // Nothing changes until release.
  expect(tab.doc.version).toBe(version);
  release(60, 55);
  expect([exists(a), exists(b), exists(c)]).toEqual([false, false, false]);
  undo();
  expect([exists(a), exists(b), exists(c)]).toEqual([true, true, true]);
  // Esc cancels the drag; releasing afterwards erases nothing.
  press(20, 20); drag(60, 20);
  fireEvent.keyDown(window, { key: 'Escape' });
  release(60, 20);
  expect([exists(a), exists(b)]).toEqual([true, true]);
  expect(status()).toBe('Click an object to erase it, or drag across objects to erase them all.');
  press(20, 20);
  fireEvent.pointerCancel(canvas, { pointerId: 1 });
  release(20, 20);
  expect(exists(a)).toBe(true);
  dispose();
});

it('follows a fast drag along its whole path, so a line between two pointer events is not skipped', () => {
  const { tab, c, press, drag, release, exists, dispose } = setup();
  act(() => { tab.commands.execute('tool.eraser'); });
  // Both pointer events are well clear of the line at y = 50; the path between them crosses it.
  press(60, 40); drag(60, 100); release(60, 100);
  expect(exists(c)).toBe(false);
  dispose();
});

it('erases a whole group, and leaves locked objects in place with a note saying how many', () => {
  const { tab, pageId, a, b, c, click, press, drag, release, exists, status, dispose } = setup();
  act(() => {
    tab.commands.execute('layout.shape.group', { pageId, entityIds: [a, b] });
    tab.commands.execute('layout.shape.setLocked', { pageId, entityIds: [c], locked: true });
  });
  act(() => { tab.commands.execute('tool.eraser'); });
  click(20, 20);
  expect([exists(a), exists(b)]).toEqual([false, false]);
  act(() => { tab.commands.execute('edit.undo'); });
  // Only the locked line is under the pointer: nothing is erased and there is no undo step.
  const version = tab.doc.version;
  click(60, 50);
  expect(exists(c)).toBe(true);
  expect(tab.doc.version).toBe(version);
  expect(status()).toBe('1 locked object was not erased.');
  // A drag across the group and the locked line erases the group and says so; the next click clears the note.
  press(20, 20); drag(60, 55); release(60, 55);
  expect([exists(a), exists(b), exists(c)]).toEqual([false, false, true]);
  expect(status()).toBe('1 locked object was not erased.');
  press(150, 150);
  expect(status()).not.toContain('locked');
  dispose();
});

it('starts with nothing selected, whether chosen by its key or its command', () => {
  const { choose, click, dispose } = setup();
  const selected = (): boolean => screen.queryByLabelText('Selected object bounds') !== null;
  click(20, 20);
  expect(selected()).toBe(true);
  fireEvent.keyDown(window, { key: 'e', code: 'KeyE' });
  choose('select');
  expect(selected()).toBe(false);
  click(20, 20);
  choose('eraser');
  choose('select');
  expect(selected()).toBe(false);
  dispose();
});

it('Delete and Backspace erase the selection; locked objects stay selected and the status bar counts them', () => {
  const { tab, pageId, a, b, c, click, press, drag, release, key, exists, undo, status, dispose } = setup();
  click(20, 20);
  key('Backspace');
  expect(exists(a)).toBe(false);
  undo();
  act(() => { tab.commands.execute('layout.shape.setLocked', { pageId, entityIds: [b], locked: true }); });
  press(5, 5); drag(95, 55); release(95, 55);
  expect(screen.getByText('3 objects selected')).toBeTruthy();
  key('Delete');
  expect([exists(a), exists(b), exists(c)]).toEqual([false, true, false]);
  expect(status()).toBe('1 locked object was not erased.');
  expect(screen.getByText(/Path #\d+ · 4 points/)).toBeTruthy();
  // With only locked objects selected, nothing is erased and no undo step is added.
  const version = tab.doc.version;
  key('Delete');
  expect(tab.doc.version).toBe(version);
  expect(status()).toBe('1 locked object was not erased.');
  dispose();
});

it('the context menu Delete erases the unlocked part of a selection that includes locked objects', () => {
  const { tab, pageId, a, b, c, canvas, press, drag, release, exists, status, dispose } = setup();
  act(() => { tab.commands.execute('layout.shape.setLocked', { pageId, entityIds: [b], locked: true }); });
  press(5, 5); drag(95, 55); release(95, 55);
  fireEvent.contextMenu(canvas, { clientX: 60, clientY: 60 });
  const remove = within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Delete' });
  expect(remove.hasAttribute('disabled')).toBe(false);
  fireEvent.click(remove);
  expect([exists(a), exists(b), exists(c)]).toEqual([false, true, false]);
  expect(status()).toBe('1 locked object was not erased.');
  // With only the locked square selected, Delete is disabled.
  fireEvent.contextMenu(canvas, { clientX: 180, clientY: 60 });
  expect(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Delete' }).hasAttribute('disabled')).toBe(true);
  dispose();
});

it('Delete and Backspace leave the page alone in a dialog, during a drag and while a tool waits for its next step', () => {
  const { tab, a, click, press, drag, release, key, exists, dispose } = setup();
  click(20, 20);
  // A modal dialog or a menu that leaves keys alone, as the app's own can: nothing behind it is erased,
  // whether the key is pressed in it or with focus elsewhere while the dialog is open.
  const modal = document.createElement('div');
  modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
  modal.innerHTML = '<button type="button">Keep</button>';
  document.body.append(modal);
  fireEvent.keyDown(modal.querySelector('button')!, { key: 'Backspace' });
  key('Delete');
  expect(exists(a)).toBe(true);
  modal.remove();
  const menu = document.createElement('ul');
  menu.setAttribute('role', 'menu'); menu.innerHTML = '<li><button type="button" role="menuitem">Open</button></li>';
  document.body.append(menu);
  fireEvent.keyDown(menu.querySelector('button')!, { key: 'Delete' });
  expect(exists(a)).toBe(true);
  menu.remove();
  // During a drag.
  press(20, 20); drag(26, 26);
  key('Delete');
  expect(exists(a)).toBe(true);
  release(26, 26);
  // While Move waits for its destination; Esc ends the move and keeps the selection.
  act(() => { tab.commands.execute('tool.move'); });
  click(22, 22);
  key('Delete');
  expect(exists(a)).toBe(true);
  key('Escape');
  key('Delete');
  expect(exists(a)).toBe(false);
  dispose();
});

it('Backspace removes the newest point of an unfinished Bézier path or clicked Lasso outline', () => {
  const { tab, click, key, entities, dispose } = setup();
  act(() => { tab.commands.execute('tool.bezier'); });
  click(20, 80); click(60, 80); click(100, 120);
  key('Backspace');
  key('Enter');
  const path = entities().at(-1)!;
  expect(entities()).toHaveLength(4);
  expect(path.points).toEqual([[20, 80], [60, 80]]);
  // Removing the only anchor ends the draft without drawing anything.
  click(20, 150);
  key('Delete');
  key('Enter');
  expect(entities()).toHaveLength(4);
  act(() => { tab.commands.execute('tool.lasso'); });
  const corners = (): number => screen.getByLabelText('Lasso outline').querySelector('polygon')!.getAttribute('points')!.split(' ').length;
  click(5, 5); click(35, 5); click(35, 35);
  const before = corners();
  key('Backspace');
  expect(corners()).toBe(before - 1);
  key('Backspace'); key('Backspace');
  expect(screen.queryByLabelText('Lasso outline')).toBeNull();
  expect(entities()).toHaveLength(4);
  dispose();
});
