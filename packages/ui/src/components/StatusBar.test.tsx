// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import { AppContext } from '../AppContext';
import { createApp } from '../bootstrap';
import type { AppInstance } from '../bootstrap';
import { StatusBar } from './StatusBar';

let app: AppInstance | null = null;
afterEach(() => {
  cleanup();
  app?.dispose();
  app = null;
});

it('shows no tool settings: they are in the tool options bar', () => {
  const a = (app = createApp({ demo: false, expose: false, kernel: new KernelClient(new InlineBackend()) }));
  render(<AppContext.Provider value={a}><StatusBar /></AppContext.Provider>);
  act(() => a.toolManager.activate('profile'));
  expect(screen.queryByLabelText('Profile')).toBeNull();
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.getByRole('status').textContent).toMatch(/round/);
});
