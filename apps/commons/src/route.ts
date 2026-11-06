// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { browseSearchPath, modelPath } from './seo';

export { browseSearchPath, modelPath };
/** Models live at `/models/<id>` and public profiles at `/u/<handle>`, so search engines can index each page. Account,
 * collection and publishing screens remain hash routes on `/`. Older `#models/<id>` links still work and move to the path. */
const handlePattern = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
const modelIdPattern = /^[a-z0-9][a-z0-9-]{0,95}$/;
export const profilePath = (handle: string): string => `/u/${handle}`;
export function profileHandleFromPath(path: string): string | null {
  const handle = /^\/u\/([^/]+)\/?$/.exec(path)?.[1];
  return handle !== undefined && handlePattern.test(handle) ? handle : null;
}
export function modelIdFromPath(path: string): string | null {
  const id = /^\/models\/([^/]+)\/?$/.exec(path)?.[1];
  return id !== undefined && modelIdPattern.test(id) ? id : null;
}
export interface CommonsLocation { path: string; hash: string }
/** Reads the current route. An old `#models/<id>` link moves to its path, and any other hash route opened from a model
 * or profile path moves back to `/` so each hash keeps one meaning. */
export function currentCommonsLocation(): CommonsLocation {
  const { pathname, hash } = window.location;
  const legacyModel = /^#models\/([^/]+)$/.exec(hash)?.[1];
  if (legacyModel !== undefined && modelIdPattern.test(legacyModel)) {
    window.history.replaceState(window.history.state, '', modelPath(legacyModel));
    return { path: modelPath(legacyModel), hash: '' };
  }
  if (pathname !== '/' && hash && hash !== '#main') {
    window.history.replaceState(window.history.state, '', '/' + hash);
    return { path: '/', hash };
  }
  return { path: pathname, hash };
}
/** The search a `browseSearchPath` link carries, or null when the address has none. */
export function browseSearchFromUrl(): string | null {
  if (window.location.pathname !== '/') return null;
  const query = new URLSearchParams(window.location.search).get('q');
  return query === null ? null : query.trim().slice(0, 200);
}
/** Removes a carried search from the address once the search box holds it, so later edits and Back behave as usual. */
export function clearBrowseSearch(): void {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('q')) return;
  params.delete('q');
  const rest = params.toString();
  window.history.replaceState(window.history.state, '', window.location.pathname + (rest ? `?${rest}` : '') + window.location.hash);
}
/** Changes the path without reloading; the app listens for `popstate`. */
export function navigateCommons(path: string, replace = false): void {
  if (replace) window.history.replaceState(window.history.state, '', path);
  else window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
/** Opens an in-app path without a reload, keeping the browser's own handling for modified clicks. */
export function openInApp(event: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; preventDefault(): void }, path: string): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigateCommons(path);
}

/** Upload and edit routes open the contributor dialog. */
export type PublishRoute = { kind: 'upload' } | { kind: 'edit'; model: string };
export function publishRoute(hash: string): PublishRoute | null {
  if (hash === '#upload' || hash === '#publish') return { kind: 'upload' };
  const edit = /^#edit\/([a-z0-9][a-z0-9-]{0,95})$/.exec(hash);
  return edit ? { kind: 'edit', model: edit[1]! } : null;
}
