// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';

it('routes every Pages function to the worker rather than the static site fallback', () => {
  const routes = JSON.parse(
    readFileSync(new URL('../../public/_routes.json', import.meta.url), 'utf8'),
  ) as { include: string[]; exclude: string[] };
  const functions = readdirSync(new URL('../../functions/', import.meta.url), {
    recursive: true,
  }) as string[];
  const matches = (pattern: string, path: string) =>
    new RegExp(
      '^' +
        pattern
          .split('*')
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('.*') +
        '$',
    ).test(path);
  for (const file of functions.filter((file) => file.endsWith('.ts'))) {
    const path =
      '/' +
        file
          .replaceAll('\\', '/')
          .replace(/\.ts$/, '')
          .replace(/\[[^/]+\]/g, 'example')
          .replace(/\/index$/, '') || '/';
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
