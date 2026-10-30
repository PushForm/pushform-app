// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { openLayoutFile } from '@pushform/io';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('selects angular from the dimension stack, places an associated angle, and reopens its cached value', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}),
  });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout(), pageId = tab.activePageId;
  const sourceId = tab.commands.execute('layout.shape.add', { pageId, points: [[50, 50], [100, 50], [50, 100]] }) as number;
  render(<LayoutWorkspace tab={tab} session={session} />);
  const canvas = screen.getByLabelText('Page 1 canvas');
  const click = (x: number, y: number): void => {
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: x * 3, clientY: y * 3 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: x * 3, clientY: y * 3 });
  };
  expect(screen.queryByRole('button', { name: 'Angular Dimension' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Dimension tools' }));
  fireEvent.click(screen.getByRole('menuitemradio', { name: /Angular Dimension/ }));
  expect(screen.queryByRole('button', { name: 'Linear Dimension' })).toBeNull();
  click(50, 50); click(100, 50); click(50, 50); click(50, 100);
  expect(screen.getByText('Click inside for the angle, or outside for its reflex; distance sets arc radius.')).toBeTruthy();
  click(75, 75);
  expect(canvas.getAttribute('data-tool')).toBe('angular-dimension');
  expect(screen.getByText('Click the first ray point or first edge.')).toBeTruthy();
  expect(screen.getByText('90.0°')).toBeTruthy();
  fireEvent.click(screen.getByLabelText('Reflex angle'));
  expect(screen.getByText('270.0°')).toBeTruthy();
  act(() => { tab.commands.execute('layout.shape.delete', { pageId, entityId: sourceId }); });
  expect(screen.getByText('Detached — showing the last measured angle.')).toBeTruthy();
  const reopened = (await openLayoutFile((await session.saveLayoutBytes(tab.id))));
  const angular = [...reopened.state.pages.get(pageId)!.entities.values()].find((e) => e.angularDimension)!;
  expect(angular.angularDimension).toMatchObject({ cachedAngleDeg: 270, detached: true, reflex: true });
  act(() => { tab.commands.execute('edit.undo'); });
  click(25, 25);
  expect(screen.getByLabelText('Angle units')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Angular Dimension' }));
  expect(screen.getByText('Click the first ray point or first edge.')).toBeTruthy();
  click(120, 120); click(160, 120); click(120, 120); click(120, 160); click(140, 140);
  expect([...tab.doc.state.pages.get(pageId)!.entities.values()].filter(entity => entity.angularDimension)).toHaveLength(2);
  expect(canvas.getAttribute('data-tool')).toBe('angular-dimension');
  session.dispose(); app.dispose();
});

function setupAngular() {
  const methods = new Map<string | symbol, unknown>();
  const ctx = new Proxy({}, { get: (_, key) => { if (!methods.has(key)) methods.set(key, vi.fn()); return methods.get(key); },
    set: (_, key, value) => { methods.set(key, value); return true; } });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}),
  });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout(), pageId = tab.activePageId;
  render(<LayoutWorkspace tab={tab} session={session} />);
  const canvas = screen.getByLabelText('Page 1 canvas');
  fireEvent.keyDown(window, { key: 'D', code: 'KeyD', shiftKey: true });
  const click = (x: number, y: number) => {
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: x * 3, clientY: y * 3 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: x * 3, clientY: y * 3 });
  };
  const move = (x: number, y: number) => fireEvent.pointerMove(canvas, { pointerId: 1, clientX: x * 3, clientY: y * 3 });
  return { ctx: ctx as CanvasRenderingContext2D, tab, session, pageId, canvas, click, move,
    page: () => tab.doc.state.pages.get(pageId)!, dispose: () => { cleanup(); session.dispose(); app.dispose(); } };
}

