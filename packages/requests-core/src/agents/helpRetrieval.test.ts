// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HELP_CONTEXT_CHARS, HELP_CHUNK_CHARS, retrieveUserHelp, splitMarkdownSections, userHelpIndex } from './digest.ts';
import type { DigestSection, HelpEditor } from './digest.ts';

function readGuides(dir = 'docs/help'): DigestSection[] {
  return readdirSync(new URL(`../../../../${dir}/`, import.meta.url), { withFileTypes: true }).flatMap(entry => {
    const path = `${dir}/${entry.name}`;
    return entry.isDirectory() ? readGuides(path) : entry.isFile() && entry.name.endsWith('.md')
      ? splitMarkdownSections(path, readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8')) : [];
  });
}
const guides = readGuides();

describe('user manual retrieval over the actual corpus', () => {
  it.each([
    ['layout', 'how do I draw a 8 sided polygon', '8s'],
    ['layout', 'octagon', '8s'],
    ['layout', 'I am trying to import an image file can you show me how', 'PNG'],
    ['layout', 'import JPG image', 'Main menu'],
    ['layout', 'import a photo', 'Import'],
    ['layout', 'what does import do and why use it', 'active page'],
    ['model', 'draw eight sided polygon', '8s'],
    ['layout', 'show polygon button', 'Draw'],
    ['layout', 'merge table cells', 'merge'],
    ...(['layout', 'model'] as const).flatMap(editor => [
      'how do I delete an object', 'how do I erase something', 'remove the pelican', 'get rid of this drawing', 'delete', 'erase',
    ].map(query => [editor, query, 'Backspace'] as const)),
    ['layout', 'export PDF', 'selectable'],
    ['layout', 'draw a rounded corner fillet radius', 'Fillet'],
    ['model', 'change model units', 'Model Info'],
    ['model', 'paste in place', 'Paste In Place'],
    ['model', 'parallel perpendicular inference', 'Down arrow'],
    ['home', 'sign in code', 'code'],
    ['home', 'save conflict', 'Save As'],
    ['home', 'cancel account deletion', 'Cancel deletion'],
  ] as const)('finds actionable help for %s: %s', (editor, query, expected) => {
    const answer = retrieveUserHelp(guides, query, editor);
    expect(answer.toLowerCase()).toContain(expected.toLowerCase());
    if (expected === 'Backspace') expect(answer.split('\n')[0]).toMatch(/Delete or remove a (?:drawing|model) object/);
    expect(answer.length).toBeLessThanOrEqual(HELP_CONTEXT_CHARS);
    expect(answer).not.toMatch(/\b(?:MOD|LAY|CLD|APP|FRQ|ADM)\d{4}\b/);
  });

  it('indexes only the active editor plus shared/cloud guides and reuses that index', () => {
    for (const editor of ['model', 'layout', 'home'] as HelpEditor[]) {
      const index = userHelpIndex(guides, editor);
      expect(userHelpIndex(guides, editor)).toBe(index);
      expect(index.sections.some(section => section.path.includes(`/help/${editor === 'model' ? 'layout' : 'modeling'}/`))).toBe(false);
    }
    expect(userHelpIndex(guides, 'all').sections.length).toBe(guides.length);
  });

  it.each(['Cut Path', 'how do I use Cut Path', 'Cut Path is now chosen', 'Cut Path target cutters apply'])('retrieves the complete Cut Path procedure for %s', query => {
    const answer = retrieveUserHelp(guides, query, 'layout');
    for (const step of ['Click the target path first', 'Then click each cutter path', 'preview', '**Enter**', '**Apply boolean**', '**Escape**', 'no fill', 'cutters are consumed', '**Undo**']) {
      expect(answer).toContain(step);
    }
    expect(answer.length).toBeLessThanOrEqual(HELP_CONTEXT_CHARS);
  });

  it.each([
    ['layout', 'Division', ['Click the target first', 'each cutter', '**Apply boolean**', '**Escape**']],
    ['layout', 'Difference', ['Click the target first', '**Apply boolean**', '**Undo**']],
    ['layout', 'Union', ['Click the target first', '**Apply boolean**']],
    ['layout', 'Intersection', ['Click the target first', '**Apply boolean**']],
    ['layout', 'Exclusion', ['Click the target first', '**Apply boolean**']],
    ['layout', 'Move', ['base point', 'click again to finish', '10mm, 5mm']],
    ['layout', 'copy array with Move', ['**Copy**', '**3x**', '**/3**']],
    ['layout', 'Rotate', ['reference direction', 'click a third time', '**30**']],
    ['layout', 'Scale', ['Drag a handle', 'release to commit', 'Escape']],
    ['layout', 'navigate model view', ['drag to orbit', 'Shift+drag', 'scroll to zoom', '**Escape**']],
    ['layout', 'Presentation mode', ['Page Down', '**Escape**']],
    ['model', 'Follow Me', ['click the profile face', 'connected path edges', 'Click to finish']],
    ['model', 'Offset', ['click the face', 'click again to commit', 'coplanar']],
    ['model', 'Subtract', ['Click the cutter first', 'second click applies', 'removes the cutter']],
    ['model', 'Trim', ['Click the cutter first', '**Trim** keeps the cutter']],
    ['model', 'Union', ['click the first solid', 'second click applies']],
    ['model', 'Outer Shell', ['two or more preselected solids', 'Escape']],
    ['model', 'Intersect', ['second click applies', 'shared volume', '**Undo**']],
    ['model', 'Split', ['second click applies', 'separate solid pieces']],
    ['model', 'Move', ['click a base point', 'click again to finish', 'Escape']],
    ['model', 'Rotate', ['center of rotation', 'set the baseline', 'click again to commit']],
    ['model', 'Scale', ['Drag a grip', 'release to commit', 'Escape']],
    ['model', 'Orbit', ['drag to turn', 'Release to stop']],
    ['model', 'Pan', ['drag to shift', 'Release to stop']],
    ['model', 'Zoom', ['drag upward', 'downward']],
    ['model', 'Zoom Window', ['drag a rectangle', 'release to frame', 'Escape']],
    ['model', 'Tape Measure distance', ['**Measure**', 'Click the start point', 'endpoint']],
    ['model', 'guide line Tape Measure', ['**Guide Lines**', 'parallel guide', 'press Enter']],
    ['model', 'Protractor', ['vertex', 'baseline', 'click a third time', 'Guide creation off']],
    ['model', 'Axes', ['new origin', 'red-axis direction', 'green-axis direction']],
    ['model', 'Push/Pull', ['click the face', 'click again to commit', 'Escape']],
    ['model', 'Line', ['Click a start point', 'endpoint', 'Escape']],
    ['model', 'Rectangle', ['first corner', 'opposite corner', 'Escape']],
    ['model', 'Rotated Rectangle', ['second corner', 'third point']],
    ['model', 'Freehand', ['Press and drag', 'release to finish', 'Escape']],
    ['model', '2 Point Arc', ['start, end, then bulge', 'last click completes']],
    ['model', 'Text', ['anchor leader text', 'press Enter', '**Edit Text**']],
    ['model', '3D Text', ['**Place**', 'click in the model', 'Escape']],
    ['model', 'Tag tool', ['pencil control', 'click an entity', 'Undo']],
    ['model', 'Paint Bucket replace material', ['Shift+click', 'Ctrl+Shift+click']],
    ['model', 'Section Plane', ['click to place the plane', 'Undo']],
    ['home', 'desktop update', ['**Restart to update**', '**Later**', '**Restart and update**']],
  ] as const)('retrieves practical %s steps for %s', (editor, query, steps) => {
    const answer = retrieveUserHelp(guides, query, editor);
    for (const step of steps) expect(answer).toContain(step);
    expect(answer.length).toBeLessThanOrEqual(HELP_CONTEXT_CHARS);
  });

  it('keeps the corpus in complete, small tasks and bounds even oversized stale inputs', () => {
    expect(guides.length).toBeGreaterThan(100);
    expect(guides.every(section => section.text.length <= HELP_CHUNK_CHARS)).toBe(true);
    const long = Array.from({ length: 12 }, (_, i) => ({ path: `docs/help/shared/test-${i}.md`, heading: 'Test '.repeat(1000), anchor: 'test', text: 'Test paragraph '.repeat(2000) }));
    expect(retrieveUserHelp(long, 'test', 'home').length).toBeLessThanOrEqual(HELP_CONTEXT_CHARS);
    expect(retrieveUserHelp(guides, 'xyzzymissingunicorn', 'layout')).toContain('No matching user help');
  });
});
