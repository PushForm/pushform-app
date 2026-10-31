// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// Serves the attack harness under the editor's own response headers, plus a second origin that records anything that
// reaches it. Started by global-setup.ts.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createSocket } from 'node:dgram';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import wabtInit from 'wabt';
import { CSP_HEADER, allPathHeaders, contentSecurityPolicy, withCspHeader } from '../../apps/web/contentSecurityPolicy.ts';
import { COMPUTE_BOOTSTRAP_ENTRY, bundleWorkerBootstrap } from '../../apps/web/extensionRuntime.ts';
import { ATTACKER_FRAME_SOURCE, FRAME_PROBE_SOURCE } from './harness/frames.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');

/** A request that reached one of the servers outside the harness's own files. */
export interface Hit {
  readonly server: 'editor' | 'remote' | 'udp';
  readonly method: string;
  readonly url: string;
  readonly upgrade: boolean;
}

export interface IsolationServers {
  /** The editor origin with the deployed headers: the policy sent report-only, as the hosted app sends it today. */
  readonly hosted: string;
  /** The same, with the editor's policy enforced, as it will be once its reports are clean. */
  readonly enforced: string;
  /** Another origin, standing for any outside server; it accepts everything, so only the runtime can stop a request. */
  readonly remote: string;
  /** `host:port` of a UDP socket that records every datagram, as a STUN server would see a WebRTC candidate check. */
  readonly stun: string;
  close(): Promise<void>;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('base64');

/** Minimal WebAssembly modules following the compute interface, for packages that declare WASM. */
async function computeModule(): Promise<number[]> {
  const wabt = await wabtInit();
  const module = wabt.parseWat('echo.wat', `(module (import "pf" "memory" (memory 1))
    (func (export "pf_abi_version") (result i32) i32.const 1)
    (func (export "pf_alloc") (param i32) (result i32) i32.const 1024)
    (func (export "pf_run") (param i32 i32) (result i32) (i32.store (i32.const 4096) (i32.const 0)) (i32.const 4096)))`);
  try {
    return Array.from(module.toBinary({}).buffer);
  } finally {
    module.destroy();
  }
}

async function bundleHarness(): Promise<string> {
  const [worker, compute, wasm] = await Promise.all([bundleWorkerBootstrap(), bundleWorkerBootstrap(COMPUTE_BOOTSTRAP_ENTRY), computeModule()]);
  const result = await build({
    entryPoints: [resolve(here, 'harness/harness.ts')], bundle: true, format: 'esm', write: false, platform: 'browser',
    target: 'es2022', logLevel: 'error', absWorkingDir: here, external: ['node:*'],
    define: { WORKER_SOURCE: JSON.stringify(worker.source), COMPUTE_SOURCE: JSON.stringify(compute.source), COMPUTE_WASM: JSON.stringify(wasm) },
  });
  return result.outputFiles[0]!.text;
}

/**
 * The response headers of every editor page: the `/*` block of the app's `_headers` with the web policy added, exactly
 * as the build writes it. The test-only frames of the harness (an attacker frame and the frame-layer probe) are
 * allowed by hash in addition, the same way the runtime's own bootstrap is; nothing else in the policy changes.
 */
function editorHeaders(enforce: boolean): [string, string][] {
  const policy = contentSecurityPolicy('web', { supabaseUrls: ['https://project.supabase.example'] });
  const withFrames = policy.replace(/(script-src [^;]*)/, `$1 'sha256-${sha256(ATTACKER_FRAME_SOURCE)}' 'sha256-${sha256(FRAME_PROBE_SOURCE)}'`);
  const headers = allPathHeaders(withCspHeader(readFileSync(resolve(repo, 'apps/web/public/_headers'), 'utf8'), withFrames));
  return headers.map(([name, value]) => [name === CSP_HEADER && enforce ? 'Content-Security-Policy' : name, value]);
}

const listen = (server: Server): Promise<string> => new Promise((done) => server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));

export async function startIsolationServers(): Promise<IsolationServers> {
  const harness = await bundleHarness();
  const hits: Hit[] = [];
  const record = (server: Hit['server'], req: IncomingMessage, upgrade = false) => hits.push({ server, method: req.method ?? 'GET', url: req.url ?? '', upgrade });

  const editor = (enforce: boolean) => {
    const headers = editorHeaders(enforce);
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      for (const [name, value] of headers) res.setHeader(name, value);
      const url = req.url ?? '/';
      if (url === '/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end('<!doctype html><html><head><meta charset="utf-8"><title>Extension isolation</title></head><body><script type="module" src="/harness.js"></script></body></html>');
      }
      if (url === '/harness.js') {
        res.setHeader('Content-Type', 'text/javascript');
        return res.end(harness);
      }
      if (url.startsWith('/__hits')) {
        // The test runner's own view of what arrived; drained per tag so tests cannot see each other's.
        const query = new URL(url, 'http://x').searchParams;
        const tag = query.get('tag') ?? '';
        const matching = query.has('all') ? hits : hits.filter((h) => (tag === 'udp' ? h.server === 'udp' : h.url.includes(`/${tag}/`)));
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(matching));
      }
      if (url === '/favicon.ico') { res.statusCode = 204; return res.end(); }
      record('editor', req);
      res.setHeader('Content-Type', 'text/javascript');
      res.end('self.__reached = true; export default 1;');
    });
    server.on('upgrade', (req, socket) => { record('editor', req, true); socket.destroy(); });
    return server;
  };

  // The outside server answers every request as permissively as it can (CORS, CORP, any method), so that a refusal
  // can only come from the runtime.
  const remote = createServer((req, res) => {
    record('remote', req);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if ((req.url ?? '').includes('/events')) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: hello\n\n');
      setTimeout(() => res.end(), 200);
      return;
    }
    res.setHeader('Content-Type', 'text/javascript');
    res.end('self.__reached = true; export default 1;');
  });
  remote.on('upgrade', (req, socket) => { record('remote', req, true); socket.destroy(); });

  const udp = createSocket('udp4');
  udp.on('message', (_message, from) => hits.push({ server: 'udp', method: 'datagram', url: `/udp/${from.port}/`, upgrade: false }));
  await new Promise<void>((done) => udp.bind(0, '127.0.0.1', () => done()));

  const servers = [editor(false), editor(true), remote];
  const [hosted, enforced, remoteUrl] = await Promise.all(servers.map(listen));
  return {
    hosted: hosted!, enforced: enforced!, remote: remoteUrl!, stun: `127.0.0.1:${udp.address().port}`,
    close: () => Promise.all([
      ...servers.map((s) => new Promise<void>((done) => { s.closeAllConnections(); s.close(() => done()); })),
      new Promise<void>((done) => udp.close(() => done())),
    ]).then(() => {}),
  };
}

