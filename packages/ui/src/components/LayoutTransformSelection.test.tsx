// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { rotateLayoutEntities, type LayoutEntity } from '@pushform/layout';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const TEXT = { content: 'Note', fontFamily: 'Arial', fontSizePt: 10, color: '#222222', bold: false, italic: false,
  underline: false, align: 'left', vertical: 'top', bounded: true, leader: 'none', endpoint: 'none' } as const;

/** Two filled squares and a text box below the first, on a page drawn at 3 screen pixels per millimeter, with snapping off. */
function setup() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}),
  });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout(), pageId = tab.activePageId;
  tab.commands.execute('layout.grid.set', { snap: false });
  tab.commands.execute('layout.snap.set', { enabled: false });
  tab.commands.execute('layout.style.setDefault', { fillColor: '#ffffff' });
  const a = tab.commands.execute('layout.shape.add', { pageId, points: [[10, 10], [30, 10], [30, 30], [10, 30]], closed: true }) as number;
  const b = tab.commands.execute('layout.shape.add', { pageId, points: [[50, 10], [70, 10], [70, 30], [50, 30]], closed: true }) as number;
  const t = tab.commands.execute('layout.text.add', { pageId, kind: 'text', points: [[10, 40], [30, 50]], text: TEXT }) as number;
  render(<LayoutWorkspace tab={tab} session={session} />);
  const canvas = screen.getByLabelText('Page 1 canvas');
  const at = (x: number, y: number, init: Record<string, unknown> = {}) => ({ button: 0, pointerId: 1, clientX: x * 3, clientY: y * 3, ...init });
  const press = (x: number, y: number, init: Record<string, unknown> = {}) => fireEvent.pointerDown(canvas, at(x, y, { buttons: 1, ...init }));
  const drag = (x: number, y: number, init: Record<string, unknown> = {}) => fireEvent.pointerMove(canvas, at(x, y, { buttons: 1, ...init }));
  const release = (x: number, y: number, init: Record<string, unknown> = {}) => fireEvent.pointerUp(canvas, at(x, y, init));
  const click = (x: number, y: number): void => { press(x, y); release(x, y); };
  /** Drags a resize handle or grip button from one page point to another. */
  const pull = (button: HTMLElement, from: [number, number], to: [number, number], init: Record<string, unknown> = {}, finish = true): void => {
    fireEvent.pointerDown(button, at(...from, init));
    fireEvent.pointerMove(button, at(...to, init));
    if (finish) fireEvent.pointerUp(button, at(...to, init));
  };
  const entity = (id: number): LayoutEntity => tab.doc.state.pages.get(pageId)!.entities.get(id)!;
  const points = (id: number) => entity(id).points;
  const selectAll = (): void => { press(5, 5); drag(80, 55); release(80, 55); };
  const selectSquares = (): void => { press(5, 5); drag(75, 35); release(75, 35); };
  const box = () => screen.getByLabelText('Selected objects bounds');
  const undo = () => act(() => { tab.commands.execute('edit.undo'); });
  const dispose = (): void => { session.dispose(); app.dispose(); };
  return { tab, pageId, a, b, t, canvas, press, drag, release, click, pull, entity, points, selectAll, selectSquares, box, undo, dispose };
}

it('shows resize handles and a rotation grip around a multi-selection, and Scale shows the handles alone', () => {
  const { tab, selectAll, box, dispose } = setup();
  selectAll();
  expect(within(box()).getAllByRole('button', { name: /^Scale selection / })).toHaveLength(8);
  expect(within(box()).getByRole('button', { name: 'Rotation handle' })).toBeTruthy();
  act(() => { tab.commands.execute('tool.scale'); });
  expect(within(box()).getAllByRole('button', { name: /^Scale selection / })).toHaveLength(8);
  expect(within(box()).queryByRole('button', { name: 'Rotation handle' })).toBeNull();
  dispose();
});

it('scales a multi-selection about the opposite corner as one undoable step, with type by the smaller factor', () => {
  const { tab, a, b, t, entity, points, selectAll, box, pull, undo, dispose } = setup();
  selectAll();
  const version = tab.doc.version;
  // The box runs from (10, 10) to (70, 50); dragging its bottom-right corner to (130, 90) doubles it.
  pull(within(box()).getByRole('button', { name: 'Scale selection bottom right' }), [70, 50], [130, 90], {}, false);
  expect(tab.doc.version).toBe(version);
  expect(box().style.width).toBe(`${120 / 297 * 100}%`);
  fireEvent.pointerUp(within(box()).getByRole('button', { name: 'Scale selection bottom right' }), { pointerId: 1, clientX: 390, clientY: 270 });
  expect(points(a)).toEqual([[10, 10], [50, 10], [50, 50], [10, 50]]);
  expect(points(b)).toEqual([[90, 10], [130, 10], [130, 50], [90, 50]]);
  expect(points(t)).toEqual([[10, 70], [50, 90]]);
  expect(entity(t).text!.fontSizePt).toBe(20);
  expect(screen.getByText('3 objects selected')).toBeTruthy();
  undo();
  expect(points(a)).toEqual([[10, 10], [30, 10], [30, 30], [10, 30]]);
  expect(entity(t).text!.fontSizePt).toBe(10);
  // Stretching across only doubles widths; the type keeps its size.
  pull(within(box()).getByRole('button', { name: 'Scale selection right' }), [70, 30], [130, 30]);
  expect(points(t)).toEqual([[10, 40], [50, 50]]);
  expect(entity(t).text!.fontSizePt).toBe(10);
  dispose();
});

