// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function setup() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}) });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout();
  tab.commands.execute('layout.grid.set', { snap: false });
  tab.commands.execute('layout.snap.set', { enabled: false });
  render(<LayoutWorkspace tab={tab} session={session} />);
  const canvas = screen.getByLabelText('Page 1 canvas');
  const at = (x: number, y: number) => ({ pointerId: 1, clientX: x * 3, clientY: y * 3 });
  const click = (x: number, y: number) => { fireEvent.pointerDown(canvas, { button: 0, ...at(x, y) }); fireEvent.pointerUp(canvas, at(x, y)); };
  const choose = (tool: string) => act(() => { tab.commands.execute(`tool.${tool}`); });
  return { tab, canvas, at, click, choose, page: () => tab.doc.state.pages.get(tab.activePageId)!, dispose: () => { cleanup(); session.dispose(); app.dispose(); } };
}

it.each([
  ['line', ['Length', 'Angle']],
  ['rectangle', ['Width', 'Height']], ['rounded-rectangle', ['Width', 'Height']],
  ['bulged-rectangle', ['Width', 'Height']], ['lozenge', ['Width', 'Height']],
  ['ellipse', ['Width', 'Height']], ['circle', ['Radius']],
  ['polygon', ['Radius']], ['circumscribed-polygon', ['Radius']],
  ['arc', ['Radius']], ['pie', ['Radius']], ['arc2', ['Length']], ['arc3', ['Length']],
  ['table', ['Width', 'Height']],
] as const)('%s keeps its operation inputs in the bar and enables them at the first point', (tool, labels) => {
  const { tab, canvas, click, choose, page, dispose } = setup();
  choose(tool);
  const persistent = ['rounded-rectangle', 'bulged-rectangle', 'polygon', 'circumscribed-polygon', 'table'].includes(tool);
  expect(Boolean(screen.queryByRole('toolbar', { name: /options$/ }))).toBe(persistent);
  const before = tab.doc.state;
  click(20, 20);
  const bar = screen.getByRole('toolbar', { name: /options$/ });
  for (const label of labels) expect((within(bar).getByRole('textbox', { name: label }) as HTMLInputElement).disabled).toBe(false);
  expect([...document.querySelectorAll('input.pf-entry')].every(el => el.closest('.pf-tob'))).toBe(true);
  expect(tab.doc.state).toBe(before);
  fireEvent.keyDown(canvas, { key: 'Escape' });
  expect(page().entities.size).toBe(0);
  expect(Boolean(screen.queryByRole('toolbar', { name: /options$/ }))).toBe(persistent);
  dispose();
});

it.each([['arc', 'Angle'], ['pie', 'Angle'], ['arc2', 'Bulge']] as const)('%s advances its bar input to %s without duplicate page inputs', (tool, next) => {
  const { click, choose, dispose } = setup();
  choose(tool); click(20, 20); click(60, 20);
  const input = screen.getByRole('textbox', { name: next }) as HTMLInputElement;
  expect(input.closest('.pf-tob')).not.toBeNull(); expect(input.disabled).toBe(false);
  expect(document.querySelectorAll('input.pf-entry')).toHaveLength(1);
  expect(document.activeElement).toBe(input);
  dispose();
});

it('Bézier bar actions finish, remove an anchor and cancel the pending curve', () => {
  const { tab, click, choose, page, dispose } = setup();
  choose('bezier');
  expect(screen.queryByRole('toolbar')).toBeNull();
  click(20, 20);
  const bar = screen.getByRole('toolbar', { name: 'Bézier Curve options' });
  expect((within(bar).getByRole('button', { name: 'Finish curve' }) as HTMLButtonElement).disabled).toBe(true);
  expect(within(bar).getByText(/Click for corners/)).toBeTruthy();
  expect(within(bar).queryByRole('spinbutton')).toBeNull();
  click(60, 20); click(80, 40);
  fireEvent.click(within(bar).getByRole('button', { name: 'Remove last anchor' }));
  fireEvent.click(within(bar).getByRole('button', { name: 'Finish curve' }));
  expect(screen.queryByRole('toolbar')).toBeNull();
  const curve = [...page().entities.values()][0]!;
  expect(curve.points).toEqual([[20, 20], [60, 20]]);
  click(100, 60); click(140, 60);
  fireEvent.click(within(bar).getByRole('button', { name: 'Cancel curve' }));
  expect(screen.queryByRole('toolbar')).toBeNull();
  expect(page().entities.size).toBe(1);
  act(() => { tab.commands.execute('edit.undo'); });
  expect(page().entities.size).toBe(0);
  dispose();
});

it('Freehand leaves the bar hidden when there are no editable options', () => {
  const { canvas, at, choose, page, dispose } = setup();
  choose('freehand');
  expect(screen.queryByRole('toolbar')).toBeNull();
  fireEvent.pointerDown(canvas, { button: 0, ...at(20, 20) });
  fireEvent.pointerMove(canvas, at(40, 30)); fireEvent.pointerUp(canvas, at(60, 20));
  expect([...page().entities.values()][0]!.closed).toBe(false);
  dispose();
});

it.each(['circle', 'rectangle'] as const)('%s hides its bar after placement and restores it for the next shape', tool => {
  const { canvas, click, choose, page, dispose } = setup();
  choose(tool); expect(screen.queryByRole('toolbar')).toBeNull();
  click(20, 20); expect(screen.getByRole('toolbar')).toBeTruthy();
  click(60, 40); expect(page().entities.size).toBe(1);
  expect(screen.queryByRole('toolbar')).toBeNull();
  click(100, 80); expect(screen.getByRole('toolbar')).toBeTruthy();
  fireEvent.keyDown(canvas, { key: 'Escape' }); expect(screen.queryByRole('toolbar')).toBeNull();
  dispose();
});
