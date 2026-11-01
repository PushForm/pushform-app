// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { openLayoutFile } from '@pushform/io';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';
import { enterLayoutValue, openLayoutEntry } from './layoutEntryTesting';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each(['polygon', 'circumscribed-polygon'])('previews a reference circle for %s and removes it on cancellation', tool => {
  const methods = new Map<string | symbol, unknown>();
  const ctx = new Proxy({}, { get: (_, key) => { if (!methods.has(key)) methods.set(key, vi.fn()); return methods.get(key); },
    set: (_, key, value) => { methods.set(key, value); return true; } });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}),
  });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout();
  tab.commands.execute('layout.grid.set', { snap: false, show: false }); tab.commands.execute('layout.snap.set', { enabled: false });
  render(<LayoutWorkspace tab={tab} session={session} />);
  act(() => { tab.commands.execute(`tool.${tool}`); });
  const canvas = screen.getByLabelText('Page 1 canvas');
  const version = tab.doc.version;
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 150, clientY: 150 });
  fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 150, clientY: 150 });
  fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 210, clientY: 150 });
  const arc = methods.get('arc') as ReturnType<typeof vi.fn>;
  expect(arc).toHaveBeenCalledWith(50, 50, 20, 0, Math.PI * 2);
  expect(methods.get('setLineDash')).toHaveBeenCalledWith([1.5, 1]);
  expect(tab.doc.version).toBe(version);
  const alternate = tool === 'polygon' ? 'circumscribed-polygon' : 'polygon';
  arc.mockClear();
  expect(fireEvent.keyDown(window, { key: 'Alt', altKey: true })).toBe(false);
  fireEvent.keyDown(window, { key: 'Alt', altKey: true, repeat: true });
  expect(canvas.getAttribute('data-tool')).toBe(alternate);
  expect(arc).toHaveBeenCalledWith(50, 50, 20, 0, Math.PI * 2);
  expect(screen.getByText(/Release Alt\/Option/).textContent).toContain(tool === 'polygon' ? 'return to Inscribed' : 'return to Circumscribed');
  arc.mockClear();
  fireEvent.keyUp(window, { key: 'Alt' });
  expect(canvas.getAttribute('data-tool')).toBe(tool);
  expect(arc).toHaveBeenCalledWith(50, 50, 20, 0, Math.PI * 2);
  expect(screen.getByText(/Hold Alt\/Option/)).toBeTruthy();
  expect(tab.doc.version).toBe(version);
  arc.mockClear();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(arc.mock.calls.some(call => call[2] === 20)).toBe(false);
  expect(tab.doc.state.pages.get(tab.activePageId)!.entities.size).toBe(0);
  fireEvent.keyDown(window, { key: 'Alt', altKey: true });
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 2, clientX: 150, clientY: 150, altKey: true });
  fireEvent.pointerUp(canvas, { pointerId: 2, clientX: 210, clientY: 150, altKey: true });
  const polygon = [...tab.doc.state.pages.get(tab.activePageId)!.entities.values()][0]!;
  const radius = tool === 'polygon' ? 20 / Math.cos(Math.PI / 6) : 20;
  for (const p of polygon.points) expect(Math.hypot(p[0] - 50, p[1] - 50)).toBeCloseTo(radius);
  fireEvent.keyUp(window, { key: 'Alt' });
  expect(canvas.getAttribute('data-tool')).toBe(tool);
  expect(tab.workspace.tool).toBe(tool);
  fireEvent.keyDown(window, { key: 'Alt', altKey: true });
  fireEvent.blur(window);
  expect(canvas.getAttribute('data-tool')).toBe(tool);
  cleanup(); session.dispose(); app.dispose();
});