it('keeps proportions with Shift and the center with Alt, leaves locked objects and cancels with Esc', () => {
  const { tab, pageId, a, b, points, selectSquares, box, pull, dispose } = setup();
  act(() => { tab.commands.execute('layout.shape.setLocked', { pageId, entityIds: [b], locked: true }); });
  selectSquares();
  // Box (10, 10)-(70, 30). The right handle with Shift and Alt doubles it about its center (40, 20).
  pull(within(box()).getByRole('button', { name: 'Scale selection right' }), [70, 20], [100, 20], { shiftKey: true, altKey: true });
  expect(points(a)).toEqual([[-20, 0], [20, 0], [20, 40], [-20, 40]]);
  expect(points(b)).toEqual([[50, 10], [70, 10], [70, 30], [50, 30]]);
  // Esc during a drag cancels it, and the release changes nothing.
  const version = tab.doc.version, handle = within(box()).getByRole('button', { name: 'Scale selection right' });
  pull(handle, [70, 20], [120, 20], {}, false);
  fireEvent.keyDown(window, { key: 'Escape' });
  fireEvent.pointerUp(handle, { pointerId: 1, clientX: 360, clientY: 60 });
  expect(tab.doc.version).toBe(version);
  dispose();
});

it('Scale picks up a whole group from a click on a member, and a double-click on a handle hands over to Select', () => {
  const { tab, pageId, a, b, click, canvas, box, dispose } = setup();
  act(() => { tab.commands.execute('layout.shape.group', { pageId, entityIds: [a, b] }); });
  act(() => { tab.commands.execute('tool.scale'); });
  click(20, 20);
  expect(within(box()).getAllByRole('button', { name: /^Scale selection / })).toHaveLength(8);
  expect(screen.getByText('2 objects selected')).toBeTruthy();
  // A lone object's handle: a double-click there edits its vertices with Select.
  act(() => { tab.commands.execute('layout.shape.ungroup', { pageId, entityIds: [a, b] }); });
  act(() => { tab.commands.execute('tool.select'); });
  click(150, 150); click(20, 20);
  act(() => { tab.commands.execute('tool.scale'); });
  fireEvent.doubleClick(screen.getByRole('button', { name: 'Scale bottom right' }));
  expect(canvas.getAttribute('data-tool')).toBe('select');
  expect(document.querySelector('.pf-layout-footer-spacer')?.textContent).toContain('Drag vertices to edit');
  dispose();
});

it('a resize handle snaps to another object, with the snap marker shown', () => {
  const { tab, a, points, click, dispose } = setup();
  act(() => { tab.commands.execute('layout.snap.set', { enabled: true }); });
  click(20, 20);
  const handle = screen.getByRole('button', { name: 'Scale bottom right' });
  // Released 1.4 mm from the other square's corner at (50, 30): the corner lands on it.
  fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 90, clientY: 90 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 147, clientY: 93 });
  expect(document.querySelector('.pf-layout-placement-marker')?.getAttribute('data-snap')).toBe('endpoint');
  fireEvent.pointerUp(handle, { pointerId: 1, clientX: 147, clientY: 93 });
  expect(points(a)).toEqual([[10, 10], [50, 10], [50, 30], [10, 30]]);
  expect(document.querySelector('.pf-layout-placement-marker')).toBeNull();
  dispose();
});

it('Rotate turns a selection about the clicked point, and the rotation grip turns it about the box center', () => {
  const { tab, a, b, entity, click, selectSquares, box, pull, undo, dispose } = setup();
  const before = [entity(a), entity(b)];
  const turned = (pivot: [number, number]) => rotateLayoutEntities(before, pivot, 90);
  selectSquares();
  act(() => { tab.commands.execute('tool.rotate'); });
  // Empty paper between the squares while they are selected: the rotation point, then a reference to the right and a quarter turn down.
  click(40, 25); click(60, 25); click(40, 45);
  expect([entity(a), entity(b)]).toEqual(turned([40, 25]));
  expect(screen.getByText('2 objects selected')).toBeTruthy();
  undo();
  act(() => { tab.commands.execute('tool.select'); });
  // The grip starts at the box's middle (40, 20); pulling its handle straight down is a quarter turn.
  pull(within(box()).getByRole('button', { name: 'Rotation handle' }), [45, 20], [40, 60]);
  expect([entity(a), entity(b)]).toEqual(turned([40, 20]));
  dispose();
});

it('Arrange rotates, scales and flips a multi-selection about its center as one step each', () => {
  const { a, b, points, selectSquares, undo, dispose } = setup();
  selectSquares();
  const panel = screen.getByRole('region', { name: 'Arrange' });
  fireEvent.change(within(panel).getByLabelText('Scale percent'), { target: { value: '50' } });
  fireEvent.click(within(panel).getByRole('button', { name: 'Apply scale' }));
  // Halved about the box's center (40, 20).
  expect(points(a)).toEqual([[25, 15], [35, 15], [35, 25], [25, 25]]);
  expect(points(b)).toEqual([[45, 15], [55, 15], [55, 25], [45, 25]]);
  undo();
  fireEvent.click(within(panel).getByRole('button', { name: 'Flip horizontally' }));
  // The squares trade places about x = 40, in one undo step.
  expect(points(a).map(([x]) => x).sort((p, q) => p - q)).toEqual([50, 50, 70, 70]);
  expect(points(b).map(([x]) => x).sort((p, q) => p - q)).toEqual([10, 10, 30, 30]);
  undo();
  expect(points(a)).toEqual([[10, 10], [30, 10], [30, 30], [10, 30]]);
  expect(points(b)).toEqual([[50, 10], [70, 10], [70, 30], [50, 30]]);
  dispose();
});
