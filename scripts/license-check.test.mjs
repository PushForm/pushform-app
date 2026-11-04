// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/* global URL */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ALLOWED, auditLicenses, licenseOf, licenseProblems, normalizeId, npmNotices, packageNoticeFiles, spdxAllows,
} from './license-check.mjs';

const ok = (id) => ['MIT', 'Apache-2.0'].includes(id);
const dirs = [];
/** A fake workspace: files by path, each value written as JSON unless it is a string. */
const workspace = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-licenses-'));
  dirs.push(dir);
  for (const [name, value] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
  }
  return dir;
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('license-check', () => {
  it('reads SPDX expressions: OR needs one side, AND both, WITH follows its license', () => {
    expect(spdxAllows('MIT', ok)).toBe(true);
    expect(spdxAllows('MIT OR GPL-2.0', ok)).toBe(true);
    expect(spdxAllows('MIT AND GPL-2.0', ok)).toBe(false);
    expect(spdxAllows('(AGPL-3.0 OR MIT) AND Apache-2.0', ok)).toBe(true);
    expect(spdxAllows('Apache-2.0 WITH LLVM-exception', ok)).toBe(true);
    expect(() => spdxAllows('MIT AND (Apache-2.0', ok)).toThrow('unbalanced');
  });

  it('reads string, object and legacy array license fields', () => {
    expect(licenseOf({ license: 'MIT' })).toBe('MIT');
    expect(licenseOf({ license: { type: 'ISC' } })).toBe('ISC');
    expect(licenseOf({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] })).toBe('(MIT) OR (Apache-2.0)');
    expect(licenseOf({})).toBeNull();
  });

  it('keeps GPL version ranges explicit instead of merging them', () => {
    expect(normalizeId('GPL-2.0+')).toBe('GPL-2.0-or-later');
    expect(normalizeId('GPL-3.0')).toBe('GPL-3.0-only');
    expect(normalizeId('LGPL-2.1')).toBe('LGPL-2.1-only');
    expect(normalizeId('AGPL-3.0')).toBe('AGPL-3.0-only');
    expect(normalizeId('GPL-3.0-or-later')).toBe('GPL-3.0-or-later');
    expect(normalizeId('MIT')).toBe('MIT');
  });

  it('allows GPLv3-compatible licenses and rejects GPL-2.0-only, AGPL and unlicensed packages', () => {
    for (const license of ['GPL-3.0', 'GPL-3.0-only', 'GPL-3.0-or-later', 'GPL-3.0+', 'GPL-2.0+', 'GPL-2.0-or-later',
      'LGPL-2.1', 'LGPL-2.1+', 'LGPL-3.0-or-later', 'Apache-2.0 AND LGPL-3.0-or-later'])
      expect(licenseProblems('a', license), license).toEqual([]);
    expect(licenseProblems('a', 'GPL-2.0-only')).toEqual(['a: GPL-2.0-only is not allowed']);
    expect(licenseProblems('a', 'GPL-2.0')).toEqual(['a: GPL-2.0 is not allowed']);
    expect(licenseProblems('a', 'AGPL-3.0-or-later')).toEqual(['a: AGPL-3.0-or-later is not allowed']);
    expect(licenseProblems('a', 'GPL-3.0-only AND AGPL-3.0-only')).toEqual(['a: GPL-3.0-only AND AGPL-3.0-only is not allowed']);
    expect(licenseProblems('pako', 'MIT AND Zlib')).toEqual([]);
    expect(licenseProblems('a', null)).toEqual(['a: no license in its package.json']);
  });

  it('walks production and optional dependencies through the workspace, not devDependencies', () => {
    const root = workspace({
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
      'package.json': { name: 'root', private: true, devDependencies: { tool: '1' } },
      'node_modules/tool/package.json': { name: 'tool', version: '1.0.0', license: 'GPL-2.0' },
      'packages/app/package.json': { name: 'app', dependencies: { lib: '1' }, optionalDependencies: { native: '1', other: '1' } },
      'packages/app/node_modules/lib/package.json': { name: 'lib', version: '1.0.0', license: 'MIT', dependencies: { deep: '1' } },
      'packages/app/node_modules/native/package.json': { name: 'native', version: '1.0.0', license: 'MIT' },
      'node_modules/deep/package.json': { name: 'deep', version: '2.0.0', license: 'AGPL-3.0' },
    });
    const { packages, problems } = auditLicenses(root);
    expect(packages.map((p) => `${p.name}@${p.version}`)).toEqual(['deep@2.0.0', 'lib@1.0.0', 'native@1.0.0']);
    expect(problems).toEqual(['deep: AGPL-3.0 is not allowed (via app > lib > deep)']);
  });

  it('reports a missing required dependency but skips a missing optional one', () => {
    const root = workspace({
      'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n',
      'package.json': { name: 'root', private: true },
      'packages/app/package.json': { name: 'app', dependencies: { gone: '1' }, optionalDependencies: { 'other-platform': '1' } },
    });
    expect(auditLicenses(root).problems).toEqual(['gone: not installed (needed by app)']);
  });
});

