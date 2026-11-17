// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';
import { LAYOUT_CLIPBOARD_TYPE } from './layoutClipboard';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function clipboard(values: Record<string, string> = {}) {
  return { getData: (type: string) => values[type] ?? '', setData: (type: string, value: string) => { values[type] = value; }, files: [], items: [] };
}

/** One selected square, then Commons is shown over the Layout tab. */
function setup() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}),
  });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout(), pageId = tab.activePageId;
  tab.commands.execute('layout.style.setDefault', { fillColor: '#ffffff' });
  const square = tab.commands.execute('layout.shape.add', { pageId, points: [[30, 30], [70, 30], [70, 70], [30, 70]], closed: true }) as number;
  const view = render(<LayoutWorkspace tab={tab} session={session} />);
  const canvas = screen.getByLabelText('Page 1 canvas');
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 150, clientY: 150 });
  fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 150, clientY: 150 });
  const showCommons = (shown: boolean) => view.rerender(<LayoutWorkspace tab={tab} session={session} catalogActive={shown} />);
  /** Fires a key on the window and says whether something in Layout claimed it. */
  const press = (init: Record<string, unknown>) => {
    const event = createEvent.keyDown(window, init);
    fireEvent(window, event);
    return event.defaultPrevented;
  };
  const page = () => tab.doc.state.pages.get(pageId)!;
  const note = () => document.querySelector('.pf-form-note')!.textContent;
  const dispose = () => { cleanup(); session.dispose(); app.dispose(); };
  return { tab, square, canvas, showCommons, press, page, note, dispose };
}

it('leaves every key and the clipboard to Commons while Commons is shown, and takes them back afterwards', () => {
  const { tab, square, canvas, showCommons, press, page, note, dispose } = setup();
  expect(note()).toMatch(/^Path #\d+/);
  showCommons(true);
  const version = tab.doc.version;
  // Erasing, nudging, undo, Select All, Print, tool letters and typed values do nothing to the page.
  for (const init of [{ key: 'Delete' }, { key: 'Backspace' }, { key: 'ArrowRight' }, { key: 'z', code: 'KeyZ', metaKey: true },
    { key: 'a', code: 'KeyA', metaKey: true }, { key: 'a', code: 'KeyA', ctrlKey: true }, { key: 'p', code: 'KeyP', ctrlKey: true },
    { key: 'r', code: 'KeyR' }, { key: '5', code: 'Digit5' }, { key: 'Escape' }]) {
    expect(press(init)).toBe(false);
  }
  expect(tab.doc.version).toBe(version);
  expect(page().entities.has(square)).toBe(true);
  expect(canvas.getAttribute('data-tool')).toBe('select');
  expect(note()).toMatch(/^Path #\d+/);
  expect(screen.queryByRole('dialog', { name: 'Print Layout' })).toBeNull();
  // Copy leaves Commons text on the clipboard, and paste adds nothing to the page.
  const copied = clipboard({ 'text/plain': 'Commons text' });
  const copy = createEvent.copy(window, { clipboardData: copied });
  fireEvent(window, copy);
  expect(copy.defaultPrevented).toBe(false);
  expect(copied.getData(LAYOUT_CLIPBOARD_TYPE)).toBe('');
  const paste = createEvent.paste(window, { clipboardData: clipboard({ 'text/plain': 'Pasted' }) });
  fireEvent(window, paste);
  expect(paste.defaultPrevented).toBe(false);
  expect(page().entityOrder).toEqual([square]);
  // Back on the Layout tab, the keys and clipboard work again.
  showCommons(false);
  const data = clipboard();
  fireEvent.copy(window, { clipboardData: data });
  expect(data.getData(LAYOUT_CLIPBOARD_TYPE)).toContain('path');
  expect(press({ key: 'Delete' })).toBe(true);
  expect(page().entities.has(square)).toBe(false);
  dispose();
});
