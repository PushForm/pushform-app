// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { openLayoutFile } from '@pushform/io';
import { LAYOUT_TEXT_INSET_MM } from '@pushform/layout';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { getLayoutTextSelection } from './LayoutTextEditor';
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
  const tab = session.newLayout();
  const view = render(<LayoutWorkspace tab={tab} session={session} />);
  const canvas = screen.getByLabelText('Page 1 canvas');
  const click = (x: number, y: number) => {
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: x * 3, clientY: y * 3 });
    fireEvent.pointerUp(canvas, { button: 0, pointerId: 1, clientX: x * 3, clientY: y * 3 });
  };
  const entities = () => tab.doc.state.pages.get(tab.activePageId)!.entities;
  return { tab, session, canvas, view, click, entities, dispose: () => { view.unmount(); session.dispose(); app.dispose(); } };
}
it.each([
  { start: [30, 30], end: [150, 90], align: 'left' },
  { start: [30, 90], end: [150, 30], align: 'left' },
  { start: [150, 30], end: [30, 90], align: 'right' },
  { start: [150, 90], end: [30, 30], align: 'right' },
])('creates $align-aligned text for a drag from $start to $end', async ({ start, end, align }) => {
  const { tab, session, canvas, entities, dispose } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Text' }));
  const version = tab.doc.version;
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: start[0], clientY: start[1] });
  fireEvent.pointerMove(canvas, { pointerId: 1, clientX: end[0], clientY: end[1] });
  expect(tab.doc.version).toBe(version);
  fireEvent.pointerUp(canvas, { pointerId: 1, clientX: end[0], clientY: end[1] });
  const editor = screen.getByRole('textbox', { name: 'Edit text on page' }) as HTMLDivElement;
  expect(editor.style.textAlign).toBe(align);
  const id = [...entities().keys()][0]!;
  expect(entities().get(id)?.points).toEqual([[10, 10], [50, 30]]);
  expect(entities().get(id)?.text).toMatchObject({ align, vertical: 'top', bounded: true });
  // Undo/redo the creation itself before adding any content edits.
  tab.commands.execute('edit.undo');
  expect(entities().has(id)).toBe(false);
  tab.commands.execute('edit.redo');
  expect(entities().get(id)?.text?.align).toBe(align);
  expect((await openLayoutFile((await session.saveLayoutBytes(tab.id)))).state.pages.get(tab.activePageId)?.entities.get(id)?.text?.align).toBe(align);
  dispose();
});

it.each([
  { x: 180, y: 150, ctrlKey: true, metaKey: false },
  { x: 120, y: 90, ctrlKey: true, metaKey: false },
  { x: 120, y: 150, ctrlKey: false, metaKey: true },
  { x: 180, y: 90, ctrlKey: false, metaKey: true },
])('centers dragged text on its starting point for end ($x, $y)', async ({ x, y, ctrlKey, metaKey }) => {
  const { tab, session, canvas, entities, dispose } = setup();
  tab.commands.execute('layout.grid.set', { snap: false }); tab.commands.execute('layout.snap.set', { enabled: false });
  fireEvent.click(screen.getByRole('button', { name: 'Text' }));
  const version = tab.doc.version;
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 150, clientY: 120 });
  fireEvent.pointerMove(canvas, { pointerId: 1, clientX: x, clientY: y, ctrlKey, metaKey });
  expect(tab.doc.version).toBe(version);
  fireEvent.pointerUp(canvas, { pointerId: 1, clientX: x, clientY: y, ctrlKey, metaKey });
  const editor = screen.getByRole('textbox', { name: 'Edit text on page' }) as HTMLDivElement;
  expect(editor.style.textAlign).toBe('center');
  const id = [...entities().keys()][0]!;
  expect(entities().get(id)?.points).toEqual([[40, 30], [60, 50]]);
  expect(entities().get(id)?.text).toMatchObject({ align: 'center', vertical: 'middle', bounded: true });
  act(() => { tab.commands.execute('edit.undo'); });
  expect(entities().has(id)).toBe(false);
  act(() => { tab.commands.execute('edit.redo'); });
  expect((await openLayoutFile((await session.saveLayoutBytes(tab.id)))).state.pages.get(tab.activePageId)?.entities.get(id)?.text)
    .toMatchObject({ align: 'center', vertical: 'middle', bounded: true });
  dispose();
});

