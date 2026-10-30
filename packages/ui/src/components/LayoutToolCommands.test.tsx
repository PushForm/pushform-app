// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LAYOUT_TOOLS, layoutToolCommandId } from '@pushform/commands';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';
import { ToastHost } from './ToastHost';
import { CommandSearch, searchableCommands } from './CommandSearch';
import { openLayoutFile } from '@pushform/io';
import { commandSearchSourceFor } from './commandSearchSource';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('offers Toggle Grid instead of Grid Settings and toggles visibility with undo and persistence', async () => {
  const { session, app, tab } = mount();
  const searchable = searchableCommands(tab.commands, null);
  expect(searchable.some(item => item.title === 'Grid Settings')).toBe(false);
  expect(searchable.some(item => item.id === 'layout.grid.toggle' && item.title === 'Toggle Grid')).toBe(true);
  render(<CommandSearch source={() => commandSearchSourceFor(tab)} />);
  const initial = { ...tab.doc.state.settings.grid };
  const input = screen.getByRole('combobox', { name: 'Search tools and commands' });
  const toggle = () => {
    fireEvent.focus(input); fireEvent.change(input, { target: { value: 'toggle grid' } });
    expect(screen.getByRole('option', { name: 'Toggle Grid' })).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Enter' });
  };
  toggle();
  expect(tab.doc.state.settings.grid).toEqual({ ...initial, show: !initial.show });
  expect((await openLayoutFile((await session.saveLayoutBytes(tab.id)))).state.settings.grid.show).toBe(!initial.show);
  act(() => { tab.commands.execute('edit.undo'); });
  expect(tab.doc.state.settings.grid).toEqual(initial);
  act(() => { tab.commands.execute('edit.redo'); });
  expect(tab.doc.state.settings.grid.show).toBe(!initial.show);
  toggle();
  expect(tab.doc.state.settings.grid).toEqual(initial);
  cleanup(); session.dispose(); app.dispose();
});

it('activates Scale from the toolbar or command search before selection', () => {
  const { session, app, tab, view, activeTool } = mount();
  expect(searchableCommands(tab.commands, null).find(item => item.id === 'tool.scale')).toMatchObject({ title: 'Scale' });
  expect(tab.commands.get('tool.scale')).toMatchObject({ menu: 'Tools', icon: 'tool-scale' });
  expect(tab.commands.isEnabled('tool.scale')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Scale' }));
  expect(activeTool()).toBe('scale');
  expect(screen.getByRole('button', { name: 'Scale' }).getAttribute('aria-pressed')).toBe('true');
  act(() => { tab.commands.execute('tool.move'); });
  act(() => { tab.commands.execute('tool.scale'); });
  expect(activeTool()).toBe('scale');
  view.unmount();
  expect(tab.commands.isEnabled('tool.scale')).toBe(false);
  session.dispose(); app.dispose();
});

it('adds an undoable active layer from command search, numbered after the existing layers', () => {
  const { session, app, tab, view } = mount();
  render(<CommandSearch source={() => commandSearchSourceFor(tab)} />);
  const input = screen.getByRole('combobox', { name: 'Search tools and commands' });
  const run = () => {
    fireEvent.focus(input); fireEvent.change(input, { target: { value: 'add layer' } });
    expect(screen.getByRole('option', { name: 'Add Layer' }).getAttribute('aria-disabled')).not.toBe('true');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect((input as HTMLInputElement).value).toBe('');
  };
  run();
  expect(tab.doc.state.layers.get(tab.doc.state.activeLayerId)).toMatchObject({ name: 'Layer 2', shared: false });
  run();
  expect(tab.doc.state.layers.get(tab.doc.state.activeLayerId)?.name).toBe('Layer 3');
  act(() => { tab.commands.execute('edit.undo'); });
  act(() => { tab.commands.execute('edit.undo'); });
  expect(tab.doc.state.layers.size).toBe(1);
  view.unmount();
  expect(tab.commands.isEnabled('layout.layer.new')).toBe(false);
  session.dispose(); app.dispose();
});

function mount() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(
    app,
    () => createApp({ demo: false, expose: false }),
    false,
    null,
  );
  const tab = session.newLayout();
  const view = render(<><LayoutWorkspace tab={tab} session={session} /><ToastHost /></>);
  const activeTool = () => screen.getByLabelText('Page 1 canvas').getAttribute('data-tool');
  return { app, session, tab, view, activeTool };
}