it('renders real ray/arc previews, rejects invalid clicks at their own stage, and commits the displayed angle', async () => {
  const { ctx, tab, session, pageId, click, move, page, dispose } = setupAngular();
  const version = tab.doc.version;
  click(40, 40); click(40, 40);
  expect(screen.getByText(/different points for the first ray/)).toBeTruthy();
  click(100, 40); click(40, 40); move(40, 100);
  expect(screen.getByLabelText('Angular dimension preview').textContent).toBe('90.0°');
  expect(ctx.fillText).toHaveBeenCalledWith('V', expect.any(Number), expect.any(Number));
  for (const label of ['1', '2', '3', '4']) expect(ctx.fillText).not.toHaveBeenCalledWith(label, expect.any(Number), expect.any(Number));
  expect(ctx.arc).toHaveBeenCalledWith(40, 40, 30, 0, Math.PI / 2, false);
  expect(tab.doc.version).toBe(version); expect(page().entities.size).toBe(0);
  click(40, 40); // Second ray cannot have coincident endpoints.
  expect(screen.getByText(/different points for each ray/)).toBeTruthy();
  click(70, 40); // Parallel rays have no unique intersection.
  expect(screen.getByText(/nonparallel/)).toBeTruthy();
  click(40, 100); click(40, 40); // Zero-radius placement: keep waiting for the arc.
  expect(screen.getByText(/arc at least 0.5 mm/)).toBeTruthy();
  move(60, 60);
  expect(screen.getByText('Click inside for the angle, or outside for its reflex; distance sets arc radius.')).toBeTruthy();
  expect(ctx.arc).toHaveBeenCalledWith(40, 40, Math.hypot(20, 20), 0, Math.PI / 2, false);
  click(60, 60);
  const entity = [...page().entities.values()][0]!;
  expect(entity.points).toEqual([[40, 40], [100, 40], [40, 100], [60, 60]]);
  expect(entity.angularDimension).toMatchObject({ cachedAngleDeg: 90, reflex: false, anchors: [null, null, null] });
  expect(screen.queryByLabelText('Angular dimension preview')).toBeNull();
  act(() => { tab.commands.execute('edit.undo'); }); expect(page().entities.size).toBe(0);
  act(() => { tab.commands.execute('edit.redo'); }); expect(page().entities.size).toBe(1);
  expect((await openLayoutFile((await session.saveLayoutBytes(tab.id)))).state.pages.get(pageId)?.entities.get(entity.id)).toEqual(entity);
  dispose();
});

it('previews and commits reflex angles across the wrap boundary using snapped associated vertices', () => {
  const { ctx, tab, pageId, click, move, page, dispose } = setupAngular();
  let sourceId = 0;
  act(() => { sourceId = tab.commands.execute('layout.shape.add', { pageId, points: [[40, 40], [100, 40], [40, 100]] }) as number; });
  click(39.6, 39.8); click(99.7, 40.2); click(39.6, 39.8); move(40.2, 99.7);
  expect(screen.getByLabelText('Angular dimension preview').textContent).toBe('90.0°');
  click(40.2, 99.7); move(15, 15);
  expect(screen.getByLabelText('Angular dimension preview').textContent).toBe('270.0°');
  expect(ctx.arc).toHaveBeenCalledWith(40, 40, Math.hypot(25, 25), 0, -3 * Math.PI / 2, true);
  click(15, 15);
  const entity = [...page().entities.values()].find(entity => entity.angularDimension)!;
  expect(entity.angularDimension).toMatchObject({ cachedAngleDeg: 270, reflex: true,
    rayDefinition: { anchors: [0, 1, 0, 2].map(pointIndex => ({ entityId: sourceId, pointIndex, pointCount: 3 })) } });
  act(() => { tab.commands.execute('layout.shape.setPath', { pageId, entityId: sourceId, points: [[40, 40], [100, 40], [100, 100]] }); });
  expect(page().entities.get(entity.id)?.angularDimension?.cachedAngleDeg).toBeCloseTo(315);
  expect(screen.getByText('315.0°')).toBeTruthy();
  dispose();
});

it.each([1, 2, 3, 4])('cancels a draft after %s clicks with Escape, pointer cancellation, tool change, and page change', count => {
  const { tab, session, canvas, click, move, page, dispose } = setupAngular();
  const points = [[40, 40], [100, 40], [40, 40], [40, 100]];
  const begin = () => { for (const [x, y] of points.slice(0, count)) click(x!, y!); move(60, 60); };
  begin(); fireEvent.keyDown(window, { key: 'Escape' });
  expect(page().entities.size).toBe(0); expect(screen.getByText('Click the first ray point or first edge.')).toBeTruthy();
  expect(screen.queryByLabelText('Angular dimension preview')).toBeNull();
  begin(); fireEvent.pointerCancel(canvas);
  expect(page().entities.size).toBe(0); expect(screen.getByText('Click the first ray point or first edge.')).toBeTruthy();
  begin(); fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  expect(page().entities.size).toBe(0); expect(screen.queryByLabelText('Angular dimension preview')).toBeNull();
  fireEvent.keyDown(window, { key: 'D', code: 'KeyD', shiftKey: true }); begin();
  act(() => { const id = tab.commands.execute('layout.page.add', {}) as number; session.setActivePage(id); });
  expect(screen.getByText('Click the first ray point or first edge.')).toBeTruthy(); expect(page().entities.size).toBe(0);
  dispose();
});

