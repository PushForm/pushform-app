// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors

/** Public profiles live at `/u/<handle>`; every other Commons page is a hash route on `/`. */
const handlePattern = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
export const profilePath = (handle: string): string => `/u/${handle}`;
export function profileHandleFromPath(path: string): string | null {
  const handle = /^\/u\/([^/]+)\/?$/.exec(path)?.[1];
  return handle !== undefined && handlePattern.test(handle) ? handle : null;
}
export interface CommonsLocation { path: string; hash: string }
/** Reads the current route. A hash route opened from a profile path moves back to `/` so `#models/…` keeps one meaning. */
export function currentCommonsLocation(): CommonsLocation {
  const { pathname, hash } = window.location;
  if (pathname !== '/' && hash && hash !== '#main') {
    window.history.replaceState(window.history.state, '', '/' + hash);
    return { path: '/', hash };
  }
  return { path: pathname, hash };
}
/** Changes the path without reloading; the app listens for `popstate`. */
export function navigateCommons(path: string, replace = false): void {
  if (replace) window.history.replaceState(window.history.state, '', path);
  else window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
