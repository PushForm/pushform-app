// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { editLayoutTextContent, type LayoutText } from '@pushform/layout';
import { openLayoutFile } from '@pushform/io';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';
import { LayoutTextEditor, getLayoutTextSelection, setLayoutTextSelection } from './LayoutTextEditor';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function setup(content = '') {
  const finish = vi.fn(), change = vi.fn();
  let latest: LayoutText;
  function Harness() {
    const [text, setText] = useState<LayoutText>({ content, fontFamily: 'Arial', fontSizePt: 12, color: '#222222',
      bold: false, italic: false, underline: false, bounded: true, align: 'left', vertical: 'top', leader: 'none', endpoint: 'none',
      spans: [{ start: 0, end: 7, bold: true, italic: false, underline: false }] });
    latest = text;
    return <LayoutTextEditor text={text} label="Test text" style={{}} pixelsPerMm={3}
      autoTextTags={['PageNumber', 'PageName', 'PageCount', 'FileName', 'CurrentDate', 'ProjectName', 'ProjectNumber', 'PageName']}
      onChange={value => { change(value); setText(previous => ({ ...previous, ...editLayoutTextContent(previous, value) })); }}
      onSelection={() => {}} onFinish={finish} onUndo={() => {}} onEmphasis={() => {}} />;
  }
  render(<Harness />);
  const editor = screen.getByRole('textbox', { name: 'Test text' });
  editor.focus();
  const type = (value: string, caret = value.length) => {
    editor.textContent = value; setLayoutTextSelection(editor, caret, caret); fireEvent.input(editor);
  };
  return { editor, type, finish, change, text: () => latest! };
}

it('opens on <, filters built-ins and custom tags, and completes the selected suggestion with Tab', () => {
  const { editor, type, text, change, finish } = setup('Before <pro after');
  type('Before <pro after', 11);
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['<ProjectName>', '<ProjectNumber>']);
  const calls = change.mock.calls.length;
  fireEvent.keyDown(editor, { key: 'ArrowDown' });
  expect(change).toHaveBeenCalledTimes(calls);
  expect(screen.getByRole('option', { name: '<ProjectNumber>' }).getAttribute('aria-selected')).toBe('true');
  expect(fireEvent.keyDown(editor, { key: 'Tab' })).toBe(false);
  expect(text().content).toBe('Before <ProjectNumber> after');
  expect(getLayoutTextSelection(editor)).toEqual({ start: 22, end: 22 });
  expect(text().spans?.[0]).toMatchObject({ start: 0, end: 7, bold: true });
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(document.activeElement).toBe(editor);
  expect(finish).not.toHaveBeenCalled();
  type('<');
  expect(screen.getAllByRole('option')).toHaveLength(7);
  type('<pa');
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['<PageNumber>', '<PageName>', '<PageCount>']);
});

it('accepts a clicked suggestion and avoids duplicating an existing closing bracket', () => {
  const { editor, type, text, finish } = setup();
  type('<PageNa>', 7);
  const option = screen.getByRole('option', { name: '<PageName>' });
  expect(fireEvent.mouseDown(option)).toBe(false);
  fireEvent.click(option);
  expect(text().content).toBe('<PageName>');
  expect(getLayoutTextSelection(editor)).toEqual({ start: 10, end: 10 });
  expect(document.activeElement).toBe(editor);
  expect(finish).not.toHaveBeenCalled();
});

it('dismisses suggestions with Escape, leaves unmatched tags literal, and retains normal Tab behavior', () => {
  const { editor, type, text, finish } = setup();
  type('<Pa');
  fireEvent.keyDown(editor, { key: 'Escape' }); fireEvent.keyUp(editor, { key: 'Escape' });
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(finish).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(editor);
  type('<NoSuchTag');
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(fireEvent.keyDown(editor, { key: 'Tab' })).toBe(true);
  expect(text().content).toBe('<NoSuchTag');
  type('<Pa');
  expect(fireEvent.keyDown(editor, { key: 'Tab', shiftKey: true })).toBe(true);
  setLayoutTextSelection(editor, 0, 2); fireEvent.select(editor);
  expect(screen.queryByRole('listbox')).toBeNull();
  fireEvent.keyDown(editor, { key: 'Escape' });
  expect(finish).toHaveBeenCalled();
});

it('hides during composition and when the caret leaves the tag or editing loses focus', () => {
  const { editor, type } = setup();
  type('Before <Pa');
  setLayoutTextSelection(editor, 2, 2); fireEvent.keyUp(editor, { key: 'ArrowLeft' });
  expect(screen.queryByRole('listbox')).toBeNull();
  type('<Pa');
  fireEvent.compositionStart(editor);
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(fireEvent.keyDown(editor, { key: 'Tab', isComposing: true })).toBe(true);
  fireEvent.compositionEnd(editor);
  expect(screen.getByRole('listbox')).toBeTruthy();
  fireEvent.blur(editor);
  expect(screen.queryByRole('listbox')).toBeNull();
});

it('completes document custom tags in the workspace with undo and native save/reopen', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}),
  });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout();
  tab.commands.execute('layout.document.setField', { name: 'ProjectName', value: 'Library' });
  render(<LayoutWorkspace tab={tab} session={session} />);
  fireEvent.click(screen.getByRole('button', { name: 'Text' }));
  const canvas = screen.getByLabelText('Page 1 canvas');
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 30, clientY: 30 });
  fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 240, clientY: 120 });
  const editor = screen.getByRole('textbox', { name: 'Edit text on page' });
  editor.textContent = '<Pro'; setLayoutTextSelection(editor, 4, 4); fireEvent.input(editor);
  expect(within(screen.getByRole('listbox', { name: 'Auto-Text suggestions' })).getByRole('option', { name: '<ProjectName>' })).toBeTruthy();
  fireEvent.keyDown(editor, { key: 'Tab' });
  const entity = () => [...tab.doc.state.pages.get(tab.activePageId)!.entities.values()][0]!;
  expect(entity().text?.content).toBe('<ProjectName>');
  const reopened = (await openLayoutFile((await session.saveLayoutBytes(tab.id))));
  expect(reopened.state.pages.get(tab.activePageId)!.entities.get(entity().id)?.text?.content).toBe('<ProjectName>');
  fireEvent.keyDown(editor, { key: 'z', ctrlKey: true });
  expect(entity().text?.content).toBe('<Pro');
  cleanup(); session.dispose(); app.dispose();
});
