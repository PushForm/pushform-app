// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { openLayoutFile } from '@pushform/io';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';
import { enterLayoutValue } from './layoutEntryTesting';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function setup() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}),
  });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout();
  tab.commands.execute('layout.style.setDefault', { fillColor: '#cceeff' });
  const sourceId = tab.commands.execute('layout.rectangle.add', { pageId: tab.activePageId, kind: 'rectangle', first: [20, 20], second: [80, 60] }) as number;
  render(<LayoutWorkspace tab={tab} session={session} />);
  const canvas = screen.getByLabelText('Page 1 canvas');
  const click = (x: number, y: number) => {
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: x * 3, clientY: y * 3 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: x * 3, clientY: y * 3 });
  };
  const move = (x: number, y: number) => fireEvent.pointerMove(canvas, { pointerId: 1, clientX: x * 3, clientY: y * 3 });
  // Corner is one tool; its bar chooses Round (fillet) or Chamfer
  const choose = (name: string) => {
    fireEvent.click(screen.getByRole('button', { name: 'Corner' }));
    fireEvent.click(within(screen.getByRole('toolbar', { name: 'Corner options' })).getByRole('radio', { name: name === 'Fillet' ? 'Round' : name }));
  };
  return { app, session, tab, canvas, click, move, choose, sourceId, page: () => tab.doc.state.pages.get(tab.activePageId)! };
}

/** Type `text` into the tool options bar's field `label` and leave it, which commits it as Enter does. */
function setBar(label: string, text: string): void {
  const input = screen.getByLabelText(label);
  fireEvent.change(input, { target: { value: text } });
  fireEvent.blur(input);
}

it('puts one Corner tool after Offset and edits native corners using its bar and typed sizes', async () => {
  const { app, session, tab, click, move, choose, sourceId, page } = setup();
  const buttons = within(screen.getByRole('navigation', { name: 'Layout tools' })).getAllByRole('button');
  const offsetIndex = buttons.findIndex(b => b.getAttribute('aria-label') === 'Offset');
  expect(buttons[offsetIndex + 1]!.getAttribute('aria-label')).toBe('Corner');
  const source = page().entities.get(sourceId)!;
  choose('Fillet'); click(50, 20); move(80, 40);
  expect(page().entities.get(sourceId)).toEqual(source);
  click(80, 40);
  expect(page().entities.get(sourceId)!.points).toEqual([[20, 20], [75, 20], [80, expect.closeTo(25, 8)], [80, 60], [20, 60]]);
  expect(page().entities.get(sourceId)!.handles![1]!.out).toBeDefined();
  choose('Chamfer');
  enterLayoutValue('4mm');
  expect((screen.getByLabelText('Distance') as HTMLInputElement).value).toMatch(/^4(\.0+)? ?mm$/);
  click(80, 45); click(50, 60);
  expect(page().entities.get(sourceId)!.points).toContainEqual([80, 56]);
  expect(page().entities.get(sourceId)).toMatchObject({ closed: true, style: source.style });
  act(() => { tab.commands.execute('edit.undo'); }); expect(page().entities.get(sourceId)!.points).toHaveLength(5);
  act(() => { tab.commands.execute('edit.redo'); });
  const reopened = (await openLayoutFile((await session.saveLayoutBytes(tab.id))));
  expect(reopened.state.pages.get(page().id)!.entities.get(sourceId)).toEqual(page().entities.get(sourceId));
  // the Corner button goes back to the last choice; Shift+F and Shift+C choose Round and Chamfer
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  fireEvent.click(screen.getByRole('button', { name: 'Corner' }));
  expect(screen.getByRole('radio', { name: 'Chamfer' }).getAttribute('aria-checked')).toBe('true');
  fireEvent.keyDown(window, { key: 'F', code: 'KeyF', shiftKey: true });
  expect(screen.getByRole('button', { name: 'Corner' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('radio', { name: 'Round' }).getAttribute('aria-checked')).toBe('true');
  fireEvent.keyDown(window, { key: 'C', code: 'KeyC', shiftKey: true });
  expect(screen.getByRole('radio', { name: 'Chamfer' }).getAttribute('aria-checked')).toBe('true');
  session.dispose(); app.dispose();
});

it('keeps invalid edits atomic, allows correcting the size, and cancels a pending corner', () => {
  const { app, session, canvas, click, choose, sourceId, page } = setup();
  const source = page().entities.get(sourceId)!;
  choose('Fillet');
  setBar('Radius', '100mm');
  click(50, 20); click(80, 40);
  expect(screen.getByRole('alert').textContent).toContain('smaller');
  expect(page().entities.get(sourceId)).toEqual(source);
  setBar('Radius', '3mm');
  click(80, 40); expect(page().entities.get(sourceId)!.points).toHaveLength(5);
  const edited = page().entities.get(sourceId)!;
  click(50, 20); fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.getByRole('status').textContent).toContain('first straight segment');
  click(80, 40); fireEvent.pointerCancel(canvas);
  expect(page().entities.get(sourceId)).toEqual(edited);
  session.dispose(); app.dispose();
});

it('joins two separate straight paths into a single editable fillet', () => {
  const { app, session, tab, click, choose, page } = setup();
  let first = 0, second = 0;
  act(() => {
    first = tab.commands.execute('layout.shape.add', { pageId: tab.activePageId, points: [[100, 20], [130, 20]], closed: false }) as number;
    second = tab.commands.execute('layout.shape.add', { pageId: tab.activePageId, points: [[130, 20], [130, 50]], closed: false }) as number;
  });
  choose('Fillet'); click(110, 20); click(130, 35);
  expect(page().entities.has(second)).toBe(false);
  expect(page().entities.get(first)!.points).toHaveLength(4);
  expect(page().entities.get(first)!.handles![1]!.out).toBeDefined();
  session.dispose(); app.dispose();
});
