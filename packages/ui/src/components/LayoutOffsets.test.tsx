// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { openLayoutFile } from '@pushform/io';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';
import { enterLayoutValue, layoutEntryField } from './layoutEntryTesting';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function setup() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}),
  });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout();
  const sourceId = tab.commands.execute('layout.rectangle.add', { pageId: tab.activePageId, kind: 'rectangle', first: [20, 20], second: [80, 60] }) as number;
  render(<LayoutWorkspace tab={tab} session={session} />);
  const canvas = screen.getByLabelText('Page 1 canvas');
  const click = (x: number, y: number) => {
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: x * 3, clientY: y * 3 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: x * 3, clientY: y * 3 });
  };
  const move = (x: number, y: number) => fireEvent.pointerMove(canvas, { pointerId: 1, clientX: x * 3, clientY: y * 3 });
  const measure = (value: string) => enterLayoutValue(value);
  return { app, session, tab, canvas, click, move, measure, sourceId, page: () => tab.doc.state.pages.get(tab.activePageId)! };
}

it('places Offset after Polygon, previews without mutation, and commits independent offsets by mouse or measurement', async () => {
  const { app, session, tab, click, move, measure, sourceId, page } = setup();
  const buttons = within(screen.getByRole('navigation', { name: 'Layout tools' })).getAllByRole('button');
  // Offset follows the Polygon stack, whose last button is its flyout expander.
  const polygonIndex = buttons.findIndex(b => b.getAttribute('aria-label') === 'Polygon tools');
  expect(buttons[polygonIndex + 1]!.getAttribute('aria-label')).toBe('Offset');
  const source = page().entities.get(sourceId)!;
  fireEvent.click(screen.getByRole('button', { name: 'Offset' }));
  click(80, 40); move(85, 40);
  expect(page().entities.size).toBe(1);
  expect(screen.getByRole('status').textContent).toContain('5.00 mm');
  click(85, 40); expect(page().entities.size).toBe(2);
  const offsetId = page().entityOrder[0]!;
  expect(page().entityOrder).toEqual([offsetId, sourceId]);
  expect(page().entities.get(offsetId)!.points).toEqual([[15, 15], [85, 15], [85, 65], [15, 65]]);
  expect(page().entities.get(sourceId)).toEqual(source);
  act(() => { tab.commands.execute('edit.undo'); }); expect(page().entities.size).toBe(1);
  act(() => { tab.commands.execute('edit.redo'); });
  // The outer filled offset must not steal a click on the original boundary.
  click(80, 40);
  fireEvent.keyDown(window, { key: '-' });
  expect(document.activeElement).toBe(layoutEntryField('Distance'));
  expect(layoutEntryField('Distance').value).toBe('-');
  measure('-3mm');
  expect(page().entities.get(page().entityOrder[2]!)!.points).toEqual([[23, 23], [77, 23], [77, 57], [23, 57]]);
  const reopened = (await openLayoutFile((await session.saveLayoutBytes(tab.id))));
  expect(reopened.state.pages.get(page().id)!.entityOrder).toEqual(page().entityOrder);
  for (const id of page().entityOrder) expect(reopened.state.pages.get(page().id)!.entities.get(id)).toEqual(page().entities.get(id));
  session.dispose(); app.dispose();
});

it('rejects invalid offsets without mutation and cancels drafts with Escape or tool changes', () => {
  const { app, session, click, move, measure, page } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Offset' }));
  click(100, 100); expect(screen.getByRole('alert').textContent).toContain('Click a path');
  click(80, 40); measure('-40mm');
  expect(screen.getByRole('alert').textContent).toContain('collapses');
  expect(page().entities.size).toBe(1);
  move(82, 40); click(82, 40); expect(page().entities.size).toBe(2);
  click(80, 40); move(75, 40); fireEvent.keyDown(window, { key: 'Escape' });
  click(100, 100); expect(page().entities.size).toBe(2);
  click(80, 40); fireEvent.keyDown(layoutEntryField('Distance'), { key: 'Escape' });
  expect(screen.getByRole('status').textContent).toContain('Click a path to offset');
  click(80, 40); fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  fireEvent.click(screen.getByRole('button', { name: 'Offset' }));
  measure('2mm'); expect(screen.getByRole('alert').textContent).toContain('Click a path before');
  expect(page().entities.size).toBe(2);
  session.dispose(); app.dispose();
});

