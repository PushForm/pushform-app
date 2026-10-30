// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { meshBox } from '@pushform/core';
import type { Id } from '@pushform/core';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import { bodyFromMesh, containerAt } from '@pushform/model';
import { AppContext } from '../AppContext';
import { createApp } from '../bootstrap';
import type { AppInstance } from '../bootstrap';
import { useAppStore } from '../store';
import { addInstance, stubInstanceCommands } from '../panels/instances.testutil';
import { ModelObjectBrowser } from './ModelObjectBrowser';
import { modelBrowserTree, type ModelBrowserNode } from './modelBrowserTree';
import * as browserModel from './modelBrowserTree';
import * as guidance from '../guidance';

let app: AppInstance | null = null;
afterEach(() => {
  cleanup();
  app?.dispose();
  app = null;
  useAppStore.getState().closeContextMenu();
});

function boot(log: string[] = []): AppInstance {
  const a = createApp({ demo: false, expose: false, kernel: new KernelClient(new InlineBackend()) });
  stubInstanceCommands(a, log);
  app = a;
  return a;
}

/** Adds a unit box solid to the container at `path` (the root by default) and returns its id. */
function addSolid(a: AppInstance, path: readonly Id[] = []): Id {
  let id = 0 as Id;
  a.document.doc.transact('add solid', (draft) => {
    id = bodyFromMesh(draft, meshBox([0, 0, 0], [1, 1, 1]), { container: containerAt(draft as never, path) as never }).id;
  });
  return id;
}

const mount = (a: AppInstance, onClose?: () => void) =>
  render(
    <AppContext.Provider value={a}>
      <ModelObjectBrowser onClose={onClose} />
    </AppContext.Provider>,
  );

const tree = (): HTMLElement => screen.getByRole('tree', { name: 'Object browser' });
const names = (): string[] => within(tree()).getAllByRole('treeitem').map((item) => item.querySelector('.pf-layout-browser-name')?.textContent ?? '');
const item = (name: string): HTMLElement =>
  within(tree()).getAllByRole('treeitem').find((el) => el.querySelector(':scope > .pf-layout-browser-row .pf-layout-browser-name')?.firstChild?.textContent === name)!;
const row = (name: string): HTMLElement => item(name).querySelector<HTMLElement>(':scope > .pf-layout-browser-row')!;

