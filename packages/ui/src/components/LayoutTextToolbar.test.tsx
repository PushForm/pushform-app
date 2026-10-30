// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { openLayoutFile } from '@pushform/io';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { getLayoutTextSelection, setLayoutTextSelection } from './LayoutTextEditor';
import { LayoutWorkspace } from './LayoutWorkspace';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function setup() {
  const methods = new Map<string | symbol, unknown>([['measureText', (text: string) => ({ width: text.length * 2 })]]);
  const ctx = new Proxy({}, { get: (_, key) => { if (!methods.has(key)) methods.set(key, vi.fn()); return methods.get(key); },
    set: (_, key, value) => { methods.set(key, value); return true; } });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}),
  });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout(); render(<LayoutWorkspace tab={tab} session={session} />);
  expect(screen.queryByRole('group', { name: 'Text formatting' })).toBeNull();
  const canvas = screen.getByLabelText('Page 1 canvas');
  fireEvent.click(screen.getByRole('button', { name: 'Text' }));
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 30, clientY: 30 });
  fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 330, clientY: 150 });
  const editor = screen.getByRole('textbox', { name: 'Edit text on page' }) as HTMLDivElement;
  fireEvent.input(editor, { target: { textContent: 'Hello world' } });
  const entity = () => [...tab.doc.state.pages.get(tab.activePageId)!.entities.values()][0]!;
  return { tab, session, editor, canvas, entity, dispose: () => { cleanup(); session.dispose(); app.dispose(); } };
}
it('places formatting in the temporary right-side pane, preserves editing focus, and hides on exit', async () => {
  const { tab, session, editor, entity, dispose } = setup();
  const group = screen.getByRole('group', { name: 'Text formatting' });
  expect(group.closest('aside')?.getAttribute('aria-label')).toBe('Layout settings');
  expect(screen.getByRole('region', { name: 'Text tool options' }).contains(group)).toBe(true);
  expect(within(screen.getByRole('navigation', { name: 'Layout tools' })).queryByRole('group', { name: 'Text formatting' })).toBeNull();
  const families = within(within(group).getByRole('combobox', { name: 'Text toolbar font' })).getAllByRole('option').map(option => option.textContent);
  expect(families).toHaveLength(167);
  expect(families).toEqual(expect.arrayContaining(['Inter', 'Roboto', 'Open Sans', 'Lato', 'Montserrat']));
  setLayoutTextSelection(editor, 0, 11); fireEvent.select(editor);
  const bold = within(group).getByRole('button', { name: 'Text toolbar bold' });
  expect(fireEvent.mouseDown(bold)).toBe(false); fireEvent.click(bold);
  expect(entity().text?.bold).toBe(true); expect(bold.getAttribute('aria-pressed')).toBe('true');
  const underline = within(group).getByRole('button', { name: 'Text toolbar underline' });
  fireEvent.click(underline);
  expect(editor.querySelector('span')?.style.textDecorationLine).toBe('underline');
  fireEvent.click(underline);
  expect(editor.querySelector('span')?.style.textDecorationLine).toBe('none');
  expect(document.activeElement).toBe(editor);
  expect(getLayoutTextSelection(editor)?.start).toBe(0); expect(getLayoutTextSelection(editor)?.end).toBe(11);
  const font = within(group).getByRole('combobox', { name: 'Text toolbar font' });
  fireEvent.blur(editor, { relatedTarget: font });
  expect(screen.getByRole('textbox', { name: 'Edit text on page' })).toBe(editor);
  fireEvent.change(font, { target: { value: 'Georgia' } });
  fireEvent.change(within(group).getByRole('spinbutton', { name: 'Text toolbar size' }), { target: { value: '18' } });
  fireEvent.change(within(group).getByLabelText('Text toolbar color'), { target: { value: '#ff0000' } });
  fireEvent.click(within(group).getByRole('button', { name: 'Text toolbar align center' }));
  expect(entity().text).toMatchObject({ fontFamily: 'Georgia', fontSizePt: 18, color: '#ff0000', align: 'center', bold: true });
  fireEvent.keyDown(editor, { key: 'Escape' });
  expect(screen.queryByRole('group', { name: 'Text formatting' })).toBeNull();
  const saved = (await openLayoutFile((await session.saveLayoutBytes(tab.id))));
  expect(saved.state.pages.get(tab.activePageId)?.entities.get(entity().id)?.text).toEqual(entity().text);
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
  expect(entity().text?.align).toBe('left');
  dispose();
});
it('toggles emphasis on the selected range and exits when clicking outside the editor/formatting group', () => {
  const { editor, canvas, entity, dispose } = setup();
  setLayoutTextSelection(editor, 0, 5); fireEvent.select(editor);
  const bold = screen.getByRole('button', { name: 'Text toolbar bold' });
  fireEvent.click(bold);
  expect(entity().text?.spans).toEqual([
    { start: 0, end: 5, bold: true, italic: false, underline: false },
    { start: 5, end: 11, bold: false, italic: false, underline: false },
  ]);
  expect(bold.getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(bold);
  expect(entity().text?.spans).toEqual([{ start: 0, end: 11, bold: false, italic: false, underline: false }]);
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 2, clientX: 600, clientY: 600 });
  expect(screen.queryByRole('group', { name: 'Text formatting' })).toBeNull();
  dispose();
});
it('keeps keyboard tool shortcuts from firing while editing toolbar values and allows Escape to finish', () => {
  const { editor, dispose } = setup();
  const size = screen.getByRole('spinbutton', { name: 'Text toolbar size' });
  size.focus();
  fireEvent.keyDown(size, { key: 'l', code: 'KeyL' });
  expect(screen.getByRole('group', { name: 'Text formatting' })).toBeTruthy();
  fireEvent.keyDown(size, { key: 'Enter' });
  expect(document.activeElement).toBe(editor);
  fireEvent.keyDown(size, { key: 'Escape' });
  expect(screen.queryByRole('group', { name: 'Text formatting' })).toBeNull();
  dispose();
});

