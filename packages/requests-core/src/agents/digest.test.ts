// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { formatDigestHit, searchDigest, slugify, splitMarkdownSections, tokenize } from './digest.ts';

const spec = `# Modeling specification

Intro paragraph about the modeler.

## Push/Pull

Push/Pull extrudes a face along its normal. Typing a distance moves the face exactly.

\`\`\`
## not a heading inside a fence
\`\`\`

## Inference locking

Holding Shift locks the current inference direction until released.
`;
const layout = `# Layout

## Tables

A table is inserted from the Insert menu and keeps its borders when resized.
`;

describe('splitMarkdownSections', () => {
  it('splits at ## headings, keeps the intro under the document title, and ignores fenced headings', () => {
    const s = splitMarkdownSections('specs/modeling.md', spec);
    expect(s.map((x) => x.heading)).toEqual(['Modeling specification', 'Push/Pull', 'Inference locking']);
    expect(s[0]?.text).toBe('Intro paragraph about the modeler.');
    expect(s[1]?.anchor).toBe('pushpull'); expect(s[1]?.text).toContain('## not a heading inside a fence');
    expect(s[2]).toMatchObject({ path: 'specs/modeling.md', anchor: 'inference-locking' });
  });
  it('slugifies like GitHub', () => { expect(slugify('Cloud & accounts: sign-in')).toBe('cloud--accounts-sign-in'); });
});

describe('searchDigest', () => {
  const sections = [...splitMarkdownSections('specs/modeling.md', spec), ...splitMarkdownSections('specs/layout.md', layout)];
  it('ranks keyword matches with heading boosts', () => {
    const hits = searchDigest(sections, 'how do I lock the inference direction?');
    expect(hits[0]?.section.heading).toBe('Inference locking');
    expect(hits.every((h) => h.score > 0)).toBe(true);
  });
  it('returns nothing for unknown words and respects the limit', () => {
    expect(searchDigest(sections, 'zebra giraffe')).toEqual([]);
    expect(searchDigest(sections, 'face table inference', 1)).toHaveLength(1);
  });
  it('stems words and drops stop words', () => {
    expect(tokenize('The tables are resized when locking')).toEqual(['tabl', 'resiz', 'lock']);
  });
  it('formats hits with source, anchor and clipped text', () => {
    const hit = searchDigest(sections, 'borders')[0]!;
    expect(formatDigestHit(hit)).toBe(`[specs/layout.md#tables] Tables\n${hit.section.text}`);
    expect(formatDigestHit(hit, 10)).toBe('[specs/layout.md#tables] Tables\nA table is…');
  });
});
