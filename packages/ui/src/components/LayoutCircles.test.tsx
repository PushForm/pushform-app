// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { openLayoutFile } from '@pushform/io';
import { flattenLayoutPath, type LayoutEntity } from '@pushform/layout';
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
  const tab = session.newLayout();
  tab.commands.execute('layout.grid.set', { snap: false }); tab.commands.execute('layout.snap.set', { enabled: false });
  render(<LayoutWorkspace tab={tab} session={session} />);
  const canvas = screen.getByLabelText('Page 1 canvas');
  // 3 screen pixels per paper millimeter.
  const at = (x: number, y: number, keys: { shiftKey?: boolean; ctrlKey?: boolean } = {}) => ({ pointerId: 1, clientX: x * 3, clientY: y * 3, ...keys });
  const drag = (from: [number, number], to: [number, number], keys: { shiftKey?: boolean; ctrlKey?: boolean } = {}) => {
    fireEvent.pointerDown(canvas, { button: 0, ...at(...from, keys) });
    fireEvent.pointerMove(canvas, at(...to, keys));
    fireEvent.pointerUp(canvas, at(...to, keys));
  };
  const latest = () => [...tab.doc.state.pages.get(tab.activePageId)!.entities.values()].at(-1)!;
  return { app, session, tab, canvas, drag, latest };
}

/** Every point along the drawn curve satisfies the ellipse equation. */
function expectOnEllipse(entity: LayoutEntity, center: [number, number], rx: number, ry: number): void {
  expect(entity).toMatchObject({ kind: 'path', closed: true, style: { fillColor: '#ffffff' } });
  expect(entity.points).toHaveLength(4);
  expect(entity.handles).toHaveLength(4);
  for (const p of flattenLayoutPath(entity.points, entity.handles, true)) {
    expect(Math.abs(Math.hypot((p[0] - center[0]) / rx, (p[1] - center[1]) / ry) - 1)).toBeLessThan(0.001);
  }
}

it('draws a circle as four Bézier curves from its center and radius, undoably and persistently', async () => {
  const { app, session, tab, drag, latest } = setup();
  act(() => { tab.commands.execute('tool.circle'); });
  expect(screen.getByText(/Click the center, then a point on the circle/)).toBeTruthy();
  drag([60, 60], [60, 80]);
  const circle = latest();
  expectOnEllipse(circle, [60, 60], 20, 20);
  // A typed radius keeps the drag direction.
  fireEvent.pointerDown(screen.getByLabelText('Page 1 canvas'), { button: 0, pointerId: 1, clientX: 450, clientY: 300 });
  fireEvent.pointerUp(screen.getByLabelText('Page 1 canvas'), { pointerId: 1, clientX: 450, clientY: 300 });
  fireEvent.pointerMove(screen.getByLabelText('Page 1 canvas'), { pointerId: 1, clientX: 450, clientY: 330 });
  const measurements = screen.getByLabelText('Layout Measurements');
  fireEvent.change(measurements, { target: { value: '15mm' } });
  fireEvent.keyDown(measurements, { key: 'Enter' });
  expectOnEllipse(latest(), [150, 100], 15, 15);
  expect(latest().points[1]).toEqual([150, 115]);
  act(() => { tab.commands.execute('edit.undo'); });
  expect(latest().id).toBe(circle.id);
  expect((await openLayoutFile((await session.saveLayoutBytes(tab.id)))).state.pages.get(tab.activePageId)!.entities.get(circle.id)).toEqual(circle);
  cleanup(); session.dispose(); app.dispose();
});

it('draws an ellipse in the box between two corners, from the center with Ctrl, and as a circle with Shift', () => {
  const { app, session, tab, drag, latest } = setup();
  act(() => { tab.commands.execute('tool.ellipse'); });
  expect(screen.getByText(/Hold Shift for a circle/)).toBeTruthy();
  drag([20, 20], [80, 50]);
  expectOnEllipse(latest(), [50, 35], 30, 15);
  drag([150, 100], [180, 110], { ctrlKey: true });
  expectOnEllipse(latest(), [150, 100], 30, 10);
  drag([20, 120], [60, 130], { shiftKey: true });
  expectOnEllipse(latest(), [40, 140], 20, 20);
  // A flat box draws nothing; the first corner waits for a second click until Esc.
  const count = tab.doc.state.pages.get(tab.activePageId)!.entities.size;
  drag([20, 180], [60, 180]);
  expect(tab.doc.state.pages.get(tab.activePageId)!.entities.size).toBe(count);
  fireEvent.keyDown(window, { key: 'Escape' });
  // Width and height in Measurements.
  fireEvent.pointerDown(screen.getByLabelText('Page 1 canvas'), { button: 0, pointerId: 1, clientX: 600, clientY: 300 });
  fireEvent.pointerUp(screen.getByLabelText('Page 1 canvas'), { pointerId: 1, clientX: 600, clientY: 300 });
  fireEvent.pointerMove(screen.getByLabelText('Page 1 canvas'), { pointerId: 1, clientX: 630, clientY: 330 });
  const measurements = screen.getByLabelText('Layout Measurements');
  fireEvent.change(measurements, { target: { value: '40mm,10mm' } });
  fireEvent.keyDown(measurements, { key: 'Enter' });
  expectOnEllipse(latest(), [220, 105], 20, 5);
  cleanup(); session.dispose(); app.dispose();
});
