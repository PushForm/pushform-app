// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { openLayoutFile } from '@pushform/io';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';
import { enterLayoutValue } from './layoutEntryTesting';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function setupLineConstraint() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}),
  });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout();
  tab.commands.execute('layout.grid.set', { snap: false });
  tab.commands.execute('layout.snap.set', { enabled: false });
  render(<LayoutWorkspace tab={tab} session={session} />);
  const canvas = screen.getByLabelText('Page 1 canvas');
  fireEvent.click(screen.getByRole('button', { name: 'Line' }));
  const pointer = (x: number, y: number, shiftKey = false) => ({ pointerId: 1, clientX: x * 3, clientY: y * 3, shiftKey });
  const click = (x: number, y: number, shiftKey = false) => {
    fireEvent.pointerDown(canvas, { button: 0, ...pointer(x, y, shiftKey) });
    fireEvent.pointerUp(canvas, pointer(x, y, shiftKey));
  };
  const entity = () => [...tab.doc.state.pages.get(tab.activePageId)!.entities.values()][0]!;
  const measure = (value: string) => enterLayoutValue(value);
  return { tab, session, canvas, pointer, click, entity, measure, dispose: () => { cleanup(); session.dispose(); app.dispose(); } };
}

it('constrains dragged and chained line segments to either axis and uses Shift state on release', async () => {
  const { tab, session, canvas, pointer, click, entity, dispose } = setupLineConstraint();
  const version = tab.doc.version;
  fireEvent.pointerDown(canvas, { button: 0, ...pointer(10, 10) });
  fireEvent.pointerMove(canvas, pointer(50, 20, true));
  expect(tab.doc.version).toBe(version);
  fireEvent.pointerUp(canvas, pointer(50, 20, true));
  expect(entity().points).toEqual([[10, 10], [50, 10]]);
  click(60, 50, true);
  expect(entity().points).toEqual([[10, 10], [50, 10], [50, 50]]);
  fireEvent.pointerDown(canvas, { button: 0, ...pointer(80, 60, true) });
  fireEvent.pointerUp(canvas, pointer(80, 60));
  expect(entity().points.at(-1)).toEqual([80, 60]);
  act(() => { tab.commands.execute('edit.undo'); });
  expect(entity().points.at(-1)).toEqual([50, 50]);
  act(() => { tab.commands.execute('edit.redo'); });
  expect((await openLayoutFile((await session.saveLayoutBytes(tab.id)))).state.pages.get(tab.activePageId)!.entities.get(entity().id)?.points).toEqual(entity().points);
  dispose();
});

it.each([true, false])('updates a stationary line preview on Shift transitions before typed length (held: %s)', (held) => {
  const { canvas, pointer, click, entity, measure, dispose } = setupLineConstraint();
  click(10, 10);
  fireEvent.pointerMove(canvas, pointer(40, 50));
  fireEvent.keyDown(window, { key: 'Shift', shiftKey: true });
  if (!held) fireEvent.keyUp(window, { key: 'Shift' });
  measure('50mm');
  expect(entity().points).toEqual(held ? [[10, 10], [10, 60]] : [[10, 10], [40, 50]]);
  dispose();
});

it('closes a line chain into one filled object that can be picked inside, moved, undone, and reopened', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}),
  });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout();
  render(<LayoutWorkspace tab={tab} session={session} />);
  const canvas = screen.getByLabelText('Page 1 canvas');
  const click = (x: number, y: number): void => {
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: x * 3, clientY: y * 3 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: x * 3, clientY: y * 3 });
  };
  fireEvent.click(screen.getByRole('button', { name: 'Line' }));
  click(10, 10); click(50, 10); click(50, 40); click(10, 40); click(10, 10);
  const page = () => tab.doc.state.pages.get(tab.activePageId)!;
  const entity = () => page().entities.get(page().entityOrder[0]!)!;
  expect(page().entities.size).toBe(1);
  expect(entity()).toMatchObject({ closed: true, style: { fillColor: '#ffffff' },
    points: [[10, 10], [50, 10], [50, 40], [10, 40]] });
  expect(tab.workspace.anchor).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  click(30, 25);
  expect(screen.getByText(`Path #${entity().id} · 4 points`)).toBeTruthy();
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 2, clientX: 90, clientY: 75 });
  fireEvent.pointerMove(canvas, { pointerId: 2, clientX: 120, clientY: 75 });
  fireEvent.pointerUp(canvas, { pointerId: 2, clientX: 120, clientY: 75 });
  expect(entity().points[0]).toEqual([20, 10]);
  act(() => { tab.commands.execute('edit.undo'); });
  expect(entity().points[0]).toEqual([10, 10]);
  const reopened = (await openLayoutFile((await session.saveLayoutBytes(tab.id))));
  expect(reopened.state.pages.get(page().id)!.entities.get(entity().id)).toEqual(entity());
  session.dispose(); app.dispose();
});
