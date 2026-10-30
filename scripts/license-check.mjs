#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/* global console, process */
// License audit of every workspace package's production dependencies (licenses must be compatible with
// GPL-3.0-or-later; no AGPL, no GPL-2.0-only). It walks the installed graph the way Node resolves it, through pnpm's
// store, including optional dependencies (pnpm's own `licenses list` leaves those out, and native binaries
// arrive as optional dependencies). Usage: node scripts/license-check.mjs [--list]
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Zlib is the permissive source license used by pako in the PDF font embedder.
 * Licenses any production dependency may carry. OFL-1.1 (SIL Open Font License) covers the fonts 3D Text bundles
 * (`@fontsource/*`): it allows bundling them with software, only not selling the fonts on their own.
 */
export const ALLOWED = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'MPL-2.0', 'CC0-1.0',
  'Unlicense', 'Zlib', 'Python-2.0', 'BlueOak-1.0.0', 'CC-BY-4.0', 'OFL-1.1',
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
 * (never `devDependencies`), with its license and the chain that first reached it, and the policy problems found.
 * Optional dependencies that are not installed (other platforms' binaries) cannot be read and are skipped.
 */
export function auditLicenses(root) {
  const workspace = new Set(workspaceDirs(root).map((dir) => realpathSync(dir)));
  const packages = new Map();
  const problems = [];
  const queue = [...workspace].map((dir) => ({ dir, chain: [readJson(join(dir, 'package.json')).name ?? relative(root, dir)] }));
  const seen = new Set(workspace);
  while (queue.length) {
    const { dir, chain } = queue.shift();
    for (const dep of productionDeps(readJson(join(dir, 'package.json')))) {
      const found = resolvePackage(dep.name, dir);
      if (!found) {
        if (!dep.optional) problems.push(`${dep.name}: not installed (needed by ${chain.join(' > ')})`);
        continue;
      }
      if (seen.has(found)) continue;
      seen.add(found);
      const manifest = readJson(join(found, 'package.json'));
      const name = manifest.name ?? dep.name;
      const license = licenseOf(manifest) ?? REVIEWED.get(name) ?? null;
      const via = [...chain, name];
      packages.set(`${name}@${manifest.version}`, { name, version: manifest.version, license, via });
      for (const problem of licenseProblems(name, license)) problems.push(`${problem} (via ${via.join(' > ')})`);
      queue.push({ dir: found, chain: via });
    }
  }
  return { packages: [...packages.values()].sort((a, b) => a.name.localeCompare(b.name)), problems };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
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
