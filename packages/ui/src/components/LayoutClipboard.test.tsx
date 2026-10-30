// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { openLayoutFile } from '@pushform/io';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';
import { LAYOUT_CLIPBOARD_TYPE, readLayoutClipboard } from './layoutClipboard';
import { layoutTextStyleAt, tableCells } from '@pushform/layout';
import { setLayoutTextSelection } from './LayoutTextEditor';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function clipboard(values: Record<string, string> = {}, files: File[] = []) {
  return { getData: (type: string) => values[type] ?? '', setData: (type: string, value: string) => { values[type] = value; }, files,
    items: files.map(file => ({ kind: 'file', type: file.type, getAsFile: () => file })) };
}
function setup() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}) });
  const app = createApp({ demo: false, expose: false }), session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout(), pageId = tab.activePageId;
  render(<LayoutWorkspace tab={tab} session={session} />);
  const canvas = screen.getByLabelText('Page 1 canvas');
  const click = (x: number, y: number) => {
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: x * 3, clientY: y * 3 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: x * 3, clientY: y * 3 });
  };
  return { tab, pageId, session, canvas, click, entities: () => [...tab.doc.state.pages.get(pageId)!.entities.values()],
    dispose: () => { cleanup(); session.dispose(); app.dispose(); } };
}
function mockImage(fail = false) {
  vi.stubGlobal('Image', class {
    naturalWidth = 1200; naturalHeight = 600;
    onload: (() => void) | null = null; onerror: (() => void) | null = null;
    set src(_src: string) { queueMicrotask(() => fail ? this.onerror?.() : this.onload?.()); }
  });
}

it('pastes multiline text in a centered fitted box, selects it, undoes once and saves/reopens it', async () => {
  const { tab, pageId, session, entities, dispose } = setup();
  fireEvent.paste(window, { clipboardData: clipboard({ 'text/plain': 'Hello\r\nworld' }) });
  const entity = entities()[0]!;
  expect(entity.text).toMatchObject({ content: 'Hello\nworld', fontFamily: 'Verdana', fontSizePt: 10, bounded: false });
  expect((entity.points[0]![0] + entity.points[1]![0]) / 2).toBeCloseTo(148.5);
  expect((entity.points[0]![1] + entity.points[1]![1]) / 2).toBeCloseTo(105);
  expect(screen.getByRole('button', { name: 'Resize text right' })).toBeTruthy();
  expect((await openLayoutFile((await session.saveLayoutBytes(tab.id)))).state.pages.get(pageId)?.entities.get(entity.id)).toEqual(entity);
  act(() => { tab.commands.execute('edit.undo'); }); expect(entities()).toHaveLength(0);
  act(() => { tab.commands.execute('edit.redo'); }); expect(entities()).toHaveLength(1);
  dispose();
});

it('copies and pastes a selected path with its styling independently', () => {
  const { tab, pageId, click, entities, dispose } = setup();
  act(() => { tab.commands.execute('layout.shape.add', { pageId, points: [[30, 30], [70, 30], [70, 70], [30, 70]], closed: true }); });
  click(50, 50);
  const data = clipboard(); fireEvent.copy(window, { clipboardData: data });
  expect(data.getData(LAYOUT_CLIPBOARD_TYPE)).toContain('path');
  fireEvent.paste(window, { clipboardData: data });
  expect(entities()).toHaveLength(2);
  expect(entities()[1]!.id).not.toBe(entities()[0]!.id);
  expect(entities()[1]!.style).toEqual(entities()[0]!.style);
  expect(entities()[1]!.points[0]).toEqual([128.5, 85]);
  dispose();
});

