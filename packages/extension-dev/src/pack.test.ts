// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExtensionPackageError, readPackageArchive } from '@pushform/extension-protocol';
import { packDirectory, validateArchive } from './pack.ts';

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

const manifest = {
  id: 'com.example.stairs', name: 'Stairs', publisher: 'Example', version: '1.2.0', apiVersion: '^0.1.0', editors: ['modeling'],
  defaultLocale: 'en', license: 'MIT', permissions: [], contributions: [{ target: 'model.command', id: 'com.example.stairs.make', name: 'Make' }],
};

async function buildDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pf-pack-'));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  return dir;
}

describe('packDirectory', () => {
  it('lists every file with its hash, validates, and zips reproducibly', async () => {
    const dir = await buildDir({
      'manifest.json': JSON.stringify(manifest),
      'main.js': 'import { make } from "./lib/make.js";\nexport function activate(ctx) { ctx.commands.register("com.example.stairs.make", make); }\n',
      'lib/make.js': 'export const make = () => 12;\n',
      '.DS_Store': 'junk',
    });
    const first = await packDirectory(dir);
    expect(first.integrity).toBe('unsigned');
    expect(Object.keys(first.manifest.files).sort()).toEqual(['lib/make.js', 'main.js']);
    expect([...readPackageArchive(first.archive).keys()].sort()).toEqual(['lib/make.js', 'main.js', 'manifest.json']);
    expect((await packDirectory(dir)).archive).toEqual(first.archive);
    expect((await validateArchive(first.archive)).contentHash).toBe(first.contentHash);
  });

  it('replaces a stale hash list and passes on the validator refusals', async () => {
    const dir = await buildDir({ 'manifest.json': JSON.stringify({ ...manifest, files: { 'old.js': '0'.repeat(64) } }), 'main.js': 'export function activate() {}' });
    expect(Object.keys((await packDirectory(dir)).manifest.files)).toEqual(['main.js']);
    const bad = await buildDir({ 'manifest.json': JSON.stringify(manifest), 'main.js': 'export function activate() {}', 'panel.html': '<b>' });
    await expect(packDirectory(bad)).rejects.toMatchObject({ details: { problem: 'file.type', path: 'panel.html' } });
    const noModule = await buildDir({ 'manifest.json': JSON.stringify(manifest), 'main.js': 'module.exports = {}' });
    await expect(packDirectory(noModule)).rejects.toBeInstanceOf(ExtensionPackageError);
    await expect(packDirectory(await buildDir({ 'main.js': '' }))).rejects.toThrow(/no manifest\.json/);
  });
});
