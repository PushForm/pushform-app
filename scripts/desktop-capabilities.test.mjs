// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// The desktop window's permission to open links: every web link the app shows (About's license and source links,
// attribution and license links of models, links in chat answers, billing pages) opens in the default browser, and
// nothing but web, mail and phone links can be opened that way.
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { expect, it } from 'vitest';

const capability = JSON.parse(readFileSync(new URL('../apps/desktop/src-tauri/capabilities/default.json', import.meta.url), 'utf8'));
const opener = capability.permissions.filter(p => (typeof p === 'string' ? p : p.identifier).startsWith('opener:'));
const ids = opener.map(p => (typeof p === 'string' ? p : p.identifier));

it('lets the main window open web, mail and phone links in their default applications', () => {
  // The plugin's own set: mailto:, tel:, http:// and https:// URLs, and no other scheme.
  expect(ids).toContain('opener:allow-default-urls');
});

it('grants no broader way to open URLs', () => {
  // A scoped open-url entry would be redundant, and `opener:default` or `allow-open-url` without a scope widen what
  // a page could open (custom schemes, file URLs).
  expect(ids).not.toContain('opener:default');
  expect(ids.filter(id => id === 'opener:allow-open-url')).toEqual([]);
  expect(capability.windows).toEqual(['main']);
});