it('draws the source and offset guides above opaque covering objects with a contrasting halo, without changing document order', () => {
  const { session, app, tab, canvas, click, move, sourceId, page } = setup();
  type Stroke = { kind: 'stroke'; color: string; width: number; start: number[] | null };
  const frame: (Stroke | { kind: 'fill'; color: string })[] = [];
  let start: number[] | null = null;
  const methods = new Map<string | symbol, unknown>();
  const ctx = new Proxy({}, {
    get: (_, key) => {
      if (!methods.has(key)) methods.set(key, vi.fn());
      return methods.get(key);
    },
    set: (_, key, value) => { methods.set(key, value); return true; },
  }) as CanvasRenderingContext2D;
  methods.set('setTransform', () => { frame.length = 0; });
  methods.set('beginPath', () => { start = null; });
  methods.set('moveTo', (x: number, y: number) => { start ??= [x, y]; });
  methods.set('fill', () => frame.push({ kind: 'fill', color: String(ctx.fillStyle) }));
  methods.set('stroke', () => frame.push({ kind: 'stroke', color: String(ctx.strokeStyle), width: ctx.lineWidth, start }));
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation(function (this: HTMLCanvasElement) {
    return this === canvas ? ctx : null;
  } as typeof HTMLCanvasElement.prototype.getContext);
  act(() => {
    // A higher, every-page layer fully covers both the lower source and the entire offset outline.
    tab.commands.execute('layout.layer.add', { name: 'Covering objects', shared: true });
    tab.commands.execute('layout.style.setDefault', { fillColor: '#1e63d1' });
    tab.commands.execute('layout.rectangle.add', { pageId: page().id, kind: 'rectangle', first: [10, 10], second: [110, 90] });
  });
  const version = tab.doc.version, localOrder = [...page().entityOrder], sharedOrder = [...tab.doc.state.sharedEntityOrder];
  const original = page().entities.get(sourceId);
  fireEvent.click(screen.getByRole('button', { name: 'Offset' }));
  click(80, 40);
  expect(frame.some(event => event.kind === 'stroke' && event.color === '#ffffff' && event.start?.[0] === 20 && event.start?.[1] === 20)).toBe(true);
  move(85, 40);
  const coveringFill = frame.findIndex(event => event.kind === 'fill' && event.color === '#1e63d1');
  expect(coveringFill).toBeGreaterThan(-1);
  for (const first of [[20, 20], [15, 15]]) {
    const guide = frame.findIndex((event, index) => index > coveringFill && event.kind === 'stroke' &&
      event.color === '#1e63d1' && event.start?.[0] === first[0] && event.start?.[1] === first[1]);
    expect(guide).toBeGreaterThan(coveringFill);
    expect(frame[guide - 1]).toMatchObject({ kind: 'stroke', color: '#ffffff', width: 1.2, start: first });
  }
  expect(tab.doc.version).toBe(version);
  expect(page().entityOrder).toEqual(localOrder); expect(tab.doc.state.sharedEntityOrder).toEqual(sharedOrder);
  expect(page().entities.get(sourceId)).toEqual(original);
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(frame.some(event => event.kind === 'stroke' && event.color === '#ffffff')).toBe(false);
  click(80, 40); move(85, 40); click(85, 40);
  expect(frame.some(event => event.kind === 'stroke' && event.color === '#ffffff')).toBe(false);
  expect(page().entities.size).toBe(2);
  session.dispose(); app.dispose();
});
