// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { openLayoutFile } from '@pushform/io';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';
import { LayoutContextMenu } from './LayoutContextMenu';
import { LAYOUT_CLIPBOARD_TYPE } from './layoutClipboard';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function setup() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}) });
  const app = createApp({ demo: false, expose: false }), session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout(), pageId = tab.activePageId;
  const ids = [10, 60, 110].map(x => tab.commands.execute('layout.shape.add', { pageId, points: [[x, 10], [x + 30, 10], [x + 30, 40], [x, 40]], closed: true }) as number);
  render(<LayoutWorkspace tab={tab} session={session} />);
  const canvas = screen.getByLabelText('Page 1 canvas');
  const open = (x = 20, y = 20) => fireEvent.contextMenu(canvas, { clientX: x * 3, clientY: y * 3 });
  const menu = () => within(screen.getByRole('menu', { name: 'Layout context menu' }));
  const choose = (name: string) => fireEvent.click(menu().getByRole('menuitem', { name }));
  const sub = (name: string) => { choose(name); return within(screen.getByRole('menu', { name: 'Layout submenu' })); };
  const selectTwo = () => {
    for (const x of [20, 70]) {
      fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: x * 3, clientY: 60, shiftKey: x === 70 });
      fireEvent.pointerUp(canvas, { pointerId: 1, clientX: x * 3, clientY: 60, shiftKey: x === 70 });
    }
  };
  const entities = () => tab.doc.state.pages.get(pageId)!.entities;
  return { tab, session, pageId, ids, canvas, open, menu, choose, sub, selectTwo, entities,
    dispose: () => { cleanup(); session.dispose(); app.dispose(); } };
}

it('shows the reference item order, selects a right-clicked object, and disables inapplicable actions', () => {
  const { open, menu, choose, entities, ids, dispose } = setup();
  open();
  expect(menu().getAllByRole('menuitem').map(item => item.textContent?.trim())).toEqual([
    'Cut', 'Copy', 'Delete', 'Lock', 'Zoom Selection', 'Move to Layer', 'Arrange', 'Center', 'Flip', 'Make Group', 'Update Pattern Reference', 'Reset Pattern Origin',
  ]);
  expect(menu().getByRole('menuitem', { name: 'Make Group' }).hasAttribute('disabled')).toBe(true);
  expect(menu().getByRole('menuitem', { name: 'Reset Pattern Origin' }).hasAttribute('disabled')).toBe(true);
  choose('Delete');
  expect(entities().has(ids[0]!)).toBe(false); expect(screen.queryByRole('menu')).toBeNull();
  open(200, 150);
  expect(menu().getByRole('menuitem', { name: 'Copy' }).hasAttribute('disabled')).toBe(true);
  expect(menu().getByRole('menuitemcheckbox', { name: 'Object Snap' }).getAttribute('aria-checked')).toBe('true');
  dispose();
});

it('zooms to the selected objects including curve extents', () => {
  const { tab, pageId, ids, open, choose, dispose } = setup();
  const workspace = screen.getByLabelText('Layout workspace');
  Object.defineProperty(workspace, 'clientWidth', { value: 600 });
  Object.defineProperty(workspace, 'clientHeight', { value: 400 });
  act(() => { tab.commands.execute('layout.shape.setPath', { pageId, entityId: ids[0],
    points: [[10, 10], [40, 10]], handles: [{ out: [10, 110] }, { in: [40, 110] }], closed: false }); });
  open(25, 85); choose('Zoom Selection');
  // This curve's visible height is 75 mm, much larger than its anchor-point height.
  expect(tab.workspace.zoom).toBeCloseTo((400 - 48) / (75 * 3));
  dispose();
});

it('locks only the selected objects, protects pointer/keyboard edits, unlocks, and saves', async () => {
  const { tab, session, pageId, ids, canvas, open, choose, entities, dispose } = setup();
  open(); choose('Lock'); expect(entities().get(ids[0]!)?.locked).toBe(true);
  fireEvent.keyDown(window, { key: 'Delete' }); expect(entities().has(ids[0]!)).toBe(true);
  fireEvent.pointerDown(canvas, { button: 0, clientX: 60, clientY: 60 });
  fireEvent.pointerMove(canvas, { clientX: 90, clientY: 90 }); fireEvent.pointerUp(canvas, { clientX: 90, clientY: 90 });
  expect(entities().get(ids[0]!)?.points[0]).toEqual([10, 10]);
  expect((await openLayoutFile((await session.saveLayoutBytes(tab.id)))).state.pages.get(pageId)!.entities.get(ids[0]!)?.locked).toBe(true);
  open(); choose('Unlock'); expect(entities().get(ids[0]!)?.locked).toBe(false);
  dispose();
});

