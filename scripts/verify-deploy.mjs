// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/* global console, process, fetch, URL */
// Checks a deployed PushForm origin:
//   node scripts/verify-deploy.mjs https://app.pushform.io
// Exits 1 on any failure. Compression is only required when --strict is passed (local servers skip it).
// --strict also checks the cloud configuration the bundles carry: they name the Supabase
// origin in VITE_SUPABASE_URL and contain no secret or service-role key.
import { serverCredentialsIn } from '../packages/cloud/src/cloudConfig.ts';

const base = process.argv[2]?.replace(/\/$/, '');
const strict = process.argv.includes('--strict');
if (!base) {
  console.error('usage: verify-deploy <origin> [--strict]');
  process.exit(2);
}

let failures = 0;
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failures++;
};
const get = (path) => fetch(base + path, { headers: { 'accept-encoding': 'br, gzip' } });
const header = (res, name) => res.headers.get(name) ?? '';

const index = await get('/');
check(index.status === 200, `GET / → ${index.status}`);
check(
  /no-cache/.test(header(index, 'cache-control')),
  `/ cache-control: ${header(index, 'cache-control')}`,
);
check(header(index, 'cross-origin-opener-policy') === 'same-origin', 'COOP same-origin');
check(header(index, 'cross-origin-embedder-policy') === 'require-corp', 'COEP require-corp');
check(header(index, 'x-content-type-options') === 'nosniff', 'X-Content-Type-Options nosniff');
// The Content-Security-Policy: report-only until the deployed app's reports are clean,
// then enforcing; either is accepted. --strict also checks that it allows the Supabase project the bundles use.
const csp = header(index, 'content-security-policy') || header(index, 'content-security-policy-report-only');
check(/(^|;\s*)default-src 'self'/.test(csp), `Content-Security-Policy present${csp ? '' : ' (missing)'}`);
check(!/'unsafe-eval'/.test(csp), "Content-Security-Policy does not allow 'unsafe-eval'");
const html = await index.text();
check(/<div id="root">/.test(html), '/ is the app shell');

const js = html.match(/src="(\/assets\/index-[^"]+\.js)"/)?.[1];
check(Boolean(js), `index.html names a bundle (${js})`);
if (js) {
  const bundle = await get(js);
  check(bundle.status === 200, `GET ${js} → ${bundle.status}`);
  check(
    /immutable/.test(header(bundle, 'cache-control')),
    `${js} cache-control: ${header(bundle, 'cache-control')}`,
  );
  const encoding = header(bundle, 'content-encoding');
  if (strict) check(encoding !== '', `${js} compressed (${encoding || 'none'})`);
  else console.log(`info ${js} content-encoding: ${encoding || 'none'}`);
  const text = await bundle.text();
  check(!/sourceMappingURL=/.test(text.slice(-200)), 'bundle carries no sourceMappingURL');
  // A production bundle carries no trial configuration: no trial
  // build variable name or value and no fr-jobs address. Strict only, because a trial deployment legitimately has them.
  if (strict) {
    for (const needle of ['VITE_TRIAL', 'fr-jobs', '__PF_TRIAL__']) check(!text.includes(needle), `bundle contains no "${needle}"`);
  }
  // The wasm is referenced from the kernel worker's chunk, so follow /assets/*.js references
  // from the bundle until a .wasm turns up; --strict reads every chunk to check the cloud configuration.
  const seen = new Set([js]);
  const queue = [text];
  const sources = [text];
  let wasm;
  while ((strict || !wasm) && queue.length) {
    const source = queue.shift();
    // Vite emits "/assets/x.js" from the entry and "./x.js" between chunks in /assets.
    for (const m of source.matchAll(/["'`](?:\.\/|\/assets\/)([\w.-]+\.(?:js|wasm))["'`]/g)) {
      const asset = `/assets/${m[1]}`;
      if (asset.endsWith('.wasm')) {
        wasm ??= asset;
        continue;
      }
      if (seen.has(asset)) continue;
      seen.add(asset);
      const res = await get(asset);
      if (res.status === 200) {
        const chunk = await res.text();
        queue.push(chunk);
        sources.push(chunk);
      }
    }
  }
  check(Boolean(wasm), `bundle graph references the Manifold wasm (${wasm})`);
  if (strict) {
    const origin = process.env.VITE_SUPABASE_URL?.trim().replace(/\/$/, '');
    check(Boolean(origin), 'VITE_SUPABASE_URL names the expected Supabase project');
    if (origin) check(sources.some(source => source.includes(origin)), `bundles name the Supabase project ${origin}`);
    if (origin) check(csp.split(';').some(d => d.trim().startsWith('connect-src') && d.includes(new URL(origin).origin)), `Content-Security-Policy connect-src allows ${origin}`);
    const found = sources.flatMap(source => serverCredentialsIn(source));
    check(!found.length, `bundles carry no server credentials${found.length ? ` (${found.join(', ')})` : ''}`);
  }
  if (wasm) {
    const res = await get(wasm);
    check(res.status === 200, `GET ${wasm} → ${res.status}`);
    check(
      header(res, 'content-type').startsWith('application/wasm'),
      `${wasm} content-type: ${header(res, 'content-type')}`,
    );
  }
}

const health = await get('/healthz');
check(health.status === 200 && (await health.text()).trim() === 'ok', 'GET /healthz → ok');

const deep = await get('/some/deep/link');
check(
  deep.status === 200 && /<div id="root">/.test(await deep.text()),
  'deep link falls back to the app shell',
);

const maps = js ? await get(`${js}.map`) : null;
if (maps)
  check(maps.status === 404 || !/"mappings"/.test(await maps.text()), 'source maps are not served');

console.log(
  failures ? `verify-deploy: ${failures} failure(s)` : 'verify-deploy: all checks passed',
);
process.exit(failures ? 1 : 0);
