// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { isTauri } from '@tauri-apps/api/core';

/** The third-party notices in the built web app, served beside index.html. */
export const THIRD_PARTY_NOTICES_URL = '/third-party-notices.txt';

/** The same notices as a file that desktop installers place in the app's resource directory. */
export const DESKTOP_NOTICES_RESOURCE = 'THIRD_PARTY_NOTICES.txt';

/** Opens the bundled notices file with the system's viewer for text files. */
async function openDesktopNotices(): Promise<void> {
  const { resolveResource } = await import('@tauri-apps/api/path');
  const { openPath } = await import('@tauri-apps/plugin-opener');
  await openPath(await resolveResource(DESKTOP_NOTICES_RESOURCE));
}

/**
 * Click handling for the About dialog's Third-party notices link. In the browser the link opens
 * the notices in a new tab by itself. On the desktop the click opens the notices file installed with the app instead,
 * and reports false when it cannot (a development build has no installed file).
 */
export function openThirdPartyNotices(
  event: { preventDefault(): void },
  desktop: boolean = isTauri(),
  open: () => Promise<void> = openDesktopNotices,
): Promise<boolean> {
  if (!desktop) return Promise.resolve(true);
  event.preventDefault();
  return open().then(() => true, () => false);
}
