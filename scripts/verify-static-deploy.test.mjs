// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/* global Response */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { verifyStaticDeploy } from './verify-static-deploy.mjs';

it('detects stale HTML, unavailable assets and incorrect asset bytes after a publish', async () => {
  const dist = await mkdtemp(join(tmpdir(), 'static-deploy-check-'));
  const html = '<script type="module" src="/assets/index-current.js"></script><link href="/assets/index-current.css" rel="stylesheet">';
  try {
    await mkdir(join(dist, 'assets'));
    await writeFile(join(dist, 'index.html'), html);
    await writeFile(join(dist, 'assets/index-current.js'), 'current application');
    await writeFile(join(dist, 'assets/index-current.css'), 'current styles');
    const check = async (liveHtml = html, status = 200, bytes = 'current application') => verifyStaticDeploy('https://example.com', dist, async url => url.pathname === '/' ? new Response(liveHtml) : new Response(url.pathname.endsWith('.css') ? 'current styles' : bytes, { status }));
    expect(await check()).toContain('2 build assets');
    await expect(check(html.replaceAll('current', 'previous'))).rejects.toThrow('does not reference this build');
    await expect(check(html, 404)).rejects.toThrow('HTTP 404');
    await expect(check(html, 200, 'wrong application')).rejects.toThrow('does not match');
  } finally { await rm(dist, { recursive: true, force: true }); }
});