it('infers the intersection and uses the farther endpoint of each pair', () => {
  const { click, move, page, dispose } = setupAngular();
  click(20, 40); click(80, 40); click(100, 60); move(100, 100);
  expect(screen.getByLabelText('Angular dimension preview').textContent).toBe('90.0°');
  click(100, 100);
  expect(page().entities.size).toBe(0); // Four measurement clicks, then arc placement.
  move(75, 65); click(75, 65);
  const dimension = [...page().entities.values()][0]!;
  expect(dimension.points).toEqual([[100, 40], [20, 40], [100, 100], [75, 65]]);
  expect(dimension.angularDimension?.cachedAngleDeg).toBeCloseTo(90);
  expect(screen.getByText('Click the first ray point or first edge.')).toBeTruthy();
  dispose();
});

it('measures two extended edges, recovers from invalid second choices, and saves the associations', async () => {
  const { tab, session, pageId, click, move, page, canvas, dispose } = setupAngular();
  let first = 0, second = 0;
  act(() => {
    first = tab.commands.execute('layout.shape.add', { pageId, points: [[20, 40], [80, 40]] }) as number;
    second = tab.commands.execute('layout.shape.add', { pageId, points: [[100, 60], [100, 100]] }) as number;
    tab.commands.execute('layout.shape.add', { pageId, points: [[20, 20], [80, 20]] });
  });
  expect(screen.getByText('Click the first ray point or first edge.')).toBeTruthy();
  const version = tab.doc.version;
  click(50, 40);
  expect(screen.getByText('Click a different edge or the second point of the first ray.')).toBeTruthy();
  click(50, 20); expect(screen.getByText(/nonparallel/)).toBeTruthy();
  click(100, 80); move(75, 65);
  expect(screen.getByLabelText('Angular dimension preview').textContent).toBe('90.0°');
  expect(tab.doc.version).toBe(version);
  click(75, 65);
  const entity = [...page().entities.values()].find(e => e.angularDimension)!;
  expect(entity.points[0]).toEqual([100, 40]); // Segments do not touch; their extensions intersect here.
  expect(entity.angularDimension).toMatchObject({ cachedAngleDeg: 90, edgeAnchors: [
    { entityId: first, segmentIndex: 0, pointCount: 2, direction: -1 },
    { entityId: second, segmentIndex: 0, pointCount: 2, direction: 1 },
  ] });
  expect(screen.getByText('Associated with straight edges')).toBeTruthy();
  expect(canvas.getAttribute('data-tool')).toBe('angular-dimension');
  expect(screen.getByText('Click the first ray point or first edge.')).toBeTruthy();
  const reopened = (await openLayoutFile((await session.saveLayoutBytes(tab.id))));
  expect(reopened.state.pages.get(pageId)?.entities.get(entity.id)).toEqual(entity);
  // Escape discards the candidate first edge for the next automatic inference.
  click(50, 40);
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.getByText('Click the first ray point or first edge.')).toBeTruthy();
  expect([...page().entities.values()].filter(e => e.angularDimension)).toHaveLength(1);
  dispose();
});

it.each([1, 2])('cancels a two-edge draft after %s selections without leaving a stale first edge', count => {
  const { tab, pageId, click, canvas, page, dispose } = setupAngular();
  act(() => {
    tab.commands.execute('layout.shape.add', { pageId, points: [[20, 40], [80, 40]] });
    tab.commands.execute('layout.shape.add', { pageId, points: [[100, 60], [100, 100]] });
  });
  const begin = () => { click(50, 40); if (count === 2) click(100, 80); };
  const version = tab.doc.version;
  begin(); fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.getByText('Click the first ray point or first edge.')).toBeTruthy();
  begin(); fireEvent.pointerCancel(canvas);
  expect(screen.getByText('Click the first ray point or first edge.')).toBeTruthy();
  expect(tab.doc.version).toBe(version);
  expect([...page().entities.values()].filter(e => e.angularDimension)).toHaveLength(0);
  dispose();
});