it('pastes rich HTML and RTF as native text with formatting and one-step undo/save/reopen', async () => {
  const { tab, pageId, session, entities, dispose } = setup();
  fireEvent.paste(window, { clipboardData: clipboard({ 'text/html': '<p style="text-align:right">Hello <b style="color:#123456;font-size:18pt">world</b></p>', 'text/plain': 'Hello world' }) });
  const entity = entities()[0]!;
  expect(entity.text!.content).toBe('Hello world'); expect(entity.text!.align).toBe('right');
  expect(layoutTextStyleAt(entity.text!, 7)).toMatchObject({ bold: true, color: '#123456', fontSizePt: 18 });
  expect((await openLayoutFile((await session.saveLayoutBytes(tab.id)))).state.pages.get(pageId)?.entities.get(entity.id)).toEqual(entity);
  act(() => { tab.commands.execute('edit.undo'); }); expect(entities()).toHaveLength(0);
  fireEvent.paste(window, { clipboardData: clipboard({ 'text/rtf': '{\\rtf1\\ansi Plain \\i italic\\i0}' }) });
  expect(entities()[0]!.text!.content).toBe('Plain italic');
  expect(layoutTextStyleAt(entities()[0]!.text!, 7).italic).toBe(true);
  dispose();
});

it('inserts rich text at the text cursor, preserving surrounding runs and supporting plain paste', () => {
  const { tab, canvas, entities, dispose } = setup();
  fireEvent.paste(window, { clipboardData: clipboard({ 'text/plain': 'before replace after' }) });
  fireEvent.doubleClick(canvas, { clientX: 148.5 * 3, clientY: 105 * 3 });
  const editor = screen.getByRole('textbox', { name: 'Edit text on page' });
  setLayoutTextSelection(editor, 7, 14);
  const data = clipboard({ 'text/html': '<b style="color:#ff0000">new</b>', 'text/plain': 'new' });
  fireEvent.paste(editor, { clipboardData: data });
  expect(entities()).toHaveLength(1); expect(entities()[0]!.text!.content).toBe('before new after');
  expect(layoutTextStyleAt(entities()[0]!.text!, 8)).toMatchObject({ bold: true, color: '#ff0000' });
  expect(layoutTextStyleAt(entities()[0]!.text!, 11).bold).toBe(false);
  act(() => { tab.commands.execute('edit.undo'); });
  expect(entities()[0]!.text!.content).toBe('before replace after');
  setLayoutTextSelection(editor, 7, 14);
  fireEvent.keyDown(editor, { key: 'v', ctrlKey: true, shiftKey: true });
  fireEvent.paste(editor, { clipboardData: data });
  expect(entities()[0]!.text!.content).toBe('before new after');
  expect(layoutTextStyleAt(entities()[0]!.text!, 8)).toMatchObject({ bold: false, color: '#000000' });
  dispose();
});

it('pastes without formatting onto the canvas as text even when the clipboard contains a table', () => {
  const { entities, dispose } = setup();
  fireEvent.keyDown(window, { key: 'v', metaKey: true, shiftKey: true });
  fireEvent.paste(window, { clipboardData: clipboard({ 'text/plain': 'A\tB', 'text/html': '<table><tr><td>A</td><td>B</td></tr></table>' }) });
  expect(entities()).toHaveLength(1); expect(entities()[0]!.kind).toBe('text');
  expect(entities()[0]!.text!.content).toBe('A\tB'); expect(entities()[0]!.text!.spans).toBeUndefined();
  dispose();
});

it('prefers editable rich text over an app-provided image preview', () => {
  const data = clipboard({ 'text/html': '<b>Editable</b>', 'text/plain': 'Editable' }, [new File(['bytes'], 'preview.png', { type: 'image/png' })]);
  expect(readLayoutClipboard(data as unknown as DataTransfer)).toMatchObject({ kind: 'text', text: 'Editable' });
});

