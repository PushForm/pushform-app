// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { openLayoutFile } from '@pushform/io';
import { LAYOUT_TEXT_INSET_MM } from '@pushform/layout';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function setup() {
  const lineTo = vi.fn(), moveTo = vi.fn(), strokeRect = vi.fn(), fillText = vi.fn();
  const methods = new Map<string | symbol, unknown>([['lineTo', lineTo], ['moveTo', moveTo], ['strokeRect', strokeRect], ['fillText', fillText],
    ['measureText', (value: string) => ({ width: value.length * 2 })]]);
  const context = new Proxy({}, { get: (_target, key) => { if (!methods.has(key)) methods.set(key, vi.fn()); return methods.get(key); },
    set: (_target, key, value) => { methods.set(key, value); return true; } });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}),
  });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout(); render(<LayoutWorkspace tab={tab} session={session} />);
  const canvas = screen.getByLabelText('Page 1 canvas');
  const click = (x: number, y: number) => {
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: x * 3, clientY: y * 3 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: x * 3, clientY: y * 3 });
  };
  const move = (x: number, y: number) => fireEvent.pointerMove(canvas, { pointerId: 1, clientX: x * 3, clientY: y * 3 });
  fireEvent.click(screen.getByRole('button', { name: 'Label' }));
  return { app, session, tab, canvas, click, move, lineTo, moveTo, strokeRect, fillText, page: () => tab.doc.state.pages.get(tab.activePageId)! };
}

it('previews both leader segments, locks the third point horizontally, and centers text on the attachment', async () => {
  const { app, session, tab, click, move, lineTo, moveTo, strokeRect, fillText, page } = setup();
  click(20, 20); move(60, 40);
  expect(page().entities.size).toBe(0);
  expect(lineTo).toHaveBeenCalledWith(20, 20);
  expect(screen.getByRole('status').textContent).toContain('leader bend');
  click(60, 40); move(95, 100);
  expect(page().entities.size).toBe(0);
  expect(moveTo).toHaveBeenCalledWith(95, 40);
  expect(lineTo).toHaveBeenCalledWith(60, 40);
  expect(strokeRect).not.toHaveBeenCalledWith(95, 30, 50, 20);
  click(95, 100);
  const label = () => page().entities.get(page().entityOrder[0]!)!;
  expect(label().points).toEqual([[95, 30], [145, 50], [20, 20], [60, 40]]);
  const editor = screen.getByRole('textbox', { name: 'Edit label on page' });
  expect(editor.style.borderWidth).toBe('0px');
  expect(editor.style.backgroundColor).toBe('transparent');
  fireEvent.input(editor, { target: { textContent: 'Hi' } });
  expect(label().text).toMatchObject({ vertical: 'middle', align: 'left' });
  fireEvent.keyDown(editor, { key: 'Escape' });
  const size = 10 * 25.4 / 72; //: the baseline sits one ascent below the vertically centred line's top.
  expect(fillText).toHaveBeenCalledWith('H', 95 + LAYOUT_TEXT_INSET_MM, expect.closeTo(40 - size * 1.117 / 2 + size * 0.905, 5));
  expect((await openLayoutFile((await session.saveLayoutBytes(tab.id)))).state.pages.get(page().id)!.entities.get(label().id)).toEqual(label());
  // The horizontal part of the leader can select the object too.
  click(80, 40);
  expect(screen.getByLabelText('Text content')).toBeTruthy();
  session.dispose(); app.dispose();
});

it('places text to the left with right alignment while preserving the selected bend', () => {
  const { app, session, click, move, page } = setup();
  click(150, 50); click(110, 80); move(90, 20); click(90, 20);
  const label = page().entities.get(page().entityOrder[0]!)!;
  expect(label.points).toEqual([[40, 70], [90, 90], [150, 50], [110, 80]]);
  expect(label.text).toMatchObject({ align: 'right', vertical: 'middle' });
  session.dispose(); app.dispose();
});

it('cancels unfinished labels and permits correcting a degenerate bend or horizontal segment', () => {
  const { app, session, canvas, click, move, page } = setup();
  click(20, 20); move(60, 40); fireEvent.keyDown(window, { key: 'Escape' });
  expect(page().entities.size).toBe(0);
  expect(screen.getByRole('status').textContent).toContain('arrow should point');
  click(20, 20); click(20, 20);
  expect(screen.getByRole('alert').textContent).toContain('bend away');
  click(60, 40); click(60, 80);
  expect(screen.getByRole('alert').textContent).toContain('left or right');
  expect(page().entities.size).toBe(0);
  fireEvent.pointerCancel(canvas);
  click(20, 20); click(60, 40); fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  expect(page().entities.size).toBe(0);
  fireEvent.click(screen.getByRole('button', { name: 'Label' }));
  click(20, 20); click(60, 40); click(95, 100);
  expect(page().entities.size).toBe(1);
  session.dispose(); app.dispose();
});