it('uses modifier state on release for text and leaves Ctrl-click text unbounded', () => {
  const { canvas, entities, dispose } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Text' }));
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 150, clientY: 120, ctrlKey: true });
  fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 120, clientY: 90, ctrlKey: true });
  fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 120, clientY: 90 });
  expect([...entities().values()][0]?.text).toMatchObject({ align: 'right', vertical: 'top', bounded: true });
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Edit text on page' }), { key: 'Escape' });
  fireEvent.keyDown(window, { key: 't', code: 'KeyT' });
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 240, clientY: 240, ctrlKey: true });
  fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 240, clientY: 240, ctrlKey: true });
  expect([...entities().values()].at(-1)?.text).toMatchObject({ align: 'left', vertical: 'top', bounded: false });
  dispose();
});

it('fits click-placed text on Escape/blur and selects all content on double-click for replacement', async () => {
  const { tab, session, canvas, click, entities, dispose } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Text' })); click(10, 10);
  let editor = screen.getByRole('textbox', { name: 'Edit text on page' }) as HTMLDivElement;
  fireEvent.input(editor, { target: { textContent: 'Hello\nworld!' } });
  fireEvent.keyDown(editor, { key: 'Escape' });
  const id = [...entities().keys()][0]!;
  expect(entities().get(id)?.points[0]).toEqual([10, 10]);
  expect(entities().get(id)?.points[1]?.[0]).toBeCloseTo(22 + 2 * LAYOUT_TEXT_INSET_MM);
  expect(entities().get(id)?.points[1]?.[1]).toBeCloseTo(10 + 2 * 10 * 25.4 / 72 * 1.117);
  expect(entities().get(id)?.text?.bounded).toBe(false);
  expect(entities().get(id)?.text?.align).toBe('left');
  click(12, 12);
  expect(screen.queryByRole('textbox', { name: 'Edit text on page' })).toBeNull();
  expect(screen.getAllByRole('button', { name: /^Resize text / })).toHaveLength(8);
  fireEvent.doubleClick(canvas, { clientX: 36, clientY: 36 });
  editor = screen.getByRole('textbox', { name: 'Edit text on page' }) as HTMLDivElement;
  expect(getLayoutTextSelection(editor)?.start).toBe(0); expect(getLayoutTextSelection(editor)?.end).toBe('Hello\nworld!'.length);
  fireEvent.input(editor, { target: { textContent: 'New' } }); fireEvent.blur(editor);
  expect(entities().get(id)?.text?.content).toBe('New');
  expect(entities().get(id)?.points[1]?.[0]).toBeCloseTo(16 + 2 * LAYOUT_TEXT_INSET_MM);
  const saved = (await openLayoutFile((await session.saveLayoutBytes(tab.id))));
  expect(saved.state.pages.get(tab.activePageId)?.entities.get(id)).toEqual(entities().get(id));
  const handle = screen.getByRole('button', { name: 'Resize text right' });
  fireEvent.pointerDown(handle, { button: 0, pointerId: 4, clientX: 48, clientY: 38 });
  fireEvent.pointerUp(handle, { pointerId: 4, clientX: 78, clientY: 38 });
  expect(entities().get(id)?.text).toMatchObject({ bounded: true, fontSizePt: 10 });
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
  expect(entities().get(id)?.text?.bounded).toBe(false);
  dispose();
});
it('keeps dragged bounds and previews/commits box resizing without changing font size or content', () => {
  const { canvas, entities, dispose } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Text' }));
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 30, clientY: 30 });
  fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 150, clientY: 90 });
  const editor = screen.getByRole('textbox', { name: 'Edit text on page' });
  fireEvent.input(editor, { target: { textContent: 'Words that will wrap and overflow the box' } });
  fireEvent.keyDown(editor, { key: 'Escape' });
  const id = [...entities().keys()][0]!;
  expect(entities().get(id)?.points).toEqual([[10, 10], [50, 30]]);
  const handle = screen.getByRole('button', { name: 'Resize text bottom right' });
  fireEvent.pointerDown(handle, { button: 0, pointerId: 2, clientX: 150, clientY: 90 });
  fireEvent.pointerMove(handle, { pointerId: 2, clientX: 90, clientY: 45 });
  expect(entities().get(id)?.points).toEqual([[10, 10], [50, 30]]);
  fireEvent.pointerUp(handle, { pointerId: 2, clientX: 90, clientY: 45 });
  expect(entities().get(id)?.points).toEqual([[10, 10], [30, 15]]);
  expect(entities().get(id)?.text).toMatchObject({ fontSizePt: 10, bounded: true, content: 'Words that will wrap and overflow the box' });
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
  expect(entities().get(id)?.points).toEqual([[10, 10], [50, 30]]);
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true });
  expect(entities().get(id)?.points).toEqual([[10, 10], [30, 15]]);
  dispose();
});
it('moves text by dragging, and finalizes auto-sized text when switching away from its edit session', () => {
  const { canvas, click, entities, dispose } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Text' })); click(10, 10);
  fireEvent.input(screen.getByRole('textbox', { name: 'Edit text on page' }), { target: { textContent: 'Text' } });
  fireEvent.click(screen.getByRole('button', { name: 'Line' }));
  const id = [...entities().keys()][0]!;
  expect(entities().get(id)?.points[1]?.[0]).toBeCloseTo(18 + 2 * LAYOUT_TEXT_INSET_MM);
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 36, clientY: 36 });
  fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 66, clientY: 66 });
  fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 66, clientY: 66 });
  expect(entities().get(id)?.points[0]).toEqual([20, 20]);
  expect(entities().get(id)?.text?.fontSizePt).toBe(10);
  dispose();
});