it('toggles snap checkmarks and document settings without requiring selection', async () => {
  const { tab, session, open, menu, dispose } = setup();
  open(200, 150); fireEvent.click(menu().getByRole('menuitemcheckbox', { name: 'Object Snap' }));
  expect(tab.doc.state.settings.objectSnap).toBe(false);
  // Grid Snap starts enabled in a new document, so the first toggle turns it off.
  expect(tab.doc.state.settings.grid.snap).toBe(true);
  open(200, 150); fireEvent.click(menu().getByRole('menuitemcheckbox', { name: 'Grid Snap' }));
  expect(tab.doc.state.settings.grid.snap).toBe(false);
  expect((await openLayoutFile((await session.saveLayoutBytes(tab.id)))).state.settings).toMatchObject({ objectSnap: false, grid: { snap: false } });
  open(); expect(menu().getByRole('menuitemcheckbox', { name: 'Object Snap' }).getAttribute('aria-checked')).toBe('false');
  dispose();
});

it('centers and flips a multi-selection about its combined bounds in one undo step', () => {
  const { tab, ids, open, sub, selectTwo, entities, dispose } = setup();
  selectTwo(); open(); fireEvent.click(sub('Center').getByRole('menuitem', { name: 'Both' }));
  expect(entities().get(ids[0]!)?.points[0]).toEqual([108.5, 90]);
  expect(entities().get(ids[1]!)?.points[0]).toEqual([158.5, 90]);
  act(() => { tab.commands.execute('edit.undo'); });
  expect(entities().get(ids[0]!)?.points[0]).toEqual([10, 10]); expect(entities().get(ids[1]!)?.points[0]).toEqual([60, 10]);
  open(); fireEvent.click(sub('Flip').getByRole('menuitem', { name: 'Horizontally' }));
  expect(entities().get(ids[0]!)?.points[0]).toEqual([90, 10]);
  expect(entities().get(ids[1]!)?.points[0]).toEqual([40, 10]);
  dispose();
});

it('moves multiple objects to a layer and arranges without reversing their relative order', () => {
  const { tab, pageId, ids, open, sub, selectTwo, entities, dispose } = setup();
  selectTwo(); open(); fireEvent.click(sub('Arrange').getByRole('menuitem', { name: 'Bring to Front' }));
  expect(tab.doc.state.pages.get(pageId)!.entityOrder).toEqual([ids[2], ids[0], ids[1]]);
  act(() => { tab.commands.execute('edit.undo'); });
  let layerId = 0; act(() => { layerId = tab.commands.execute('layout.layer.add', { name: 'Details' }) as number; });
  open(); fireEvent.click(sub('Move to Layer').getByRole('menuitemcheckbox', { name: 'Details' }));
  expect(ids.slice(0, 2).map(id => entities().get(id)?.layerId)).toEqual([layerId, layerId]);
  act(() => { tab.commands.execute('edit.undo'); });
  expect(entities().get(ids[0]!)?.layerId).not.toBe(layerId); expect(entities().get(ids[1]!)?.layerId).not.toBe(layerId);
  dispose();
});

it('groups objects, reselects all members, moves them together and ungroups', async () => {
  const { tab, session, pageId, ids, canvas, open, choose, selectTwo, entities, dispose } = setup();
  selectTwo(); open(); choose('Make Group');
  const groupId = entities().get(ids[0]!)?.groupId; expect(groupId).toBeDefined();
  expect(entities().get(ids[1]!)?.groupId).toBe(groupId);
  expect((await openLayoutFile((await session.saveLayoutBytes(tab.id)))).state.pages.get(pageId)!.entities.get(ids[0]!)?.groupId).toBe(groupId);
  open(200, 150); fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
  fireEvent.pointerDown(canvas, { button: 0, clientX: 60, clientY: 60 });
  fireEvent.pointerMove(canvas, { clientX: 90, clientY: 90 }); fireEvent.pointerUp(canvas, { clientX: 90, clientY: 90 });
  expect(entities().get(ids[0]!)?.points[0]).toEqual([20, 20]); expect(entities().get(ids[1]!)?.points[0]).toEqual([70, 20]);
  open(25, 25); choose('Ungroup');
  expect(entities().get(ids[0]!)?.groupId).toBeUndefined(); expect(entities().get(ids[1]!)?.groupId).toBeUndefined();
  act(() => { tab.commands.execute('edit.undo'); }); expect(entities().get(ids[0]!)?.groupId).toBe(groupId);
  dispose();
});

it('copies rich Layout content and cuts only after a successful clipboard write', () => {
  const { tab, ids, open, choose, selectTwo, entities, dispose } = setup();
  const values: Record<string, string> = {};
  const exec = vi.fn(() => { fireEvent.copy(window, { clipboardData: { setData: (type: string, value: string) => { values[type] = value; } } }); return true; });
  Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
  selectTwo(); open(); choose('Copy');
  expect(JSON.parse(values[LAYOUT_CLIPBOARD_TYPE]!).entities.map((entity: { id: number }) => entity.id)).toEqual(ids.slice(0, 2));
  open(); choose('Cut'); expect(entities().size).toBe(1);
  act(() => { tab.commands.execute('edit.undo'); }); expect(entities().size).toBe(3);
  exec.mockReturnValueOnce(false); open(); choose('Cut'); expect(entities().size).toBe(3);
  delete (document as unknown as { execCommand?: unknown }).execCommand;
  dispose();
});

