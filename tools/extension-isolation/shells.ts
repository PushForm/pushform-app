// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors

/**
 * Every shell PushForm runs in, and whether its extension runtime is covered by this suite. A shell is `included`
 * only when the whole attack suite runs and passes in it. Anything else is `excluded` with the reason, never waived:
 * an excluded shell must not offer extensions until it is included. The Playwright projects are generated from this
 * table (playwright.config.ts), and README.md shows it.
 */
export type ShellStatus = 'included' | 'excluded';

export interface Shell {
  readonly id: string;
  readonly shell: string;
  readonly engine: string;
  readonly status: ShellStatus;
  readonly reason: string;
  /** The Playwright project running the full suite (included shells) or the fail-closed check (excluded browsers). */
  readonly project?: { readonly browser: 'chromium' | 'webkit' | 'firefox'; readonly editor: 'hosted' | 'enforced'; readonly suite: 'full' | 'fails-closed' };
}

export const SHELLS: readonly Shell[] = [
  {
    id: 'web-chromium', shell: 'Hosted web', engine: 'Chromium (Chrome, Edge)', status: 'included',
    reason: 'The full suite runs under the deployed response headers, with the editor policy report-only as the hosted app sends it today.',
    project: { browser: 'chromium', editor: 'hosted', suite: 'full' },
  },
  {
    id: 'web-chromium-enforced', shell: 'Hosted web, editor policy enforced', engine: 'Chromium', status: 'included',
    reason: 'The same suite with the editor policy enforced, as the hosted app will send it once its reports are clean.',
    project: { browser: 'chromium', editor: 'enforced', suite: 'full' },
  },
  {
    id: 'web-firefox', shell: 'Hosted web', engine: 'Firefox (Gecko)', status: 'included',
    reason: 'The full suite runs and passes under the deployed headers, with the editor policy report-only.',
    project: { browser: 'firefox', editor: 'hosted', suite: 'full' },
  },
  {
    id: 'web-firefox-enforced', shell: 'Hosted web, editor policy enforced', engine: 'Firefox', status: 'included',
    reason: 'The same suite with the editor policy enforced.',
    project: { browser: 'firefox', editor: 'enforced', suite: 'full' },
  },
  {
    id: 'web-webkit', shell: 'Hosted web', engine: 'WebKit (Safari)', status: 'excluded',
    reason: 'Under the editor\'s cross-origin isolation, WebKit refuses to start a worker from the runtime frame\'s opaque blob: URL. The runtime reports that it is unsupported and starts nothing; the fail-closed check proves it.',
    project: { browser: 'webkit', editor: 'hosted', suite: 'fails-closed' },
  },
  {
    id: 'offline-web', shell: 'Installed offline web', engine: 'Any', status: 'excluded',
    reason: 'There is no installed offline web build yet (no service worker or offline bundle). When one exists it must run this suite under its own headers before it offers extensions.',
  },
  {
    id: 'desktop-macos', shell: 'Desktop (Tauri) macOS', engine: 'WKWebView', status: 'excluded',
    reason: 'The desktop extension runtime is not built; the desktop shell does not start extensions. Its runtime needs its own origin and policy, and this suite has to run against it.',
  },
  {
    id: 'desktop-windows', shell: 'Desktop (Tauri) Windows', engine: 'WebView2', status: 'excluded',
    reason: 'As for macOS: the desktop extension runtime is not built and the desktop shell does not start extensions.',
  },
  {
    id: 'desktop-linux', shell: 'Desktop (Tauri) Linux', engine: 'WebKitGTK', status: 'excluded',
    reason: 'As for macOS: the desktop extension runtime is not built and the desktop shell does not start extensions.',
  },
];

/** The Playwright project name of a shell. */
export const projectName = (shell: Shell): string => shell.id;
