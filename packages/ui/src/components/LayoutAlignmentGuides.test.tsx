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
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}) });
  const app = createApp({ demo: false, expose: false }), session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout(), pageId = tab.activePageId;
  tab.commands.execute('layout.grid.set', { snap: false });
  tab.commands.execute('layout.rectangle.add', { pageId, kind: 'rectangle', first: [20, 20], second: [80, 60] });
  render(<LayoutWorkspace tab={tab} session={session} />);
  const canvas = screen.getByLabelText('Page 1 canvas');
  const pointer = (x: number, y: number, shiftKey = false) => ({ pointerId: 1, clientX: x * 3, clientY: y * 3, shiftKey });
  const move = (x: number, y: number, shiftKey = false) => fireEvent.pointerMove(canvas, pointer(x, y, shiftKey));
  const click = (x: number, y: number) => {
    fireEvent.pointerDown(canvas, { button: 0, ...pointer(x, y) });
    fireEvent.pointerUp(canvas, pointer(x, y));
  };
  const guide = () => document.querySelector('.pf-layout-alignment-guide')?.getAttribute('data-axis') ?? null;
  const line = () => [...tab.doc.state.pages.get(pageId)!.entities.values()].at(-1)!;
  act(() => { tab.commands.execute('tool.line'); });
  return { tab, move, click, guide, line, dispose: () => { cleanup(); session.dispose(); app.dispose(); } };
}

it('uses the last touched vertex as a reference for horizontal and vertical guides', () => {
  const { tab, move, click, guide, line, dispose } = setup();
  move(130, 61);
  expect(guide()).toBeNull(); // No vertex touched yet.
  move(80.2, 60.2); // Touch the rectangle's corner.
  expect(guide()).toBeNull();
  const version = tab.doc.version;
  move(130, 61);
  expect(guide()).toBe('horizontal');
  expect(tab.doc.version).toBe(version);
  click(130, 61);
  move(81, 100);
  expect(guide()).toBe('vertical');
  click(81, 100);
  expect(line().points).toEqual([[130, 60], [80, 100]]);
  move(150, 120); // Out of reach of both lines through the reference.
  expect(guide()).toBeNull();
  dispose();
});

it('uses a segment midpoint as a reference', () => {
  const { move, click, guide, line, dispose } = setup();
  move(50.2, 59.8); // The rectangle's bottom midpoint.
  move(130, 61);
  expect(guide()).toBe('horizontal');
  move(51, 100);
  expect(guide()).toBe('vertical');
  click(51, 100); click(150, 120);
  expect(line().points[0]).toEqual([50, 100]);
  dispose();
});

it('does not use an entity center as a reference', () => {
  const { move, guide, dispose } = setup();
  move(50.2, 40.2); // The rectangle's center.
  move(130, 41);
  expect(guide()).toBeNull();
  dispose();
});

it('gives way to Shift, other object snaps, Object Snap off and a tool change', () => {
  const { tab, move, click, guide, dispose } = setup();
  move(80.2, 60.2);
  click(130, 100);
  move(160, 61, true); // Shift constrains from the start point instead.
  expect(guide()).toBeNull();
  move(50.2, 59); // The rectangle's bottom midpoint wins over the alignment.
  expect(guide()).toBeNull();
  act(() => { tab.commands.execute('tool.rectangle'); });
  act(() => { tab.commands.execute('tool.line'); });
  move(160, 61);
  expect(guide()).toBeNull(); // The reference was forgotten.
  act(() => { tab.commands.execute('layout.snap.set', { enabled: false }); });
  move(80.2, 60.2); move(160, 61);
  expect(guide()).toBeNull();
  dispose();
});
