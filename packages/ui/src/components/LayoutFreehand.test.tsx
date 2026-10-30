// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { openLayoutFile } from '@pushform/io';
import { createLayoutFreehand, type PaperPathPoint } from '@pushform/layout';
import { FREEHAND_SMOOTHING_PX } from '@pushform/core';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function setup() {
  const methods = new Map<string | symbol, unknown>([['measureText', () => ({ width: 5 })]]);
  const ctx = new Proxy({}, { get: (_, key) => { if (!methods.has(key)) methods.set(key, vi.fn()); return methods.get(key); },
    set: (_, key, value) => { methods.set(key, value); return true; } });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}),
  });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout();
  tab.commands.execute('layout.grid.set', { snap: false });
  tab.commands.execute('layout.snap.set', { enabled: false });
  render(<LayoutWorkspace tab={tab} session={session} />);
  act(() => { tab.commands.execute('tool.freehand'); });
  const canvas = screen.getByLabelText('Page 1 canvas');
  const at = (x: number, y: number) => ({ pointerId: 1, clientX: x * 3, clientY: y * 3 });
  const entities = () => [...tab.doc.state.pages.get(tab.activePageId)!.entities.values()];
  return { app, session, tab, canvas, at, entities, methods };
}

it('commits a smoothed curve once on release, editable and persistent through undo/redo', async () => {
  const { app, session, tab, canvas, at, entities, methods } = setup();
  const before = tab.doc.state;
  fireEvent.pointerDown(canvas, { button: 0, ...at(20, 30) });
  for (let i = 1; i <= 40; i++) fireEvent.pointerMove(canvas, at(20 + i, 30 + 15 * Math.sin(i * Math.PI / 50)));
  expect(tab.doc.state).toBe(before);
  expect(methods.get('bezierCurveTo')).toHaveBeenCalled();
  fireEvent.pointerUp(canvas, at(70, 30));
  expect(entities()).toHaveLength(1);
  const stroke = entities()[0]!;
  expect(stroke).toMatchObject({ kind: 'path', closed: false, style: { fillColor: null } });
  expect(stroke.points.length).toBeLessThan(20);
  expect(stroke.points[0]).toEqual([20, 30]);
  expect(stroke.points.at(-1)).toEqual([70, 30]);
  expect(stroke.handles?.some(h => h.in || h.out)).toBe(true);
  expect((await openLayoutFile((await session.saveLayoutBytes(tab.id)))).state.pages.get(tab.activePageId)!.entities.get(stroke.id)).toEqual(stroke);
  act(() => { tab.commands.execute('edit.undo'); });
  expect(entities()).toHaveLength(0);
  act(() => { tab.commands.execute('edit.redo'); });
  expect(entities()).toEqual([stroke]);
  act(() => { tab.commands.execute('tool.select'); });
  fireEvent.doubleClick(canvas, at(20, 30));
  expect(screen.getByText(/Drag anchors or curve handles/)).toBeTruthy();
  cleanup(); session.dispose(); app.dispose();
});

it('discards cancelled strokes and clicks, includes a release without moves, and retains loops', () => {
  const { app, session, tab, canvas, at, entities } = setup();
  fireEvent.pointerDown(canvas, { button: 0, ...at(20, 30) });
  fireEvent.pointerUp(canvas, at(20, 30));
  expect(entities()).toHaveLength(0);
  for (const cancel of ['escape', 'pointer', 'tool'] as const) {
    fireEvent.pointerDown(canvas, { button: 0, ...at(20, 30) });
    fireEvent.pointerMove(canvas, at(40, 50));
    if (cancel === 'escape') fireEvent.keyDown(window, { key: 'Escape' });
    else if (cancel === 'pointer') fireEvent.pointerCancel(canvas, at(40, 50));
    else act(() => { tab.commands.execute('tool.line'); });
    fireEvent.pointerUp(canvas, at(60, 30));
    expect(entities()).toHaveLength(0);
    act(() => { tab.commands.execute('tool.freehand'); });
  }
  fireEvent.pointerDown(canvas, { button: 0, ...at(20, 30) });
  fireEvent.pointerUp(canvas, at(40, 30));
  expect(entities()[0]!.points).toEqual([[20, 30], [40, 30]]);
  fireEvent.pointerDown(canvas, { button: 0, ...at(80, 30) });
  fireEvent.pointerMove(canvas, at(100, 30));
  fireEvent.pointerMove(canvas, at(100, 50));
  fireEvent.pointerMove(canvas, at(80, 50));
  fireEvent.pointerUp(canvas, at(80, 30));
  expect(entities()).toHaveLength(2);
  expect(entities()[1]).toMatchObject({ closed: false, style: { fillColor: null } });
  expect(entities()[1]!.points[0]).toEqual(entities()[1]!.points.at(-1));
  cleanup(); session.dispose(); app.dispose();
});

it.each([false, true])('ignores grid and object snapping throughout a stroke with Object Snap %s', objectSnap => {
  const { app, session, tab, canvas, at, entities } = setup();
  act(() => {
    tab.commands.execute('layout.grid.set', { snap: true, spacingMm: 10 });
    tab.commands.execute('layout.snap.set', { enabled: objectSnap });
    tab.commands.execute('layout.rectangle.add', { pageId: tab.activePageId, kind: 'rectangle', first: [20, 20], second: [80, 60] });
  });
  // Near an endpoint, midpoint, center, edge, and grid point; every sample stays unsnapped.
  const samples: PaperPathPoint[] = [[20.5, 20.5], [50.5, 20.5], [50.5, 40.5], [35.5, 20.5], [110.5, 90.5], [80.5, 60.5]];
  fireEvent.pointerMove(canvas, at(...samples[0]!));
  expect(document.querySelector('.pf-layout-placement-marker')?.getAttribute('data-snap')).toBe('none');
  fireEvent.pointerDown(canvas, { button: 0, ...at(...samples[0]!) });
  for (const sample of samples.slice(1, -1)) {
    fireEvent.pointerMove(canvas, at(...sample));
    expect(document.querySelector('.pf-layout-placement-marker')?.getAttribute('data-snap')).toBe('none');
    expect(screen.queryByRole('tooltip', { name: 'Snap type' })).toBeNull();
  }
  fireEvent.pointerUp(canvas, at(...samples.at(-1)!));
  const expected = createLayoutFreehand(samples, FREEHAND_SMOOTHING_PX / 3);
  expect(entities().at(-1)).toMatchObject(expected);
  expect(tab.doc.state.settings.grid.snap).toBe(true);
  cleanup(); session.dispose(); app.dispose();
});
