// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { z } from 'zod';
import {
  CommandRegistry,
  DocumentHost,
  SERVICE_DOCUMENT,
  createLayoutRegistry,
  defineCommand,
} from '@pushform/commands';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import { createLayoutDocument } from '@pushform/layout';
import { createApp } from '../bootstrap';
import type { AppInstance } from '../bootstrap';
import { DocumentSession } from '../session';
import { useAppStore } from '../store';
import { CommandSearch, searchCommands } from './CommandSearch';
import { commandSearchSourceFor, type CommandSearchSource } from './commandSearchSource';

let app: AppInstance | null = null;
afterEach(() => {
  cleanup();
  app?.dispose();
  app = null;
  useAppStore.getState().setNotice(null);
});

function boot(): AppInstance {
  app = createApp({ demo: false, expose: false, kernel: new KernelClient(new InlineBackend()) });
  return app;
}

const modelSource = (
  a: AppInstance,
  focusWorkspace = (): void => undefined,
): CommandSearchSource => ({
  registry: a.commands,
  keymap: a.keymap,
  focusWorkspace,
});

const input = () => screen.getByRole('combobox', { name: 'Search tools and commands' });
const options = () => screen.queryAllByRole('option').map((o) => o.textContent);

describe('searchCommands', () => {
  it('ranks Save As ahead of Save as Template for its exact name, ignoring a dialog ellipsis', () => {
    const a = boot();
    for (const [id, title] of [['file.saveAs', 'Save As…'], ['file.saveTemplate', 'Save as Template…']] as const) {
      a.commands.register(defineCommand({ id, title, category: 'file', params: z.object({}), undoable: false, run: () => {} }));
    }
    expect(searchCommands(a.commands, a.keymap, 'Save As').map(item => item.id)).toEqual(['file.saveAs', 'file.saveTemplate']);
    expect(searchCommands(a.commands, a.keymap, 'Save as Template')[0]?.id).toBe('file.saveTemplate');
  });
  it('indexes runnable commands only: no internal commands, none that need parameters', () => {
    const a = boot();
    const all = searchCommands(a.commands, a.keymap, 'e');
    expect(all.length).toBeLessThanOrEqual(12);
    const ids = (q: string) => searchCommands(a.commands, a.keymap, q).map((i) => i.id);
    expect(ids('push')).toContain('tool.pushpull');
    expect(ids('selection.set')).toEqual([]); // requires refs
    expect(ids('material.getActive')).toEqual([]); // internal
    const push = searchCommands(a.commands, a.keymap, 'push/pull')[0]!;
    expect(push).toMatchObject({ title: 'Push/Pull', icon: 'tool-pushpull', key: 'P' });
    // ranking: title prefix beats substring
    expect(ids('zoom')[0]).toBe('tool.zoom');
  });

  it('is limited to the given registry, so another mode never sees model tools', () => {
    const host = new DocumentHost();
    const other = new CommandRegistry({ tx: host, services: new Map([[SERVICE_DOCUMENT, host]]) });
    other.register(
      defineCommand({
        id: 'layout.page.add',
        title: 'Add Page',
        category: 'layout',
        params: z.object({}),
        undoable: false,
        run: () => undefined,
      }),
    );
    expect(searchCommands(other, null, 'push')).toEqual([]);
    expect(searchCommands(other, null, 'page').map((i) => i.id)).toEqual(['layout.page.add']);
    expect(searchCommands(other, null, 'page')[0]?.key).toBeNull();
  });
});