it('resizes leader-label text while keeping its anchor, bend and vertical center', () => {
  const { canvas, click, entities, dispose } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Label' }));
  click(10, 50); click(40, 50); click(60, 70);
  const editor = screen.getByRole('textbox', { name: 'Edit label on page' });
  fireEvent.input(editor, { target: { textContent: 'Leader label' } });
  fireEvent.keyDown(editor, { key: 'Escape' });
  const id = [...entities().keys()][0]!;
  const original = entities().get(id)!;
  const handle = screen.getByRole('button', { name: 'Resize text bottom right' });
  fireEvent.pointerDown(handle, { button: 0, pointerId: 2, clientX: 330, clientY: 180 });
  fireEvent.pointerMove(handle, { pointerId: 2, clientX: 300, clientY: 165 });
  fireEvent.pointerUp(handle, { pointerId: 2, clientX: 300, clientY: 165 });
  const changed = entities().get(id)!;
  expect(changed.points.slice(2)).toEqual(original.points.slice(2));
  expect((changed.points[0]![1] + changed.points[1]![1]) / 2).toBe(50);
  expect(changed.text?.fontSizePt).toBe(10);
  fireEvent.doubleClick(canvas, { clientX: 200, clientY: 150 });
  const editing = screen.getByRole('textbox', { name: 'Edit label on page' }) as HTMLDivElement;
  expect(getLayoutTextSelection(editing)?.start).toBe(0); expect(getLayoutTextSelection(editing)?.end).toBe('Leader label'.length);
  dispose();
});

