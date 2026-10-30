// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { duplicateRequirementIds, readSpecs, requirementDefinitions } from './spec-ids.mjs';

describe('spec-ids', () => {
  it('finds definitions at the start of a line only, with their detail suffixes', () => {
    const defs = requirementDefinitions({
      'specs/a.md': 'MOD0100 - One.\nMOD0100.01 - Detail.\nSee MOD0200 - not a definition.\n',
      'specs/b.md': 'LAY0100 - Layout one.\n\n```text\nLAY0100 - An example in a code block is not a definition.\n```\n',
    });
    expect([...defs.keys()]).toEqual(['MOD0100', 'MOD0100.01', 'LAY0100']);
    expect(defs.get('MOD0100')).toEqual([{ file: 'specs/a.md', line: 1 }]);
  });

  it('reports an ID defined in two files, or twice in one, with every place', () => {
    const duplicates = duplicateRequirementIds({
      'specs/extensions.md': 'MOD3100 - Tools.\nMOD3110 - Pointer.\n',
      'specs/modeling.md': 'MOD3100 - Images.\n\nMOD3110 - Import.\nMOD3110 - Again.\nMOD3120 - Fine.\n',
    });
    expect(duplicates).toEqual([
      ['MOD3100', [{ file: 'specs/extensions.md', line: 1 }, { file: 'specs/modeling.md', line: 1 }]],
      ['MOD3110', [{ file: 'specs/extensions.md', line: 2 }, { file: 'specs/modeling.md', line: 3 }, { file: 'specs/modeling.md', line: 4 }]],
    ]);
    expect(duplicateRequirementIds({ 'specs/a.md': 'MOD0100 - One.\n' })).toEqual([]);
  });

  // Without a specs/ directory there is nothing to check.
  const specsRoot = join(fileURLToPath(import.meta.url), '..', '..');
  it.skipIf(!Object.keys(readSpecs(specsRoot)).length)('finds no duplicate requirement IDs in the specs (PF-273)', () => {
    const specs = readSpecs(specsRoot);
    expect(Object.keys(specs)).toContain('specs/modeling.md');
    expect(duplicateRequirementIds(specs)).toEqual([]);
  });
});
