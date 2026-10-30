// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { componentPlacement, SERVICE_FONTS } from '@pushform/commands';
import type { FontSource } from '@pushform/commands';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import { AppContext } from '../AppContext';
import { createApp } from '../bootstrap';
import type { AppInstance } from '../bootstrap';
import { installUiCommands } from '../engine/uiCommands';
import { useAppStore } from '../store';
import { TOOLBAR_LAYOUT } from './toolbarLayout';
import { DialogHost } from './MakeComponentDialog';

const require = createRequire(import.meta.url);
/** Roboto from disk for every family (jsdom cannot fetch the bundled asset URLs). */
const diskFonts: FontSource = {
  load: (_font, bold) =>
    Promise.resolve(['latin', 'latin-ext'].map((subset) => {
      const b = readFileSync(require.resolve(`@fontsource/roboto/files/roboto-${subset}-${bold ? 700 : 400}-normal.woff`));
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    })),
};

let app: AppInstance | null = null;
afterEach(() => {
  cleanup();
  app?.dispose();
  app = null;
  useAppStore.getState().closeDialog();
  componentPlacement.current = null;
});

function boot(): AppInstance {
  const a = createApp({ demo: false, expose: false, kernel: new KernelClient(new InlineBackend()) });
  a.commands.ctx.services.set(SERVICE_FONTS, diskFonts);
  installUiCommands(a.commands);
  app = a;
  render(
    <AppContext.Provider value={a}>
      <DialogHost />
    </AppContext.Provider>,
  );
  return a;
}

describe('Text3DDialog', () => {
  it('sits in the Measure stack after Text', () => {
    const measure = TOOLBAR_LAYOUT.find((s) => s.kind === 'stack' && s.title === 'Measure');
    expect(measure && measure.kind === 'stack' ? measure.entries : []).toContainEqual({ command: 'ui.text3d', icon: 'tool-text3d' });
  });

  it('opens from ui.text3d, creates the component and hands it to the Place Component tool', async () => {
    const a = boot();
    act(() => void a.commands.execute('ui.text3d'));
    screen.getByRole('dialog', { name: 'Place 3D Text' });
    // first-use lengths in an inch model: 1' high, 1" deep
    expect((screen.getByLabelText('Height') as HTMLInputElement).value).toBe(`1'`);
    expect((screen.getByLabelText('Depth') as HTMLInputElement).value).toBe(`1"`);
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'Hello' } });
    fireEvent.change(screen.getByLabelText('Weight'), { target: { value: 'bold' } });
    fireEvent.change(screen.getByLabelText('Height'), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Place' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const state = a.document.doc.state;
    const def = [...state.definitions.values()].find((d) => d.name === 'Hello')!;
    expect(def.entities.bodies.size).toBeGreaterThan(0);
    expect(componentPlacement.current).toBe(def.id);
    expect(a.toolManager.activeToolId).toBe('placeComponent');
  });

  it('turns Extruded off with Filled and refuses an empty text', () => {
    const a = boot();
    act(() => void a.commands.execute('ui.text3d'));
    fireEvent.click(screen.getByLabelText('Filled'));
    expect((screen.getByLabelText('Extruded') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Depth') as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: '  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Place' }));
    expect(screen.getByRole('alert').textContent).toBe('Enter some text.');
  });
});
