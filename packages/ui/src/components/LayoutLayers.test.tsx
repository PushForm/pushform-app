// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { openLayoutFile } from '@pushform/io';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';

afterEach(() => { cleanup(); vi.restoreAllMocks(); document.body.innerHTML = ''; });

/** A Layout tab with the object browser open; layers are managed there since the Layers pane was removed. */
function setup(build?: (tab: ReturnType<DocumentSession['newLayout']>) => void) {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout();
  build?.(tab);
  const host = document.createElement('div');
  document.body.append(host);
  render(<LayoutWorkspace tab={tab} session={session} objectBrowser={{ host, open: true, onClose: () => {} }} />);
  const layerRow = (layerId: number): HTMLElement =>
    host.querySelector<HTMLElement>(`[data-key="layer:${tab.activePageId}:${layerId}"] > .pf-layout-browser-row`)!;
  const menu = (layerId: number, item: string): void => {
    fireEvent.contextMenu(layerRow(layerId), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole(item === 'Show on Every Page' ? 'menuitemcheckbox' : 'menuitem', { name: item }));
  };
  const dispose = (): void => { session.dispose(); app.dispose(); };
  return { session, tab, host, layerRow, menu, dispose };
}

it('keeps layer order, visibility and locks from the object browser through undo and save/reopen', async () => {
  let middle = 0, top = 0;
  const { session, tab, layerRow, dispose } = setup(tab => {
    middle = tab.commands.execute('layout.layer.add', { name: 'Middle' }) as number;
    top = tab.commands.execute('layout.layer.add', { name: 'Top' }) as number;
  });
  const bottom = tab.doc.state.layerOrder[0]!;
  const layer = (id: number): HTMLElement => layerRow(id).parentElement!;
  layer(bottom).focus();
  fireEvent.keyDown(layer(bottom), { key: 'ArrowUp', altKey: true });
  expect(tab.doc.state.layerOrder).toEqual([middle, bottom, top]);
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
  expect(tab.doc.state.layerOrder).toEqual([bottom, middle, top]);
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true });
  expect(tab.doc.state.layerOrder).toEqual([middle, bottom, top]);
  const visible = within(layerRow(top)).getByRole('button', { name: 'Show Top' });
  const locked = within(layerRow(top)).getByRole('button', { name: 'Lock Top' });
  fireEvent.click(visible); fireEvent.click(locked);
  const reopened = (await openLayoutFile((await session.saveLayoutBytes(tab.id))));
  expect(reopened.state.layerOrder).toEqual([middle, bottom, top]);
  expect(reopened.state.layers.get(top)).toMatchObject({ visible: true, locked: true });
  expect(reopened.state.pages.get(tab.activePageId)!.layerVisibility?.get(top)).toBe(false);
  dispose();
});

it('toggles Show on Every Page from the layer menu with undo and persistence, and disables it while locked', async () => {
  let shapeId = 0;
  const { session, tab, menu, layerRow, dispose } = setup(tab => {
    shapeId = tab.commands.execute('layout.shape.add', { pageId: tab.activePageId, points: [[10, 10], [30, 10]], closed: false }) as number;
    tab.commands.execute('layout.layer.add', { name: 'Other' });
  });
  const layerId = tab.doc.state.layerOrder[0]!;
  menu(layerId, 'Show on Every Page');
  expect(tab.doc.state.layers.get(layerId)?.shared).toBe(true);
  const saved = (await openLayoutFile((await session.saveLayoutBytes(tab.id))));
  expect(saved.state.layers.get(layerId)?.shared).toBe(true);
  expect(saved.state.sharedEntities.get(shapeId)?.points).toEqual([[10, 10], [30, 10]]);
  menu(layerId, 'Show on Every Page');
  expect(tab.doc.state.layers.get(layerId)?.shared).toBe(false);
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
  expect(tab.doc.state.layers.get(layerId)?.shared).toBe(true);
  fireEvent.click(within(layerRow(layerId)).getByRole('button', { name: 'Lock Layer 1' }));
  fireEvent.contextMenu(layerRow(layerId), { clientX: 10, clientY: 10 });
  expect((screen.getByRole('menuitemcheckbox', { name: 'Show on Every Page' }) as HTMLButtonElement).disabled).toBe(true);
  dispose();
});

it.each(['current', 'all'] as const)('offers a modal source choice and applies %s page content only after Apply', async (choice) => {
  let line = 0, other = 0, second = 0;
  const { session, tab, menu, dispose } = setup(tab => {
    line = tab.commands.execute('layout.shape.add', { pageId: tab.activePageId, points: [[0, 0], [20, 0]], closed: false }) as number;
    second = tab.commands.execute('layout.page.add', {}) as number;
    other = tab.commands.execute('layout.shape.add', { pageId: second, points: [[30, 30], [80, 30]], closed: false }) as number;
  });
  const first = tab.activePageId, layerId = tab.doc.state.layerOrder[0]!;
  const version = tab.doc.version;
  menu(layerId, 'Show on Every Page');
  let dialog = screen.getByRole('dialog', { name: 'Choose shared layer content' });
  expect((within(dialog).getByRole('radio', { name: 'Include only entities from this page' }) as HTMLInputElement).checked).toBe(true);
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
  expect(tab.doc.version).toBe(version);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(tab.doc.version).toBe(version);
  menu(layerId, 'Show on Every Page');
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(tab.doc.version).toBe(version);
  menu(layerId, 'Show on Every Page');
  dialog = screen.getByRole('dialog', { name: 'Choose shared layer content' });
  if (choice === 'all') fireEvent.click(within(dialog).getByRole('radio', { name: 'Collect entities from all pages' }));
  expect(tab.doc.version).toBe(version);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(tab.doc.state.sharedEntityOrder).toEqual(choice === 'all' ? [line, other] : [line]);
  const saved = (await openLayoutFile((await session.saveLayoutBytes(tab.id))));
  expect(saved.state.sharedEntityOrder).toEqual(choice === 'all' ? [line, other] : [line]);
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
  expect(tab.doc.state.pages.get(first)?.entityOrder).toEqual([line]);
  expect(tab.doc.state.pages.get(second)?.entityOrder).toEqual([other]);
  dispose();
});
