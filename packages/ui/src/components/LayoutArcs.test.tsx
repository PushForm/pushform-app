// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
  const tab = session.newLayout(); render(<LayoutWorkspace tab={tab} session={session} />);
  const canvas = screen.getByLabelText('Page 1 canvas');
  const click = (x: number, y: number) => {
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: x * 3, clientY: y * 3 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: x * 3, clientY: y * 3 });
  };
  const choose = (name: string) => {
    fireEvent.click(screen.getByRole('button', { name: 'Arc tools' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name }));
  };
  return { app, session, tab, canvas, click, choose, page: () => tab.doc.state.pages.get(tab.activePageId)! };
}

it('places the arc stack after Line, draws all four variants, and saves editable curves', async () => {
  const { app, session, tab, canvas, click, choose, page } = setup();
  const buttons = within(screen.getByRole('navigation', { name: 'Layout tools' })).getAllByRole('button');
  const lineIndex = buttons.findIndex(button => button.getAttribute('aria-label') === 'Line');
  expect(buttons[lineIndex + 1]!.getAttribute('aria-label')).toBe('Line tools');
  expect(buttons[lineIndex + 2]!.getAttribute('aria-label')).toBe('Arc');
  fireEvent.click(screen.getByRole('button', { name: 'Arc tools' }));
  expect(screen.getAllByRole('menuitemradio').map(item => item.textContent?.trim())).toEqual(['Arc', '2 Point ArcA', '3 Point Arc', 'Pie']) // A is 2 Point Arc;
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Arc' }));
  click(30, 30); click(50, 30);
  expect(page().entities.size).toBe(0);
  click(30, 50); expect(page().entities.size).toBe(1);
  choose('2 Point Arc'); click(70, 30); click(110, 30); click(90, 50);
  expect(page().entities.get(page().entityOrder[1]!)!.points).toContainEqual([90, 50]);
  choose('3 Point Arc'); click(20, 90); click(40, 70); click(60, 90);
  expect(page().entities.get(page().entityOrder[2]!)!.points).toContainEqual([40, 70]);
  act(() => { tab.commands.execute('layout.style.setDefault', { fillColor: '#ccddff' }); });
  choose('Pie'); click(90, 90); click(110, 90); click(90, 110);
  const pieId = page().entityOrder[3]!;
  expect(page().entities.get(pieId)).toMatchObject({ closed: true, style: { fillColor: '#ccddff' } });
  act(() => { tab.commands.execute('edit.undo'); }); expect(page().entities.size).toBe(3);
  act(() => { tab.commands.execute('edit.redo'); });
  const reopened = (await openLayoutFile((await session.saveLayoutBytes(tab.id))));
  for (const id of page().entityOrder) {
    expect(reopened.state.pages.get(page().id)!.entities.get(id)).toEqual(page().entities.get(id));
    expect(page().entities.get(id)!.handles!.some(h => h.out)).toBe(true);
  }
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  expect(screen.getByRole('button', { name: 'Pie' })).toBeTruthy();
  fireEvent.doubleClick(canvas, { clientX: 150, clientY: 90 });
  expect(screen.getByRole('button', { name: 'Done editing path' })).toBeTruthy();
  session.dispose(); app.dispose();
});

it('allows correction after invalid placement and cancels on Escape and tool changes', () => {
  const { app, session, canvas, click, choose, page } = setup();
  choose('2 Point Arc'); click(20, 20); click(20, 20);
  expect(screen.getByRole('status').textContent).toContain('different second point');
  click(60, 20); click(40, 20);
  expect(page().entities.size).toBe(0);
  click(40, 40); expect(page().entities.size).toBe(1);
  click(80, 80); fireEvent.keyDown(window, { key: 'Escape' });
  click(80, 100); click(100, 100); expect(page().entities.size).toBe(1);
  fireEvent.keyDown(window, { code: 'KeyL', key: 'l' });
  choose('3 Point Arc'); click(20, 80); click(40, 80);
  expect(page().entities.size).toBe(1);
  click(60, 100); expect(page().entities.size).toBe(2);
  fireEvent.pointerCancel(canvas);
  session.dispose(); app.dispose();
});

it('previews and commits sweeps beyond a semicircle in either direction', () => {
  const { app, session, canvas, click, choose, page } = setup();
  const bezierCurveTo = vi.fn();
  const methods = new Map<string | symbol, unknown>([['bezierCurveTo', bezierCurveTo]]);
  const context = new Proxy({}, {
    get: (_target, key) => {
      if (!methods.has(key)) methods.set(key, vi.fn());
      return methods.get(key);
    },
    set: (_target, key, value) => { methods.set(key, value); return true; },
  });
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(context as CanvasRenderingContext2D);
  choose('Arc');
  click(40, 40); click(60, 40);
  const move = (x: number, y: number) => fireEvent.pointerMove(canvas, { pointerId: 1, clientX: x * 3, clientY: y * 3 });
  move(40, 60); move(20, 40); move(40, 20);
  expect(page().entities.size).toBe(0); expect(bezierCurveTo).toHaveBeenCalled();
  click(40, 20);
  const positive = page().entities.get(page().entityOrder[0]!)!;
  expect(positive.points).toHaveLength(4);
  expect(positive.points[1]![1]).toBeCloseTo(60);
  click(100, 100); click(120, 100);
  move(100, 80); move(80, 100); move(100, 120);
  click(100, 120);
  const negative = page().entities.get(page().entityOrder[1]!)!;
  expect(negative.points).toHaveLength(4);
  expect(negative.points[1]![1]).toBeCloseTo(80);
  session.dispose(); app.dispose();
});
