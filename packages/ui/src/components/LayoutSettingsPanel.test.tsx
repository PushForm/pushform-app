// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { openLayoutFile } from '@pushform/io';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function setup(drawing = false) {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: drawing ? 30000 : 891, height: drawing ? 21000 : 630, right: drawing ? 30000 : 891, bottom: drawing ? 21000 : 630, x: 0, y: 0, toJSON: () => ({}) });
  const app = createApp({ demo: false, expose: false }), session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = drawing ? session.newDrawing() : session.newLayout(), pageId = tab.activePageId;
  const shape = tab.commands.execute('layout.rectangle.add', { pageId, kind: 'rectangle', first: [10, 10], second: [40, 30] }) as number;
  tab.commands.execute('layout.clipboard.paste', { pageId, entities: [{ kind: 'image', points: [[100, 100], [150, 100], [150, 120], [100, 120]], closed: true,
    image: { src: 'data:image/png;base64,eA==' } }] });
  render(<LayoutWorkspace tab={tab} session={session} />);
  const panel = screen.getByRole('complementary', { name: 'Layout settings' });
  const sections = () => within(panel).getAllByRole('heading', { level: 2 }).map((h) => h.textContent?.replace(/\d+$/, '').trim());
  const click = (x: number, y: number) => {
    const canvas = screen.getByLabelText(drawing ? 'Drawing canvas' : 'Page 1 canvas');
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: x * 3, clientY: y * 3 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: x * 3, clientY: y * 3 });
  };
  return { tab, session, pageId, shape, panel, sections, click, dispose: () => { cleanup(); session.dispose(); app.dispose(); } };
}

it('shows only the selection panel, with Document Setup, Layers and Pages moved out', () => {
  const { sections, dispose } = setup();
  expect(sections()).toEqual(['New Shapes']);
  dispose();
});

it('titles the top panel by the selection and shows only its editable properties', () => {
  const { panel, sections, click, dispose } = setup();
  // Nothing selected: default style, no Arrange.
  expect(within(panel).getByLabelText('Weight (pt)')).toBeTruthy();
  expect(within(panel).getByText('Fill')).toBeTruthy();
  expect(within(panel).queryByRole('region', { name: 'Arrange' })).toBeNull();

  click(25, 20);
  expect(sections()[0]).toBe('Shape');
  expect(within(panel).getByText('Fill')).toBeTruthy();
  expect(within(panel).getByRole('region', { name: 'Arrange' })).toBeTruthy();
  expect(within(panel).getByRole('combobox', { name: 'Shape layer' })).toBeTruthy();

  click(125, 110);
  expect(sections()[0]).toBe('Image');
  expect(within(panel).queryByLabelText('Weight (pt)')).toBeNull();
  expect(within(panel).queryByText('Fill')).toBeNull();
  expect(within(panel).getByRole('region', { name: 'Arrange' })).toBeTruthy();
  dispose();
});

it('shows the count and Arrange, but no style controls, for several objects', () => {
  const { panel, sections, click, dispose } = setup();
  click(25, 20);
  const canvas = screen.getByLabelText('Page 1 canvas');
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 375, clientY: 330, shiftKey: true });
  fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 375, clientY: 330, shiftKey: true });
  expect(sections()[0]).toBe('2 Objects');
  expect(within(panel).getByText('2 objects selected')).toBeTruthy();
  expect(within(panel).queryByLabelText('Weight (pt)')).toBeNull();
  // Arrange acts on the selection as a whole.
  expect(within(panel).getByRole('region', { name: 'Arrange' })).toBeTruthy();
  dispose();
});

