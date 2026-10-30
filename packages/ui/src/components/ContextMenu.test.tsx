// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import { AppContext } from '../AppContext';
import { createApp } from '../bootstrap';
import type { AppInstance } from '../bootstrap';
import { installUiCommands } from '../engine/uiCommands';
import { useAppStore } from '../store';
import { addInstance, stubInstanceCommands } from '../panels/instances.testutil';
import { ContextMenuHost } from './ContextMenu';

let app: AppInstance | null = null;
afterEach(() => {
  cleanup();
  app?.dispose();
  app = null;
  useAppStore.getState().closeContextMenu();
  useAppStore.getState().closePanel();
});

function boot(log: string[] = []): AppInstance {
  const a = createApp({ demo: false, expose: false, kernel: new KernelClient(new InlineBackend()) });
  stubInstanceCommands(a, log);
  installUiCommands(a.commands);
  app = a;
  return a;
}

const mount = (a: AppInstance) =>
  render(
    <AppContext.Provider value={a}>
      <ContextMenuHost />
    </AppContext.Provider>,
  );

const itemLabels = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole('menuitem')
    .map((b) => b.textContent);

describe('ContextMenu', () => {
  it('ui.contextMenu.open selects the right-clicked instance and shows its items; clicking runs the command', () => {
    const log: string[] = [];
    const a = boot(log);
    const house = addInstance(a, { name: 'House' });
    mount(a);
    expect(screen.queryByRole('menu')).toBeNull();
    const ref = { kind: 'instance', path: [], id: house } as const;
    act(() => void a.commands.execute('ui.contextMenu.open', { x: 40, y: 50, refs: [ref] }));
    expect(a.document.selection.refs).toEqual([ref]);
    const menu = screen.getByRole('menu', { name: 'Context menu' });
    expect(itemLabels(menu)).toEqual(['Entity Info', 'Erase', 'Hide', 'Lock', 'Edit Group', 'Explode', 'Make Component…', 'Flip Along', 'Red', 'Green', 'Blue', 'Rename…', 'Zoom Selection']);
    expect((within(menu).getByRole('menuitem', { name: 'Zoom Selection' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Hide' }));
    expect(log).toEqual(['setHidden true']);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(a.document.doc.rootDefinition.entities.instances.get(house)!.hidden).toBe(true);

    act(() => void a.commands.execute('ui.contextMenu.open', { x: 40, y: 50, refs: [ref] }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit Group' }));
    expect(a.document.context.path).toEqual([house]);
    act(() => void a.commands.execute('ui.contextMenu.open', { x: 40, y: 50, refs: [ref] }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Entity Info' }));
    expect(useAppStore.getState().openPanel).toBe('entityInfo');
  });

  it('empty space menu offers Exit Group inside a context; Esc and outside clicks close it', () => {
    const a = boot();
    const house = addInstance(a, { name: 'House' });
    mount(a);
    act(() => void a.commands.execute('ui.contextMenu.open', { x: 0, y: 0 }));
    let menu = screen.getByRole('menu', { name: 'Context menu' });
    expect(itemLabels(menu)).toEqual(['Paste In Place', 'Select All', 'Zoom Extents']);
    expect((within(menu).getByRole('menuitem', { name: 'Paste In Place' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();

    act(() => void a.commands.execute('context.enter', { path: [house] }));
    act(() => void a.commands.execute('ui.contextMenu.open', { x: 0, y: 0 }));
    menu = screen.getByRole('menu', { name: 'Context menu' });
    expect(itemLabels(menu)).toContain('Exit Group');
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
    act(() => void a.commands.execute('ui.contextMenu.open', { x: 0, y: 0 }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Exit Group' }));
    expect(a.document.context.path).toEqual([]);
  });

  it('edge menu has a Select submenu whose items set the selection', () => {
    const a = boot();
    a.commands.execute('sketch.rectangle', { a: [0, 0, 0], b: [1, 0, 0], c: [1, 1, 0], d: [0, 1, 0] });
    const sketch = a.document.doc.rootDefinition.entities.sketch;
    const edgeId = [...sketch.edges.keys()][0]!;
    mount(a);
    act(() => void a.commands.execute('ui.contextMenu.open', { x: 0, y: 0, refs: [{ kind: 'sketchEdge', path: [], id: edgeId }] }));
    const sub = screen.getByRole('menu', { name: 'Select' });
    fireEvent.click(within(sub).getByRole('menuitem', { name: 'All Connected' }));
    expect(a.document.selection.size).toBe(5);
  });
});
