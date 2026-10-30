// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { openLayoutFile } from '@pushform/io';
import { LayoutDocument } from '@pushform/layout';
import { createLayoutRegistry } from '@pushform/commands';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function setup(attached = true) {
  const lineTo = vi.fn(), moveTo = vi.fn();
  const methods = new Map<string | symbol, unknown>([['lineTo', lineTo], ['moveTo', moveTo], ['measureText', (value: string) => ({ width: value.length * 2 })]]);
  const context = new Proxy({}, { get: (_target, key) => { if (!methods.has(key)) methods.set(key, vi.fn()); return methods.get(key); },
    set: (_target, key, value) => { methods.set(key, value); return true; } });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}) });
  const app = createApp({ demo: false, expose: false }), session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout(), pageId = tab.activePageId;
  const sourceId = tab.commands.execute('layout.shape.add', { pageId, points: [[10, 10], [40, 10], [40, 40], [10, 40]], closed: true }) as number;
  render(<LayoutWorkspace tab={tab} session={session} />);
  const canvas = screen.getByLabelText('Page 1 canvas');
  const down = (x: number, y: number) => fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: x * 3, clientY: y * 3 });
  const move = (x: number, y: number) => fireEvent.pointerMove(canvas, { pointerId: 1, clientX: x * 3, clientY: y * 3 });
  const up = (x: number, y: number) => fireEvent.pointerUp(canvas, { pointerId: 1, clientX: x * 3, clientY: y * 3 });
  const click = (x: number, y: number) => { down(x, y); up(x, y); };
  const drag = (x: number, y: number, toX: number, toY: number) => { down(x, y); move(toX, toY); up(toX, toY); };
  fireEvent.click(screen.getByRole('button', { name: 'Label' }));
  click(attached ? 10.2 : 20, attached ? 10.1 : 50); click(60, 60); click(95, 60);
  const editor = screen.getByRole('textbox', { name: 'Edit label on page' });
  fireEvent.input(editor, { target: { textContent: 'Label' } }); fireEvent.keyDown(editor, { key: 'Escape' });
  const labelId = tab.doc.state.pages.get(pageId)!.entityOrder[1]!;
  // Use a manually sized box so these attachment/drag fixtures are independent of initial text fitting.
  act(() => { tab.commands.execute('layout.text.setBounds', { pageId, entityId: labelId, widthMm: 50, heightMm: 20 }); });
  const label = () => tab.doc.state.pages.get(pageId)!.entities.get(labelId)!;
  return { tab, session, pageId, sourceId, labelId, label, canvas, down, move, up, click, drag, lineTo, moveTo,
    dispose: () => { cleanup(); session.dispose(); app.dispose(); } };
}

it('attaches the first snapped click, previews the connection while moving the source, and saves/reopens it', async () => {
  const { tab, session, pageId, sourceId, labelId, label, down, move, up, lineTo, dispose } = setup();
  expect(label().labelAnchor).toEqual({ entityId: sourceId, pointIndex: 0, pointCount: 4 });
  expect(label().points[2]).toEqual([10, 10]);
  const original = label(), version = tab.doc.version;
  down(25, 20); lineTo.mockClear(); move(35, 25);
  expect(lineTo).toHaveBeenCalledWith(20, 15);
  expect(tab.doc.version).toBe(version); expect(label()).toEqual(original);
  up(35, 25);
  expect(label().points[2]).toEqual([20, 15]);
  expect(label().points.slice(0, 2)).toEqual(original.points.slice(0, 2)); expect(label().points[3]).toEqual([60, 60]);
  const reopened = new LayoutDocument((await openLayoutFile(await session.saveLayoutBytes(tab.id))).state);
  expect(reopened.state.pages.get(pageId)!.entities.get(labelId)).toEqual(label());
  createLayoutRegistry(reopened).commands.execute('layout.shape.move', { pageId, entityId: sourceId, delta: [5, 5] });
  expect(reopened.state.pages.get(pageId)!.entities.get(labelId)?.points[2]).toEqual([25, 20]);
  act(() => { tab.commands.execute('edit.undo'); }); expect(label().points[2]).toEqual([10, 10]);
  dispose();
});

it.each([true, false])('stretches the leader when dragging text (attached: %s)', attached => {
  const { tab, label, down, move, up, lineTo, drag, dispose } = setup(attached);
  const tip = label().points[2], version = tab.doc.version;
  down(110, 60); lineTo.mockClear(); move(125, 60);
  expect(lineTo).toHaveBeenCalledWith(...tip!); expect(tab.doc.version).toBe(version);
  up(125, 60);
  expect(label().points.slice(0, 2)).toEqual([[110, 50], [160, 70]]);
  expect(label().points[3]).toEqual([60, 60]); expect(label().points[2]).toEqual(tip);
  drag(125, 60, 125, 80);
  expect(label().points.slice(0, 2)).toEqual([[110, 70], [160, 90]]);
  expect(label().points[3]).toEqual([60, 80]); expect(label().points[2]).toEqual(tip);
  expect(Boolean(label().labelAnchor)).toBe(attached);
  dispose();
});

it('detaches and moves the entire label when its attached arrow is dragged; undo restores attachment', () => {
  const { tab, pageId, sourceId, label, click, drag, dispose } = setup();
  const original = label(); click(10, 10); expect(label().labelAnchor).toEqual(original.labelAnchor);
  drag(10, 10, 20, 25);
  expect(label().labelAnchor).toBeUndefined();
  expect(label().points).toEqual(original.points.map(([x, y]) => [x + 10, y + 15]));
  act(() => { tab.commands.execute('edit.undo'); }); expect(label()).toEqual(original);
  act(() => { tab.commands.execute('edit.redo'); tab.commands.execute('layout.shape.move', { pageId, entityId: sourceId, delta: [5, 5] }); });
  expect(label().points[2]).toEqual([20, 25]);
  dispose();
});

it('moves an unattached label rigidly when dragging its leader outside the text', () => {
  const { label, drag, dispose } = setup(false);
  const original = label(); drag(75, 60, 90, 70);
  expect(label().points).toEqual(original.points.map(([x, y]) => [x + 15, y + 10]));
  dispose();
});

it.each(['Escape', 'pointer cancellation'])('leaves attachment and geometry unchanged after %s', cancel => {
  const { tab, label, canvas, down, move, up, dispose } = setup();
  const original = label(), version = tab.doc.version;
  down(10, 10); move(30, 30);
  expect(label()).toEqual(original); expect(tab.doc.version).toBe(version);
  if (cancel === 'Escape') fireEvent.keyDown(window, { key: 'Escape' }); else fireEvent.pointerCancel(canvas);
  up(30, 30);
  expect(label()).toEqual(original); expect(tab.doc.version).toBe(version);
  dispose();
});