describe('ModelObjectBrowser', () => {
  it('updates selection without rebuilding the model hierarchy', () => {
    const a = boot();
    const first = addInstance(a, { name: 'First' });
    const second = addInstance(a, { name: 'Second' });
    mount(a);
    const build = vi.spyOn(browserModel, 'modelBrowserTree');
    const register = vi.spyOn(guidance, 'registerGuidanceTargets');
    try {
      act(() => a.document.selection.set([{ kind: 'instance', path: [], id: first }]));
      expect(item('First').getAttribute('aria-selected')).toBe('true');
      act(() => a.document.selection.set([{ kind: 'instance', path: [], id: second }]));
      expect(item('First').getAttribute('aria-selected')).toBe('false');
      expect(item('Second').getAttribute('aria-selected')).toBe('true');
      expect(build).not.toHaveBeenCalled();
      expect(register).not.toHaveBeenCalled();
      act(() => void addSolid(a));
      expect(build).toHaveBeenCalled();
      expect(names()).toContain('Solid 1');
    } finally { build.mockRestore(); register.mockRestore(); }
  });

  it('lists solids, groups and components in creation order with the Layout browser look, nested and expandable', () => {
    const a = boot();
    addSolid(a);
    const house = addInstance(a, { name: 'House', isGroup: true });
    addSolid(a, [house]);
    addInstance(a, { name: 'Front chair', defName: 'Chair', isGroup: false, parent: [house] });
    addInstance(a, { name: 'Tree', isGroup: true });
    mount(a);
    expect(screen.getByRole('heading', { name: 'Object browser' })).toBeTruthy();
    expect(names()).toEqual(['Solid 1', 'House', 'Tree']);
    expect(item('House').getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(row('House').querySelector('.pf-layout-browser-chevron')!);
    expect(names()).toEqual(['Solid 1', 'House', 'Solid 2', 'Front chair <Chair>', 'Tree']);
    expect(item('House').getAttribute('aria-level')).toBe('1');
    expect(item('Solid 2').getAttribute('aria-level')).toBe('2');
    expect(item('House').getAttribute('aria-expanded')).toBe('true');
    expect(within(row('Solid 1')).getByRole('img', { name: 'Solid' })).toBeTruthy();
    expect(within(row('House')).getByRole('img', { name: 'Group' })).toBeTruthy();
    expect(within(row('Front chair')).getByRole('img', { name: 'Component' })).toBeTruthy();
    // Only groups and components have a lock.
    expect(within(row('Solid 1')).queryByRole('button', { name: /^Lock/ })).toBeNull();
    expect(within(row('House')).getByRole('button', { name: 'Lock House' })).toBeTruthy();

    fireEvent.click(row('House').querySelector('.pf-layout-browser-chevron')!);
    expect(names()).toEqual(['Solid 1', 'House', 'Tree']);
    fireEvent.click(row('House').querySelector('.pf-layout-browser-chevron')!);
    expect(names()).toEqual(['Solid 1', 'House', 'Solid 2', 'Front chair <Chair>', 'Tree']);

    // The tree follows document changes.
    act(() => void addSolid(a));
    expect(names().at(-1)).toBe('Solid 3');
  });

  it('keeps nested and newly added groups and components collapsed until explicitly opened', () => {
    const a = boot();
    const outer = addInstance(a, { name: 'Outer' });
    const inner = addInstance(a, { name: 'Inner', isGroup: false, parent: [outer] });
    addSolid(a, [outer, inner]);
    mount(a);
    expect(names()).toEqual(['Outer']);
    fireEvent.click(row('Outer').querySelector('.pf-layout-browser-chevron')!);
    expect(names()).toEqual(['Outer', 'Inner']);
    expect(item('Inner').getAttribute('aria-expanded')).toBe('false');
    act(() => { const added = addInstance(a, { name: 'Added' }); addSolid(a, [added]); });
    expect(names()).toEqual(['Outer', 'Inner', 'Added']);
    expect(item('Outer').getAttribute('aria-expanded')).toBe('true');
    expect(item('Added').getAttribute('aria-expanded')).toBe('false');
  });

  it('moves with the keyboard, keeps keys from the modeler, and hides on Escape', () => {
    const a = boot();
    const house = addInstance(a, { name: 'House' });
    addInstance(a, { name: 'Door', parent: [house] });
    addInstance(a, { name: 'Tree' });
    const onClose = vi.fn();
    const shortcut = vi.fn();
    window.addEventListener('keydown', shortcut);
    mount(a, onClose);
    expect(item('House').tabIndex).toBe(0);
    item('House').focus();
    fireEvent.keyDown(item('House'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(item('House'));
    fireEvent.keyDown(item('House'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(item('Door'));
    fireEvent.keyDown(item('Door'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(item('House'));
    fireEvent.keyDown(item('House'), { key: 'ArrowLeft' });
    expect(names()).toEqual(['House', 'Tree']);
    fireEvent.keyDown(item('House'), { key: 'ArrowRight' });
    expect(names()).toEqual(['House', 'Door', 'Tree']);
    fireEvent.keyDown(item('House'), { key: 'End' });
    expect(document.activeElement).toBe(item('Tree'));
    fireEvent.keyDown(item('Tree'), { key: 'Enter' });
    expect(a.document.selection.refs).toEqual([{ kind: 'instance', path: [], id: expect.any(Number) }]);
    // Tool letters and Delete stay in the tree; undo passes through.
    fireEvent.keyDown(item('Tree'), { key: 'm' });
    fireEvent.keyDown(item('Tree'), { key: 'Delete' });
    expect(shortcut).not.toHaveBeenCalled();
    fireEvent.keyDown(item('Tree'), { key: 'z', ctrlKey: true });
    expect(shortcut).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(item('Tree'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    window.removeEventListener('keydown', shortcut);
  });

  it('selects forward and backward ranges with collapsed descendants', () => {
    const a = boot();
    const first = addInstance(a, { name: 'First' });
    const middle = addInstance(a, { name: 'Middle' });
    const nested = addInstance(a, { name: 'Nested', parent: [middle] });
    const solid = addSolid(a, [middle, nested]);
    const last = addInstance(a, { name: 'Last' });
    addInstance(a, { name: 'Outside' });
    mount(a);
    const expected = [
      { kind: 'instance', path: [], id: first },
      { kind: 'instance', path: [], id: middle },
      { kind: 'instance', path: [middle], id: nested },
      { kind: 'body', path: [middle, nested], id: solid },
      { kind: 'instance', path: [], id: last },
    ];
    fireEvent.click(row('First'));
    fireEvent.click(row('Last'), { shiftKey: true });
    expect(a.document.selection.refs).toEqual(expected);
    fireEvent.click(row('Last'));
    fireEvent.click(row('First'), { shiftKey: true });
    expect(a.document.selection.refs).toEqual(expected);
  });

  it('selects with the viewport modifiers and reveals a selection made elsewhere', () => {
    const a = boot();
    const solid = addSolid(a);
    const house = addInstance(a, { name: 'House' });
    const door = addInstance(a, { name: 'Door', parent: [house] });
    mount(a);
    const solidRef = { kind: 'body', path: [], id: solid };
    const houseRef = { kind: 'instance', path: [], id: house };
    fireEvent.click(row('Solid 1'));
    expect(a.document.selection.refs).toEqual([solidRef]);
    expect(item('Solid 1').getAttribute('aria-selected')).toBe('true');
    fireEvent.click(row('House'), { ctrlKey: true });
    expect(a.document.selection.refs).toEqual([solidRef, houseRef]);
    fireEvent.click(row('Solid 1'), { shiftKey: true });
    expect(a.document.selection.refs).toEqual([solidRef, houseRef, { kind: 'instance', path: [house], id: door }]);
    fireEvent.click(row('Solid 1'));
    fireEvent.click(row('House'), { ctrlKey: true, shiftKey: true });
    expect(a.document.selection.refs).toEqual([solidRef]);
    fireEvent.click(row('House'));
    expect(a.document.selection.refs).toEqual([houseRef]);

    expect(item('House').getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(row('House').querySelector('.pf-layout-browser-chevron')!);
    expect(names()).toEqual(['Solid 1', 'House']);
    act(() => a.document.selection.set([{ kind: 'instance', path: [house], id: door }]));
    expect(names()).toEqual(['Solid 1', 'House', 'Door']);
    expect(item('Door').getAttribute('aria-selected')).toBe('true');
  });

  it('hides and shows solids, groups and components, and locks groups and components', () => {
    const log: string[] = [];
    const a = boot(log);
    const solid = addSolid(a);
    addInstance(a, { name: 'House' });
    mount(a);
    fireEvent.click(within(row('House')).getByRole('button', { name: 'Show House' }));
    expect(log).toEqual(['setHidden true']);
    expect(item('House').className).toContain('is-hidden');
    expect(within(row('House')).getByRole('button', { name: 'Show House' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(within(row('House')).getByRole('button', { name: 'Lock House' }));
    expect(log.at(-1)).toBe('setLocked true');
    expect(within(row('House')).getByRole('button', { name: 'Lock House' }).getAttribute('aria-pressed')).toBe('true');
    // Pressing a button never selects the row.
    expect(a.document.selection.refs).toEqual([]);

    fireEvent.click(row('Solid 1'));
    fireEvent.click(within(row('Solid 1')).getByRole('button', { name: 'Show Solid 1' }));
    expect(a.document.doc.state.definitions.get(a.document.doc.state.rootDefinitionId)!.entities.bodies.get(solid)!.hidden).toBe(true);
    expect(a.document.selection.refs).toEqual([]);
    expect(item('Solid 1').className).toContain('is-hidden');
    expect(screen.getAllByText('Hidden').length).toBe(2);
    fireEvent.click(within(row('Solid 1')).getByRole('button', { name: 'Show Solid 1' }));
    expect(item('Solid 1').className).not.toContain('is-hidden');
  });

  it('renames groups and components in place; solids have no name to edit', () => {
    const log: string[] = [];
    const a = boot(log);
    addSolid(a);
    addInstance(a, { name: '', defName: 'Group#1' });
    mount(a);
    fireEvent.doubleClick(row('Solid 1'));
    expect(screen.queryByRole('textbox')).toBeNull();

    fireEvent.doubleClick(row('Group#1'));
    const field = screen.getByRole('textbox', { name: 'Rename Group#1' }) as HTMLInputElement;
    // An empty name on an instance without its own name changes nothing.
    fireEvent.change(field, { target: { value: '  ' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(log).toEqual([]);
    item('Group#1').focus();
    fireEvent.keyDown(item('Group#1'), { key: 'F2' });
    const again = screen.getByRole('textbox', { name: 'Rename Group#1' });
    fireEvent.change(again, { target: { value: ' House ' } });
    fireEvent.keyDown(again, { key: 'Enter' });
    expect(log).toEqual(['rename House']);
    expect(names()).toEqual(['Solid 1', 'House']);
    expect(document.activeElement).toBe(item('House'));
    // Escape cancels; an empty name now restores the definition name.
    fireEvent.doubleClick(row('House'));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(log).toEqual(['rename House']);
    fireEvent.doubleClick(row('House'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } });
    fireEvent.blur(screen.getByRole('textbox'));
    expect(log.at(-1)).toBe('rename ');
    expect(names()).toEqual(['Solid 1', 'Group#1']);
  });

  it('opens the modeler context menu from a right-click or Shift+F10, and marks the group open for editing', () => {
    const a = boot();
    const solid = addSolid(a);
    const house = addInstance(a, { name: 'House' });
    mount(a);
    fireEvent.contextMenu(row('House'), { clientX: 10, clientY: 20 });
    expect(useAppStore.getState().contextMenu).toEqual({ x: 10, y: 20, refs: [{ kind: 'instance', path: [], id: house }] });
    item('Solid 1').focus();
    fireEvent.keyDown(item('Solid 1'), { key: 'F10', shiftKey: true });
    expect(useAppStore.getState().contextMenu?.refs).toEqual([{ kind: 'body', path: [], id: solid }]);

    act(() => a.document.setContext([house]));
    expect(within(row('House')).getByRole('img', { name: 'Open for editing' })).toBeTruthy();
    expect(item('House').className).toContain('is-current');
  });

  it('modelBrowserTree numbers solids across the model and guards definition cycles', () => {
    const a = boot();
    const outer = addInstance(a, { name: 'Outer', withBox: true });
    const inner = addInstance(a, { name: 'Inner', parent: [outer] });
    addSolid(a);
    a.document.doc.transact('cycle', (draft) => {
      const outerInst = draft.definitions.get(draft.rootDefinitionId)!.entities.instances.get(outer)!;
      const innerDef = draft.definitions.get(draft.definitions.get(outerInst.definitionId)!.entities.instances.get(inner)!.definitionId)!;
      const id = draft.meta.nextId++ as never;
      innerDef.entities.instances.set(id, { ...outerInst, id, name: 'Loop' } as never);
    });
    const flat = (nodes: readonly ModelBrowserNode[]): string[] => nodes.flatMap((n) => [`${n.level}:${n.label}`, ...flat(n.children)]);
    expect(flat(modelBrowserTree(a.document.doc.state, [outer, inner], new Set()))).toEqual(['1:Outer', '2:Solid 1', '2:Inner', '3:Loop', '1:Solid 2']);
    const innerNode = modelBrowserTree(a.document.doc.state, [outer, inner], new Set())[0]!.children[1]!;
    expect(innerNode.current).toBe(true);
    expect(innerNode.children[0]!.children).toEqual([]);
  });
});
