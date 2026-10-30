// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { openLayoutFile } from '@pushform/io';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';
import { ToastHost } from './ToastHost';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function setup() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}),
  });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout(), pageId = tab.activePageId;
  const ids = [[20, 20, 80, 80], [40, 40, 60, 60]].map(([x, y, right, bottom]) => tab.commands.execute('layout.rectangle.add', {
    pageId, kind: 'rectangle', first: [x, y], second: [right, bottom],
  }) as number);
  tab.doc.transact('Different styles', draft => {
    draft.pages.get(pageId)!.entities.get(ids[0]!)!.style!.fillColor = '#ff0000';
    draft.pages.get(pageId)!.entities.get(ids[1]!)!.style!.fillColor = '#0000ff';
  });
  const view = render(<><LayoutWorkspace tab={tab} session={session} /><ToastHost /></>);
  const canvas = screen.getByLabelText('Page 1 canvas');
  const event = (x: number, y: number, shiftKey = false) => ({ button: 0, buttons: 1, pointerId: 1, clientX: x * 3, clientY: y * 3, shiftKey });
  const click = (x: number, y: number, shift = false) => {
    fireEvent.pointerDown(canvas, event(x, y, shift)); fireEvent.pointerUp(canvas, event(x, y, shift));
  };
  const start = async () => {
    click(25, 25); click(50, 50, true);
    fireEvent.click(screen.getByRole('button', { name: 'Boolean tools' }));
    expect(screen.getAllByRole('menuitemradio')[0]!.getAttribute('aria-label')).toBe('Shape Builder');
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Shape Builder' }));
    await screen.findByLabelText('Shape Builder preview');
  };
  const previewCount = () => screen.getByLabelText('Shape Builder preview').querySelectorAll('[data-result]').length;
  const dispose = () => { cleanup(); session.dispose(); app.dispose(); };
  return { tab, session, pageId, ids, canvas, click, event, start, previewCount, view, dispose };
}

it('merges successively clicked regions with the first-region style, previews without mutation and commits with persistence and undo', async () => {
  const t = setup(), before = t.tab.doc.state, version = t.tab.doc.version;
  await t.start();
  t.click(50, 50); t.click(25, 25);
  expect(t.previewCount()).toBe(1);
  expect(t.tab.doc.state).toBe(before); expect(t.tab.doc.version).toBe(version);
  expect([...screen.getByLabelText('Shape Builder preview').querySelectorAll('[data-result]')].map(p => p.getAttribute('fill'))).toEqual(['#0000ff']);
  expect((await openLayoutFile((await t.session.saveLayoutBytes(t.tab.id)))).state.pages.get(t.pageId)!.entities.size).toBe(2);
  fireEvent.keyDown(window, { key: 'Enter' });
  expect(t.canvas.getAttribute('data-tool')).toBe('select');
  const page = t.tab.doc.state.pages.get(t.pageId)!;
  expect(page.entities.size).toBe(1);
  expect(t.ids.every(id => !page.entities.has(id))).toBe(true);
  for (const entity of page.entities.values()) expect(entity.style!.fillColor).toBe('#0000ff');
  const saved = (await openLayoutFile((await t.session.saveLayoutBytes(t.tab.id))));
  expect(saved.state.pages.get(t.pageId)!.entities).toEqual(page.entities);
  act(() => { t.tab.commands.execute('edit.undo'); });
  expect(t.tab.doc.state).toEqual(before);
  act(() => { t.tab.commands.execute('edit.redo'); });
  expect(t.tab.doc.state.pages.get(t.pageId)!.entities).toEqual(page.entities);
  t.dispose();
});

it('merges swept regions, uses local undo/redo, and cancels only the pending pointer gesture', async () => {
  const t = setup(), before = t.tab.doc.state;
  await t.start();
  t.click(50, 50);
  const outline = () => screen.getByLabelText('Shape Builder preview').querySelector('[data-result]')!.getAttribute('d');
  const originalOutline = outline();
  fireEvent.pointerDown(t.canvas, t.event(25, 50));
  fireEvent.pointerMove(t.canvas, t.event(70, 50));
  expect(t.previewCount()).toBe(1);
  expect(outline()).not.toBe(originalOutline);
  fireEvent.pointerCancel(t.canvas);
  expect(outline()).toBe(originalOutline);
  fireEvent.pointerDown(t.canvas, t.event(25, 50));
  fireEvent.pointerUp(t.canvas, t.event(70, 50));
  const mergedOutline = outline();
  expect(mergedOutline).not.toBe(originalOutline);
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true }); expect(outline()).toBe(originalOutline);
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true }); expect(outline()).toBe(mergedOutline);
  t.click(50, 50, true);
  expect(t.previewCount()).toBe(1);
  expect(screen.getByLabelText('Shape Builder preview').querySelector('[data-result]')!.getAttribute('fill')).toBe('#0000ff');
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(t.canvas.getAttribute('data-tool')).toBe('select');
  expect(t.tab.doc.state).toBe(before);
  t.dispose();
});

