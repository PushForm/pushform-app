// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import type { EntityRef } from '@pushform/model';
import { AppContext } from '../AppContext';
import { createApp } from '../bootstrap';
import type { AppInstance } from '../bootstrap';
import { installUiCommands } from '../engine/uiCommands';
import { useAppStore } from '../store';
import { DialogHost } from './MakeComponentDialog';

let app: AppInstance | null = null;
afterEach(() => {
  cleanup();
  app?.dispose();
  app = null;
  useAppStore.getState().closeDialog();
});

function boot(): AppInstance {
  const a = createApp({ demo: false, expose: false, kernel: new KernelClient(new InlineBackend()) });
  installUiCommands(a.commands);
  app = a;
  render(
    <AppContext.Provider value={a}>
      <DialogHost />
    </AppContext.Provider>,
  );
  return a;
}

const textOf = (a: AppInstance, ref: EntityRef) => a.document.doc.rootDefinition.entities.texts.get(ref.id)?.text;

describe('TextEditor', () => {
  it('edits a text in place: Enter keeps the edit, Shift+Enter is a new line', () => {
    const a = boot();
    const ref = a.commands.execute('text.add', { kind: 'screen', screen: [0.1, 0.1], text: 'Enter text' }) as EntityRef;
    act(() => void a.commands.execute('ui.editText', { ref }));
    const box = screen.getByLabelText('Edit text') as HTMLTextAreaElement;
    expect(box.value).toBe('Enter text');
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: 'Site plan' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(screen.queryByLabelText('Edit text')).not.toBeNull();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(screen.queryByLabelText('Edit text')).toBeNull();
    expect(textOf(a, ref)).toBe('Site plan');
  });

  it('Escape keeps the text as it was; text edited to nothing is erased', () => {
    const a = boot();
    const ref = a.commands.execute('text.add', { kind: 'leader', anchor: [0, 0, 0], label: [1, 1, 0], text: 'Note' }) as EntityRef;
    act(() => void a.commands.execute('ui.editText', { ref }));
    const box = screen.getByLabelText('Edit text') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'Changed' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(textOf(a, ref)).toBe('Note');
    act(() => void a.commands.execute('ui.editText', { ref }));
    const again = screen.getByLabelText('Edit text') as HTMLTextAreaElement;
    fireEvent.change(again, { target: { value: '' } });
    fireEvent.blur(again);
    expect(textOf(a, ref)).toBeUndefined();
  });
});