describe('CommandSearch', () => {
  it('filters as you type, shows name, shortcut and icon, runs on Enter and returns focus', () => {
    const a = boot();
    const onExecuted = vi.fn();
    render(<CommandSearch source={() => modelSource(a, onExecuted)} />);
    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: 'push' } });
    expect(options()).toContain('Push/PullP');
    expect(screen.getByRole('option', { name: /Push\/Pull/ }).querySelector('svg')).not.toBeNull();
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(a.toolManager.activeToolId).toBe('pushpull');
    expect(onExecuted).toHaveBeenCalledTimes(1);
    expect((input() as HTMLInputElement).value).toBe('');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('ArrowDown moves the highlight; Escape clears; Cmd/Ctrl+K focuses from anywhere', () => {
    const a = boot();
    render(<CommandSearch source={() => modelSource(a)} />);
    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: 'zoom' } });
    const first = screen.getAllByRole('option')[0]!;
    expect(first.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[1]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect((input() as HTMLInputElement).value).toBe('');
    act(() => {
      input().blur();
    });
    expect(document.activeElement).not.toBe(input());
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(document.activeElement).toBe(input());
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(document.activeElement).toBe(input());
  });

  it('view.search focuses the input and has Mod+K bound', () => {
    const a = boot();
    render(<CommandSearch source={() => modelSource(a)} />);
    expect(a.commands.has('view.search')).toBe(true);
    expect(a.keymap.bindingsFor('view.search').length).toBeGreaterThanOrEqual(2);
    act(() => {
      a.commands.execute('view.search');
    });
    expect(document.activeElement).toBe(input());
  });
});

describe('CommandSearch in Layout mode', () => {
  it('lists every Layout tool with its shortcut hint and activates it through the tab registry', () => {
    const { commands } = createLayoutRegistry(createLayoutDocument());
    const activated: string[] = [];
    commands.ctx.tools = { activate: (id) => activated.push(id), activeToolId: 'select' };
    const focusWorkspace = vi.fn();
    render(<CommandSearch source={() => ({ registry: commands, keymap: null, focusWorkspace })} />);
    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: 'push' } });
    expect(options()).toEqual([]);
    fireEvent.change(input(), { target: { value: 'rect' } });
    expect(options()).toEqual(['RectangleR', 'Bulged Rectangle', 'Rounded Rectangle']); // Draw Rectangle needs params
    expect(screen.getByRole('option', { name: /^Rectangle/ }).querySelector('svg')).not.toBeNull();
    fireEvent.change(input(), { target: { value: 'label' } });
    expect(options()).toEqual(['Label']); // Label has no key
    fireEvent.change(input(), { target: { value: '2 point' } });
    expect(options()).toEqual(['2 Point ArcA']);
    fireEvent.change(input(), { target: { value: 'angular' } });
    expect(options()).toEqual(['Angular DimensionShift+D']);
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(activated).toEqual(['angular-dimension']);
    expect(focusWorkspace).toHaveBeenCalledTimes(1);
    expect((input() as HTMLInputElement).value).toBe('');
    fireEvent.change(input(), { target: { value: 'page' } });
    expect(options()).toContain('Add Page');
    fireEvent.change(input(), { target: { value: 'present' } });
    expect(options()).toEqual(['Presentation Mode']);
  });

  it('lists Layout tools as disabled while no workspace is mounted', () => {
    const { commands } = createLayoutRegistry(createLayoutDocument());
    const item = searchCommands(commands, null, 'freehand')[0]!;
    expect(item).toMatchObject({
      id: 'tool.freehand',
      title: 'Freehand',
      icon: 'tool-freehand',
      key: null,
      enabled: false,
    });
  });
});

describe('commandSearchSourceFor', () => {
  it('maps a model tab to the app registry and keymap, and a layout tab to its own registry', () => {
    const a = boot();
    const session = new DocumentSession(a, () => boot(), false, null);
    const model = commandSearchSourceFor(session.active);
    expect(model.registry).toBe(a.commands);
    expect(model.keymap).toBe(a.keymap);
    const tab = session.newLayout();
    const layout = commandSearchSourceFor(session.active);
    expect(layout.registry).toBe(tab.commands);
    expect(layout.keymap).toBeNull();
    expect(searchCommands(layout.registry, layout.keymap, 'push')).toEqual([]);
    expect(searchCommands(model.registry, model.keymap, 'lozenge')).toEqual([]);
    expect(searchCommands(layout.registry, layout.keymap, 'lozenge').map((i) => i.id)).toEqual([
      'tool.lozenge',
    ]);
    session.dispose();
  });
});
