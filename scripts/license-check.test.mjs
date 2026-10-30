// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { auditLicenses, licenseOf, licenseProblems, normalizeId, spdxAllows } from './license-check.mjs';

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
