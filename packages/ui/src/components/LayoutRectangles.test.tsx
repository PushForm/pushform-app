// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { openLayoutFile } from '@pushform/io';
import { createLayoutRectangle } from '@pushform/layout';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';
import { enterLayoutValue } from './layoutEntryTesting';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('updates the rectangle outline on modifier changes without moving the pointer', () => {
  const methods = new Map<string | symbol, unknown>();
  const ctx = new Proxy({}, { get: (_, key) => {
    if (!methods.has(key)) methods.set(key, vi.fn());
    return methods.get(key);
  }, set: (_, key, value) => { methods.set(key, value); return true; } });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}),
  });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout();
  tab.commands.execute('layout.grid.set', { snap: false, show: false }); tab.commands.execute('layout.snap.set', { enabled: false });
  render(<LayoutWorkspace tab={tab} session={session} />);
  fireEvent.click(screen.getByRole('button', { name: 'Rectangle' }));
  const canvas = screen.getByLabelText('Page 1 canvas');
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 120, clientY: 120 });
  fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 180, clientY: 150 });
  const moveTo = methods.get('moveTo') as ReturnType<typeof vi.fn>;
  moveTo.mockClear();
  const version = tab.doc.version;
  fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });
  expect(moveTo).toHaveBeenCalledWith(20, 30);
  moveTo.mockClear();
  fireEvent.keyDown(window, { key: 'Shift', ctrlKey: true, shiftKey: true });
  expect(moveTo).toHaveBeenCalledWith(20, 20);
  moveTo.mockClear();
  fireEvent.keyUp(window, { key: 'Control', shiftKey: true });
  expect(moveTo).toHaveBeenCalledWith(40, 40);
  expect(tab.doc.version).toBe(version);
  cleanup(); session.dispose(); app.dispose();
});

it.each([
  ['Rectangle', 'rectangle'], ['Rounded', 'rounded-rectangle'], ['Bulged', 'bulged-rectangle'], ['Lozenge', 'lozenge'],
] as const)('draws %s from its center with a square constraint and accepts full typed dimensions', async (name, kind) => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}),
  });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout();
  tab.commands.execute('layout.grid.set', { snap: false }); tab.commands.execute('layout.snap.set', { enabled: false });
  render(<LayoutWorkspace tab={tab} session={session} />);
  fireEvent.click(screen.getByRole('button', { name: 'Rectangle tools' }));
  fireEvent.click(screen.getByRole('menuitemradio', { name }));
  const canvas = screen.getByLabelText('Page 1 canvas');
  const at = (x: number, y: number, ctrlKey = false, shiftKey = false) => ({ pointerId: 1, clientX: x * 3, clientY: y * 3, ctrlKey, shiftKey });
  const latest = () => [...tab.doc.state.pages.get(tab.activePageId)!.entities.values()].at(-1)!;
  const check = (first: [number, number], second: [number, number]) => {
    const expected = createLayoutRectangle(kind, first, second, 5);
    expect(latest().points).toEqual(expected.points);
    if (expected.handles) expect(latest().handles).toEqual(expected.handles);
  };
  const version = tab.doc.version;
  fireEvent.pointerDown(canvas, { button: 0, ...at(80, 80) });
  fireEvent.pointerMove(canvas, at(60, 70, true, true));
  expect(tab.doc.version).toBe(version);
  fireEvent.pointerUp(canvas, at(60, 70, true, true));
  check([100, 100], [60, 60]);
  const saved = latest();
  act(() => { tab.commands.execute('edit.undo'); });
  expect(tab.doc.state.pages.get(tab.activePageId)!.entities.size).toBe(0);
  act(() => { tab.commands.execute('edit.redo'); });
  expect(latest()).toEqual(saved);
  expect((await openLayoutFile((await session.saveLayoutBytes(tab.id)))).state.pages.get(tab.activePageId)!.entities.get(saved.id)).toEqual(saved);
  // Two-click placement, center only.
  fireEvent.pointerDown(canvas, { button: 0, ...at(80, 80) }); fireEvent.pointerUp(canvas, at(80, 80));
  fireEvent.pointerDown(canvas, { button: 0, ...at(100, 90, true) }); fireEvent.pointerUp(canvas, at(100, 90, true));
  check([60, 70], [100, 90]);
  // Shift alone, with Cmd released before committing.
  fireEvent.pointerDown(canvas, { button: 0, ...at(80, 80) });
  fireEvent.pointerMove(canvas, { ...at(100, 90, false, true), metaKey: true });
  fireEvent.pointerUp(canvas, at(100, 90, false, true));
  check([80, 80], [100, 100]);
  // Full typed dimensions win over Shift and are halved only to construct center extents.
  fireEvent.pointerDown(canvas, { button: 0, ...at(80, 80) }); fireEvent.pointerUp(canvas, at(80, 80));
  fireEvent.keyDown(window, { key: 'Control', ctrlKey: true, shiftKey: true });
  enterLayoutValue('60mm,20mm', { ctrlKey: true, shiftKey: true });
  check([50, 70], [110, 90]);
  cleanup(); session.dispose(); app.dispose();
});

it('chooses rectangle variants from one stack, draws them, accepts measurements, and saves curve controls', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}),
  });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout();
  render(<LayoutWorkspace tab={tab} session={session} />);
  const canvas = screen.getByLabelText('Page 1 canvas');
  const choose = (name: string): void => {
    fireEvent.click(screen.getByRole('button', { name: 'Rectangle tools' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name }));
  };
  const down = (x: number, y: number): void => { fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: x * 3, clientY: y * 3 }); };
  const up = (x: number, y: number): void => { fireEvent.pointerUp(canvas, { pointerId: 1, clientX: x * 3, clientY: y * 3 }); };
  const page = () => tab.doc.state.pages.get(tab.activePageId)!;
  choose('Rounded');
  fireEvent.change(screen.getByLabelText('Corner radius (mm)'), { target: { value: '4' } });
  down(10, 10); up(70, 40);
  const roundedId = page().entityOrder[0]!;
  expect(page().entities.get(roundedId)!.points[0]).toEqual([14, 10]);
  expect(page().entities.get(roundedId)!.handles).toHaveLength(8);
  choose('Bulged');
  expect(screen.queryByRole('button', { name: 'Rounded' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Bulge (mm)'), { target: { value: '3' } });
  down(90, 10); up(130, 40);
  expect(page().entities.get(page().entityOrder[1]!)!.handles![1]!.out![0]).toBe(134);
  choose('Lozenge');
  down(10, 70); up(10, 70);
  enterLayoutValue('60mm,20mm');
  expect(page().entities.size).toBe(3);
  for (const entity of page().entities.values()) expect(entity.style?.fillColor).toBe('#ffffff');
  const lozengeId = page().entityOrder[2]!;
  expect(page().entities.get(lozengeId)!.points).toHaveLength(6);
  act(() => { tab.commands.execute('edit.undo'); }); expect(page().entities.size).toBe(2);
  act(() => { tab.commands.execute('edit.redo'); });
  const reopened = (await openLayoutFile((await session.saveLayoutBytes(tab.id))));
  expect(reopened.state.pages.get(page().id)!.entities.get(lozengeId)).toEqual(page().entities.get(lozengeId));
  // Curves remain native path geometry, so the existing editor can expose their vertices/handles.
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  fireEvent.doubleClick(canvas, { clientX: 120, clientY: 210 });
  expect(screen.getByRole('button', { name: 'Done editing path' })).toBeTruthy();
  session.dispose(); app.dispose();
});