it.each([
  { first: [50, 40], second: [70, 40], edges: false, label: 'same edge' },
  { first: [50, 40], second: [50, 100], edges: false, label: 'edge then paper' },
  { first: [50, 40], second: [100, 80], edges: true, label: 'two distinct edges' },
  { first: [50, 120], second: [100, 80], edges: false, label: 'paper then edge' },
  { first: [50, 120], second: [70, 120], edges: false, label: 'two paper points' },
])('infers $label from just the first two clicks without extra toolbar controls', ({ first, second, edges }) => {
  const { tab, pageId, click, page, dispose } = setupAngular();
  act(() => {
    tab.commands.execute('layout.shape.add', { pageId, points: [[20, 40], [80, 40]] });
    tab.commands.execute('layout.shape.add', { pageId, points: [[100, 60], [100, 100]] });
  });
  expect(screen.queryByLabelText('Angular dimension method')).toBeNull();
  expect(screen.queryByLabelText('Draw reflex angle')).toBeNull();
  click(first[0]!, first[1]!); click(second[0]!, second[1]!);
  expect(screen.getByText(edges ? 'Click inside for the angle, or outside for its reflex; distance sets arc radius.' : 'Click the first point of the second ray.')).toBeTruthy();
  expect([...page().entities.values()].filter(e => e.angularDimension)).toHaveLength(0);
  if (!edges) { click(20, 140); click(60, 180); }
  click(40, 100);
  const dimensions = [...page().entities.values()].filter(e => e.angularDimension);
  expect(dimensions).toHaveLength(1);
  expect(Boolean(dimensions[0]!.angularDimension?.edgeAnchors)).toBe(edges);
  if (!edges) expect(dimensions[0]!.angularDimension?.edgeAnchors).toBeUndefined();
  dispose();
});

it.each(['points', 'edges'])('automatically previews inside and reflex angles during %s placement and commits the displayed sweep', method => {
  const { tab, pageId, ctx, click, move, page, dispose } = setupAngular();
  let vertex: [number, number], inside: [number, number], outside: [number, number];
  if (method === 'edges') {
    act(() => {
      tab.commands.execute('layout.shape.add', { pageId, points: [[20, 40], [80, 40]] });
      tab.commands.execute('layout.shape.add', { pageId, points: [[100, 60], [100, 100]] });
    });
    click(50, 40); click(100, 80); vertex = [100, 40]; inside = [75, 65]; outside = [125, 15];
  } else {
    click(40, 40); click(100, 40); click(40, 40); click(40, 100); vertex = [40, 40]; inside = [65, 65]; outside = [15, 15];
  }
  move(...inside); expect(screen.getByLabelText('Angular dimension preview').textContent).toBe('90.0°');
  move(...outside); expect(screen.getByLabelText('Angular dimension preview').textContent).toBe('270.0°');
  move(...inside); expect(screen.getByLabelText('Angular dimension preview').textContent).toBe('90.0°');
  move(...outside);
  expect(ctx.arc).toHaveBeenCalledWith(...vertex, Math.hypot(25, 25), method === 'edges' ? Math.PI : 0,
    method === 'edges' ? Math.PI + 3 * Math.PI / 2 : -3 * Math.PI / 2, method !== 'edges');
  click(...outside);
  expect([...page().entities.values()].find(e => e.angularDimension)?.angularDimension).toMatchObject({ reflex: true, cachedAngleDeg: 270 });
  dispose();
});

it.each(['curve', 'zero-length'])('accepts a first click on a %s as a point and continues with four-point ray placement', kind => {
  const { tab, pageId, click, page, dispose } = setupAngular();
  act(() => { tab.commands.execute('layout.shape.add', { pageId,
    points: kind === 'curve' ? [[40, 40], [80, 80]] : [[40, 40], [40, 40]],
    ...(kind === 'curve' ? { handles: [{ out: [80, 40] }, {}] } : {}) }); });
  click(40, 40); click(100, 40); click(40, 40); click(40, 100); click(65, 65);
  const dimension = [...page().entities.values()].find(e => e.angularDimension)!;
  expect(dimension.angularDimension?.edgeAnchors).toBeUndefined();
  expect(dimension.angularDimension?.cachedAngleDeg).toBeCloseTo(90);
  dispose();
});

it.each(Array.from({ length: 8 }, (_, order) => order))('keeps the arc on the drawn sides for endpoint and ray ordering %s', order => {
  const { click, move, page, dispose } = setupAngular();
  const first: [number, number][] = [[20, 40], [80, 40]], second: [number, number][] = [[100, 60], [100, 100]];
  if (order & 1) first.reverse();
  if (order & 2) second.reverse();
  const pairs = order & 4 ? [second, first] : [first, second];
  for (const point of pairs.flat()) click(...point);
  move(75, 65);
  expect(screen.getByLabelText('Angular dimension preview').textContent).toBe('90.0°');
  move(125, 15);
  expect(screen.getByLabelText('Angular dimension preview').textContent).toBe('270.0°');
  click(75, 65);
  const dimension = [...page().entities.values()].find(e => e.angularDimension)!;
  expect(dimension.points[0]).toEqual([100, 40]);
  expect(dimension.points.slice(1, 3)).toEqual(order & 4 ? [[100, 100], [20, 40]] : [[20, 40], [100, 100]]);
  expect(dimension.angularDimension).toMatchObject({ cachedAngleDeg: 90, reflex: false });
  dispose();
});
