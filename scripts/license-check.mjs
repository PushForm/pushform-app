#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/* global console, process */
// License audit of every workspace package's production dependencies (licenses must be compatible with
// GPL-3.0-or-later; no AGPL, no GPL-2.0-only). It walks the installed graph the way Node resolves it, through pnpm's
// store, including optional dependencies (pnpm's own `licenses list` leaves those out, and native binaries
// arrive as optional dependencies).
//   node scripts/license-check.mjs [--list]
//   node scripts/license-check.mjs --notices [file]   license texts of the packages the web and desktop apps ship
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Zlib is the permissive source license used by pako in the PDF font embedder.
 * Licenses any production dependency may carry. OFL-1.1 (SIL Open Font License) covers the fonts 3D Text bundles
 * (`@fontsource/*`): it allows bundling them with software, only not selling the fonts on their own.
 */
export const ALLOWED = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'MPL-2.0', 'CC0-1.0',
  'Unlicense', 'Zlib', 'Python-2.0', 'BlueOak-1.0.0', 'CC-BY-4.0', 'OFL-1.1',
  // Permissive licenses found among the Rust crates (scripts/notices/about.toml accepts only licenses listed here).
  'BSL-1.0', 'Unicode-3.0', 'Unicode-DFS-2016',
  // GPLv3-compatible copyleft. GPL-2.0-only and every AGPL version are deliberately absent: GPL-2.0-only cannot be
  // combined with GPLv3 code, and AGPL adds network-source obligations that need a separate decision.
  'GPL-3.0-only', 'GPL-3.0-or-later', 'GPL-2.0-or-later', 'LGPL-3.0-only', 'LGPL-3.0-or-later', 'LGPL-2.1-only',
  'LGPL-2.1-or-later']);

/** Packages whose package.json states no license, with the license found by reading the package. */
export const REVIEWED = new Map();

/**
 * An SPDX id with its GPL-family version range made explicit: the deprecated `GPL-2.0+` means `GPL-2.0-or-later`
 * and a bare `GPL-3.0` (or `LGPL-2.1`, `AGPL-3.0`) means `-only`. Ranges are never merged: `GPL-2.0-only` is not
 * `GPL-2.0-or-later`.
 */
export function normalizeId(id) {
  if (/^A?L?GPL-\d(\.\d)?\+$/.test(id)) return `${id.slice(0, -1)}-or-later`;
  if (/^A?L?GPL-\d(\.\d)?$/.test(id)) return `${id}-only`;
  return id;
}

/**
 * Whether an SPDX license expression is acceptable when `ok(id)` says which single licenses are: `OR` needs one
 * side, `AND` both, and `WITH` exceptions follow their license.
 */
export function spdxAllows(expression, ok) {
  const tokens = expression.replace(/[()]/g, ' $& ').trim().split(/\s+/).filter(Boolean);
  let at = 0;
  const peek = () => tokens[at]?.toUpperCase();
  const or = () => {
    let value = and();
    while (peek() === 'OR') { at++; const right = and(); value = value || right; }
    return value;
  };
  const and = () => {
    let value = term();
    while (peek() === 'AND') { at++; const right = term(); value = value && right; }
    return value;
  };
  const term = () => {
    const token = tokens[at++];
    if (token === undefined) throw new Error(`incomplete license expression "${expression}"`);
    if (token === '(') {
      const value = or();
      if (tokens[at++] !== ')') throw new Error(`unbalanced license expression "${expression}"`);
      return value;
    }
    if (peek() === 'WITH') at += 2;
    return ok(normalizeId(token));
  };
  const value = or();
  if (at !== tokens.length) throw new Error(`unreadable license expression "${expression}"`);
  return value;
}

/** A package.json's license as one SPDX expression; legacy `licenses` arrays are alternatives. */
export function licenseOf(manifest) {
  const one = (entry) => typeof entry === 'string' ? entry : entry?.type;
  if (manifest.license) return one(manifest.license) ?? null;
  if (Array.isArray(manifest.licenses) && manifest.licenses.length)
    return manifest.licenses.map(one).filter(Boolean).map((id) => `(${id})`).join(' OR ') || null;
  return null;
}

/** Problems with one package's license under the policy; empty when it is allowed. */
export function licenseProblems(name, license) {
  if (!license) return [`${name}: no license in its package.json`];
  try {
    return spdxAllows(license, (id) => ALLOWED.has(id)) ? [] : [`${name}: ${license} is not allowed`];
  } catch (error) {
    return [`${name}: ${error.message}`];
  }
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** Workspace package directories from pnpm-workspace.yaml's `dir/*` globs, plus the root. */
export function workspaceDirs(root) {
  const yaml = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
  const globs = [...yaml.matchAll(/^\s*-\s*['"]?([^'"\s#]+)\/\*['"]?\s*$/gm)].map((m) => m[1]);
  const dirs = [root];
  for (const glob of globs) {
    const parent = join(root, glob);
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true }))
      if (entry.isDirectory() && existsSync(join(parent, entry.name, 'package.json'))) dirs.push(join(parent, entry.name));
  }
  return dirs;
}

