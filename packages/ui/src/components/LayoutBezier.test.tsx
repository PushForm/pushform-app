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
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}) });
  const app = createApp({ demo: false, expose: false }), session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout(), pageId = tab.activePageId;
  tab.commands.execute('layout.grid.set', { snap: false });
  render(<LayoutWorkspace tab={tab} session={session} />);
  const canvas = screen.getByLabelText('Page 1 canvas');
  const pointer = (x: number, y: number, buttons = 0) => ({ pointerId: 1, clientX: x * 3, clientY: y * 3, buttons });
  const click = (x: number, y: number) => {
    fireEvent.pointerDown(canvas, { button: 0, ...pointer(x, y, 1) });
    fireEvent.pointerUp(canvas, pointer(x, y));
  };
  /** Press at (x, y) and drag to the handle position before releasing. */
  const drag = (x: number, y: number, hx: number, hy: number) => {
    fireEvent.pointerDown(canvas, { button: 0, ...pointer(x, y, 1) });
    fireEvent.pointerMove(canvas, pointer(hx, hy, 1));
    fireEvent.pointerUp(canvas, pointer(hx, hy));
  };
  const entities = () => [...tab.doc.state.pages.get(pageId)!.entities.values()];
  act(() => { tab.commands.execute('tool.bezier'); });
  return { tab, session, pageId, canvas, pointer, click, drag, entities, dispose: () => { cleanup(); session.dispose(); app.dispose(); } };
}

it('sits in the Line stack after Line', () => {
  const { dispose } = setup();
  expect(screen.getByLabelText('Page 1 canvas').getAttribute('data-tool')).toBe('bezier');
  fireEvent.click(screen.getByRole('button', { name: 'Line tools' }));
  expect(screen.getAllByRole('menuitemradio').map(item => item.getAttribute('aria-label'))).toEqual(['Line', 'Bézier Curve', 'Freehand']);
  dispose();
});

it('places corners by clicking and smooth anchors by dragging, ending with Enter as one undoable path', async () => {
  const { tab, session, pageId, canvas, pointer, click, drag, entities, dispose } = setup();
  click(20, 20);
  drag(60, 20, 70, 30);
  fireEvent.pointerMove(canvas, pointer(100, 60)); // Previews only.
  expect(entities()).toHaveLength(0);
  click(100, 60);
  fireEvent.keyDown(window, { key: 'Enter' });
  expect(entities()).toHaveLength(1);
  const path = entities()[0]!;
  expect(path.points).toEqual([[20, 20], [60, 20], [100, 60]]);
  expect(path.handles).toEqual([{}, { in: [50, 10], out: [70, 30] }, {}]);
  expect(path.closed).toBe(false);
  expect((await openLayoutFile((await session.saveLayoutBytes(tab.id)))).state.pages.get(pageId)!.entities.get(path.id)?.handles).toEqual(path.handles);
  act(() => { tab.commands.execute('edit.undo'); });
  expect(entities()).toHaveLength(0);
  dispose();
});

it('closes into a filled shape on the first anchor, and a double-click or Esc ends an open curve', () => {
  const { click, drag, entities, dispose } = setup();
  drag(20, 20, 30, 10);
  click(60, 20);
  click(40, 50);
  click(20.3, 20.3); // The first anchor.
  expect(entities()).toHaveLength(1);
  expect(entities()[0]).toMatchObject({ closed: true, handles: [{ in: [10, 30], out: [30, 10] }, {}, {}] });
  expect(entities()[0]!.style?.fillColor).toBeTruthy();
  click(120, 20); click(150, 40); click(150, 40); // A double-click lands on the last anchor.
  expect(entities()).toHaveLength(2);
  expect(entities()[1]).toMatchObject({ points: [[120, 20], [150, 40]], closed: false });
  click(120, 100); click(150, 100);
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(entities()).toHaveLength(3);
  click(200, 100);
  fireEvent.keyDown(window, { key: 'Escape' }); // One anchor draws nothing.
  expect(entities()).toHaveLength(3);
  dispose();
});

it('forgets an unfinished curve when the tool changes', () => {
  const { tab, click, entities, dispose } = setup();
  click(20, 20); click(60, 20);
  act(() => { tab.commands.execute('tool.line'); });
  act(() => { tab.commands.execute('tool.bezier'); });
  fireEvent.keyDown(window, { key: 'Enter' });
  expect(entities()).toHaveLength(0);
  dispose();
});