it('pastes rich text and embedded images in reading order atomically, retaining their native objects', async () => {
  mockImage();
  const { tab, pageId, session, entities, dispose } = setup();
  fireEvent.paste(window, { clipboardData: clipboard({ 'text/html': '<div><p><b>Before</b></p><img src="data:image/png;base64,eA=="><p><i>After</i></p></div>', 'text/plain': 'Before\nAfter' }) });
  await waitFor(() => expect(entities()).toHaveLength(3));
  const pasted = entities();
  expect(pasted.map(entity => entity.kind)).toEqual(['text', 'image', 'text']);
  expect(layoutTextStyleAt(pasted[0]!.text!, 0).bold).toBe(true);
  expect(layoutTextStyleAt(pasted[2]!.text!, 0).italic).toBe(true);
  expect(pasted[1]!.points[0]![1]).toBeGreaterThan(pasted[0]!.points[0]![1]);
  expect(pasted[2]!.points[0]![1]).toBeGreaterThan(pasted[1]!.points[0]![1]);
  expect((await openLayoutFile((await session.saveLayoutBytes(tab.id)))).state.pages.get(pageId)!.entities.size).toBe(3);
  act(() => { tab.commands.execute('edit.undo'); }); expect(entities()).toHaveLength(0);
  dispose();
});

it('retains distinct paragraph alignment and inherited styles as editable text blocks', async () => {
  const { entities, dispose } = setup();
  fireEvent.paste(window, { clipboardData: clipboard({ 'text/html': '<div style="color:#123456;font-family:Arial"><p style="text-align:left">Left</p><p style="text-align:right;line-height:2">Right</p></div>' }) });
  await waitFor(() => expect(entities()).toHaveLength(2));
  expect(entities().map(entity => entity.text!.align)).toEqual(['left', 'right']);
  expect(layoutTextStyleAt(entities()[1]!.text!, 0)).toMatchObject({ color: '#123456', fontFamily: 'Arial' });
  expect(entities()[1]!.text!.lineSpacing).toEqual({ mode: 'multiple', value: 2 });
  dispose();
});

it('uses clipboard image files for mixed HTML whose image references an app-local file', async () => {
  mockImage();
  const { entities, dispose } = setup();
  fireEvent.paste(window, { clipboardData: clipboard({ 'text/html': '<p>Caption</p><img src="file:///tmp/picture.webp">' }, [new File(['bytes'], 'picture.webp', { type: 'image/webp' })]) });
  await waitFor(() => expect(entities()).toHaveLength(2));
  expect(entities()[0]!.text!.content).toBe('Caption');
  expect(entities()[1]!.image!.src).toMatch(/^data:image\/webp/);
  dispose();
});

it('does not insert mixed HTML content after a page change or after an image fails', async () => {
  mockImage(true);
  const { tab, entities, dispose } = setup();
  const html = '<p>Before</p><img src="data:image/png;base64,eA=="><p>After</p>';
  fireEvent.paste(window, { clipboardData: clipboard({ 'text/html': html }) });
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('could not be loaded'));
  expect(entities()).toHaveLength(0);
  mockImage();
  fireEvent.paste(window, { clipboardData: clipboard({ 'text/html': html }) });
  act(() => { tab.activePageId = tab.commands.execute('layout.page.add', { name: 'Other' }) as number; });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(entities()).toHaveLength(0);
  dispose();
});

it('retains rich formatting and white default fills in pasted table cells', () => {
  const { entities, dispose } = setup();
  fireEvent.paste(window, { clipboardData: clipboard({ 'text/html': '<table><tr><td><b>Bold</b> plain <i style="color:#123456">italic</i></td><td>Default</td></tr></table>' }) });
  const entity = entities()[0]!, text = entity.table!.cells[0]!.text;
  expect(text.content).toBe('Bold plain italic'); expect(layoutTextStyleAt(text, 0).bold).toBe(true);
  expect(layoutTextStyleAt(text, 12)).toMatchObject({ italic: true, color: '#123456' });
  expect(tableCells(entity).map(cell => cell.fillColor)).toEqual(['#ffffff', '#ffffff']);
  dispose();
});