it('selects and drags nested groups together, retaining inner groups after Ungroup', async () => {
  const { tab, session, pageId, ids, canvas, open, choose, entities, dispose } = setup();
  let inner = 0, outer = 0;
  act(() => {
    inner = tab.commands.execute('layout.shape.group', { pageId, entityIds: ids.slice(0, 2) }) as number;
    outer = tab.commands.execute('layout.shape.group', { pageId, entityIds: ids }) as number;
  });
  expect((await openLayoutFile((await session.saveLayoutBytes(tab.id)))).state.pages.get(pageId)!.entities.get(ids[0]!)?.nestedGroupIds).toEqual([inner]);
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 60, clientY: 60 });
  fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 90, clientY: 90 });
  fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 90, clientY: 90 });
  expect(screen.getByText('3 objects selected')).toBeTruthy();
  expect(ids.map(id => entities().get(id)?.points[0])).toEqual([[20, 20], [70, 20], [120, 20]]);
  open(25, 25); choose('Ungroup');
  expect(ids.map(id => entities().get(id)?.groupId)).toEqual([inner, inner, undefined]);
  open(200, 150); fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 75, clientY: 75 });
  fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 105, clientY: 105 });
  fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 105, clientY: 105 });
  expect(screen.getByText('2 objects selected')).toBeTruthy();
  expect(ids.map(id => entities().get(id)?.points[0])).toEqual([[30, 30], [80, 30], [120, 20]]);
  act(() => { tab.commands.execute('edit.undo'); tab.commands.execute('edit.undo'); });
  expect(ids.map(id => entities().get(id)?.groupId)).toEqual([outer, outer, outer]);
  dispose();
});

it('supports keyboard navigation, closes from submenus and clamps menus to the window', () => {
  const close = vi.fn(), action = vi.fn();
  render(<LayoutContextMenu x={2000} y={2000} onClose={close} items={[
    { label: 'Disabled', disabled: true }, { label: 'Submenu', children: [{ label: 'Action', action }] },
  ]} />);
  const root = screen.getByRole('menu', { name: 'Layout context menu' });
  expect(parseFloat(root.style.left)).toBeLessThan(window.innerWidth);
  expect(parseFloat(root.style.top)).toBeLessThan(window.innerHeight);
  fireEvent.keyDown(root, { key: 'ArrowDown' });
  const button = screen.getByRole('menuitem', { name: 'Submenu' }); expect(document.activeElement).toBe(button);
  fireEvent.keyDown(button, { key: 'ArrowRight' });
  const leaf = screen.getByRole('menuitem', { name: 'Action' }); fireEvent.click(leaf);
  expect(action).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
});

it.each(['Escape', 'outside', 'scroll'])('dismisses the context menu on %s', method => {
  const { open, dispose } = setup(); open();
  if (method === 'Escape') fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
  else if (method === 'outside') fireEvent.pointerDown(document.body);
  else fireEvent.scroll(screen.getByLabelText('Layout workspace'));
  expect(screen.queryByRole('menu')).toBeNull(); dispose();
});

it.each(['success', 'failure', 'changed'])('waits for the system clipboard before cutting (%s)', async outcome => {
  const { tab, pageId, ids, open, choose, selectTwo, entities, dispose } = setup();
  let resolve!: () => void, reject!: (error: Error) => void;
  const written = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  vi.stubGlobal('ClipboardItem', class { static supports = () => true; });
  vi.stubGlobal('navigator', { ...navigator, clipboard: { write: vi.fn(() => written) } });
  Object.defineProperty(document, 'execCommand', { configurable: true, value: () => {
    fireEvent.copy(window, { clipboardData: { setData: () => {} } }); return true;
  } });
  try {
    selectTwo(); open(); choose('Cut');
    expect(entities().size).toBe(3);
    await waitFor(() => expect(navigator.clipboard.write).toHaveBeenCalledOnce());
    if (outcome === 'changed') act(() => { tab.commands.execute('layout.shape.move', { pageId, entityIds: [ids[0]], delta: [1, 0] }); });
    await act(async () => { if (outcome === 'failure') reject(new Error('Clipboard denied')); else resolve(); await written.catch(() => {}); });
    expect(entities().size).toBe(outcome === 'success' ? 1 : 3);
    if (outcome === 'success') { act(() => { tab.commands.execute('edit.undo'); }); expect(entities().size).toBe(3); }
  } finally { delete (document as unknown as { execCommand?: unknown }).execCommand; vi.unstubAllGlobals(); dispose(); }
});