/** Node's lookup of `name` from `dir`: the nearest node_modules/<name> up the tree, as its real path. */
function resolvePackage(name, dir) {
  for (let at = dir; ; at = dirname(at)) {
    const candidate = join(at, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) return dirname(realpathSync(candidate));
    if (dirname(at) === at) return null;
  }
}

const productionDeps = (manifest) => [
  ...Object.keys(manifest.dependencies ?? {}).map((name) => ({ name, optional: false })),
  ...Object.keys(manifest.optionalDependencies ?? {}).map((name) => ({ name, optional: true })),
];

/**
 * Every third-party package reachable from the workspace packages' `dependencies` and `optionalDependencies`
 * (never `devDependencies`), with its license, its directory and the chain that first reached it, and the policy
 * problems found. Optional dependencies that are not installed (other platforms' binaries) cannot be read and are
 * skipped. `from` (directories relative to the root) starts the walk at those workspace packages only, following
 * their workspace dependencies, instead of at every workspace package. `skip` names packages whose subtree the walk
 * leaves out entirely.
 */
export function auditLicenses(root, { from, skip = new Map() } = {}) {
  const workspace = new Set(workspaceDirs(root).map((dir) => realpathSync(dir)));
  const starts = from ? from.map((dir) => realpathSync(join(root, dir))) : [...workspace];
  const packages = new Map();
  const problems = [];
  const queue = starts.map((dir) => ({ dir, chain: [readJson(join(dir, 'package.json')).name ?? relative(root, dir)] }));
  const seen = new Set(from ? starts : workspace);
  while (queue.length) {
    const { dir, chain } = queue.shift();
    for (const dep of productionDeps(readJson(join(dir, 'package.json')))) {
      if (skip.has(dep.name)) continue;
      const found = resolvePackage(dep.name, dir);
      if (!found) {
        if (!dep.optional) problems.push(`${dep.name}: not installed (needed by ${chain.join(' > ')})`);
        continue;
      }
      if (seen.has(found)) continue;
      seen.add(found);
      const manifest = readJson(join(found, 'package.json'));
      const name = manifest.name ?? dep.name;
      if (workspace.has(found)) {
        queue.push({ dir: found, chain: [...chain, name] });
        continue;
      }
      const license = licenseOf(manifest) ?? REVIEWED.get(name) ?? null;
      const via = [...chain, name];
      packages.set(`${name}@${manifest.version}`, { name, version: manifest.version, license, via, dir: found });
      for (const problem of licenseProblems(name, license)) problems.push(`${problem} (via ${via.join(' > ')})`);
      queue.push({ dir: found, chain: via });
    }
  }
  return { packages: [...packages.values()].sort((a, b) => a.name.localeCompare(b.name)), problems };
}

/** The directories of the workspace packages whose production dependencies ship in the web and desktop apps. */
export const SHIPPED = ['apps/web', 'apps/desktop'];

/**
 * Production dependencies that only run under Node, never in the web bundle or the desktop app, each with the reason.
 * The notices walk leaves out their subtrees, including the platform-specific native binaries a machine happens to
 * install; the full license check still audits them.
 */
export const NOT_SHIPPED = new Map([
  ['sharp', 'Node image library behind ndarray-pixels\' Node entry point; browser builds use its canvas entry point'],
]);

/**
 * Shipped packages whose published package carries no license file, each with the reason it is accepted. Their notices
 * name the license, authors and source from package.json and give the license's standard terms.
 */
export const NO_LICENSE_FILE = new Map([
  ['@jscadui/3mf-export', 'published without a license file; MIT per its package.json'],
  ['@nodable/entities', 'published without a license file; MIT per its package.json and README'],
  ['@pdf-lib/fontkit', 'published without a license file; MIT per its package.json and README'],
  ['openskp', 'published without a license file; MIT per its package.json and README'],
  ['splaytree', 'published without a license file; MIT per its package.json'],
  ['standardwebhooks', 'published without a license file; MIT per its package.json'],
]);

/** Standard license terms, by SPDX id, for the packages NO_LICENSE_FILE accepts. */
export const STANDARD_TERMS = new Map([['MIT', `MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`]]);

const LICENSE_FILE = /^(licen[cs]e|copying|unlicense)([-._ ].*)?$/i;
const NOTICE_FILE = /^notice([-._ ].*)?$/i;

/** Text with LF line ends, no trailing spaces and no surrounding blank lines, so equal licenses compare equal. */
export const normalizeText = (text) => text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();

/**
 * The license and NOTICE files of a package directory: those at its top, then those one directory down (bundled
 * components such as decoders and fonts carry their own), never inside node_modules. Paths use `/`.
 */
