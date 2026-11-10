// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/* global URL */
import { join, dirname, basename } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cargoAboutReports, RUST_WORKSPACES, crateLabel, noticesText, rustNotices, verbatimNoticeFiles } from './third-party-notices.mjs';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/** A cargo-about JSON report reduced to the fields the notices read. */
const report = (crates, licenses) => ({
  crates: crates.map(([id, license, authors = [], repository = null]) => {
    const [name, version] = id.split('@');
    return { package: { id, name, version, license, authors, repository } };
  }),
  licenses: licenses.map(([text, own, ids]) => ({ text, source_path: own ? 'LICENSE' : null, used_by: ids.map((id) => ({ crate: { id } })) })),
});

describe('third-party notices', () => {
  it('reads cargo-about UTF-8 output files and caches reports without using redirected stdout', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'pushform-notices-test-'));
    try {
      for (const manifest of ['scripts/notices/about.toml', ...RUST_WORKSPACES.flatMap(workspace => [workspace.manifest, join(dirname(workspace.manifest), 'Cargo.lock')])]) {
        const path = join(fixture, manifest); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'fixture');
      }
      let calls = 0;
      const runCommand = (command, args, options) => {
        calls++; expect(command).toBe('cargo'); expect(options.stdio[1]).toBe('ignore');
        const path = args[args.indexOf('--output-file') + 1]; expect(path).toBeTruthy();
        writeFileSync(path, JSON.stringify({ crates: [], licenses: [{ text: 'Caf\u00e9 license', source_path: 'LICENSE', used_by: [] }] }), 'utf8');
        return 'Not JSON: stdout is not the report';
      };
      expect(cargoAboutReports(fixture, 'version', { runCommand })[0].report.licenses[0].text).toBe('Caf\u00e9 license');
      cargoAboutReports(fixture, 'version', { runCommand }); expect(calls).toBe(RUST_WORKSPACES.length);
      expect(readdirSync(join(fixture, 'node_modules/.cache/pushform-notices')).every(file => !file.startsWith('cargo-about-'))).toBe(true);
    } finally {
      expect(dirname(realpathSync(fixture))).toBe(realpathSync(tmpdir())); expect(basename(fixture).startsWith('pushform-notices-test-')).toBe(true);
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('groups Rust crates by license text across workspaces and records the builds each ships in', () => {
    const step = report([['a@1.0.0', 'MIT'], ['b@2.0.0', 'MIT OR Apache-2.0']],
      [['MIT text\r\n', true, ['a@1.0.0', 'b@2.0.0']]]);
    const desktop = report([['a@1.0.0', 'MIT'], ['c@3.0.0', 'Apache-2.0', ['C Author'], 'https://example.com/c'], ['d@4.0.0', 'MIT']],
      [['MIT text', true, ['a@1.0.0']], ['Apache text', false, ['c@3.0.0']]]);
    const { count, groups, problems } = rustNotices([{ ships: 'web', report: step }, { ships: 'desktop', report: desktop }]);
    expect(count).toBe(4);
    expect(groups.map((group) => [group.text, group.packages.map((crate) => crate.name)]))
      .toEqual([['MIT text', ['a', 'b']], ['Apache text', ['c']]]);
    expect([...groups[0].packages[0].ships]).toEqual(['web', 'desktop']);
    expect(problems).toEqual(['d@4.0.0: no license text found']);
    expect(crateLabel(groups[0].packages[0])).toBe('a 1.0.0 (MIT; web, desktop)');
    // A crate that carries no license file of its own names its authors and source.
    expect(crateLabel(groups[1].packages[0])).toBe('c 3.0.0 (Apache-2.0; desktop)\n  Authors: C Author\n  Source: https://example.com/c');
  });

  it('includes the STEP reader and kernel notices verbatim and says when the Rust crates are not listed', () => {
    const files = verbatimNoticeFiles(root);
    expect(files.slice(0, 4)).toEqual(['crates/step-reader/NOTICE.md', 'crates/solidcraft/NOTICE-solidcraft.txt',
      'crates/solidcraft/LICENSE-MIT', 'crates/solidcraft/LICENSE-APACHE']);
    expect(files).toContain('crates/solidcraft/vendor/truck-shapeops/LICENSE');
    expect(files).toContain('crates/native-kernel/NOTICE.md');
    const npm = { count: 1, text: 'NPM SECTION' };
    const without = noticesText(root, npm, null);
    expect(without).toContain('NPM SECTION');
    expect(without).toContain('Third-party notices for the STEP reader');
    expect(without).toContain('Rust crates (not listed in this build)');
    expect(without).toContain('This build was made without cargo-about');
    const rust = rustNotices([{ ships: 'desktop app', report: report([['a@1.0.0', 'MIT']], [['MIT text', true, ['a@1.0.0']]]) }]);
    const full = noticesText(root, npm, rust);
    expect(full).toContain('3. Rust crates: 1 Rust crates');
    expect(full).toContain('a 1.0.0 (MIT; desktop app)\n' + '-'.repeat(100) + '\n\nMIT text');
    expect(full).not.toContain('without cargo-about');
  });
});
