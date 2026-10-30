// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/load.ts';
import { SAMPLE_CONFIG_INPUT } from '../config/sample.ts';
import { validateConfig } from '../config/load.ts';
import { CHANGE_CLASS_TABLE, classesOfPaths, className, classOfPath, compareClass, globError, globMatch, globToRegExp, highestAllowedClass, highestClass, isClass, treatmentOf } from './classes.ts';

const boundaries = loadConfig(SAMPLE_CONFIG_INPUT).boundaries;

describe('change classes', () => {
  it('lists the seven classes in order with their names', () => {
    expect(CHANGE_CLASS_TABLE.map(c => c.class)).toEqual(['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7']);
    expect(className('C7')).toBe('Security and money');
    expect(className('C1')).toBe('Content and copy');
  });
  it('orders and picks the highest', () => {
    expect(compareClass('C2', 'C5')).toBeLessThan(0);
    expect(highestClass(['C3', 'C1', 'C6', 'C2'])).toBe('C6');
    expect(highestClass([])).toBeNull();
    expect(isClass('C4')).toBe(true);
    expect(isClass('C8')).toBe(false);
  });
  it('reads treatments and the highest allowed class', () => {
    expect(treatmentOf(boundaries, 'C5')).toBe('review');
    expect(highestAllowedClass(boundaries)).toBe('C4');
  });
});

describe('glob matching', () => {
  it('handles **, *, ?, braces and basename patterns', () => {
    expect(globMatch('docs/**', 'docs/a/b/c.md')).toBe(true);
    expect(globMatch('docs/**', 'docs/readme.md')).toBe(true);
    expect(globMatch('docs/**', 'docsx/readme.md')).toBe(false);
    expect(globMatch('supabase/**/*policy*', 'supabase/migrations/2026_policy_fix.sql')).toBe(true);
    expect(globMatch('supabase/**/*policy*', 'supabase/policy.sql')).toBe(true);
    expect(globMatch('supabase/**/*policy*', 'supabase/migrations/2026_init.sql')).toBe(false);
    expect(globMatch('packages/cloud/src/CloudFiles*.ts', 'packages/cloud/src/CloudFiles.sql.test.ts')).toBe(true);
    expect(globMatch('packages/cloud/src/CloudFiles*.ts', 'packages/cloud/src/CloudFiles/x.ts')).toBe(false);
    expect(globMatch('apps/web/vite.config.ts', 'apps/web/vite.config.ts')).toBe(true);
    expect(globMatch('apps/web/vite.config.ts', 'apps/web/vite.config.tsx')).toBe(false);
    expect(globMatch('package.json', 'package.json')).toBe(true);
    expect(globMatch('package.json', 'packages/core/package.json')).toBe(true);
    expect(globMatch('src/?.ts', 'src/a.ts')).toBe(true);
    expect(globMatch('src/?.ts', 'src/ab.ts')).toBe(false);
    expect(globMatch('**/*.{ts,tsx}', 'a/b.tsx')).toBe(true);
    expect(globMatch('**/*.{ts,tsx}', 'b.ts')).toBe(true);
    expect(globMatch('**/*.{ts,tsx}', 'a/b.js')).toBe(false);
    expect(globMatch('./docs/**', '/docs/x.md')).toBe(true);
  });
  it('nests braces and keeps a double star inside a segment within that segment', () => {
    expect(globMatch('x/{a,{b,c}}.ts', 'x/c.ts')).toBe(true);
    expect(globMatch('x/{a,{b,c}}.ts', 'x/a.ts')).toBe(true);
    expect(globMatch('x/{a,{b,c}}.ts', 'x/d.ts')).toBe(false);
    expect(globMatch('x/{a,{b,c}}.ts', 'x/c}.ts')).toBe(false);
    expect(globMatch('a**b', 'axxb')).toBe(true);
    expect(globMatch('a**b', 'a/x/b')).toBe(false);
    expect(globMatch('src/**.ts', 'src/a/b.ts')).toBe(false);
    expect(globMatch('src/**', 'src/a/b.ts')).toBe(true);
    expect(globMatch('**/x', 'a/b/x')).toBe(true);
    expect(globError('x/{a,b')).toMatch(/unbalanced "\{"/);
    expect(globError('x/a}')).toMatch(/unbalanced "\}"/);
    expect(globError('x/{a,{b,c}}')).toBeNull();
    expect(() => globToRegExp('{')).toThrow();
  });
  it('reports a path mapping that cannot be compiled at configuration time', () => {
    const bad = validateConfig({ ...SAMPLE_CONFIG_INPUT, boundaries: { ...SAMPLE_CONFIG_INPUT.boundaries, paths: { C5: ['supabase/migrations/**', 'x/{a,b'] } } });
    expect(bad.ok).toBe(false);
    expect(bad.errors).toEqual([expect.stringMatching(/^boundaries\.paths\.C5\.1: glob pattern "x\/\{a,b" has an unbalanced/)]);
  });
  it('escapes regex characters', () => {
    expect(globToRegExp('a+b(c).ts').test('a+b(c).ts')).toBe(true);
    expect(globToRegExp('a+b(c).ts').test('aab(c)xts')).toBe(false);
  });
});

describe('classOfPath', () => {
  it('maps configured paths and defaults unmapped files to C3 (changed) or C4 (added)', () => {
    expect(classOfPath(boundaries, 'docs/architecture.md')).toBe('C1');
    expect(classOfPath(boundaries, 'specs/modeling.md', true)).toBe('C1');
    expect(classOfPath(boundaries, 'supabase/migrations/20261023_x.sql')).toBe('C5');
    expect(classOfPath(boundaries, '.github/workflows/ci.yml')).toBe('C6');
    expect(classOfPath(boundaries, 'package.json')).toBe('C6');
    expect(classOfPath(boundaries, 'packages/cloud/src/CloudSession.ts')).toBe('C7');
    expect(classOfPath(boundaries, 'supabase/config.toml')).toBe('C7');
    expect(classOfPath(boundaries, 'packages/model/src/Document.ts')).toBe('C3');
    expect(classOfPath(boundaries, 'packages/model/src/NewTool.ts', true)).toBe('C4');
  });
  it('takes the highest class when several mappings match', () => {
    const b = { ...boundaries, paths: { C1: ['supabase/**'], C7: ['supabase/**/*policy*'] } };
    expect(classOfPath(b, 'supabase/policy.sql')).toBe('C7');
    expect(classOfPath(b, 'supabase/seed.sql')).toBe('C1');
  });
  it('groups a change set by class in order', () => {
    const grouped = classesOfPaths(boundaries, [
      { path: 'packages/ui/src/Panel.tsx' }, { path: 'docs/x.md' }, { path: 'specs/y.md', added: true }, { path: 'packages/ui/src/New.tsx', added: true }, { path: 'pnpm-lock.yaml' },
    ]);
    expect([...grouped.entries()]).toEqual([
      ['C1', ['docs/x.md', 'specs/y.md']], ['C3', ['packages/ui/src/Panel.tsx']], ['C4', ['packages/ui/src/New.tsx']], ['C6', ['pnpm-lock.yaml']],
    ]);
  });
});
