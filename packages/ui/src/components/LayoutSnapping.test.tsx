// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LAYOUT_TOOL_IDS, type LayoutToolId } from '@pushform/commands';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
function setup() {
  vi.useFakeTimers();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}) });
  const app = createApp({ demo: false, expose: false }), session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout(), pageId = tab.activePageId;
  tab.commands.execute('layout.rectangle.add', { pageId, kind: 'rectangle', first: [20, 20], second: [80, 60] });
  render(<LayoutWorkspace tab={tab} session={session} />);
  const canvas = screen.getByLabelText('Page 1 canvas');
  const move = (x: number, y: number) => fireEvent.pointerMove(canvas, { pointerId: 1, clientX: x * 3, clientY: y * 3 });
  const click = (x: number, y: number) => {
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: x * 3, clientY: y * 3 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: x * 3, clientY: y * 3 });
  };
  const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
  const tooltip = () => screen.queryByRole('tooltip', { name: 'Snap type' });
  return { tab, pageId, canvas, move, click, advance, tooltip, dispose: () => { cleanup(); session.dispose(); app.dispose(); } };
}

// These tools pick whole objects; they do not place a point using the snap resolver.
const objectPickingTools = ['scale', 'boolean-union', 'boolean-subtract', 'boolean-intersect',
  'boolean-exclude', 'boolean-division', 'boolean-cut-path'] as const satisfies readonly LayoutToolId[];
const nonSnappingTools = new Set<LayoutToolId>(['select', 'lasso', 'eraser', 'freehand', 'shape-builder', ...objectPickingTools]);

it.each(LAYOUT_TOOL_IDS.filter(id => !nonSnappingTools.has(id)))('uses shared endpoint, midpoint, center and edge snapping with delayed tooltips for %s', tool => {
  const { tab, move, advance, tooltip, dispose } = setup();
  act(() => { tab.commands.execute(`tool.${tool}`); });
  for (const [x, y, label] of [[20.2, 20.3, 'Endpoint'], [50.2, 20.3, 'Midpoint'], [50.2, 40.3, 'Center'], [35, 20.3, 'On path']] as const) {
    move(x, y); expect(tooltip()).toBeNull();
    advance(999); expect(tooltip()).toBeNull();
    advance(1); expect(tooltip()?.textContent).toBe(label);
  }
  dispose();
});

it.each(objectPickingTools)('clears snap feedback and does not show point-placement tooltips for %s', tool => {
  const { tab, move, advance, tooltip, dispose } = setup();
  act(() => { tab.commands.execute('tool.line'); });
  move(20.2, 20.3); advance(1000);
  expect(tooltip()?.textContent).toBe('Endpoint');
  act(() => { tab.commands.execute(`tool.${tool}`); });
  expect(tooltip()).toBeNull();
  const before = tab.doc.state;
  for (const [x, y] of [[20.2, 20.3], [50.2, 20.3], [50.2, 40.3], [35, 20.3]] as const) {
    move(x, y); advance(1000);
    expect(tooltip()).toBeNull();
    expect(document.querySelector('.pf-layout-placement-marker')).toBeNull();
  }
  expect(tab.doc.state).toBe(before);
  dispose();
});

it('resets the one-second delay on leaving, clicking, changing tools and cancelling, without resetting at the same fixed target', () => {
  const { tab, canvas, move, click, advance, tooltip, dispose } = setup();
  act(() => { tab.commands.execute('tool.line'); });
  move(20.2, 20.3); advance(700); move(20.3, 20.2); advance(300);
  expect(tooltip()?.textContent).toBe('Endpoint');
  fireEvent.pointerLeave(canvas); expect(tooltip()).toBeNull();
  move(20.2, 20.3); advance(999); expect(tooltip()).toBeNull(); advance(1); expect(tooltip()).toBeTruthy();
  click(20.2, 20.3); expect(tooltip()).toBeNull(); advance(1000); expect(tooltip()).toBeTruthy();
  fireEvent.keyDown(window, { key: 'Escape' }); expect(tooltip()).toBeNull();
  move(50, 40); advance(500);
  act(() => { tab.commands.execute('tool.rectangle'); });
  expect(tooltip()).toBeNull(); move(50, 40); advance(999); expect(tooltip()).toBeNull(); advance(1); expect(tooltip()?.textContent).toBe('Center');
  fireEvent.pointerCancel(canvas); expect(tooltip()).toBeNull();
  dispose();
});

it('commits the same center used by the hover preview and suppresses grid tooltips with Object Snap on or off', () => {
  const { tab, pageId, move, click, advance, tooltip, dispose } = setup();
  act(() => { tab.commands.execute('tool.line'); });
  move(110.2, 90.3); advance(2000); expect(tooltip()).toBeNull();
  move(50.2, 40.3); advance(1000); expect(tooltip()?.textContent).toBe('Center');
  click(50.2, 40.3); click(110, 90);
  const created = [...tab.doc.state.pages.get(pageId)!.entities.values()].find(e => e.points.length === 2)!;
  expect(created.points).toEqual([[50, 40], [110, 90]]);
  act(() => { tab.commands.execute('layout.snap.set', { enabled: false }); });
  move(50.2, 40.3); advance(1000); expect(tooltip()).toBeNull();
  act(() => { tab.commands.execute('layout.grid.set', { snap: false }); });
  move(50.2, 40.3); advance(1000); expect(tooltip()).toBeNull();
  dispose();
});

it('snaps offset placement to other objects without snapping a small offset back to its own source', () => {
  const { tab, pageId, move, click, dispose } = setup();
  act(() => { tab.commands.execute('tool.offset'); });
  click(80, 40); move(82, 40); click(82, 40);
  const page = tab.doc.state.pages.get(pageId)!;
  expect(page.entities.size).toBe(2);
  expect(page.entities.get(page.entityOrder[0]!)!.points).toEqual([[18, 18], [82, 18], [82, 62], [18, 62]]);
  dispose();
});
