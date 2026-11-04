// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import { AppContext } from '../AppContext';
import { createApp } from '../bootstrap';
import type { AppInstance } from '../bootstrap';
import { useAppStore } from '../store';
import { StatusBar } from './StatusBar';

let app: AppInstance | null = null;
afterEach(() => {
  cleanup();
  app?.dispose();
  app = null;
});

it('shows the Profile Edges tool\'s profile pick list beside its status and sets the profile from it', () => {
  const a = (app = createApp({ demo: false, expose: false, kernel: new KernelClient(new InlineBackend()) }));
  render(<AppContext.Provider value={a}><StatusBar /></AppContext.Provider>);
  expect(screen.queryByLabelText('Profile')).toBeNull();
  act(() => a.toolManager.activate('profile'));
  const select = screen.getByLabelText<HTMLSelectElement>('Profile');
  expect([...select.options].map((o) => o.textContent)).toEqual(['Roundover', 'Cove', 'Ogee', 'Bead', 'Chamfer', 'Step']);
  expect(select.value).toBe('roundover');
  act(() => { fireEvent.change(select, { target: { value: 'cove' } }); });
  expect(useAppStore.getState().toolChoices[0]!.value).toBe('cove');
  expect(screen.getByRole('status').textContent).toMatch(/cove/);
  act(() => a.toolManager.activate('fillet'));
  expect(screen.queryByLabelText('Profile')).toBeNull();
});
