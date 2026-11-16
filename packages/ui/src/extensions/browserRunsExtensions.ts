// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors

/**
 * Whether this browser can run the isolated extension runtime. WebKit refuses the runtime's workers while the page is
 * cross-origin isolated, as PushForm's is, so Safari is excluded. Kept free of imports so tooling outside the app can
 * check it against the browsers it tests.
 */
export function browserRunsExtensions(userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return !/AppleWebKit/.test(userAgent) || /Chrome\/|Chromium\/|Edg\//.test(userAgent);
}