it.each(['Escape', 'blur'])('fits a new label to its initial multiline text on %s, preserving the leader and persistence', async finish => {
  const { app, session, tab, click, page } = setup();
  click(20, 20); click(60, 40); click(95, 40);
  const id = page().entityOrder[0]!, entity = () => page().entities.get(id)!;
  const editor = screen.getByRole('textbox', { name: 'Edit label on page' });
  expect(editor.style.borderWidth).toBe('0px');
  expect(screen.queryByLabelText('Selected object bounds')).toBeNull();
  fireEvent.input(editor, { target: { textContent: 'Hi\nthere' } });
  expect(entity().points).toEqual([[95, 30], [145, 50], [20, 20], [60, 40]]); // Commit bounds on finish.
  if (finish === 'Escape') fireEvent.keyDown(editor, { key: 'Escape' }); else fireEvent.blur(editor);
  const height = 2 * 10 * 25.4 / 72 * 1.117;
  expect(entity().points[0]![0]).toBe(95); expect(entity().points[1]![0]).toBeCloseTo(105 + 2 * LAYOUT_TEXT_INSET_MM);
  expect(entity().points[0]![1]).toBeCloseTo(40 - height / 2); expect(entity().points[1]![1]).toBeCloseTo(40 + height / 2);
  expect(entity().points.slice(2)).toEqual([[20, 20], [60, 40]]);
  expect(entity().text).toMatchObject({ content: 'Hi\nthere', bounded: true });
  expect((await openLayoutFile((await session.saveLayoutBytes(tab.id)))).state.pages.get(page().id)!.entities.get(id)).toEqual(entity());
  act(() => { tab.commands.execute('edit.undo'); });
  expect(entity().points.slice(0, 2)).toEqual([[95, 30], [145, 50]]);
  act(() => { tab.commands.execute('edit.redo'); }); expect(entity().points[1]![0]).toBeCloseTo(105 + 2 * LAYOUT_TEXT_INSET_MM);
  session.dispose(); app.dispose();
});

it('fits left-facing labels without moving their right-side attachment or vertical center', () => {
  const { app, session, click, page } = setup();
  click(150, 50); click(110, 80); click(90, 80);
  const editor = screen.getByRole('textbox', { name: 'Edit label on page' });
  fireEvent.input(editor, { target: { textContent: 'Room' } }); fireEvent.keyDown(editor, { key: 'Escape' });
  const entity = page().entities.get(page().entityOrder[0]!)!;
  expect(entity.points[0]![0]).toBeCloseTo(82 - 2 * LAYOUT_TEXT_INSET_MM); expect(entity.points[1]![0]).toBe(90);
  expect((entity.points[0]![1] + entity.points[1]![1]) / 2).toBe(80);
  expect(entity.points.slice(2)).toEqual([[150, 50], [110, 80]]);
  session.dispose(); app.dispose();
});

it('allows initial text wider than the provisional box and does not fit again on later edits', () => {
  const { app, session, canvas, click, page } = setup();
  click(20, 20); click(60, 40); click(95, 40);
  const firstEditor = screen.getByRole('textbox', { name: 'Edit label on page' });
  fireEvent.input(firstEditor, { target: { textContent: 'A'.repeat(100) } });
  expect(firstEditor.style.whiteSpace).toBe('pre'); expect(firstEditor.style.overflow).toBe('visible');
  fireEvent.keyDown(firstEditor, { key: 'Escape' });
  const id = page().entityOrder[0]!, entity = () => page().entities.get(id)!;
  expect(entity().points[1]![0] - entity().points[0]![0]).toBeCloseTo(200 + 2 * LAYOUT_TEXT_INSET_MM);
  const bounds = entity().points;
  fireEvent.doubleClick(canvas, { clientX: 300, clientY: 120 });
  const nextEditor = screen.getByRole('textbox', { name: 'Edit label on page' });
  expect(nextEditor.style.borderWidth).not.toBe('0px');
  fireEvent.input(nextEditor, { target: { textContent: 'Short' } }); fireEvent.keyDown(nextEditor, { key: 'Escape' });
  expect(entity().points).toEqual(bounds);
  session.dispose(); app.dispose();
});
