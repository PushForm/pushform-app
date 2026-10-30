// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';
import * as printing from './layoutPrint';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function setup() {
  const methods = new Map<string | symbol, unknown>([['measureText', () => ({ width: 5 })]]);
  const ctx = new Proxy({}, { get: (_, key) => { if (!methods.has(key)) methods.set(key, vi.fn()); return methods.get(key); },
    set: (_, key, value) => { methods.set(key, value); return true; } });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as CanvasRenderingContext2D);
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout();
  const view = render(<LayoutWorkspace tab={tab} session={session} />);
  return { tab, session, view, methods, dispose: () => { view.unmount(); session.dispose(); app.dispose(); } };
}

it('opens clean print setup through keyboard and command, without a toolbar button or document edits', () => {
  const { tab, methods, dispose } = setup();
  const version = tab.doc.version;
  expect(screen.queryByRole('button', { name: 'Print Layout' })).toBeNull();
  const clip = methods.get('clip') as ReturnType<typeof vi.fn>;
  const margin = methods.get('strokeRect') as ReturnType<typeof vi.fn>;
  clip.mockClear(); margin.mockClear();
  act(() => { tab.commands.execute('layout.print'); });
  expect(screen.getByRole('dialog', { name: 'Print Layout' })).toBeTruthy();
  expect(clip).not.toHaveBeenCalled(); expect(margin).not.toHaveBeenCalled();
  const canvas = screen.getByLabelText('Print preview: Page 1') as HTMLCanvasElement;
  expect(canvas.width).toBe(Math.round(297 * 96 / 25.4));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.keyDown(window, { key: 'p', ctrlKey: true });
  expect(screen.getByRole('dialog', { name: 'Print Layout' })).toBeTruthy();
  fireEvent.keyDown(window, { key: 'Escape' });
  act(() => { tab.commands.execute('layout.print'); });
  expect(screen.getByRole('dialog', { name: 'Print Layout' })).toBeTruthy();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(tab.doc.version).toBe(version);
  dispose();
  expect(tab.commands.isEnabled('layout.print')).toBe(false);
});

it('prints current/all pages at chosen resolution, retains editing state, and reports retryable errors', async () => {
  const { tab, session, methods, dispose } = setup();
  act(() => { session.setActivePage(tab.commands.execute('layout.page.add') as number); });
  const active = tab.activePageId;
  const version = tab.doc.version;
  const print = vi.spyOn(printing, 'printLayoutDocument').mockRejectedValueOnce(new Error('Image unavailable'));
  act(() => { tab.commands.execute('layout.print'); });
  fireEvent.click(screen.getByRole('radio', { name: 'Current page (Page 2)' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Print quality' }), { target: { value: '150' } });
  fireEvent.click(screen.getByRole('button', { name: 'Print…' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Image unavailable'));
  expect(print.mock.calls[0]![1]).toEqual([active]);
  expect(print.mock.calls[0]![4]).toBe(150);
  const paint = print.mock.calls[0]![3];
  const canvas = document.createElement('canvas');
  paint(canvas, tab.doc.state.pages.get(active)!, tab.doc.state, 300);
  expect(canvas.width).toBe(Math.round(297 * 300 / 25.4));
  expect(canvas.height).toBe(Math.round(210 * 300 / 25.4));
  expect(methods.get('setTransform')).toHaveBeenCalledWith(300 / 25.4, 0, 0, 300 / 25.4, 0, 0);
  print.mockResolvedValue();
  fireEvent.click(screen.getByRole('radio', { name: 'All pages' }));
  fireEvent.click(screen.getByRole('button', { name: 'Print…' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(print.mock.calls[1]![1]).toEqual(tab.doc.state.pageOrder);
  expect(tab.doc.version).toBe(version); expect(tab.activePageId).toBe(active);
  dispose();
});
