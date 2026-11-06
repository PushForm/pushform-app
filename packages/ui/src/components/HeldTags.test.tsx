// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import { AppContext } from '../AppContext';
import { createApp } from '../bootstrap';
import type { AppInstance } from '../bootstrap';
import { HeldTags } from './HeldTags';

let app: AppInstance | null = null;
afterEach(() => {
  cleanup();
  app?.dispose();
  app = null;
});

it('shows the tags the tool reports below the pointer, never above the band', () => {
  const a = (app = createApp({ demo: false, expose: false, kernel: new KernelClient(new InlineBackend()) }));
  const pointer = { current: [200, 10] as const };
  const band = { current: 42 };
  render(<AppContext.Provider value={a}><HeldTags pointer={pointer} minTop={band} /></AppContext.Provider>);
  expect(screen.queryByLabelText('Held keys')).toBeNull();
  act(() => a.toolManager.activate('line'));
  const alt = { key: 'Alt', code: 'AltLeft', modifiers: { shift: false, ctrl: false, alt: true, meta: false }, repeat: false };
  act(() => {
    a.toolManager.keyDown(alt);
    a.toolManager.keyUp(alt);
  });
  const tags = screen.getByLabelText('Held keys');
  expect(tags.textContent).toBe('Inference off · Alt');
  expect(tags.style.left).toBe('214px');
  // the pointer's 10 px + 46 would be 56; never above the band's 42 px either way
  expect(parseFloat(tags.style.top)).toBeGreaterThanOrEqual(42);
});
