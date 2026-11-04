// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { expect, it } from 'vitest';

async function verifyFixture({ missingChunk = false, release = 'abc1234' } = {}) {
  const html = '<div id="root"></div><script src="/assets/index-main.js"></script>';
  const server = createServer((req, res) => {
    let body = html, type = 'text/html';
    if (req.url === '/assets/index-main.js') {
      body = 'const chunks=["assets/kernel.js"];const release="abc1234";'; type = 'application/javascript';
    } else if (req.url === '/assets/kernel.js' && !missingChunk) {
      body = 'const wasm="./manifold-test.wasm";const cloud="https://example.supabase.co";'; type = 'application/javascript';
    } else if (req.url === '/assets/manifold-test.wasm') {
      body = '\0asm'; type = 'application/wasm';
    } else if (req.url === '/healthz') { body = 'ok'; type = 'text/plain'; }
    res.writeHead(200, {
      'Content-Type': type, 'Content-Encoding': 'gzip',
      'Cache-Control': req.url.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
      'X-Content-Type-Options': 'nosniff', 'Permissions-Policy': 'microphone=(self)',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self' https://example.supabase.co",
    });
    res.end(gzipSync(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await new Promise(resolve => execFile(process.execPath,
      [fileURLToPath(new URL('./verify-deploy.mjs', import.meta.url)), `http://127.0.0.1:${server.address().port}`, '--strict'],
      { env: { ...process.env, VITE_SUPABASE_URL: 'https://example.supabase.co', VITE_RELEASE: release } },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, output: stdout + stderr })));
  } finally { await new Promise(resolve => server.close(resolve)); }
}

it('follows Vite asset mappings and verifies the expected release and geometry runtime', async () => {
  const result = await verifyFixture();
  expect(result.code).toBe(0);
  expect(result.output).toContain('verify-deploy: all checks passed');
});
it('rejects a missing chunk served as a successful HTML fallback during deployment propagation', async () => {
  const result = await verifyFixture({ missingChunk: true });
  expect(result.code).toBe(1);
  expect(result.output).toContain('FAIL /assets/kernel.js serves JavaScript');
});
it('rejects a healthy but older release', async () => {
  const result = await verifyFixture({ release: 'def5678' });
  expect(result.code).toBe(1);
  expect(result.output).toContain('FAIL bundles contain the expected release def5678');
});