it.each(['html', 'tsv'])('pastes %s table data as a native editable table with undo and save/reopen', async format => {
  const { tab, pageId, session, canvas, entities, dispose } = setup();
  const data = clipboard({ 'text/plain': 'Item\tCount\r\nDoors\t2\r\n',
    ...(format === 'html' ? { 'text/html': '<style>.heading {background-color:#ffee00}</style><table><tr><th class="heading">Item</th><th style="background:#00ffff">Count</th></tr><tr><td>Doors</td><td>2</td></tr></table><img src="data:image/png;base64,eA==">' } : {}) });
  fireEvent.paste(window, { clipboardData: data });
  const entity = entities()[0]!;
  expect(entities()).toHaveLength(1); expect(entity.kind).toBe('table');
  expect(entity.table!.cells.map(cell => cell.text.content)).toEqual(['Item', 'Count', 'Doors', '2']);
  expect(entity.table!.cells[0]!.text).toMatchObject({ fontFamily: 'Verdana', fontSizePt: 10 });
  expect(entity.table!.cells.map(cell => cell.fillColor)).toEqual(format === 'html' ? ['#ffee00', '#00ffff', undefined, undefined] : [undefined, undefined, undefined, undefined]);
  expect((entity.points[0]![0] + entity.points[1]![0]) / 2).toBeCloseTo(148.5);
  expect((entity.points[0]![1] + entity.points[3]![1]) / 2).toBeCloseTo(105);
  expect((await openLayoutFile((await session.saveLayoutBytes(tab.id)))).state.pages.get(pageId)?.entities.get(entity.id)).toEqual(entity);
  act(() => { tab.commands.execute('edit.undo'); }); expect(entities()).toHaveLength(0);
  act(() => { tab.commands.execute('edit.redo'); }); expect(entities()[0]).toEqual(entity);
  fireEvent.doubleClick(canvas, { clientX: (entity.points[0]![0] + 5) * 3, clientY: (entity.points[0]![1] + 5) * 3 });
  const editor = screen.getByLabelText('Edit table cell on page');
  expect((screen.getByLabelText('Cell fill') as HTMLInputElement).value).toBe(format === 'html' ? '#ffee00' : '#ffffff');
  fireEvent.change(editor, { target: { value: 'Edited heading' } }); fireEvent.blur(editor);
  expect(entities()[0]!.table!.cells[0]!.text.content).toBe('Edited heading');
  dispose();
});

it('rejects oversized tables and table insertion on a hidden layer atomically', () => {
  const { tab, entities, dispose } = setup();
  const before = tab.doc.state;
  fireEvent.paste(window, { clipboardData: clipboard({ 'text/plain': Array(101).fill('a\tb').join('\n') }) });
  expect(screen.getByRole('alert').textContent).toContain('at most 100');
  expect(tab.doc.state).toBe(before);
  act(() => { tab.commands.execute('layout.layer.setVisible', { layerId: tab.doc.state.activeLayerId, visible: false }); });
  fireEvent.paste(window, { clipboardData: clipboard({ 'text/plain': 'a\tb' }) });
  expect(screen.getByRole('alert').textContent).toContain('unlocked layer');
  expect(entities()).toHaveLength(0);
  dispose();
});

it('retains SVG source paste when its markup contains indentation tabs', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg">\n\t<rect width="10" height="10"/>\n</svg>';
  expect(readLayoutClipboard(clipboard({ 'text/plain': svg }) as unknown as DataTransfer)).toEqual({ kind: 'svg', source: svg });
});

