// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('presents pages in order, hides drafting guides, blocks editing, and returns without document changes', () => {
  const calls = new Map<string | symbol, unknown>();
  const context = new Proxy({}, {
    get: (_target, key) => { if (!calls.has(key)) calls.set(key, vi.fn()); return calls.get(key); },
    set: (_target, key, value) => { calls.set(key, value); return true; },
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as CanvasRenderingContext2D);
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout();
  tab.commands.execute('layout.shape.add', { pageId: tab.activePageId, points: [[10, 20], [80, 20]], closed: false });
  render(<LayoutWorkspace tab={tab} session={session} />);
  act(() => { session.setActivePage(tab.commands.execute('layout.page.add') as number); });
  const editingPage = tab.activePageId;
  const version = tab.doc.version;
  const trigger = screen.getByRole('button', { name: 'Presentation mode' });
  trigger.focus();
  (calls.get('strokeRect') as ReturnType<typeof vi.fn>).mockClear();
  (calls.get('clip') as ReturnType<typeof vi.fn>).mockClear();
  (calls.get('lineTo') as ReturnType<typeof vi.fn>).mockClear();
  fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog', { name: 'Presentation mode' });
  expect(within(dialog).getByLabelText('Page 2 presentation')).toBeTruthy();
  expect(within(dialog).queryAllByRole('button')).toHaveLength(0);
  expect(dialog.textContent).toBe('');
  fireEvent.keyDown(window, { key: 'ArrowRight' });
  expect(within(dialog).getByLabelText('Page 2 presentation')).toBeTruthy();
  expect(calls.get('strokeRect')).not.toHaveBeenCalled();
  expect(calls.get('clip')).not.toHaveBeenCalled();
  fireEvent.keyDown(window, { key: 'Home' });
  expect(calls.get('lineTo')).toHaveBeenCalledWith(80, 20);
  fireEvent.keyDown(window, { key: 'Home' });
  expect(within(dialog).getByLabelText('Page 1 presentation')).toBeTruthy();
  fireEvent.click(within(dialog).getByLabelText('Page 1 presentation'));
  expect(within(dialog).getByLabelText('Page 1 presentation')).toBeTruthy();
  fireEvent.keyDown(window, { key: 'ArrowRight' });
  expect(within(dialog).getByLabelText('Page 2 presentation')).toBeTruthy();
  fireEvent.click(within(dialog).getByLabelText('Page 2 presentation'));
  expect(within(dialog).getByLabelText('Page 1 presentation')).toBeTruthy();
  expect(fireEvent.contextMenu(dialog)).toBe(false);
  expect(within(dialog).getByLabelText('Page 2 presentation')).toBeTruthy();
  fireEvent.contextMenu(dialog);
  expect(within(dialog).getByLabelText('Page 2 presentation')).toBeTruthy();
  fireEvent.keyDown(window, { key: 'ArrowLeft' });
  expect(within(dialog).getByLabelText('Page 1 presentation')).toBeTruthy();
  fireEvent.keyDown(window, { key: ' ' });
  expect(within(dialog).getByLabelText('Page 2 presentation')).toBeTruthy();
  fireEvent.keyDown(window, { key: 'Tab' });
  expect(document.activeElement).toBe(dialog);
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
  fireEvent.keyDown(window, { key: 'Delete' });
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(tab.doc.version).toBe(version);
  expect(tab.activePageId).toBe(editingPage);
  expect(tab.doc.state.pageOrder).toHaveLength(2);
  expect(document.activeElement).toBe(trigger);
  session.dispose(); app.dispose();
});

it('keeps presentation usable when the browser rejects fullscreen', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const request = vi.fn().mockRejectedValue(new Error('Fullscreen unavailable'));
  Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: request });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout();
  render(<LayoutWorkspace tab={tab} session={session} />);
  fireEvent.click(screen.getByRole('button', { name: 'Presentation mode' }));
  await waitFor(() => expect(request).toHaveBeenCalledOnce());
  expect(screen.getByRole('dialog', { name: 'Presentation mode' })).toBeTruthy();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  delete (HTMLElement.prototype as Partial<HTMLElement>).requestFullscreen;
  session.dispose(); app.dispose();
});
