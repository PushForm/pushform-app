// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

/**
 * The window background color. The top bar doubles as the title bar, so the window background
 * shows through any strip around it; keeping that background equal to the app's header surface
 * makes the window follow PushForm's light or dark theme instead of the system window gray.
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

export type DesktopPlatform = 'mac' | 'other';

/** The desktop shell flavor, or null in the browser. macOS keeps native window controls over the top bar; other platforms draw their own. */
export function desktopPlatform(
  desktop: boolean = isTauri(),
  agent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent,
): DesktopPlatform | null {
  if (!desktop) return null;
  return /Mac/i.test(agent) ? 'mac' : 'other';
}

/** Tag the document so the top bar can reserve room for the window controls and act as the drag region. Returns the cleanup function. */
export function markDesktopShell(platform: DesktopPlatform | null = desktopPlatform(), root: HTMLElement = document.documentElement): () => void {
  if (!platform) return () => {};
  root.dataset.desktopShell = platform;
  return () => { delete root.dataset.desktopShell; };
}
