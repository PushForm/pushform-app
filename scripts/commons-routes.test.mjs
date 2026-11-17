// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('routes every Pages function to the worker rather than the static site fallback', () => {
  const routes = JSON.parse(readFileSync(resolve('apps/commons/public/_routes.json'), 'utf8'));
  const functions = readdirSync(resolve('apps/commons/functions'), {
    recursive: true,
  });
  const matches = (pattern, path) =>
    new RegExp(
      '^' +
        pattern
          .split('*')
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('.*') +
        '$',
    ).test(path);
  for (const file of functions.filter((file) => file.endsWith('.ts'))) {
    const route =
      '/' +
      file
        .replaceAll('\\', '/')
        .replace(/\.ts$/, '')
        .replace(/\[[^/]+\]/g, 'example');
    const path = route.replace(/\/index$/, '') || '/';
    expect(
      routes.include.some((pattern) => matches(pattern, path)),
      `Unreachable Pages function: ${file}`,
    ).toBe(true);
    expect(
      routes.exclude.some((pattern) => matches(pattern, path)),
      `Excluded Pages function: ${file}`,
    ).toBe(false);
  }
});
