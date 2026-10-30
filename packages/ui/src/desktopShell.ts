// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

/**
 * The native title bar's color. The desktop window's title bar is transparent, so the
 * window background shows through it; keeping that background equal to the app's header surface
 * makes the title bar follow PushForm's light or dark theme instead of the system window gray.
 */
export function desktopTitleBarColor(dark: boolean): string {
  return dark ? '#24282e' : '#ffffff';
}

const colorScheme = (): MediaQueryList | null =>
  typeof window === 'undefined' || !window.matchMedia ? null : window.matchMedia('(prefers-color-scheme: dark)');

/** Keep the desktop window background in step with the theme; a no-op in the browser. Returns the unsubscribe function. */
export function syncDesktopTitleBar(
  apply: (color: string) => Promise<void> = color => getCurrentWindow().setBackgroundColor(color),
  query: MediaQueryList | null = colorScheme(),
  desktop: boolean = isTauri(),
): () => void {
  if (!desktop || !query) return () => {};
  const update = (): void => { void apply(desktopTitleBarColor(query.matches)).catch(() => {}); };
  update();
  query.addEventListener('change', update);
  return () => query.removeEventListener('change', update);
}
