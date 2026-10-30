// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { cloneLayoutTable } from '@pushform/layout';
import { openLayoutFile } from '@pushform/io';
import type { LayoutEntity } from '@pushform/layout';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';
import { repeatLayoutShape } from './layoutShapeRepeat';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const bounds = (entity: LayoutEntity) => {
  const xs = entity.points.map(p => p[0]), ys = entity.points.map(p => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(v => Math.round(v * 1000) / 1000);
};

it('moves a repeated shape so its first placement point lands on the click, curve controls included', () => {
  expect(repeatLayoutShape({ anchor: [10, 10], rectangle: { kind: 'rounded-rectangle', first: [10, 10], second: [30, 20], amountMm: 2 } }, 7, [50, 60]))
    .toEqual({ id: 'layout.rectangle.add', params: { pageId: 7, kind: 'rounded-rectangle', first: [50, 60], second: [70, 70], amountMm: 2 } });
  expect(repeatLayoutShape({ anchor: [0, 0], shape: { points: [[1, 0], [0, 1]], handles: [{ out: [1, 1] }, {}], closed: true } }, 7, [5, 5]))
    .toEqual({ id: 'layout.shape.add', params: { pageId: 7, points: [[6, 5], [5, 6]], handles: [{ out: [6, 6] }, {}], closed: true } });
});

it('repeats each tool\'s last shape on a double-click, from the point where it was started, across tool switches', () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}),
  });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout();
  tab.commands.execute('layout.grid.set', { snap: false, show: false }); tab.commands.execute('layout.snap.set', { enabled: false });
  render(<LayoutWorkspace tab={tab} session={session} />);
  const canvas = screen.getByLabelText('Page 1 canvas');
  // The page is 297 mm across 891 px: 3 px per mm.
  const at = (x: number, y: number) => ({ button: 0, pointerId: 1, clientX: x * 3, clientY: y * 3 });
  const drag = (from: [number, number], to: [number, number]) => {
    fireEvent.pointerDown(canvas, at(...from)); fireEvent.pointerMove(canvas, at(...to)); fireEvent.pointerUp(canvas, at(...to));
  };
  const doubleClick = (x: number, y: number) => {
    for (let i = 0; i < 2; i++) { fireEvent.pointerDown(canvas, at(x, y)); fireEvent.pointerUp(canvas, at(x, y)); }
    fireEvent.doubleClick(canvas, at(x, y));
  };
  const entities = () => [...tab.doc.state.pages.get(tab.activePageId)!.entities.values()];

  // Nothing drawn yet: a double-click draws nothing.
  fireEvent.click(screen.getByRole('button', { name: 'Rectangle' }));
  doubleClick(150, 100);
  expect(entities()).toHaveLength(0);

  // Drawn from its bottom-right corner, so the copy's bottom-right corner is at the click.
  drag([60, 40], [20, 20]);
  doubleClick(100, 80);
  expect(entities()).toHaveLength(2);
  expect(bounds(entities().at(-1)!)).toEqual([60, 60, 100, 80]);

  fireEvent.click(screen.getByRole('button', { name: 'Circle' }));
  drag([150, 100], [160, 100]);
  doubleClick(250, 50);
  expect(entities()).toHaveLength(4);
  expect(bounds(entities().at(-1)!)).toEqual([240, 40, 260, 60]);

  // Rectangle still remembers its own last shape after Circle was used.
  fireEvent.click(screen.getByRole('button', { name: 'Rectangle' }));
  doubleClick(200, 150);
  expect(bounds(entities().at(-1)!)).toEqual([160, 130, 200, 150]);
  expect(entities()).toHaveLength(5);
  tab.commands.execute('edit.undo');
  expect(entities()).toHaveLength(4);
  cleanup(); session.dispose(); app.dispose();
});

it('repeats the last created object only with a drawing tool active, preserving table edits and Select double-click editing', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}),
  });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null), tab = session.newLayout();
  const pageId = tab.activePageId, entities = () => [...tab.doc.state.pages.get(pageId)!.entities.values()];
  render(<LayoutWorkspace tab={tab} session={session} />);
  const canvas = screen.getByLabelText('Page 1 canvas');
  const doubleClick = (x: number, y: number) => {
    for (let i = 0; i < 2; i++) {
      fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: x * 3, clientY: y * 3 });
      fireEvent.pointerUp(canvas, { pointerId: 1, clientX: x * 3, clientY: y * 3 });
    }
    fireEvent.doubleClick(canvas, { clientX: x * 3, clientY: y * 3 });
  };
  doubleClick(150, 100); expect(entities()).toHaveLength(0);
  act(() => {
    const id = tab.commands.execute('layout.table.add', { pageId, first: [10, 10], second: [70, 50], rows: 2, columns: 3 }) as number;
    const table = cloneLayoutTable(entities()[0]!.table!);
    table.cells[0]!.text.content = 'Heading'; table.cells[0]!.fillColor = '#123456';
    tab.commands.execute('layout.table.update', { pageId, entityId: id, table });
  });
  const source = entities()[0]!;
  doubleClick(150, 100);
  expect(entities()).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Table', pressed: false }));
  doubleClick(150, 100);
  expect(entities()).toHaveLength(2);
  const copy = entities()[1]!;
  expect(copy.id).not.toBe(source.id); expect(copy.table).toEqual(source.table);
  expect(bounds(copy)).toEqual([120, 80, 180, 120]);
  expect(entities()[0]).toBe(source);
  expect(canvas.getAttribute('data-tool')).toBe('table');
  expect((await openLayoutFile((await session.saveLayoutBytes(tab.id)))).state.pages.get(pageId)!.entities.get(copy.id)).toEqual(copy);
  act(() => { tab.commands.execute('edit.undo'); }); expect(entities()).toHaveLength(1);
  doubleClick(230, 100); expect(entities()).toHaveLength(2); expect(bounds(entities()[1]!)).toEqual([200, 80, 260, 120]);
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  doubleClick(150, 150); expect(entities()).toHaveLength(2);
  doubleClick(20, 20);
  expect(entities()).toHaveLength(2); expect(screen.getByLabelText('Edit table cell on page')).toBeTruthy();
  fireEvent.keyDown(screen.getByLabelText('Edit table cell on page'), { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: 'Table', pressed: false }));
  act(() => { tab.commands.execute('layout.layer.setVisible', { layerId: tab.doc.state.activeLayerId, visible: false }); });
  const before = tab.doc.state;
  doubleClick(150, 150);
  expect(tab.doc.state).toBe(before); expect(screen.getByRole('alert').textContent).toContain('unavailable');
  cleanup(); session.dispose(); app.dispose();
});
