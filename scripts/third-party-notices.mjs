#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/* global Buffer, console, process */
// Writes THIRD_PARTY_NOTICES.txt, the license texts and notices of the third-party software in PushForm's builds:
// - the npm packages the web and desktop apps ship (scripts/license-check.mjs --notices),
// - the STEP reader's, its geometry kernel's and the native kernel's notices, verbatim (crates/step-reader,
//   crates/solidcraft, crates/native-kernel),
// - the Rust crates of the STEP reader and of the desktop app, from `cargo about` (scripts/notices/about.toml).
// The web build copies it into apps/web/dist/third-party-notices.txt, and desktop release builds bundle that file.
//
//   node scripts/third-party-notices.mjs [--out file] [--complete]
//
// Generation fails when a shipped package or crate has no license text or a license the policy does not allow.
// Without cargo-about (`cargo install cargo-about --locked --features cli`) the Rust crates cannot be listed: that
// fails in CI, with --complete, or with PUSHFORM_NOTICES=complete, and otherwise writes the file without them and
// warns, so local builds work without it. Release builds always run in CI.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatGroups, normalizeText, npmNoticesSection } from './license-check.mjs';

/** The Rust workspaces that ship, the build each one is part of, and the targets their crates are resolved for. */
export const RUST_WORKSPACES = [
  { manifest: 'crates/step-reader/Cargo.toml', ships: 'web app STEP reader',
    targets: ['wasm32-wasip1', 'wasm32-wasip1-threads'] },
  { manifest: 'apps/desktop/src-tauri/Cargo.toml', ships: 'desktop app',
    targets: ['x86_64-pc-windows-msvc', 'aarch64-apple-darwin', 'x86_64-unknown-linux-gnu'] },
  { manifest: 'crates/native-kernel/Cargo.toml', ships: 'desktop app, native kernel builds',
    targets: ['x86_64-pc-windows-msvc', 'aarch64-apple-darwin', 'x86_64-unknown-linux-gnu'] },
];

/** Notice and license files carried with the STEP reader and the SolidCraft kernel, included verbatim. */
export function verbatimNoticeFiles(root) {
  const vendor = join(root, 'crates/solidcraft/vendor');
  return ['crates/step-reader/NOTICE.md', 'crates/solidcraft/NOTICE-solidcraft.txt', 'crates/solidcraft/LICENSE-MIT',
    'crates/solidcraft/LICENSE-APACHE', 'crates/native-kernel/NOTICE.md',
    ...readdirSync(vendor, { withFileTypes: true }).filter((entry) => entry.isDirectory())
      .map((entry) => `crates/solidcraft/vendor/${entry.name}/LICENSE`).sort()];
}

/**
 * Rust crates from `cargo about generate --format json` reports (one per workspace, with the build it ships in),
 * grouped by identical license text like the npm packages. A crate whose license text is only the license's standard
 * wording (the crate carries no license file) lists its authors and source. A crate with no license text is a problem.
 */
export function rustNotices(reports) {
  const crates = new Map();
  for (const { ships, report } of reports) {
    const texts = new Map();
    for (const license of report.licenses)
      for (const use of license.used_by) {
        const id = use.crate.id;
        if (!texts.has(id)) texts.set(id, []);
        texts.get(id).push({ text: normalizeText(license.text), own: Boolean(license.source_path) });
      }
    for (const { package: pkg } of report.crates) {
      const known = crates.get(pkg.id);
      if (known) { known.ships.add(ships); continue; }
      crates.set(pkg.id, { name: pkg.name, version: pkg.version, license: pkg.license ?? null, authors: pkg.authors ?? [],
        repository: pkg.repository ?? null, ships: new Set([ships]), texts: texts.get(pkg.id) ?? [] });
    }
  }
  const groups = new Map();
  const problems = [];
  for (const crate of [...crates.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))) {
    if (!crate.texts.length) { problems.push(`${crate.name}@${crate.version}: no license text found`); continue; }
    const text = [...new Set(crate.texts.map((entry) => entry.text))].join('\n\n');
    if (!groups.has(text)) groups.set(text, []);
    groups.get(text).push(crate);
  }
  return { count: crates.size, groups: [...groups].map(([text, members]) => ({ text, packages: members })), problems };
}

/** A crate's line in the notices: name, version, license and builds, then authors and source when it has no license file. */
export function crateLabel(crate) {
  const line = `${crate.name} ${crate.version} (${crate.license ?? 'unknown'}; ${[...crate.ships].join(', ')})`;
  if (crate.texts.some((entry) => entry.own)) return line;
  return [line, crate.authors.length ? `  Authors: ${crate.authors.join(', ')}` : null,
    crate.repository ? `  Source: ${crate.repository}` : null].filter(Boolean).join('\n');
}

const run = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'], ...options });

