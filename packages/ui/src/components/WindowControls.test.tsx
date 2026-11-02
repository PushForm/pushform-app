// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

const win = vi.hoisted(() => ({
  minimize: vi.fn(async () => {}),
  toggleMaximize: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
}));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => win }));

import { WindowControls } from './WindowControls';

it('minimizes, maximizes and closes the frameless desktop window', () => {
  render(<WindowControls platform="other" />);
  const group = screen.getByRole('group', { name: 'Window' });
  expect(group.classList.contains('pf-window-controls')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Minimize window' }));
  fireEvent.click(screen.getByRole('button', { name: 'Maximize window' }));
  fireEvent.click(screen.getByRole('button', { name: 'Close window' }));
  expect(win.minimize).toHaveBeenCalledTimes(1);
  expect(win.toggleMaximize).toHaveBeenCalledTimes(1);
  expect(win.close).toHaveBeenCalledTimes(1);
});

it('draws nothing on macOS or in the browser', () => {
  const { container, rerender } = render(<WindowControls platform="mac" />);
  expect(container.firstChild).toBeNull();
  rerender(<WindowControls platform={null} />);
  expect(container.firstChild).toBeNull();
});