it.each(['html-image', 'mixed-html', 'inline-svg', 'data-url', 'async-svg'])('imports %s vectors as editable objects despite a bitmap preview', async format => {
  const { tab, pageId, session, entities, dispose } = setup();
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40"><path d="M0 0L60 40" fill="none" stroke="#123456"/><rect x="10" y="10" width="10" height="10"/></svg>';
  const source = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  const values = format === 'data-url' ? { 'text/plain': source } : format === 'async-svg' ? {} :
    { 'text/html': format === 'inline-svg' ? svg : `${format === 'mixed-html' ? '<p>Caption</p>' : ''}<img src="${source}">` };
  const read = vi.fn().mockResolvedValue([{ types: ['image/svg+xml'], getType: async () => ({ text: async () => svg }) }]);
  vi.stubGlobal('navigator', { clipboard: { read } });
  fireEvent.paste(window, { clipboardData: clipboard(values, [new File(['preview'], 'preview.png', { type: 'image/png' })]) });
  await waitFor(() => expect(entities()).toHaveLength(format === 'mixed-html' ? 3 : 2));
  const paths = entities().filter(entity => entity.kind === 'path');
  expect(paths.map(entity => entity.closed)).toEqual([false, true]);
  expect(entities().some(entity => entity.kind === 'image')).toBe(false);
  expect(read).toHaveBeenCalledTimes(format === 'async-svg' ? 1 : 0);
  expect([...(await openLayoutFile((await session.saveLayoutBytes(tab.id)))).state.pages.get(pageId)!.entities.values()]).toEqual(entities());
  act(() => { tab.commands.execute('edit.undo'); }); expect(entities()).toHaveLength(0);
  dispose();
});

it.each(['png', 'jpg', 'webp', 'gif', 'bmp', 'avif', 'svg', 'svg-source'])('pastes %s preserving aspect ratio and save/reopen', async format => {
  mockImage();
  const { tab, pageId, session, entities, dispose } = setup();
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 600"><rect width="1200" height="600" fill="red"/></svg>';
  const data = format === 'svg-source' ? clipboard({ 'text/plain': svg }) : clipboard({}, [new File([format === 'svg' ? svg : 'bytes'], `image.${format}`,
    { type: format === 'jpg' ? 'image/jpeg' : format === 'svg' ? 'image/svg+xml' : `image/${format}` })]);
  fireEvent.paste(window, { clipboardData: data });
  await waitFor(() => expect(entities()).toHaveLength(1));
  const entity = entities()[0]!;
  expect(entity.kind).toBe(format.startsWith('svg') ? 'path' : 'image');
  if (!format.startsWith('svg')) expect(entity.image?.src).toMatch(new RegExp(`^data:image/${format === 'jpg' ? 'jpeg' : format}`));
  const [a, b, c] = format.startsWith('svg') ? [entity.points[1], entity.points[2], entity.points[3]] : entity.points;
  expect((a![0] + c![0]) / 2).toBeCloseTo(148.5); expect((a![1] + c![1]) / 2).toBeCloseTo(105);
  expect((b![0] - a![0]) / (c![1] - a![1])).toBeCloseTo(2);
  expect(b![0] - a![0]).toBeLessThanOrEqual(277);
  expect((await openLayoutFile((await session.saveLayoutBytes(tab.id)))).state.pages.get(pageId)?.entities.get(entity.id)).toEqual(entity);
  act(() => { tab.commands.execute('edit.undo'); }); expect(entities()).toHaveLength(0);
  dispose();
});

it('leaves paste inside the text editor and editable fields to normal text editing', () => {
  const { canvas, entities, dispose } = setup();
  fireEvent.paste(window, { clipboardData: clipboard({ 'text/plain': 'Existing' }) });
  fireEvent.doubleClick(canvas, { clientX: 148.5 * 3, clientY: 105 * 3 });
  const editor = screen.getByRole('textbox', { name: 'Edit text on page' });
  fireEvent.paste(editor, { clipboardData: clipboard({ 'text/plain': 'Replacement' }) });
  expect(entities()).toHaveLength(1); expect(entities()[0]!.text?.content).toBe('Replacement');
  fireEvent.keyDown(editor, { key: 'Escape' });
  const event = createEvent.paste(screen.getByLabelText('Layout Measurements'), { clipboardData: clipboard({ 'text/plain': '100' }) });
  fireEvent(screen.getByLabelText('Layout Measurements'), event);
  expect(event.defaultPrevented).toBe(false); expect(entities()).toHaveLength(1);
  dispose();
});

