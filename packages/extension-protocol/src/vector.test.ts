// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { UI_LIMITS, UiTreeError, validateUiTree } from './ui.ts';

/** A 2440 x 1220 mm sheet with two parts, in meters. */
const sheet = (overrides: Record<string, unknown> = {}) => ({
  type: 'vector', id: 'sheet', label: 'Sheet 1', units: 'length',
  bounds: { x: 0, y: 0, width: 2.44, height: 1.22 },
  styles: [{ stroke: '#333333' }, { fill: '#e8d5b0', stroke: '#8a6d3b' }, { hatch: true, stroke: '#999999' }, {}],
  shapes: [
    { kind: 'rect', x: 0, y: 0, width: 2.44, height: 1.22, style: 0 },
    { kind: 'rect', x: 0.01, y: 0.01, width: 0.72, height: 0.4, style: 1, item: 'side', tip: 'Side, 720 x 400' },
    { kind: 'polyline', points: [0.8, 0.01, 1.4, 0.01, 1.4, 0.5], closed: true, style: 1, item: 'gusset' },
    { kind: 'rect', x: 2.0, y: 0.8, width: 0.44, height: 0.42, style: 2 },
    { kind: 'text', x: 0.37, y: 0.21, text: 'Side <A&B>', size: 0.04, anchor: 'middle', angle: 90, style: 3, item: 'side' },
  ],
  selected: ['side'],
  ...overrides,
});

const problem = (input: unknown): { code: string; message: string } => {
  try { validateUiTree(input); } catch (error) { if (error instanceof UiTreeError) return { code: error.code, message: error.message }; throw error; }
  throw new Error('expected the tree to be refused');
};

describe('vector views', () => {
  it('accept bounded shapes that refer to declared styles', () => {
    const tree = validateUiTree(sheet());
    expect(tree).toMatchObject({ type: 'vector', shapes: [{ kind: 'rect' }, { kind: 'rect', item: 'side' }, { kind: 'polyline' }, { kind: 'rect' }, { kind: 'text' }] });
  });

  it('refuse markup, unknown properties, missing styles and malformed points', () => {
    expect(problem(sheet({ svg: '<script/>' })).message).toMatch(/svg|Unrecognized/i);
    expect(problem(sheet({ shapes: [{ kind: 'path', d: 'M0 0' , style: 0 }] })).code).toBe('validation.failed');
    expect(problem(sheet({ shapes: [{ kind: 'rect', x: 0, y: 0, width: 1, height: 1, style: 0, onclick: 'x' }] })).message).toMatch(/shapes\.0/);
    expect(problem(sheet({ shapes: [{ kind: 'rect', x: 0, y: 0, width: 1, height: 1, style: 9 }] })).message).toMatch(/no style 9/);
    expect(problem(sheet({ shapes: [{ kind: 'polyline', points: [0, 0, 1, 1, 2], style: 0 }] })).message).toMatch(/pairs/);
    expect(problem(sheet({ styles: [{ fill: 'red' }] })).code).toBe('validation.failed');
    expect(problem(sheet({ bounds: { x: 0, y: 0, width: 0, height: 1 } })).code).toBe('validation.failed');
  });

  it('bound shapes and coordinates before parsing them', () => {
    const many = Array.from({ length: UI_LIMITS.vectorShapes + 1 }, () => ({ kind: 'rect', x: 0, y: 0, width: 1, height: 1, style: 0 }));
    expect(problem(sheet({ shapes: many })).code).toBe('validation.failed');
    const long = [{ kind: 'polyline', points: new Array(UI_LIMITS.vectorCoordinates + 2).fill(0), style: 0 }];
    expect(problem(sheet({ shapes: long }))).toMatchObject({ code: 'limit.exceeded', message: expect.stringMatching(/coordinates/) });
  });
});
