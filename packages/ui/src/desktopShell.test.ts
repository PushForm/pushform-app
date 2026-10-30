// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it, vi } from 'vitest';
import { desktopTitleBarColor, syncDesktopTitleBar } from './desktopShell';

/** A media query stub whose `matches` flips when `set` is called, notifying change listeners. */
function scheme(dark: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: dark,
    addEventListener: (_: 'change', fn: () => void) => { listeners.add(fn); },
    removeEventListener: (_: 'change', fn: () => void) => { listeners.delete(fn); },
    set(next: boolean) { query.matches = next; for (const fn of listeners) fn(); },
    listeners,
  };
  return query;
}

it('paints the title bar in the header surface color for the current theme and follows theme changes', () => {
  expect(desktopTitleBarColor(false)).toBe('#ffffff');
  expect(desktopTitleBarColor(true)).toBe('#24282e');
  const apply = vi.fn(async () => {});
  const query = scheme(true);
  const stop = syncDesktopTitleBar(apply, query as unknown as MediaQueryList, true);
  expect(apply).toHaveBeenCalledWith('#24282e');
  query.set(false);
  expect(apply).toHaveBeenLastCalledWith('#ffffff');
  stop();
  expect(query.listeners.size).toBe(0);
  query.set(true);
  expect(apply).toHaveBeenCalledTimes(2);
});

it('does nothing in the browser', () => {
  const apply = vi.fn(async () => {});
  const query = scheme(true);
  syncDesktopTitleBar(apply, query as unknown as MediaQueryList, false);
  expect(apply).not.toHaveBeenCalled();
  expect(query.listeners.size).toBe(0);
});