/** cargo-about's version, or null when it is not installed. */
export function cargoAboutVersion() {
  try {
    return run('cargo', ['about', '--version'], { stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/**
 * The cargo-about report of each Rust workspace, cached in node_modules/.cache by the inputs that decide it (the
 * cargo-about version, its configuration, and each workspace's Cargo.toml and Cargo.lock), so repeated builds skip it.
 */
export function cargoAboutReports(root, version) {
  const config = join(root, 'scripts/notices/about.toml');
  const cache = join(root, 'node_modules/.cache/pushform-notices');
  return RUST_WORKSPACES.map(({ manifest, ships, targets }) => {
    const path = join(root, manifest);
    const hash = createHash('sha256').update(`${version}\n${targets.join(' ')}\n`);
    for (const file of [config, path, join(dirname(path), 'Cargo.lock')]) hash.update(readFileSync(file));
    const cached = join(cache, `${hash.digest('hex').slice(0, 24)}.json`);
    if (existsSync(cached)) return { ships, report: JSON.parse(readFileSync(cached, 'utf8')) };
    // cargo-about refuses redirected output in PowerShell, so it writes to a file that is read back.
    mkdirSync(cache, { recursive: true });
    const raw = `${cached}.raw`;
    run('cargo', ['about', 'generate', '--format', 'json', '--fail', '--locked', '-c', config, '-m', path,
      ...targets.flatMap((target) => ['--target', target]), '-o', raw]);
    const full = JSON.parse(readFileSync(raw, 'utf8'));
    rmSync(raw, { force: true });
    const report = {
      crates: full.crates.map(({ package: pkg }) => ({ package: { id: pkg.id, name: pkg.name, version: pkg.version,
        license: pkg.license, authors: pkg.authors, repository: pkg.repository } })),
      licenses: full.licenses.map((license) => ({ text: license.text, source_path: license.source_path,
        used_by: license.used_by.map((use) => ({ crate: { id: use.crate.id } })) })),
    };
    mkdirSync(cache, { recursive: true });
    writeFileSync(cached, JSON.stringify(report));
    return { ships, report };
  });
}

/**
 * The whole notices file. `rust` is the list of cargo-about reports, or null when cargo-about is unavailable, which
 * leaves the crate list out and says so in the file.
 */
export function noticesText(root, npm, rust) {
  const rule = '='.repeat(100);
  const files = verbatimNoticeFiles(root);
  const rustCount = rust ? `${rust.count} Rust crates` : 'Rust crates (not listed in this build)';
  const header = [
    'PushForm third-party notices',
    '',
    'PushForm is free software, licensed under the GNU General Public License, version 3 or later. Its web and',
    'desktop apps include third-party software that keeps its own license. This file gives the license texts and',
    'notices of that software, generated from the dependency graphs of the build it ships with.',
    '',
    'Contents:',
    `  1. JavaScript packages: ${npm.count} npm packages in the web app and the desktop app's interface, including the`,
    '     fonts 3D text uses and the PDF reader with its image decoders.',
    '  2. STEP reader and geometry kernel: notices of the STEP reader, in both apps.',
    `  3. Rust crates: ${rustCount} of the STEP reader and of the desktop app's native code.`,
    '',
  ].join('\n');
  const verbatim = [rule, 'STEP reader and geometry kernel', rule, '',
    'The STEP reader (WebAssembly in the web app, native code in the desktop app) carries these notices and licenses.',
    'native-kernel/NOTICE.md applies only to desktop builds made with the native kernel feature.', '',
    ...files.flatMap((file) => ['-'.repeat(100), file.replace(/^crates\//, ''), '-'.repeat(100), '',
      normalizeText(readFileSync(join(root, file), 'utf8')), ''])].join('\n');
  const crates = rust
    ? formatGroups('Rust crates',
      `The STEP reader and the desktop app's native code include these ${rust.count} Rust crates; each line names the`
        + ' builds it is part of. Crates that share a license text are listed together above it.',
      rust.groups, crateLabel)
    : [rule, 'Rust crates', rule, '',
      'This build was made without cargo-about, so its Rust crates are not listed here. Release builds list them.', ''].join('\n');
  return [header, npm.text, verbatim, crates].join('\n');
}

/**
 * Generates the notices. Returns the text, a one-line summary, whether the Rust crates are listed, and the problems
 * that make the build fail.
 */
export function generateNotices(root, { requireRust = false } = {}) {
  const npm = npmNoticesSection(root);
  const problems = [...npm.problems];
  const version = cargoAboutVersion();
  let rust = null;
  if (version) {
    try {
      rust = rustNotices(cargoAboutReports(root, version));
      problems.push(...rust.problems);
    } catch (error) {
      problems.push(`cargo about failed: ${error.message.split('\n')[0]}`);
    }
  } else if (requireRust) {
    problems.push('cargo-about is not installed; install it with `cargo install cargo-about --locked --features cli`');
  }
  const text = noticesText(root, npm, rust);
  const summary = `${npm.count} npm packages in ${npm.groups} license groups, `
    + (rust ? `${rust.count} Rust crates in ${rust.groups.length} license groups` : 'Rust crates not listed (no cargo-about)')
    + `, ${Math.round(Buffer.byteLength(text) / 1024)} KiB`;
  return { text, summary, complete: Boolean(rust), problems };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--out');
  const out = at >= 0 ? argv[at + 1] : join(root, 'THIRD_PARTY_NOTICES.txt');
  const requireRust = argv.includes('--complete') || (Boolean(process.env.CI) && process.env.CI !== 'false') || process.env.PUSHFORM_NOTICES === 'complete';
  const { text, summary, complete, problems } = generateNotices(root, { requireRust });
  if (problems.length) {
    for (const problem of problems) console.error(`third-party-notices: ${problem}`);
    process.exit(1);
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${text}\n`);
  console.log(`third-party-notices: ${summary}`);
  if (!complete)
    console.warn('third-party-notices: warning: cargo-about is not installed, so the Rust crates are not listed. '
      + 'Install it with `cargo install cargo-about --locked --features cli` before making a build to distribute.');
}