describe('Layout tool commands', () => {
  it('runs Zoom to Page and Fit Content from search using current visible page content', () => {
    const { session, app, tab, view } = mount();
    const workspace = screen.getByLabelText('Layout workspace');
    Object.defineProperty(workspace, 'clientWidth', { value: 948 });
    Object.defineProperty(workspace, 'clientHeight', { value: 648 });
    workspace.scrollTo = vi.fn();
    render(<CommandSearch source={() => ({ registry: tab.commands, keymap: null, focusWorkspace: () => {} })} />);
    const input = screen.getByRole('combobox', { name: 'Search tools and commands' });
    const run = (query: string, title: string) => {
      fireEvent.focus(input); fireEvent.change(input, { target: { value: query } });
      expect(screen.getByRole('option', { name: title }).getAttribute('aria-disabled')).not.toBe('true');
      fireEvent.keyDown(input, { key: 'Enter' });
      expect((input as HTMLInputElement).value).toBe('');
    };
    const version = tab.doc.version;
    run('zoom to page', 'Zoom to Page');
    expect(tab.workspace.zoom).toBeCloseTo(600 / 630);
    run('fit content', 'Fit Content'); // Empty content falls back to the page.
    expect(tab.workspace.zoom).toBeCloseTo(600 / 630);
    expect(tab.doc.version).toBe(version); expect(tab.doc.undoStack.canUndo).toBe(false);
    act(() => {
      tab.commands.execute('layout.shape.add', { pageId: tab.activePageId, points: [[10, 10], [110, 60]] });
      tab.commands.execute('layout.layer.add', { name: 'Shared', shared: true });
      tab.commands.execute('layout.shape.add', { pageId: tab.activePageId, points: [[160, 10], [210, 60]] });
      const hidden = tab.commands.execute('layout.layer.add', { name: 'Hidden' });
      tab.commands.execute('layout.shape.add', { pageId: tab.activePageId, points: [[0, 0], [1000, 1000]] });
      tab.commands.execute('layout.layer.setVisible', { layerId: hidden, visible: false });
    });
    const contentVersion = tab.doc.version;
    run('fit content', 'Fit Content');
    expect(tab.workspace.zoom).toBeCloseTo(1.5); // Includes shared content and excludes the hidden layer.
    expect(tab.doc.version).toBe(contentVersion);
    act(() => { tab.commands.execute('layout.page.setup', { pageId: tab.activePageId, widthMm: 400, heightMm: 300 }); });
    run('zoom to page', 'Zoom to Page');
    expect(tab.workspace.zoom).toBeCloseTo(2 / 3);
    view.unmount();
    expect(tab.commands.isEnabled('layout.zoom.page')).toBe(false);
    expect(tab.commands.isEnabled('layout.zoom.content')).toBe(false);
    session.dispose(); app.dispose();
  });

  it('activate the workspace tool while mounted and are disabled once it unmounts', () => {
    const { session, app, tab, view, activeTool } = mount();
    expect(tab.commands.isEnabled('tool.line')).toBe(true);
    expect(tab.commands.ctx.tools?.activeToolId).toBe('select');
    act(() => {
      tab.commands.execute('tool.line');
    });
    expect(activeTool()).toBe('line');
    expect(tab.commands.ctx.tools?.activeToolId).toBe('line');
    expect(screen.getByRole('button', { name: 'Line' }).getAttribute('aria-pressed')).toBe('true');
    act(() => {
      tab.commands.execute('tool.rounded-rectangle');
    });
    expect(activeTool()).toBe('rounded-rectangle');
    // The Rectangle stack now shows the chosen entry on its face.
    expect(screen.getByRole('button', { name: 'Rounded' })).not.toBeNull();
    view.unmount();
    expect(tab.commands.isEnabled('tool.line')).toBe(false);
    session.dispose();
    app.dispose();
  });

  it('declare the same shortcuts the workspace handles', () => {
    const { session, app, tab, activeTool } = mount();
    for (const tool of LAYOUT_TOOLS) {
      if (!tool.keybinding) continue;
      const parts = tool.keybinding.split('+');
      const key = parts[parts.length - 1]!;
      const code = key === 'Space' ? 'Space' : `Key${key}`;
      act(() => {
        tab.commands.execute('tool.eraser');
      });
      fireEvent.keyDown(window, {
        key: key === 'Space' ? ' ' : key.toLowerCase(),
        code,
        shiftKey: parts.includes('Shift'),
      });
      if (tool.id === 'shape-builder') {
        // Shape Builder requires selected paths; the dedicated suite covers X with eligible selection.
        expect(activeTool()).toBe('eraser');
        expect(screen.getByText('You must select some object to use with the Shape Builder tool.')).toBeTruthy();
      } else expect(activeTool(), `${layoutToolCommandId(tool.id)} via ${tool.keybinding}`).toBe(tool.id);
    }
    session.dispose();
    app.dispose();
  });

  it('open Presentation mode through layout.present', () => {
    const { session, app, tab, view } = mount();
    expect(screen.queryByRole('dialog', { name: 'Presentation mode' })).toBeNull();
    act(() => {
      tab.commands.execute('layout.present');
    });
    expect(screen.getByRole('dialog', { name: 'Presentation mode' })).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Presentation mode' })).toBeNull();
    view.unmount();
    expect(tab.commands.isEnabled('layout.present')).toBe(false);
    session.dispose();
    app.dispose();
  });

  it('organizes the ribbon into labeled groups with Transform first', () => {
    const { session, app } = mount();
    const labels = [
      ...document.querySelectorAll(
        '[aria-label="Layout tools"] button',
      ),
    ]
      .map((b) => b.getAttribute('aria-label'))
      .filter((l) => l !== null && !/tools$/.test(l));
    expect(labels.slice(0, 6)).toEqual(['Select', 'Move', 'Rotate', 'Scale', 'Eraser', 'Line']);
    expect([...document.querySelectorAll('.pf-layout-ribbon-group')].map(group => group.getAttribute('aria-label')))
      .toEqual(['Transform', 'Draw', 'Modify', 'Annotate', 'Insert', 'Present']);
    expect(labels.at(-1)).toBe('Presentation mode');
    session.dispose();
    app.dispose();
  });
});
