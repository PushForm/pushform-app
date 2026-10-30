// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cloudConfigProblems } from './check-cloud-config.mjs';

const env = { VITE_SUPABASE_URL: 'https://abc.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x1' };
const dirs = [];
const dist = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-dist-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('check-cloud-config', () => {
  it('passes a valid configuration and a build that names the project', () => {
    expect(cloudConfigProblems(env)).toEqual([]);
    expect(cloudConfigProblems(env, [dist({ 'index.html': '<div id="root">', 'assets/index-a.js': 'const u="https://abc.supabase.co";' })])).toEqual([]);
  });

  it('fails an empty or secret-shaped variable before any build', () => {
    expect(cloudConfigProblems({})).toEqual(['cloud configuration: VITE_SUPABASE_URL is not set.']);
    expect(cloudConfigProblems({ ...env, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_abc' }))
      .toEqual(['cloud configuration: Cloud configuration requires a public publishable or anon key.']);
  });

  it('fails a build that carries a server credential or does not name the project', () => {
    const leaked = dist({ 'assets/index-a.js': 'const u="https://abc.supabase.co",k="sb_secret_abc";' });
    expect(cloudConfigProblems(env, [leaked])).toEqual([`${join(leaked, 'assets', 'index-a.js')}: contains 1 Supabase secret key (sb_secret_…)`]);
    const other = dist({ 'assets/index-a.js': 'const u="https://other.supabase.co";' });
    expect(cloudConfigProblems(env, [other])).toEqual([`${other}: no built file names the Supabase project https://abc.supabase.co`]);
  });
});
