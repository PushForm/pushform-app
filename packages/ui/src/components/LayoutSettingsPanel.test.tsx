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
  const app = createApp({ demo: false, expose: false }), session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout(), pageId = tab.activePageId;
  const shape = tab.commands.execute('layout.rectangle.add', { pageId, kind: 'rectangle', first: [10, 10], second: [40, 30] }) as number;
  tab.commands.execute('layout.clipboard.paste', { pageId, entities: [{ kind: 'image', points: [[100, 100], [150, 100], [150, 120], [100, 120]], closed: true,
    image: { src: 'data:image/png;base64,eA==' } }] });
  render(<LayoutWorkspace tab={tab} session={session} />);
  const panel = screen.getByRole('complementary', { name: 'Layout settings' });
  const sections = () => within(panel).getAllByRole('heading', { level: 2 }).map((h) => h.textContent?.replace(/\d+$/, '').trim());
  const click = (x: number, y: number) => {
    const canvas = screen.getByLabelText('Page 1 canvas');
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: x * 3, clientY: y * 3 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: x * 3, clientY: y * 3 });
  };
  return { tab, pageId, shape, panel, sections, click, dispose: () => { cleanup(); session.dispose(); app.dispose(); } };
}

it('shows only the selection panel, with Document Setup, Layers and Pages moved out', () => {
  const { sections, dispose } = setup();
  expect(sections()).toEqual(['Default Style']);
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

it('shows the count and no style or Arrange controls for several objects', () => {
  const { panel, sections, click, dispose } = setup();
  click(25, 20);
  const canvas = screen.getByLabelText('Page 1 canvas');
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 375, clientY: 330, shiftKey: true });
  fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 375, clientY: 330, shiftKey: true });
  expect(sections()[0]).toBe('2 Objects');
  expect(within(panel).getByText('2 objects selected')).toBeTruthy();
  expect(within(panel).queryByLabelText('Weight (pt)')).toBeNull();
  expect(within(panel).queryByRole('region', { name: 'Arrange' })).toBeNull();
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