export function packageNoticeFiles(dir) {
  const files = [];
  const scan = (at, prefix) => {
    const entries = readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries)
      if (entry.isFile() && (LICENSE_FILE.test(entry.name) || NOTICE_FILE.test(entry.name)))
        files.push({ path: prefix + entry.name, notice: NOTICE_FILE.test(entry.name),
          text: normalizeText(readFileSync(join(at, entry.name), 'utf8')) });
    return entries;
  };
  for (const entry of scan(dir, ''))
    if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) scan(join(dir, entry.name), `${entry.name}/`);
  return files.filter((file) => file.text);
}

const person = (entry) => typeof entry === 'string' ? entry : entry?.name;
const repositoryOf = (manifest) => {
  const repository = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
  return repository?.replace(/^git\+/, '').replace(/\.git$/, '') || manifest.homepage || null;
};

/**
 * Notices for npm packages (records from auditLicenses). Packages whose license and NOTICE files are identical share
 * one group, so each text is written once. A package without a license file is a problem unless `accepted`
 * (NO_LICENSE_FILE) lists it, in which case its text names its authors and gives its license's standard terms. An
 * accepted package that is no longer shipped, or now has a license file, is a problem too, so the list stays current.
 */
export function npmNotices(packages, accepted = NO_LICENSE_FILE) {
  const groups = new Map();
  const problems = [];
  const unused = new Set(accepted.keys());
  for (const pkg of packages) {
    let files = packageNoticeFiles(pkg.dir);
    if (files.some((file) => !file.notice)) {
      if (accepted.has(pkg.name)) problems.push(`${pkg.name}@${pkg.version}: has a license file now; remove it from NO_LICENSE_FILE`);
    } else {
      const terms = STANDARD_TERMS.get(pkg.license);
      if (!accepted.has(pkg.name) || !terms) {
        problems.push(`${pkg.name}@${pkg.version}: no license file in the package`);
        continue;
      }
      unused.delete(pkg.name);
      const manifest = readJson(join(pkg.dir, 'package.json'));
      const authors = [person(manifest.author), ...(manifest.contributors ?? []).map(person)].filter(Boolean);
      const facts = [`${pkg.name} ${pkg.version} is published without a license file; its package.json states ${pkg.license}.`,
        authors.length ? `Authors: ${authors.join(', ')}.` : null,
        repositoryOf(manifest) ? `Source: ${repositoryOf(manifest)}` : null].filter(Boolean).join('\n');
      files = [...files, { path: 'package.json', notice: false, text: `${facts}\n\n${terms}` }];
    }
    const text = files.map((file) => files.length > 1 ? `--- ${file.path} ---\n\n${file.text}` : file.text).join('\n\n');
    if (!groups.has(text)) groups.set(text, []);
    groups.get(text).push(pkg);
  }
  for (const name of unused) if (!packages.some((pkg) => pkg.name === name)) problems.push(`${name}: no longer shipped; remove it from NO_LICENSE_FILE`);
  return { groups: [...groups].map(([text, members]) => ({ text, packages: members })), problems };
}

/** A notices section as plain text: a heading, an introduction, then each group's members above the text they share. */
export function formatGroups(title, intro, groups, label) {
  const rule = '='.repeat(100);
  const line = '-'.repeat(100);
  const out = [rule, title, rule, '', intro, ''];
  for (const group of groups) out.push(line, ...group.packages.map(label), line, '', group.text, '');
  return out.join('\n');
}

/** The npm section of the third-party notices: its text, package and group counts, and what keeps it incomplete. */
export function npmNoticesSection(root) {
  const { packages, problems } = auditLicenses(root, { from: SHIPPED, skip: NOT_SHIPPED });
  const notices = npmNotices(packages);
  const text = formatGroups('JavaScript packages',
    `The web app, and the desktop app's interface, include these ${packages.length} npm packages. Packages that share`
      + ' the same license and notice files are listed together above them.',
    notices.groups, (pkg) => `${pkg.name} ${pkg.version} (${pkg.license})`);
  return { text, count: packages.length, groups: notices.groups.length, problems: [...problems, ...notices.problems] };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const at = process.argv.indexOf('--notices');
  if (at >= 0) {
    const { text, count, groups, problems } = npmNoticesSection(root);
    const file = process.argv[at + 1];
    if (file) writeFileSync(file, `${text}\n`);
    else process.stdout.write(`${text}\n`);
    console.error(`license-check: notices for ${count} shipped packages in ${groups} license groups`);
    for (const problem of problems) console.error(`license-check: ${problem}`);
    process.exit(problems.length ? 1 : 0);
  }
  const { packages, problems } = auditLicenses(root);
  const counts = new Map();
  for (const p of packages) counts.set(p.license ?? 'none', (counts.get(p.license ?? 'none') ?? 0) + 1);
  if (process.argv.includes('--list'))
    for (const p of packages) console.log(`${p.name}@${p.version}  ${p.license ?? 'none'}  (${p.via.join(' > ')})`);
  console.log(`license-check: ${packages.length} production packages: ` +
    [...counts].sort((a, b) => b[1] - a[1]).map(([license, n]) => `${n} ${license}`).join(', '));
  if (problems.length) {
    for (const problem of problems) console.error(`license-check: ${problem}`);
    process.exit(1);
  }
}
