// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/* global console, process */
// Requirement IDs must be unique across every specification file (specs/README.md): a block reserved in one file
// cannot be reused in another. `node scripts/spec-ids.mjs` lists each ID defined twice and exits 1 when any is.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A requirement definition: an ID at the start of a line, followed by " - ". */
const DEFINITION = /^((?:LAY|MOD|CLD|APP|FRQ|ADM)\d{4}(?:\.\d{2})?) - /;

/** Every requirement definition in `files` (path → markdown), as id → [{ file, line }]. Fenced code blocks hold
 * examples (specs/README.md shows the format), not definitions. */
export function requirementDefinitions(files) {
  const byId = new Map();
  for (const [file, text] of Object.entries(files)) {
    let fenced = false;
    text.split('\n').forEach((content, index) => {
      if (/^\s*```/.test(content)) { fenced = !fenced; return; }
      const match = fenced ? null : DEFINITION.exec(content);
      if (!match) return;
      const id = match[1];
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push({ file, line: index + 1 });
    });
  }
  return byId;
}

/** IDs defined more than once, each with every place it is defined, sorted by ID. */
export function duplicateRequirementIds(files) {
  return [...requirementDefinitions(files)].filter(([, places]) => places.length > 1).sort(([a], [b]) => a.localeCompare(b));
}

/**
 * The specification files, path → text: every `.md` in `specs/` under the repository root (or under SPECS_DIR).
 * Empty when there is no `specs/` directory, as in a checkout without the specifications.
 */
export function readSpecs(root) {
  const base = process.env.SPECS_DIR ?? root;
  const dir = join(base, 'specs');
  if (!existsSync(dir)) return {};
  return Object.fromEntries(readdirSync(dir).filter(name => name.endsWith('.md')).sort().map(name => [`specs/${name}`, readFileSync(join(dir, name), 'utf8')]));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(fileURLToPath(import.meta.url), '..', '..');
  const specs = readSpecs(root);
  if (!Object.keys(specs).length) console.log('No specs/ directory found (set SPECS_DIR); nothing to check.');
  const duplicates = duplicateRequirementIds(specs);
  for (const [id, places] of duplicates) console.error(`${id} is defined ${places.length} times: ${places.map(p => `${p.file}:${p.line}`).join(', ')}`);
  if (duplicates.length) process.exit(1);
  if (Object.keys(specs).length) console.log('Requirement IDs are unique across specs/.');
}