it('rotates the text and box together, then picks, edits, and resizes in its rotated axes', async () => {
  const { tab, session, canvas, click, entities, dispose } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Text' }));
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 30, clientY: 30 });
  fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 150, clientY: 90 });
  fireEvent.input(screen.getByRole('textbox', { name: 'Edit text on page' }), { target: { textContent: 'Rotated text' } });
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Edit text on page' }), { key: 'Escape' });
  const id = [...entities().keys()][0]!, original = entities().get(id)!;
  fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
  click(30, 20); click(50, 20);
  fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 90, clientY: 120 });
  expect(entities().get(id)).toEqual(original); // Preview does not mutate the document.
  click(30, 40);
  expect(entities().get(id)?.points).toEqual(original.points);
  expect(entities().get(id)?.text).toEqual({ ...original.text, rotationDeg: 90 });
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  expect((screen.getByLabelText('Selected object bounds') as HTMLElement).style.transform).toBe('rotate(90deg)');
  // This point is inside the rotated box, outside the original bounds.
  click(30, 38);
  expect(screen.getAllByRole('button', { name: /^Resize text / })).toHaveLength(8);
  fireEvent.doubleClick(canvas, { clientX: 90, clientY: 114 });
  const editor = screen.getByRole('textbox', { name: 'Edit text on page' }) as HTMLDivElement;
  expect(editor.style.transform).toBe('rotate(90deg)');
  expect(getLayoutTextSelection(editor)?.end).toBe('Rotated text'.length);
  fireEvent.keyDown(editor, { key: 'Escape' });
  const handle = screen.getByRole('button', { name: 'Resize text right' });
  fireEvent.pointerDown(handle, { button: 0, pointerId: 2, clientX: 90, clientY: 120 });
  fireEvent.pointerUp(handle, { pointerId: 2, clientX: 90, clientY: 150 });
  const resized = entities().get(id)!;
  expect(resized.points[1]![0] - resized.points[0]![0]).toBeCloseTo(50);
  expect(resized.points[1]![1] - resized.points[0]![1]).toBeCloseTo(20);
  expect(resized.text).toEqual({ ...original.text, rotationDeg: 90 });
  expect((await openLayoutFile((await session.saveLayoutBytes(tab.id)))).state.pages.get(tab.activePageId)?.entities.get(id)).toEqual(resized);
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
  expect(entities().get(id)?.points).toEqual(original.points);
  dispose();
});

it('waits for a selected webfont before fitting click-placed text after editing', async () => {
  const original = Object.getOwnPropertyDescriptor(document, 'fonts');
  let loaded = false, ready!: (faces: FontFace[]) => void;
  Object.defineProperty(document, 'fonts', { configurable: true, value: {
    check: () => loaded, load: () => new Promise<FontFace[]>(resolve => { ready = resolve; }),
  } });
  const { click, entities, dispose } = setup();
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Text' })); click(10, 10);
    const editor = screen.getByRole('textbox', { name: 'Edit text on page' });
    fireEvent.input(editor, { target: { textContent: 'Font' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Text toolbar font' }), { target: { value: 'Roboto' } });
    fireEvent.keyDown(editor, { key: 'Escape' });
    const entity = () => [...entities().values()][0]!;
    expect(entity().points[1]![0]).toBe(70); // Do not fit using fallback metrics while the font is pending.
    await act(async () => {
      document.querySelector('link[data-layout-font="Roboto"]')!.dispatchEvent(new Event('load'));
      for (let i = 0; i < 8; i++) await Promise.resolve();
      loaded = true; ready([{} as FontFace]);
    });
    expect(entity().points[1]![0]).toBeCloseTo(18 + 2 * LAYOUT_TEXT_INSET_MM);
    expect(entity().text?.fontFamily).toBe('Roboto');
  } finally {
    dispose(); document.querySelectorAll('link[data-layout-font="Roboto"]').forEach(link => link.remove());
    if (original) Object.defineProperty(document, 'fonts', original); else Reflect.deleteProperty(document, 'fonts');
  }
});