it('offers start and end arrows only for lines: line tools with nothing selected and an open shape, not a closed one', () => {
  const { tab, pageId, panel, sections, click, dispose } = setup();
  // Nothing selected: only a tool that draws lines offers arrows, which set the default for new lines.
  for (const tool of ['select', 'rectangle', 'circle', 'text']) {
    act(() => { tab.commands.execute(`tool.${tool}`); });
    expect(within(panel).queryByRole('combobox', { name: 'End arrow' })).toBeNull();
  }
  act(() => { tab.commands.execute('tool.line'); });
  fireEvent.change(within(panel).getByRole('combobox', { name: 'End arrow' }), { target: { value: 'filled-triangle' } });
  expect(tab.doc.state.defaultStyle.endArrow).toEqual({ type: 'filled-triangle', sizePt: 4 });
  act(() => { tab.commands.execute('tool.select'); });
  let line = 0;
  act(() => { line = tab.commands.execute('layout.shape.add', { pageId, points: [[10, 50], [60, 50]] }) as number; });
  const style = () => tab.doc.state.pages.get(pageId)!.entities.get(line)!.style!;
  expect(style().endArrow).toEqual({ type: 'filled-triangle', sizePt: 4 });
  click(35, 50);
  expect(sections()[0]).toBe('Shape');
  fireEvent.change(within(panel).getByRole('combobox', { name: 'Start arrow' }), { target: { value: 'open-circle' } });
  fireEvent.change(within(panel).getByRole('spinbutton', { name: 'Start arrow size (pt)' }), { target: { value: '7' } });
  fireEvent.change(within(panel).getByRole('combobox', { name: 'End arrow' }), { target: { value: 'none' } });
  expect(style().startArrow).toEqual({ type: 'open-circle', sizePt: 7 });
  expect(style().endArrow).toBeUndefined();
  expect(within(panel).queryByRole('spinbutton', { name: 'End arrow size (pt)' })).toBeNull();
  // A rectangle is closed: no arrow controls.
  click(25, 20);
  expect(within(panel).queryByRole('combobox', { name: 'Start arrow' })).toBeNull();
  dispose();
});

it('clears a leftover selection when a drawing tool is chosen, so style edits go to new shapes', () => {
  const { sections, click, dispose } = setup();
  click(25, 20);
  expect(sections()[0]).toBe('Shape');
  fireEvent.keyDown(window, { key: 'r', code: 'KeyR' });
  expect(sections()[0]).toBe('New Shapes');
  // other tools keep the selection
  click(25, 20);
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  click(25, 20);
  fireEvent.keyDown(window, { key: 'm', code: 'KeyM' });
  expect(sections()[0]).toBe('Shape');
  dispose();
});

it('remembers tool settings while the app is open, also when the workspace remounts', () => {
  const first = setup();
  act(() => { first.tab.commands.execute('tool.polygon'); });
  const sides = screen.getByLabelText('Sides');
  fireEvent.change(sides, { target: { value: '9' } });
  fireEvent.keyDown(sides, { key: 'Enter' });
  first.dispose();
  const second = setup();
  act(() => { second.tab.commands.execute('tool.polygon'); });
  expect((screen.getByLabelText('Sides') as HTMLInputElement).value).toBe('9');
  second.dispose();
});

it('edits real-world drawing stroke widths, converts units without edits, and preserves undo and native saves', async () => {
  const { tab, session, pageId, shape, click, dispose } = setup(true);
  const field = (unit: string) => screen.getByLabelText(`Stroke width (${unit})`) as HTMLInputElement;
  expect(screen.queryByLabelText('Weight (pt)')).toBeNull();
  const original = tab.doc.state.defaultStyle.strokeWeightPt;
  expect(Number(field('mm').value)).toBeCloseTo(original * 25.4 / 72, 5);
  fireEvent.change(field('mm'), { target: { value: '25.4' } });
  expect(tab.doc.state.defaultStyle.strokeWeightPt).toBeCloseTo(72);
  act(() => { tab.commands.execute('layout.grid.set', { units: 'in' }); });
  expect(Number(field('in').value)).toBe(1);
  expect(tab.doc.state.defaultStyle.strokeWeightPt).toBeCloseTo(72);
  fireEvent.change(field('in'), { target: { value: '0.125' } });
  expect(tab.doc.state.defaultStyle.strokeWeightPt).toBeCloseTo(9);
  act(() => { tab.doc.undoStack.undo(); });
  expect(Number(field('in').value)).toBe(1);
  click(10, 20);
  const style = () => tab.doc.state.pages.get(pageId)!.entities.get(shape)!.style!;
  const before = style().strokeWeightPt;
  fireEvent.change(field('in'), { target: { value: '0.25' } });
  expect(style().strokeWeightPt).toBeCloseTo(18);
  expect(tab.doc.state.defaultStyle.strokeWeightPt).toBeCloseTo(72);
  act(() => { tab.doc.undoStack.undo(); });
  expect(style().strokeWeightPt).toBe(before);
  act(() => { tab.doc.undoStack.redo(); });
  const reopened = await openLayoutFile(await session.saveLayoutBytes(tab.id));
  expect(reopened.state.pages.get(pageId)!.entities.get(shape)!.style!.strokeWeightPt).toBeCloseTo(18);
  expect(reopened.state.defaultStyle.strokeWeightPt).toBeCloseTo(72);
  dispose();
});