it('reports malformed content and hidden layers without inserting an object', async () => {
  const { tab, entities, dispose } = setup();
  fireEvent.paste(window, { clipboardData: clipboard({ 'text/plain': '<svg><broken></svg>' }) });
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('invalid'));
  expect(entities()).toHaveLength(0);
  act(() => { tab.commands.execute('layout.layer.setVisible', { layerId: tab.doc.state.activeLayerId, visible: false }); });
  fireEvent.paste(window, { clipboardData: clipboard({ 'text/plain': 'Blocked' }) });
  expect(screen.getByRole('alert').textContent).toContain('unlocked layer'); expect(entities()).toHaveLength(0);
  dispose();
});

it('does not insert an image after a page change or after image decoding fails', async () => {
  let finish: (() => void) | null = null;
  vi.stubGlobal('Image', class {
    naturalWidth = 100; naturalHeight = 100; onload: (() => void) | null = null;
    set src(_src: string) { finish = () => this.onload?.(); }
  });
  const { tab, session, pageId, entities, dispose } = setup();
  fireEvent.paste(window, { clipboardData: clipboard({ 'text/plain': 'data:image/png;base64,eA==' }) });
  act(() => { session.setActivePage(tab.commands.execute('layout.page.add', {}) as number); });
  await act(async () => { (finish as (() => void) | null)?.(); });
  expect(entities()).toHaveLength(0);
  act(() => { session.setActivePage(pageId); });
  mockImage(true);
  fireEvent.paste(window, { clipboardData: clipboard({ 'text/plain': 'data:image/png;base64,eA==' }) });
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('could not be loaded'));
  expect(entities()).toHaveLength(0);
  dispose();
});

it('resizes and rotates a pasted image with on-page controls, preserving the picture through undo and save', async () => {
  mockImage();
  const { tab, pageId, session, click, entities, dispose } = setup();
  fireEvent.paste(window, { clipboardData: clipboard({ 'text/plain': 'data:image/png;base64,eA==' }) });
  await waitFor(() => expect(entities()).toHaveLength(1));
  const original = entities()[0]!, [a, , c] = original.points;
  let handle = screen.getByRole('button', { name: 'Resize image bottom right' });
  fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: c![0] * 3, clientY: c![1] * 3 });
  fireEvent.pointerUp(handle, { pointerId: 1, clientX: (c![0] + 10) * 3, clientY: (c![1] + 10) * 3 });
  expect(entities()[0]!.points[0]).toEqual(a);
  expect(entities()[0]!.points[2]![0]).toBeCloseTo(c![0] + 10);
  expect(entities()[0]!.points[2]![1]).toBeCloseTo(c![1] + 10);
  const resized = entities()[0]!;
  const center: [number, number] = [(resized.points[0]![0] + resized.points[2]![0]) / 2, (resized.points[0]![1] + resized.points[2]![1]) / 2];
  fireEvent.click(screen.getByRole('button', { name: /^Rotate$/ }));
  click(...center); click(center[0] + 20, center[1]); click(center[0], center[1] + 20);
  const rotated = entities()[0]!;
  const width = (e: typeof original) => Math.hypot(e.points[1]![0] - e.points[0]![0], e.points[1]![1] - e.points[0]![1]);
  const height = (e: typeof original) => Math.hypot(e.points[3]![0] - e.points[0]![0], e.points[3]![1] - e.points[0]![1]);
  expect(rotated.points[1]![0]).toBeCloseTo(rotated.points[0]![0]);
  expect(rotated.points[1]![1]).toBeGreaterThan(rotated.points[0]![1]);
  expect(width(rotated)).toBeCloseTo(width(resized)); expect(rotated.image).toEqual(original.image);
  fireEvent.click(screen.getByRole('button', { name: /^Select$/ }));
  handle = screen.getByRole('button', { name: 'Resize image right' });
  // At 90 degrees, the image's local right handle moves down on paper.
  const middle: [number, number] = [(rotated.points[1]![0] + rotated.points[2]![0]) / 2, (rotated.points[1]![1] + rotated.points[2]![1]) / 2];
  fireEvent.pointerDown(handle, { button: 0, pointerId: 2, clientX: middle[0] * 3, clientY: middle[1] * 3 });
  fireEvent.pointerUp(handle, { pointerId: 2, clientX: middle[0] * 3, clientY: (middle[1] + 10) * 3 });
  const scaled = entities()[0]!;
  expect(width(scaled)).toBeCloseTo(width(rotated) + 10); expect(height(scaled)).toBeCloseTo(height(rotated));
  expect((await openLayoutFile((await session.saveLayoutBytes(tab.id)))).state.pages.get(pageId)?.entities.get(original.id)).toEqual(scaled);
  act(() => { tab.commands.execute('edit.undo'); }); expect(entities()[0]!.points).toEqual(rotated.points);
  dispose();
});

