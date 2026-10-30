// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { openLayoutFile } from '@pushform/io';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';

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
  const choose = (name: string) => {
    fireEvent.click(screen.getByRole('button', { name: 'Fillet / Chamfer tools' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name }));
  };
  return { app, session, tab, canvas, click, move, choose, sourceId, page: () => tab.doc.state.pages.get(tab.activePageId)! };
}

it('stacks Fillet and Chamfer after Offset and edits native corners using toolbar and Measurements sizes', async () => {
  const { app, session, tab, click, move, choose, sourceId, page } = setup();
  const buttons = within(screen.getByRole('navigation', { name: 'Layout tools' })).getAllByRole('button');
  const offsetIndex = buttons.findIndex(b => b.getAttribute('aria-label') === 'Offset');
  expect(buttons[offsetIndex + 1]!.getAttribute('aria-label')).toBe('Fillet');
  const source = page().entities.get(sourceId)!;
  choose('Fillet'); click(50, 20); move(80, 40);
  expect(page().entities.get(sourceId)).toEqual(source);
  click(80, 40);
  expect(page().entities.get(sourceId)!.points).toEqual([[20, 20], [75, 20], [80, expect.closeTo(25, 8)], [80, 60], [20, 60]]);
  expect(page().entities.get(sourceId)!.handles![1]!.out).toBeDefined();
  choose('Chamfer');
  fireEvent.change(screen.getByLabelText('Layout Measurements'), { target: { value: '4mm' } });
  fireEvent.keyDown(screen.getByLabelText('Layout Measurements'), { key: 'Enter' });
  expect((screen.getByLabelText('Chamfer distance (mm)') as HTMLInputElement).value).toBe('4');
  click(80, 45); click(50, 60);
  expect(page().entities.get(sourceId)!.points).toContainEqual([80, 56]);
  expect(page().entities.get(sourceId)).toMatchObject({ closed: true, style: source.style });
  act(() => { tab.commands.execute('edit.undo'); }); expect(page().entities.get(sourceId)!.points).toHaveLength(5);
  act(() => { tab.commands.execute('edit.redo'); });
  const reopened = (await openLayoutFile((await session.saveLayoutBytes(tab.id))));
  expect(reopened.state.pages.get(page().id)!.entities.get(sourceId)).toEqual(page().entities.get(sourceId));
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  expect(screen.getByRole('button', { name: 'Chamfer' })).toBeTruthy();
  fireEvent.keyDown(window, { key: 'F', code: 'KeyF', shiftKey: true });
  expect(screen.getByRole('button', { name: 'Fillet' }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.keyDown(window, { key: 'C', code: 'KeyC', shiftKey: true });
  expect(screen.getByRole('button', { name: 'Chamfer' }).getAttribute('aria-pressed')).toBe('true');
  session.dispose(); app.dispose();
});

it('keeps invalid edits atomic, allows correcting the size, and cancels a pending corner', () => {
  const { app, session, canvas, click, choose, sourceId, page } = setup();
  const source = page().entities.get(sourceId)!;
  choose('Fillet');
  fireEvent.change(screen.getByLabelText('Fillet radius (mm)'), { target: { value: '100' } });
  click(50, 20); click(80, 40);
  expect(screen.getByRole('alert').textContent).toContain('smaller');
  expect(page().entities.get(sourceId)).toEqual(source);
  fireEvent.change(screen.getByLabelText('Fillet radius (mm)'), { target: { value: '3' } });
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