it('defaults to inscribed polygons and offers circumscribed drawing, typed radius, undo and persistence', async () => {
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
  const at = (x: number, y: number) => ({ pointerId: 1, clientX: x * 3, clientY: y * 3 });
  const click = (x: number, y: number) => {
    fireEvent.pointerDown(canvas, { button: 0, ...at(x, y) }); fireEvent.pointerUp(canvas, at(x, y));
  };
  const page = () => tab.doc.state.pages.get(tab.activePageId)!;
  const latest = () => [...page().entities.values()].at(-1)!;
  fireEvent.click(screen.getByRole('button', { name: 'Polygon' }));
  fireEvent.pointerDown(canvas, { button: 0, ...at(50, 50) });
  fireEvent.pointerUp(canvas, at(70, 50));
  expect(latest().points).toHaveLength(6);
  for (const p of latest().points) expect(Math.hypot(p[0] - 50, p[1] - 50)).toBeCloseTo(20);
  fireEvent.click(screen.getByRole('button', { name: 'Polygon tools' }));
  const option = screen.getByRole('menuitemradio', { name: 'Circumscribed Polygon' });
  expect(option.querySelector('path')?.getAttribute('d')).toContain('a6 6');
  fireEvent.click(option);
  expect(canvas.getAttribute('data-tool')).toBe('circumscribed-polygon');
  click(100, 100);
  const version = tab.doc.version;
  fireEvent.pointerMove(canvas, at(120, 100));
  expect(tab.doc.version).toBe(version);
  const measurements = openLayoutEntry('30mm');
  fireEvent.keyDown(measurements, { key: 'Alt', altKey: true });
  expect(canvas.getAttribute('data-tool')).toBe('polygon');
  expect((measurements as HTMLInputElement).value).toBe('30mm');
  fireEvent.keyUp(measurements, { key: 'Alt' });
  expect(canvas.getAttribute('data-tool')).toBe('circumscribed-polygon');
  // Other key presses do not latch or toggle a momentary modifier.
  fireEvent.keyDown(window, { key: 'Alt', altKey: true });
  fireEvent.keyDown(window, { key: 'x', altKey: true });
  expect(canvas.getAttribute('data-tool')).toBe('polygon');
  fireEvent.keyUp(window, { key: 'Alt' });
  expect(canvas.getAttribute('data-tool')).toBe('circumscribed-polygon');
  fireEvent.keyDown(measurements, { key: 'Enter' });
  const polygon = latest();
  expect(polygon).toMatchObject({ closed: true, kind: 'path', style: { fillColor: '#ffffff' } });
  for (let i = 0; i < polygon.points.length; i++) {
    const a = polygon.points[i]!, b = polygon.points[(i + 1) % polygon.points.length]!;
    expect(Math.hypot((a[0] + b[0]) / 2 - 100, (a[1] + b[1]) / 2 - 100)).toBeCloseTo(30);
  }
  act(() => { tab.commands.execute('edit.undo'); });
  expect(page().entities.size).toBe(1);
  act(() => { tab.commands.execute('edit.redo'); });
  expect((await openLayoutFile((await session.saveLayoutBytes(tab.id)))).state.pages.get(page().id)!.entities.get(polygon.id)).toEqual(polygon);
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  fireEvent.click(screen.getByRole('button', { name: 'Circumscribed Polygon' }));
  expect(canvas.getAttribute('data-tool')).toBe('circumscribed-polygon');
  act(() => { tab.commands.execute('tool.polygon'); });
  expect(screen.getByRole('button', { name: 'Polygon' })).toBeTruthy();
  act(() => { tab.commands.execute('tool.circumscribed-polygon'); });
  expect(screen.getByRole('button', { name: 'Circumscribed Polygon' })).toBeTruthy();
  cleanup(); session.dispose(); app.dispose();
});

it('sets the side count from Measurements or the toolbar and keeps it for later polygons', () => {
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
  const at = (x: number, y: number) => ({ pointerId: 1, clientX: x * 3, clientY: y * 3 });
  const draw = (x: number) => { fireEvent.pointerDown(canvas, { button: 0, ...at(x, 50) }); fireEvent.pointerUp(canvas, at(x + 20, 50)); };
  const latest = () => [...tab.doc.state.pages.get(tab.activePageId)!.entities.values()].at(-1)!;
  act(() => { tab.commands.execute('tool.polygon'); });
  const sides = screen.getByLabelText('Sides') as HTMLInputElement;
  expect(sides.value).toBe('6');
  expect(screen.getByText(/followed by s to set the sides/)).toBeTruthy();
  // Typed before the first click: no shape is needed.
  enterLayoutValue('8s');
  expect(sides.value).toBe('8');
  expect(document.querySelector('input.pf-entry')).toBeNull();
  draw(50);
  expect(latest().points).toHaveLength(8);
  for (const p of latest().points) expect(Math.hypot(p[0] - 50, p[1] - 50)).toBeCloseTo(20);
  // Both variants share the count, and the toolbar field sets it too.
  act(() => { tab.commands.execute('tool.circumscribed-polygon'); });
  fireEvent.change(screen.getByLabelText('Sides'), { target: { value: '5' } });
  draw(120);
  expect(latest().points).toHaveLength(5);
  // Out of range counts are reported and change nothing.
  const version = tab.doc.version;
  enterLayoutValue('2s');
  expect(screen.getByRole('alert').textContent).toContain('3 to 100 sides');
  fireEvent.change(screen.getByLabelText('Sides'), { target: { value: '101' } });
  expect((screen.getByLabelText('Sides') as HTMLInputElement).value).toBe('5');
  expect(tab.doc.version).toBe(version);
  cleanup(); session.dispose(); app.dispose();
});

it('turns the reference point to the nearest 90° from the center within the snap tolerance', () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}),
  });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout();
  tab.commands.execute('layout.grid.set', { snap: false, show: false }); tab.commands.execute('layout.snap.set', { enabled: false });
  render(<LayoutWorkspace tab={tab} session={session} />);
  act(() => { tab.commands.execute('tool.polygon'); });
  const canvas = screen.getByLabelText('Page 1 canvas');
  // 3 px per mm, so the 8 px tolerance is 8/3 mm.
  const place = (cx: number, cy: number, rx: number, ry: number): [number, number][] => {
    for (const [x, y] of [[cx, cy], [rx, ry]]) {
      fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: x, clientY: y });
      fireEvent.pointerUp(canvas, { pointerId: 1, clientX: x, clientY: y });
    }
    const page = tab.doc.state.pages.get(tab.activePageId)!;
    return page.entities.get(page.entityOrder.at(-1)!)!.points as [number, number][];
  };
  // 6 px below horizontal: the first vertex lands on the horizontal through the center, at the same distance.
  const [first] = place(150, 150, 210, 156);
  expect(first![1]).toBeCloseTo(50);
  expect(first![0]).toBeCloseTo(50 + Math.hypot(60, 6) / 3);
  // 6 px left of vertical, above the center: straight up the page.
  const [up] = place(450, 300, 444, 210);
  expect(up![0]).toBeCloseTo(150);
  expect(up![1]).toBeCloseTo(100 - Math.hypot(6, 90) / 3);
  // 30 px off: the reference point stays where it was clicked.
  const [free] = place(150, 450, 210, 480);
  expect(free).toEqual([70, 160]);
  session.dispose(); app.dispose();
});
