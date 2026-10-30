// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/** Two squares (10–30 and 50–70 across, 10–30 down) and a line at y = 50 from x = 40 to 90, as in LayoutBoxSelect. */
function setup() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}),
  });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout(), pageId = tab.activePageId;
  tab.commands.execute('layout.shape.add', { pageId, points: [[10, 10], [30, 10], [30, 30], [10, 30]], closed: true });
  tab.commands.execute('layout.shape.add', { pageId, points: [[50, 10], [70, 10], [70, 30], [50, 30]], closed: true });
  tab.commands.execute('layout.shape.add', { pageId, points: [[40, 50], [90, 50]] });
  render(<LayoutWorkspace tab={tab} session={session} />);
  const canvas = screen.getByLabelText('Page 1 canvas');
  const at = (x: number, y: number, init: Record<string, unknown> = {}) => ({ button: 0, pointerId: 1, clientX: x * 3, clientY: y * 3, ...init });
  const press = (x: number, y: number, init: Record<string, unknown> = {}) => fireEvent.pointerDown(canvas, at(x, y, init));
  const drag = (x: number, y: number, init: Record<string, unknown> = {}) => fireEvent.pointerMove(canvas, at(x, y, { buttons: 1, ...init }));
  const release = (x: number, y: number, init: Record<string, unknown> = {}) => fireEvent.pointerUp(canvas, at(x, y, init));
  const click = (x: number, y: number, init: Record<string, unknown> = {}): void => { press(x, y, init); release(x, y, init); };
  const outline = () => screen.queryByLabelText('Lasso outline');
  const dispose = (): void => { session.dispose(); app.dispose(); };
  return { canvas, press, drag, release, click, outline, dispose };
}

it('Shift+Space picks the Lasso; a freehand outline closes on release and selects by direction', () => {
  const { canvas, press, drag, release, click, outline, dispose } = setup();
  fireEvent.keyDown(window, { key: ' ', code: 'Space', shiftKey: true });
  expect(canvas.getAttribute('data-tool')).toBe('lasso');
  // Down, then right, then up the page: counterclockwise, so only the enclosed square is selected.
  press(5, 5); drag(5, 35); drag(35, 35); drag(35, 5);
  expect(outline()?.getAttribute('data-mode')).toBe('window');
  release(35, 5);
  expect(outline()).toBeNull();
  expect(screen.getByText(/Path #\d+ · 4 points/)).toBeTruthy();
  // Clockwise over the line only: it touches the line, which replaces the selection.
  press(45, 45); drag(95, 45); drag(95, 55); drag(45, 55);
  expect(outline()?.getAttribute('data-mode')).toBe('crossing');
  release(45, 55);
  expect(screen.getByText(/Path #\d+ · 2 points/)).toBeTruthy();
  // Space returns to Select; the outline belongs to the Lasso.
  click(150, 150);
  fireEvent.keyDown(window, { key: ' ', code: 'Space' });
  expect(canvas.getAttribute('data-tool')).toBe('select');
  dispose();
});

it('clicked points close on double-click or Enter with Select-click modifiers; Escape drops the outline', () => {
  const { canvas, click, outline, dispose } = setup();
  fireEvent.keyDown(window, { key: ' ', code: 'Space', shiftKey: true });
  // Counterclockwise around the left square, closed by a double-click.
  for (const [x, y] of [[5, 5], [5, 35], [35, 35], [35, 5]] as const) click(x, y);
  fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 40 * 3, clientY: 5 * 3 });
  expect(outline()?.querySelector('polygon')?.getAttribute('points')?.split(' ')).toHaveLength(5);
  click(35, 5); // the double-click's second click adds no point
  fireEvent.doubleClick(canvas, { clientX: 35 * 3, clientY: 5 * 3 });
  expect(screen.getByText(/Path #\d+ · 4 points/)).toBeTruthy();
  // Ctrl adds what a clockwise outline over the line touches, closed with Enter.
  for (const [x, y] of [[45, 45], [95, 45], [95, 55]] as const) click(x, y);
  fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
  expect(screen.getByText('2 objects selected')).toBeTruthy();
  // Ctrl+Shift removes it again.
  for (const [x, y] of [[45, 45], [95, 45], [95, 55]] as const) click(x, y);
  fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true, shiftKey: true });
  expect(screen.getByText(/Path #\d+ · 4 points/)).toBeTruthy();
  // Escape drops an unfinished outline; two points select nothing.
  click(45, 45); click(95, 45);
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(outline()).toBeNull();
  click(45, 45); click(95, 45);
  fireEvent.doubleClick(canvas, { clientX: 95 * 3, clientY: 45 * 3 });
  expect(screen.getByText(/Path #\d+ · 4 points/)).toBeTruthy();
  dispose();
});
