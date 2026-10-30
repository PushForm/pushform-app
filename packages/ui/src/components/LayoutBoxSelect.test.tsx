// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  const a = tab.commands.execute('layout.shape.add', { pageId, points: [[10, 10], [30, 10], [30, 30], [10, 30]], closed: true }) as number;
  const b = tab.commands.execute('layout.shape.add', { pageId, points: [[50, 10], [70, 10], [70, 30], [50, 30]], closed: true }) as number;
  const c = tab.commands.execute('layout.shape.add', { pageId, points: [[40, 50], [90, 50]] }) as number;
  render(<LayoutWorkspace tab={tab} session={session} />);
  const canvas = screen.getByLabelText('Page 1 canvas');
  const press = (x: number, y: number, init: Record<string, unknown> = {}) =>
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: x * 3, clientY: y * 3, ...init });
  const drag = (x: number, y: number, init: Record<string, unknown> = {}) =>
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: x * 3, clientY: y * 3, ...init });
  const release = (x: number, y: number, init: Record<string, unknown> = {}) =>
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: x * 3, clientY: y * 3, ...init });
  const click = (x: number, y: number, init: Record<string, unknown> = {}): void => { press(x, y, init); release(x, y, init); };
  const points = (id: number) => tab.doc.state.pages.get(pageId)!.entities.get(id)?.points;
  const dispose = (): void => { session.dispose(); app.dispose(); };
  return { tab, pageId, a, b, c, press, drag, release, click, points, dispose };
}

it('selects enclosed objects left to right, touched objects right to left, and toggles with Shift', () => {
  const { press, drag, release, click, dispose } = setup();
  press(5, 5); drag(75, 35);
  expect(screen.getByLabelText('Selection box').getAttribute('data-mode')).toBe('window');
  release(75, 35);
  expect(screen.queryByLabelText('Selection box')).toBeNull();
  expect(screen.getByLabelText('Selected objects bounds')).toBeTruthy();
  expect(screen.getByText('2 objects selected')).toBeTruthy();
  // A plain click on empty paper clears the selection.
  click(150, 150);
  expect(screen.queryByLabelText('Selected objects bounds')).toBeNull();
  // Right to left: the line is only touched, the square is not reached.
  press(95, 55); drag(60, 45);
  expect(screen.getByLabelText('Selection box').getAttribute('data-mode')).toBe('crossing');
  release(60, 45);
  expect(screen.getByLabelText('Selected object bounds')).toBeTruthy();
  expect(screen.getByText(/Path #\d+ · 2 points/)).toBeTruthy();
  click(20, 20, { shiftKey: true });
  expect(screen.getByText('2 objects selected')).toBeTruthy();
  click(20, 20, { shiftKey: true });
  expect(screen.getByText(/Path #\d+ · 2 points/)).toBeTruthy();
  // Shift while boxing adds to the selection; Escape abandons an unfinished box.
  press(5, 5, { shiftKey: true }); drag(35, 35, { shiftKey: true }); release(35, 35, { shiftKey: true });
  expect(screen.getByText('2 objects selected')).toBeTruthy();
  press(150, 150); drag(5, 5);
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByLabelText('Selection box')).toBeNull();
  release(5, 5);
  expect(screen.getByText('2 objects selected')).toBeTruthy();
  dispose();
});

it('moves and erases a multi-selection as single undoable steps, leaving locked members in place', () => {
  const { tab, a, b, c, press, drag, release, points, dispose } = setup();
  press(5, 5); drag(75, 35); release(75, 35);
  expect(screen.getByText('2 objects selected')).toBeTruthy();
  const version = tab.doc.version;
  press(20, 20); drag(26, 26);
  expect(tab.doc.version).toBe(version);
  release(26, 26);
  expect(points(a)![0]).toEqual([16, 16]);
  expect(points(b)![0]).toEqual([56, 16]);
  expect(points(c)![0]).toEqual([40, 50]);
  expect(screen.getByText('2 objects selected')).toBeTruthy();
  act(() => { tab.commands.execute('edit.undo'); });
  expect(points(a)![0]).toEqual([10, 10]);
  expect(points(b)![0]).toEqual([50, 10]);
  fireEvent.keyDown(window, { key: 'Delete' });
  expect(points(a)).toBeUndefined();
  expect(points(b)).toBeUndefined();
  expect(points(c)).toBeDefined();
  act(() => { tab.commands.execute('edit.undo'); });
  expect(points(a)).toBeDefined();
  expect(points(b)).toBeDefined();
  // A locked layer's objects can be box-selected but stay put during a group move and erase.
  const lockedLayer = tab.commands.execute('layout.layer.add', { name: 'Fixed' }) as number;
  act(() => {
    tab.commands.execute('layout.shape.assignLayer', { pageId: tab.activePageId, entityId: b, layerId: lockedLayer });
    tab.commands.execute('layout.layer.setLocked', { layerId: lockedLayer, locked: true });
  });
  press(5, 5); drag(75, 35); release(75, 35);
  expect(screen.getByText('2 objects selected')).toBeTruthy();
  press(20, 20); drag(26, 26); release(26, 26);
  expect(points(a)![0]).toEqual([16, 16]);
  expect(points(b)![0]).toEqual([50, 10]);
  expect(screen.getByText('2 objects selected')).toBeTruthy();
  fireEvent.keyDown(window, { key: 'Delete' });
  expect(points(a)).toBeUndefined();
  expect(points(b)).toBeDefined();
  dispose();
});