it('keeps added regions highlighted blue away from the pointer and updates highlights on removal and undo', async () => {
  const t = setup(); await t.start();
  const selected = () => [...screen.getByLabelText('Shape Builder preview').querySelectorAll('[data-selected-region]')];
  t.click(50, 50); t.click(25, 25);
  fireEvent.pointerLeave(t.canvas);
  expect(selected()).toHaveLength(2);
  expect(selected().every(path => path.getAttribute('fill') === '#1e63d1' && path.getAttribute('stroke') === '#1e63d1')).toBe(true);
  t.click(50, 50, true); fireEvent.pointerLeave(t.canvas);
  expect(selected()).toHaveLength(1);
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
  expect(selected()).toHaveLength(2);
  t.dispose();
});

it('supports Remove mode, Shift reversal, Keep originals and an explicit empty-result action', async () => {
  const t = setup(); await t.start();
  expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
  t.click(50, 50, true); expect(t.previewCount()).toBe(1);
  t.click(50, 50); expect(t.previewCount()).toBe(0);
  expect((screen.getByRole('button', { name: 'Apply: delete selected shapes' }) as HTMLButtonElement).disabled).toBe(false);
  t.click(25, 25, true);
  fireEvent.click(screen.getByLabelText('Keep originals'));
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  const page = t.tab.doc.state.pages.get(t.pageId)!;
  expect(page.entities.size).toBe(2);
  expect(t.ids.every(id => !page.entities.has(id))).toBe(true);
  expect([...page.entities.values()].every(entity => entity.contourStarts?.length === 2)).toBe(true);
  t.dispose();
});

it.each(['tool change', 'page change', 'source change'])('cancels on %s without applying the preview', async reason => {
  const t = setup();
  let secondPage = 0;
  if (reason === 'page change') act(() => { secondPage = t.tab.commands.execute('layout.page.add', { name: 'Next' }) as number; });
  await t.start(); t.click(50, 50);
  if (reason === 'tool change') fireEvent.keyDown(window, { key: 'm', code: 'KeyM' });
  if (reason === 'page change') {
    act(() => { t.session.setActivePage(secondPage); }); t.view.rerender(<><LayoutWorkspace tab={t.tab} session={t.session} /><ToastHost /></>);
  }
  if (reason === 'source change') act(() => { t.tab.commands.execute('layout.shape.move', { pageId: t.pageId, entityIds: [t.ids[0]], delta: [1, 0] }); });
  await waitFor(() => expect(screen.queryByLabelText('Shape Builder preview')).toBeNull());
  expect(t.ids.every(id => t.tab.doc.state.pages.get(t.pageId)!.entities.has(id))).toBe(true);
  t.dispose();
});

