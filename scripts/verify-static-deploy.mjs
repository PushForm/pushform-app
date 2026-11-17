// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/* global console, process, fetch, AbortSignal */
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { URL, pathToFileURL } from 'node:url';

/** Verify the live HTML references this build and its hashed JS/CSS bytes are actually available. Vite builds put them in /assets, Astro builds in /_astro. */
export async function verifyStaticDeploy(origin, dist, fetcher = fetch) {
  const base = new URL(origin);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname))) throw new Error('Use HTTPS or a local development origin.');
  const html = await readFile(resolve(dist, 'index.html'), 'utf8');
  const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/(?:assets|_astro)\/[a-zA-Z0-9_.-]+\.(?:js|css))"/g)].map(match => match[1]))];
  if (!assets.some(asset => asset.endsWith('.js'))) throw new Error('The local build has no hashed JavaScript entry.');
  const request = async path => {
    const response = await fetcher(new URL(path, base), { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Published ${path} returned HTTP ${response.status}.`);
    return response;
  };
  const live = await (await request('/?deployment-check=' + Date.now())).text();
  for (const asset of assets) {
    if (!live.includes(`"${asset}"`)) throw new Error(`The live page does not reference this build's ${asset}.`);
    const expected = await readFile(resolve(dist, '.' + asset));
    const actual = Buffer.from(await (await request(asset)).arrayBuffer());
    const sha = bytes => createHash('sha256').update(bytes).digest('hex');
    if (sha(expected) !== sha(actual)) throw new Error(`Published ${asset} does not match the built file.`);
  }
  return `Verified live HTML and ${assets.length} build assets.`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , origin, dist] = process.argv;
  if (!origin || !dist) { console.error('Usage: node scripts/verify-static-deploy.mjs <origin> <dist>'); process.exit(1); }
  try { console.log(await verifyStaticDeploy(origin, dist)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