it('applies every character attribute to only the selected characters, retaining mixed styles in the editor and file', async () => {
  const { tab, session, editor, entity, dispose } = setup();
  setLayoutTextSelection(editor, 1, 4); fireEvent.select(editor);
  fireEvent.change(screen.getByRole('combobox', { name: 'Text toolbar font' }), { target: { value: 'Georgia' } });
  const size = screen.getByRole('spinbutton', { name: 'Text toolbar size' });
  fireEvent.pointerDown(size); window.getSelection()?.removeAllRanges(); size.focus();
  fireEvent.change(size, { target: { value: '24' } });
  fireEvent.input(screen.getByLabelText('Text toolbar color'), { target: { value: '#ff0000' } });
  const colorVersion = tab.doc.version;
  fireEvent.change(screen.getByLabelText('Text toolbar color'), { target: { value: '#ff0000' } });
  expect(tab.doc.version).toBe(colorVersion);
  for (const key of ['bold', 'italic', 'underline']) fireEvent.click(screen.getByRole('button', { name: `Text toolbar ${key}` }));
  expect(entity().text).toMatchObject({ fontFamily: 'Verdana', fontSizePt: 10, color: '#000000', bold: false, italic: false, underline: false });
  expect(entity().text?.spans).toEqual([
    { start: 0, end: 1, bold: false, italic: false, underline: false },
    { start: 1, end: 4, bold: true, italic: true, underline: true, fontFamily: 'Georgia', fontSizePt: 24, color: '#ff0000' },
    { start: 4, end: 11, bold: false, italic: false, underline: false },
  ]);
  const spans = editor.querySelectorAll('span');
  expect([...spans].map(span => span.textContent)).toEqual(['H', 'ell', 'o world']);
  expect(Object.fromEntries(['fontFamily', 'fontSize', 'color', 'fontWeight', 'fontStyle', 'textDecorationLine'].map(key => [key, spans[1]!.style[key as keyof CSSStyleDeclaration]]))).toEqual({ fontFamily: 'Georgia', fontSize: `${24 * 25.4 / 72 * 3}px`, color: 'rgb(255, 0, 0)',
    fontWeight: 'bold', fontStyle: 'italic', textDecorationLine: 'underline' });
  expect(getLayoutTextSelection(editor)).toEqual({ start: 1, end: 4 });
  // Overlapping changes leave the previous attributes and all other characters untouched.
  setLayoutTextSelection(editor, 3, 7); fireEvent.select(editor);
  fireEvent.change(screen.getByLabelText('Text toolbar color'), { target: { value: '#0000ff' } });
  expect(entity().text?.spans?.find(span => span.start === 3)).toMatchObject({ end: 4, color: '#0000ff', fontFamily: 'Georgia', fontSizePt: 24, bold: true });
  fireEvent.keyDown(editor, { key: 'z', ctrlKey: true });
  expect(entity().text?.spans?.find(span => span.start === 1)).toMatchObject({ end: 4, color: '#ff0000' });
  const saved = (await openLayoutFile((await session.saveLayoutBytes(tab.id))));
  expect(saved.state.pages.get(tab.activePageId)?.entities.get(entity().id)?.text).toEqual(entity().text);
  dispose();
});