it('rejects empty selection, enters with X after selection, and never activates X while typing', async () => {
  const t = setup();
  fireEvent.keyDown(window, { key: 'x', code: 'KeyX' });
  expect(t.canvas.getAttribute('data-tool')).toBe('select');
  expect(screen.getByText('You must select some object to use with the Shape Builder tool.')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  t.click(25, 25);
  const input = screen.getByLabelText('Measurements');
  fireEvent.keyDown(input, { key: 'x', code: 'KeyX' });
  expect(t.canvas.getAttribute('data-tool')).toBe('select');
  fireEvent.keyDown(window, { key: 'x', code: 'KeyX' });
  await screen.findByLabelText('Shape Builder preview');
  t.dispose();
});

it('shows the same toast from the toolbar button and menu without changing document or tool', () => {
  const t = setup(), before = t.tab.doc.state, version = t.tab.doc.version;
  fireEvent.click(screen.getByRole('button', { name: 'Shape Builder' }));
  fireEvent.click(screen.getByRole('button', { name: 'Boolean tools' }));
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Shape Builder' }));
  expect(screen.getAllByText('You must select some object to use with the Shape Builder tool.')).toHaveLength(1);
  expect(t.canvas.getAttribute('data-tool')).toBe('select');
  expect(t.tab.doc.state).toBe(before); expect(t.tab.doc.version).toBe(version);
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
  expect(screen.queryByText('You must select some object to use with the Shape Builder tool.')).toBeNull();
  t.dispose();
});

it.each([false, true])('previews deletion-only trimming and preserves the rest with Keep originals %s', async keepOriginals => {
  const t = setup(), before = t.tab.doc.state;
  await t.start();
  if (keepOriginals) fireEvent.click(screen.getByLabelText('Keep originals'));
  t.click(50, 50, true);
  expect(t.previewCount()).toBe(1);
  expect(screen.getByLabelText('Shape Builder preview').querySelector('[data-result]')!.getAttribute('fill')).toBe('#ff0000');
  expect(screen.getByLabelText('Shape Builder preview').querySelectorAll('[data-selected-region]')).toHaveLength(0);
  expect(t.tab.doc.state).toBe(before);
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  const remaining = [...t.tab.doc.state.pages.get(t.pageId)!.entities.values()];
  expect(remaining).toHaveLength(1);
  expect(remaining[0]!.contourStarts).toHaveLength(2);
  act(() => { t.tab.commands.execute('edit.undo'); });
  expect(t.tab.doc.state).toEqual(before);
  t.dispose();
});

it('uses only selected lines and shapes, preserving ignored images and the full selection on Cancel and Undo', async () => {
  const t = setup();
  let imageId = 0;
  act(() => {
    t.tab.doc.transact('Open cutter', draft => {
      const line = draft.pages.get(t.pageId)!.entities.get(t.ids[1]!)!;
      line.closed = false; line.points = [[10, 50], [90, 50]];
    });
    [imageId] = t.tab.commands.execute('layout.clipboard.paste', { pageId: t.pageId, position: [110, 110], entities: [{
      kind: 'image', closed: true, points: [[100, 100], [120, 100], [120, 120], [100, 120]],
      image: { src: 'data:image/png;base64,eA==' },
    }] }) as [number];
  });
  const before = t.tab.doc.state;
  const image = before.pages.get(t.pageId)!.entities.get(imageId);
  t.click(25, 25); t.click(85, 50, true); t.click(110, 110, true);
  expect(screen.getByText('3 objects selected')).toBeTruthy();
  fireEvent.keyDown(window, { key: 'x', code: 'KeyX' });
  await screen.findByLabelText('Shape Builder preview');
  t.click(30, 30);
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.getByText('3 objects selected')).toBeTruthy();
  expect(t.tab.doc.state).toBe(before);
  fireEvent.keyDown(window, { key: 'x', code: 'KeyX' });
  await screen.findByLabelText('Shape Builder preview');
  t.click(30, 30);
  fireEvent.keyDown(window, { key: 'Enter' });
  const page = t.tab.doc.state.pages.get(t.pageId)!;
  expect(page.entities.size).toBe(2);
  expect(page.entities.get(imageId)).toEqual(image);
  const result = [...page.entities.values()].find(entity => entity.kind === 'path')!;
  expect(result.closed).toBe(true);
  expect(result.points.every(point => point[1] <= 50)).toBe(true);
  act(() => { t.tab.commands.execute('edit.undo'); });
  expect(t.tab.doc.state).toEqual(before);
  expect(screen.getByText('3 objects selected')).toBeTruthy();
  act(() => { t.tab.commands.execute('edit.redo'); });
  expect(t.tab.doc.state.pages.get(t.pageId)!.entities).toEqual(page.entities);
  t.dispose();
});

it('explains selections with only unsupported objects without changing the active tool or document', () => {
  const t = setup();
  act(() => {
    t.tab.doc.transact('Image', draft => {
      const entity = draft.pages.get(t.pageId)!.entities.get(t.ids[0]!)!;
      entity.kind = 'image'; entity.image = { src: 'data:image/png;base64,eA==' };
    });
  });
  t.click(25, 25);
  const before = t.tab.doc.state;
  fireEvent.keyDown(window, { key: 'x', code: 'KeyX' });
  expect(t.canvas.getAttribute('data-tool')).toBe('select');
  expect(screen.getByText('Select lines or shapes before using Shape Builder.')).toBeTruthy();
  expect(t.tab.doc.state).toBe(before);
  t.dispose();
});
