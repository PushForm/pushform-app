// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import { AppContext } from '../AppContext';
import { createApp } from '../bootstrap';
import type { AppInstance } from '../bootstrap';
import { installUiCommands } from '../engine/uiCommands';
import { useAppStore } from '../store';
import { addInstance, stubInstanceCommands } from '../panels/instances.testutil';
import { componentAxesPick } from '@pushform/commands';
import { DialogHost } from './MakeComponentDialog';

let app: AppInstance | null = null;
afterEach(() => {
  cleanup();
  app?.dispose();
  app = null;
  useAppStore.getState().closeDialog();
});

function boot(log: string[]): AppInstance {
  const a = createApp({ demo: false, expose: false, kernel: new KernelClient(new InlineBackend()) });
  stubInstanceCommands(a, log);
  installUiCommands(a.commands);
  app = a;
  return a;
}

const mount = (a: AppInstance) =>
  render(
    <AppContext.Provider value={a}>
      <DialogHost />
    </AppContext.Provider>,
  );

describe('MakeComponentDialog', () => {
  it('opens from ui.makeComponent (G) with a selection and submits component.make with the fields', () => {
    const log: string[] = [];
    const a = boot(log);
    mount(a);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(a.commands.isEnabled('ui.makeComponent')).toBe(false); // nothing selected
    const bodyId = a.commands.execute('model.addBox') as number;
    act(() => a.document.selection.set([{ kind: 'body', path: [], id: bodyId as never }]));
    expect(a.keymap.resolve({ key: 'g', code: 'KeyG', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false })).toBe('ui.makeComponent');
    expect(a.keymap.resolve({ key: 'g', code: 'KeyG', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false })).toBe('group.make');
    act(() => void a.commands.execute('ui.makeComponent'));
    const dialog = screen.getByRole('dialog', { name: 'Create Component' });
    expect(dialog).toBeTruthy();
    const name = screen.getByLabelText('Name') as HTMLInputElement;
    expect(name.value).toBe('Component#1');
    fireEvent.change(name, { target: { value: 'Window' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'A window' } });
    fireEvent.change(screen.getByLabelText('Glue to'), { target: { value: 'vertical' } });
    fireEvent.click(screen.getByLabelText('Cut opening'));
    // Shadows face sun is offered only with Always face camera, which brings it along
    const sun = screen.getByLabelText('Shadows face sun') as HTMLInputElement;
    expect(sun.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Always face camera'));
    expect(sun.disabled).toBe(false);
    expect(sun.checked).toBe(true);
    expect((screen.getByLabelText('Replace selection with component') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByText('Create'));
    expect(log).toEqual([
      'component.make ' +
        JSON.stringify({ name: 'Window', description: 'A window', glueTo: 'vertical', cutOpening: true, alwaysFaceCamera: true, shadowsFaceSun: true, replaceSelection: true }),
    ]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Set Component Axes hides the dialog while the axes are picked and makes the component with them', () => {
    const log: string[] = [];
    const a = boot(log);
    mount(a);
    act(() => useAppStore.getState().openDialog('makeComponent'));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Shelf' } });
    fireEvent.click(screen.getByText('Set Component Axes'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(a.toolManager.activeToolId).toBe('componentAxes');
    // Escape while picking brings the dialog back unchanged
    act(() => a.commands.execute('tool.cancel'));
    expect(a.toolManager.activeToolId).toBe('select');
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Shelf');
    expect(screen.queryByText('Custom axes set')).toBeNull();
    fireEvent.click(screen.getByText('Set Component Axes'));
    act(() => componentAxesPick.request!.onPicked({ origin: [1, 2, 3], x: [0, 1, 0], y: [-1, 0, 0], z: [0, 0, 1] }));
    expect(screen.getByText('Custom axes set')).toBeTruthy();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Shelf');
    fireEvent.click(screen.getByText('Create'));
    expect(log).toEqual([
      'component.make ' +
        JSON.stringify({ name: 'Shelf', description: '', glueTo: 'none', cutOpening: false, alwaysFaceCamera: false, shadowsFaceSun: false, replaceSelection: true,
          axesOrigin: [1, 2, 3], axesX: [0, 1, 0], axesY: [-1, 0, 0], axesZ: [0, 0, 1] }),
    ]);
  });

  it('Cancel and Esc close without running; a failing command keeps the dialog open with the error', () => {
    const log: string[] = [];
    const a = boot(log);
    mount(a);
    act(() => useAppStore.getState().openDialog('makeComponent'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => useAppStore.getState().openDialog('makeComponent'));
    fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(log).toEqual([]);

  });

  it('a failing component.make keeps the dialog open and shows the error', () => {
    const a = createApp({ demo: false, expose: false, kernel: new KernelClient(new InlineBackend()) });
    app = a;
    a.commands.replace({
      id: 'component.make',
      title: 'Make Component',
      category: 'edit',
      params: z.object({ name: z.string() }).loose(),
      undoable: false,
      run: () => {
        throw new Error('Select at least one entity');
      },
    });
    installUiCommands(a.commands);
    mount(a);
    act(() => useAppStore.getState().openDialog('makeComponent'));
    fireEvent.click(screen.getByText('Create'));
    expect(screen.getByRole('alert').textContent).toBe('Select at least one entity');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('RenameInstanceDialog opens from ui.renameInstance and submits instance.rename', () => {
    const log: string[] = [];
    const a = boot(log);
    const id = addInstance(a, { name: 'House' });
    mount(a);
    act(() => void a.commands.execute('ui.renameInstance', { ref: { kind: 'instance', path: [], id } }));
    expect(screen.getByRole('dialog', { name: 'Rename' })).toBeTruthy();
    const name = screen.getByLabelText('Name') as HTMLInputElement;
    expect(name.value).toBe('House');
    fireEvent.change(name, { target: { value: 'Villa' } });
    fireEvent.submit(name.closest('form')!);
    expect(log).toEqual(['rename Villa']);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