it('sets the whole box line spacing, shows an imported fixed spacing, and saves and undoes it', async () => {
  const { tab, session, editor, entity, dispose } = setup();
  setLayoutTextSelection(editor, 1, 4); fireEvent.select(editor);
  const spacing = screen.getByRole('combobox', { name: 'Text toolbar line spacing' }) as HTMLSelectElement;
  expect(spacing.value).toBe('1');
  expect([...spacing.options].map(option => option.textContent)).toEqual(['0.8×', 'Single', '1.15×', '1.5×', '2×', '2.5×', '3×']);
  const spans = entity().text?.spans;
  fireEvent.change(spacing, { target: { value: '1.5' } });
  expect(entity().text?.lineSpacing).toEqual({ mode: 'multiple', value: 1.5 });
  expect(entity().text?.spans).toEqual(spans);
  expect(editor.style.lineHeight).toBe(String(1.5 * (0.905 + 0.212)));
  const saved = (await openLayoutFile((await session.saveLayoutBytes(tab.id))));
  expect(saved.state.pages.get(tab.activePageId)?.entities.get(entity().id)?.text?.lineSpacing).toEqual({ mode: 'multiple', value: 1.5 });
  act(() => { tab.commands.execute('layout.text.update', { pageId: tab.activePageId, entityId: entity().id, text: { lineSpacing: { mode: 'exactly', value: 14 } } }); });
  expect(spacing.value).toBe('exactly:14');
  expect(spacing.selectedOptions[0]!.textContent).toBe('Exactly 14 pt');
  fireEvent.keyDown(editor, { key: 'z', ctrlKey: true });
  expect(entity().text?.lineSpacing).toEqual({ mode: 'multiple', value: 1.5 });
  dispose();
});

it('keeps the editor and selection when clicking toolbar blank areas, buttons, and tool-stack flyouts', () => {
  const { editor, canvas, dispose } = setup();
  setLayoutTextSelection(editor, 1, 4); fireEvent.select(editor);
  const toolbar = screen.getByRole('navigation', { name: 'Layout tools' });
  const formatting = screen.getByRole('group', { name: 'Text formatting' });
  for (const target of [toolbar, screen.getByRole('region', { name: 'Text tool options' }), formatting, formatting.querySelector('.pf-layout-text-toolbar-divider')!]) {
    expect(fireEvent.pointerDown(target, { button: 0 })).toBe(false);
    expect(fireEvent.mouseDown(target, { button: 0 })).toBe(false);
    fireEvent.click(target);
    expect(document.activeElement).toBe(editor);
    expect(getLayoutTextSelection(editor)).toEqual({ start: 1, end: 4 });
    expect(screen.getByRole('textbox', { name: 'Edit text on page' })).toBe(editor);
  }
  const expand = screen.getByRole('button', { name: 'Dimension tools' });
  fireEvent.pointerDown(expand, { button: 0 }); fireEvent.mouseDown(expand, { button: 0 }); fireEvent.click(expand);
  const flyout = screen.getByRole('menu', { name: 'Dimension tools' });
  expect(document.activeElement).toBe(editor);
  fireEvent.pointerDown(flyout, { button: 0 }); fireEvent.mouseDown(flyout, { button: 0 }); fireEvent.click(flyout);
  expect(screen.getByRole('textbox', { name: 'Edit text on page' })).toBe(editor);
  expect(getLayoutTextSelection(editor)).toEqual({ start: 1, end: 4 });
  // An intentional tool selection still works.
  fireEvent.click(screen.getByRole('menuitemradio', { name: /Angular Dimension/ }));
  expect(screen.queryByRole('textbox', { name: 'Edit text on page' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Angular Dimension' }).getAttribute('aria-pressed')).toBe('true');
  expect(canvas).toBeTruthy();
  dispose();
});

it('preserves editing through the top bar and editable toolbar fields, returning to the document on blank clicks', () => {
  const { editor, dispose } = setup();
  // An application bar is outside LayoutWorkspace, as it is in the complete app.
  const bar = document.createElement('header'); bar.className = 'pf-topbar';
  const button = document.createElement('button'); button.textContent = 'Toolbar action';
  const search = document.createElement('input'); search.setAttribute('aria-label', 'Command search');
  bar.append(button, search); document.body.append(bar);
  try {
    setLayoutTextSelection(editor, 2, 7); fireEvent.select(editor);
    fireEvent.pointerDown(button, { button: 0 }); fireEvent.mouseDown(button, { button: 0 }); fireEvent.click(button);
    expect(document.activeElement).toBe(editor);
    fireEvent.pointerDown(search, { button: 0 });
    fireEvent.blur(editor, { relatedTarget: search }); search.focus();
    window.getSelection()?.removeAllRanges();
    expect(document.activeElement).toBe(search);
    expect(screen.getByRole('textbox', { name: 'Edit text on page' })).toBe(editor);
    fireEvent.pointerDown(bar, { button: 0 }); fireEvent.mouseDown(bar, { button: 0 }); fireEvent.click(bar);
    expect(document.activeElement).toBe(editor);
    expect(getLayoutTextSelection(editor)).toEqual({ start: 2, end: 7 });
    // Moving from a formatting field to another toolbar also retains the edit session.
    const size = screen.getByRole('spinbutton', { name: 'Text toolbar size' });
    fireEvent.pointerDown(size, { button: 0 }); size.focus();
    fireEvent.blur(size, { relatedTarget: search }); search.focus();
    expect(screen.getByRole('textbox', { name: 'Edit text on page' })).toBe(editor);
  } finally { bar.remove(); dispose(); }
});