it('resizes pasted text bounds without scaling its text and rotates the text with its box', () => {
  const { tab, entities, dispose } = setup();
  fireEvent.paste(window, { clipboardData: clipboard({ 'text/plain': 'Resize and rotate me' }) });
  const original = entities()[0]!, end = original.points[1]!;
  const handle = screen.getByRole('button', { name: 'Resize text right' });
  fireEvent.pointerDown(handle, { button: 0, pointerId: 3, clientX: end[0] * 3, clientY: 315 });
  fireEvent.pointerUp(handle, { pointerId: 3, clientX: (end[0] + 20) * 3, clientY: 315 });
  expect(entities()[0]!.text).toMatchObject({ content: original.text!.content, fontSizePt: 10, bounded: true });
  expect(entities()[0]!.points[1]![0]).toBeCloseTo(end[0] + 20);
  fireEvent.click(screen.getByRole('button', { name: 'Rotate clockwise' }));
  expect(entities()[0]!.text).toMatchObject({ rotationDeg: 90, fontSizePt: 10, content: original.text!.content });
  act(() => { tab.commands.execute('edit.undo'); }); expect(entities()[0]!.text?.rotationDeg ?? 0).toBe(0);
  dispose();
});

it('allows two images pasted in quick succession to finish independently', async () => {
  mockImage();
  const { entities, dispose } = setup();
  fireEvent.paste(window, { clipboardData: clipboard({ 'text/plain': 'data:image/png;base64,eA==' }) });
  fireEvent.paste(window, { clipboardData: clipboard({ 'text/plain': 'data:image/png;base64,eQ==' }) });
  await waitFor(() => expect(entities()).toHaveLength(2));
  dispose();
});

it('copies a multiple selection and pastes the objects together without changing their spacing', () => {
  const { tab, pageId, canvas, click, entities, dispose } = setup();
  act(() => {
    tab.commands.execute('layout.shape.add', { pageId, points: [[20, 20], [40, 20], [40, 40], [20, 40]], closed: true });
    tab.commands.execute('layout.shape.add', { pageId, points: [[70, 20], [90, 20], [90, 40], [70, 40]], closed: true });
  });
  click(30, 30);
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 4, clientX: 240, clientY: 90, shiftKey: true });
  fireEvent.pointerUp(canvas, { pointerId: 4, clientX: 240, clientY: 90, shiftKey: true });
  const data = clipboard(); fireEvent.copy(window, { clipboardData: data });
  expect(JSON.parse(data.getData(LAYOUT_CLIPBOARD_TYPE)).entities).toHaveLength(2);
  fireEvent.paste(window, { clipboardData: data });
  expect(entities()).toHaveLength(4);
  expect(entities()[3]!.points[0]![0] - entities()[2]!.points[0]![0]).toBeCloseTo(50);
  dispose();
});
