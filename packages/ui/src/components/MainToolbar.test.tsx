// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import type { CommandInfo } from '@pushform/commands';
import { AppContext } from '../AppContext';
import { createApp } from '../bootstrap';
import type { AppInstance } from '../bootstrap';
import { MainToolbar } from './MainToolbar';
import { resolveSlots } from './toolbarLayout';

let app: AppInstance | null = null;
afterEach(() => {
  cleanup();
  app?.dispose();
  app = null;
  vi.restoreAllMocks();
});

function boot(): AppInstance {
  app = createApp({ demo: false, expose: false, kernel: new KernelClient(new InlineBackend()) });
  return app;
}

const info = (id: string, title = id): CommandInfo => ({
  id: `tool.${id}`,
  title,
  category: 'tool',
  icon: undefined,
  menu: undefined,
  keybinding: undefined,
  undoable: false,
  enabled: true,
});

describe('resolveSlots', () => {
  it('drops missing tools, demotes one-tool stacks, appends leftovers and collapses separators', () => {
    const slots = resolveSlots(
      [
        { kind: 'tool', id: 'select' },
        { kind: 'sep' },
        { kind: 'stack', title: 'Arc', entries: ['arc2', 'arc3', 'pie'] },
        { kind: 'stack', title: 'Solid', entries: ['solid.union', 'solid.trim'] },
        {
          kind: 'stack',
          title: 'Zoom',
          entries: ['zoom', { command: 'camera.zoomExtents', icon: 'zoom-extents' }],
        },
        { kind: 'sep' },
        { kind: 'sep' },
        { kind: 'tool', id: 'ghost' },
      ],
      [
        info('select'),
        info('arc2'),
        info('arc3'),
        info('solid.union'),
        info('extra', 'Extra'),
        info('texturePosition'),
        info('zoom'),
        { ...info('x'), id: 'texture.positionTool', title: 'Position Texture' },
        { ...info('x'), id: 'camera.zoomExtents', title: 'Zoom Extents', category: 'camera' },
      ],
      (id) => (id === 'tool.select' ? 'Space' : id === 'camera.zoomExtents' ? 'Shift+Z' : null),
    );
    expect(
      slots.map((s) =>
        s.kind === 'sep'
          ? '|'
          : s.kind === 'tool'
            ? s.tool.id
            : `${s.title}[${s.tools.map((t) => t.id).join(',')}]`,
      ),
    ).toEqual([
      'select',
      '|',
      'Arc[arc2,arc3]',
      'solid.union',
      'Zoom[zoom,camera.zoomExtents]',
      '|',
      'extra',
    ]);
    expect(slots[0]).toMatchObject({
      tool: { key: 'Space', icon: 'tool-select', commandId: 'tool.select' },
    });
    expect(slots[4]).toMatchObject({
      tools: [
        { commandId: 'tool.zoom' },
        { commandId: 'camera.zoomExtents', icon: 'zoom-extents', key: 'Shift+Z' },
      ],
    });
  });
});

describe('MainToolbar', () => {
  it('uses icon buttons and tooltips for file and Commons import without changing their actions', () => {
    const a = boot(), onCommons = vi.fn();
    const execute = vi.spyOn(a.commands, 'tryExecute');
    render(<AppContext.Provider value={a}><MainToolbar onCommons={onCommons}/></AppContext.Provider>);
    const group = within(screen.getByRole('group', { name: 'Import' }));
    const file = group.getByRole('button', { name: 'From file' });
    const commons = group.getByRole('button', { name: 'Commons' });
    expect(file.querySelector('svg')).toBeTruthy();
    expect(commons.querySelector('svg')).toBeTruthy();
    fireEvent.mouseEnter(file);
    expect(screen.getByRole('tooltip').textContent).toBe('From file');
    fireEvent.mouseLeave(file);
    fireEvent.click(file);
    expect(execute).toHaveBeenCalledWith('file.import');
    fireEvent.click(commons);
    expect(onCommons).toHaveBeenCalledOnce();
  });
  it('shows stacked slots whose face follows the active tool, and activates tools through commands', () => {
    const a = boot();
    render(
      <AppContext.Provider value={a}>
        <MainToolbar />
      </AppContext.Provider>,
    );
    expect(screen.getAllByRole('group').map((group) => group.getAttribute('aria-label'))).toEqual([
      'Transform',
      'Draw',
      'Modify',
      'Inspect',
      'Organize',
      'Navigate',
    ]);
    expect(
      screen
        .getByRole('group', { name: 'Transform' })
        .contains(screen.getByRole('button', { name: 'Move' })),
    ).toBe(true);
    expect(
      screen
        .getByRole('group', { name: 'Modify' })
        .contains(screen.getByRole('button', { name: /^Push\/Pull/ })),
    ).toBe(true);
    expect(
      screen.getByRole('group', { name: 'Inspect' })
        .contains(screen.getByRole('button', { name: 'Section Plane' })),
    ).toBe(true);
    // stacked tools are not individual toolbar buttons
    const names = () => screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(names()).not.toContain('Freehand');
    expect(names()).not.toContain('Position Texture');
    expect(names()).toContain('Line');
    const draw = within(screen.getByRole('group', { name: 'Draw' }));
    fireEvent.click(draw.getByRole('button', { name: 'Text' }));
    expect(a.toolManager.activeToolId).toBe('text');
    fireEvent.click(draw.getByRole('button', { name: 'Text tools' }));
    expect(screen.getAllByRole('menuitemradio').map(item => item.getAttribute('aria-label'))).toEqual([
      'Text', '3D Text',
    ]);
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Text' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Inspect' })).getByRole('button', { name: 'Measure tools' }));
    expect(screen.getAllByRole('menuitemradio').map(item => item.getAttribute('aria-label'))).toEqual([
      'Tape Measure', 'Dimension', 'Protractor', 'Axes',
    ]);
    fireEvent.keyDown(screen.getByRole('menuitemradio', { name: 'Dimension' }), { key: 'Escape' });
    // picking from the flyout activates the tool and the face follows
    fireEvent.click(screen.getByRole('button', { name: 'Line tools' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Freehand' }));
    expect(a.toolManager.activeToolId).toBe('freehand');
    expect(screen.getByRole('button', { name: 'Freehand' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    // a keyboard shortcut elsewhere moves the face too
    act(() => {
      a.commands.execute('tool.circle');
    });
    expect(screen.getByRole('button', { name: 'Circle' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: 'Freehand' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
    // single buttons still work
    fireEvent.click(screen.getByRole('button', { name: /^Push\/Pull/ }));
    expect(a.toolManager.activeToolId).toBe('pushpull');
    // a one-shot command in a stack runs without becoming the active tool
    expect(names()).not.toContain('Zoom Extents');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom tools' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Zoom Extents' }));
    expect(a.toolManager.activeToolId).toBe('pushpull');
    expect(screen.getByRole('button', { name: 'Zoom Extents' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });
});