describe('license-check --notices', () => {
  it('starts the walk at the shipped apps, following their workspace packages and skipping the others', () => {
    const root = workspace({
      'pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - packages/*\n',
      'package.json': { name: 'root', private: true },
      'apps/web/package.json': { name: 'web', dependencies: { ui: 'workspace:*' } },
      'packages/ui/package.json': { name: 'ui', dependencies: { lib: '1' } },
      'packages/ui/node_modules/lib/package.json': { name: 'lib', version: '1.0.0', license: 'MIT' },
      'packages/tool/package.json': { name: 'tool', dependencies: { builder: '1' } },
      'packages/tool/node_modules/builder/package.json': { name: 'builder', version: '1.0.0', license: 'MIT' },
    });
    // pnpm links a workspace dependency into node_modules.
    mkdirSync(join(root, 'apps/web/node_modules'));
    symlinkSync(join(root, 'packages/ui'), join(root, 'apps/web/node_modules/ui'), 'junction');
    const { packages, problems } = auditLicenses(root, { from: ['apps/web'] });
    expect(packages.map((p) => p.name)).toEqual(['lib']);
    expect(packages[0].via).toEqual(['web', 'ui', 'lib']);
    expect(problems).toEqual([]);
    expect(auditLicenses(root).packages.map((p) => p.name)).toEqual(['builder', 'lib']);
  });

  it('leaves out the subtree of a package that is not shipped, but the full audit still reaches it', () => {
    const root = workspace({
      'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
      'package.json': { name: 'root', private: true },
      'apps/web/package.json': { name: 'web', dependencies: { pixels: '1' } },
      'apps/web/node_modules/pixels/package.json': { name: 'pixels', version: '1.0.0', license: 'MIT', dependencies: { image: '1' } },
      'node_modules/image/package.json': { name: 'image', version: '1.0.0', license: 'Apache-2.0', optionalDependencies: { 'image-native': '1' } },
      'node_modules/image-native/package.json': { name: 'image-native', version: '1.0.0', license: 'LGPL-3.0-or-later' },
    });
    const shipped = auditLicenses(root, { from: ['apps/web'], skip: new Map([['image', 'runs only under Node']]) });
    expect(shipped.packages.map((p) => p.name)).toEqual(['pixels']);
    expect(auditLicenses(root).packages.map((p) => p.name)).toEqual(['image', 'image-native', 'pixels']);
  });

  it('reads license and NOTICE files at the top of a package and one directory down, not in node_modules', () => {
    const dir = workspace({
      'LICENSE.md': 'MIT License\r\n\r\nCopyright (c) A   \r\n',
      'NOTICE': 'Notice text',
      'COPYING': 'Copying text',
      'README.md': 'not a license',
      'wasm/LICENSE_DECODER': 'Decoder license',
      'node_modules/dep/LICENSE': 'nested',
      'a/b/LICENSE': 'too deep',
      'empty/LICENSE': '   ',
    });
    expect(packageNoticeFiles(dir)).toEqual([
      { path: 'COPYING', notice: false, text: 'Copying text' },
      { path: 'LICENSE.md', notice: false, text: 'MIT License\n\nCopyright (c) A' },
      { path: 'NOTICE', notice: true, text: 'Notice text' },
      { path: 'wasm/LICENSE_DECODER', notice: false, text: 'Decoder license' },
    ]);
  });

  it('groups packages with identical license files and fails packages without one unless accepted', () => {
    const root = workspace({
      'a/package.json': { name: 'a', version: '1.0.0', license: 'MIT' }, 'a/LICENSE': 'MIT text\n',
      'b/package.json': { name: 'b', version: '2.0.0', license: 'MIT' }, 'b/LICENSE': 'MIT text',
      'c/package.json': { name: 'c', version: '3.0.0', license: 'Apache-2.0' }, 'c/LICENSE': 'Apache text', 'c/NOTICE': 'C notice',
      'd/package.json': { name: 'd', version: '4.0.0', license: 'MIT' },
      'e/package.json': { name: 'e', version: '5.0.0', license: 'MIT', author: { name: 'E Author' },
        repository: { url: 'git+https://example.com/e.git' } },
    });
    const pkg = (name, version, license) => ({ name, version, license, dir: join(root, name) });
    const packages = [pkg('a', '1.0.0', 'MIT'), pkg('b', '2.0.0', 'MIT'), pkg('c', '3.0.0', 'Apache-2.0'),
      pkg('d', '4.0.0', 'MIT'), pkg('e', '5.0.0', 'MIT')];
    const { groups, problems } = npmNotices(packages, new Map([['e', 'no license file'], ['gone', 'no license file']]));
    expect(groups.map((group) => group.packages.map((p) => p.name))).toEqual([['a', 'b'], ['c'], ['e']]);
    expect(groups[0].text).toBe('MIT text');
    expect(groups[1].text).toBe('--- LICENSE ---\n\nApache text\n\n--- NOTICE ---\n\nC notice');
    expect(groups[2].text.split('\n').slice(0, 6)).toEqual([
      'e 5.0.0 is published without a license file; its package.json states MIT.',
      'Authors: E Author.',
      'Source: https://example.com/e',
      '',
      'MIT License',
      '',
    ]);
    expect(problems).toEqual(['d@4.0.0: no license file in the package', 'gone: no longer shipped; remove it from NO_LICENSE_FILE']);
    expect(npmNotices([pkg('a', '1.0.0', 'MIT')], new Map([['a', 'no license file']])).problems)
      .toEqual(['a@1.0.0: has a license file now; remove it from NO_LICENSE_FILE']);
  });

  it('accepts only Rust crate licenses that the npm policy allows too', () => {
    const toml = readFileSync(new URL('./notices/about.toml', import.meta.url), 'utf8');
    const accepted = [...toml.match(/^accepted = \[([^\]]*)\]/m)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(accepted.length).toBeGreaterThan(5);
    for (const license of accepted) expect(ALLOWED.has(license.split(' WITH ')[0]), license).toBe(true);
  });
});
