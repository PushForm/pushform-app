// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ExtensionError } from '@pushform/extension-protocol';
import { FRAME_BOOTSTRAP_SHA256, FRAME_BOOTSTRAP_SOURCE, frameContentSecurityPolicy, runtimeFrameDocument } from './frameBootstrap';
import { linkModules, resolve } from './link';
import { lockDownRuntime } from './lockdown';

const encode = (text: string) => new TextEncoder().encode(text);
const files = (entries: Record<string, string>) => new Map(Object.entries(entries).map(([p, s]) => [p, encode(s)] as const));

/** Links `entries` and returns the minted sources by path, in minting order, with URLs named `url:<path>`. */
async function link(entries: Record<string, string>, main = 'main.js'): Promise<{ order: string[]; sources: Map<string, string>; url: string }> {
  const sources = new Map<string, string>();
  const url = await linkModules(files(entries), main, (path, source) => { sources.set(path, source); return `url:${path}`; });
  return { order: [...sources.keys()], sources, url };
}

async function refusal(run: Promise<unknown>): Promise<string> {
  try { await run; } catch (error) { if (error instanceof ExtensionError) { expect(error.code).toBe('validation.failed'); return error.message; } throw error; }
  throw new Error('expected the link to be refused');
}

describe('linkModules', () => {
  it('links dependencies first and rewrites static imports, re-exports and literal dynamic imports', async () => {
    const { order, sources, url } = await link({
      'main.js': 'import { a } from "./lib/a.js";\nexport * from "./lib/b.mjs";\nexport async function activate() { return (await import("./lazy.js")).x + a; }',
      'lib/a.js': "import { c } from '../lib/c.js'; export const a = c;",
      'lib/b.mjs': 'export const b = 2;',
      'lib/c.js': 'export const c = 1;',
      'lazy.js': 'export const x = 3; export const where = import.meta.url;',
      'unused.js': 'throw new Error("never linked");',
    });
    expect(url).toBe('url:main.js');
    expect(order).toEqual(['lib/c.js', 'lib/a.js', 'lib/b.mjs', 'lazy.js', 'main.js']);
    expect(sources.get('lib/a.js')).toBe("import { c } from 'url:lib/c.js'; export const a = c;");
    expect(sources.get('main.js')).toBe('import { a } from "url:lib/a.js";\nexport * from "url:lib/b.mjs";\nexport async function activate() { return (await import("url:lazy.js")).x + a; }');
    expect(sources.get('lazy.js')).toContain('import.meta.url');
  });

  it('links a module imported from several places once', async () => {
    const { order } = await link({ 'main.js': 'import "./a.js"; import "./b.js";', 'a.js': 'import "./shared.js";', 'b.js': 'import "./shared.js";', 'shared.js': '' });
    expect(order).toEqual(['shared.js', 'a.js', 'b.js', 'main.js']);
  });

  it('leaves dynamic imports of non-literal specifiers alone', async () => {
    const { sources } = await link({ 'main.js': 'export function activate(name) { return import(`./${name}.js`); }' });
    expect(sources.get('main.js')).toContain('import(`./${name}.js`)');
  });

  it('refuses bare specifiers, URLs, paths outside the package and missing or non-JavaScript files', async () => {
    expect(await refusal(link({ 'main.js': 'import React from "react";' }))).toMatch(/only their own files/);
    expect(await refusal(link({ 'main.js': 'import "https://cdn.example.com/x.js";' }))).toMatch(/only their own files/);
    expect(await refusal(link({ 'main.js': 'import "/abs.js";' }))).toMatch(/only their own files/);
    expect(await refusal(link({ 'main.js': 'import "../outside.js";' }))).toMatch(/outside the package/);
    expect(await refusal(link({ 'main.js': 'import "./missing.js";' }))).toMatch(/not a JavaScript file/);
    expect(await refusal(link({ 'main.js': 'import "./data.json";', 'data.json': '{}' }))).toMatch(/not a JavaScript file/);
    expect(await refusal(link({ 'main.js': 'const x = import("https://evil.example/x.js");' }))).toMatch(/only their own files/);
  });

  it('refuses import cycles, naming them', async () => {
    expect(await refusal(link({ 'main.js': 'import "./a.js";', 'a.js': 'import "./b.js";', 'b.js': 'import "./a.js";' })))
      .toMatch(/a\.js → b\.js → a\.js/);
  });

  it('refuses source that is not a valid module', async () => {
    expect(await refusal(link({ 'main.js': 'import { from "./a.js";' }))).toMatch(/not a valid ES module/);
  });

  it('resolves relative paths inside the package', () => {
    expect(resolve('a/b/c.js', './d.js')).toBe('a/b/d.js');
    expect(resolve('a/b/c.js', '../d.js')).toBe('a/d.js');
    expect(resolve('a/b/c.js', '.././../d.js')).toBe('d.js');
    expect(() => resolve('a/c.js', '../../d.js')).toThrow(/outside the package/);
  });
});

describe('lockDownRuntime', () => {
  /** A stand-in for a worker's global: URL and Worker own, importScripts on the prototype as in WorkerGlobalScope. */
  function fakeWorkerScope() {
    const proto = { importScripts: () => 'loaded' };
    const scope = Object.create(proto) as Record<string, unknown>;
    scope.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };
    scope.webkitURL = scope.URL;
    scope.Worker = function Worker() {};
    return { scope, proto };
  }

  it('removes blob URL creation and worker and script loading, permanently', () => {
    const { scope, proto } = fakeWorkerScope();
    lockDownRuntime(scope);
    const url = scope.URL as Record<string, unknown>;
    expect(url.createObjectURL).toBeUndefined();
    expect(typeof url.revokeObjectURL).toBe('function');
    expect(scope.Worker).toBeUndefined();
    expect(scope.importScripts).toBeUndefined();
    expect(proto.importScripts).toBeUndefined();
    expect(() => { 'use strict'; delete url.createObjectURL; }).toThrow();
    expect(() => Object.defineProperty(url, 'createObjectURL', { value: () => 'again' })).toThrow();
    expect(() => Object.defineProperty(scope, 'Worker', { value: () => {} })).toThrow();
  });
});

describe('runtime frame', () => {
  it('keeps the published hash equal to the bootstrap source', () => {
    expect(createHash('sha256').update(FRAME_BOOTSTRAP_SOURCE).digest('base64')).toBe(FRAME_BOOTSTRAP_SHA256);
  });

  it('allows only the bootstrap and blob scripts, no network, and WASM only when declared', () => {
    const policy = frameContentSecurityPolicy({ wasm: false });
    expect(policy).toContain(`script-src 'sha256-${FRAME_BOOTSTRAP_SHA256}' blob:;`);
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("default-src 'none'");
    expect(policy).not.toMatch(/unsafe-eval|unsafe-inline|data:|https?:/);
    expect(frameContentSecurityPolicy({ wasm: true })).toContain("'wasm-unsafe-eval'");
  });

  it('embeds the bootstrap unchanged, with nothing that could end the script element early', () => {
    const html = runtimeFrameDocument({ wasm: false });
    expect(html).toContain(`<script>${FRAME_BOOTSTRAP_SOURCE}</script>`);
    expect(FRAME_BOOTSTRAP_SOURCE).not.toContain('</');
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<script>'));
  });
});
