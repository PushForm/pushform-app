// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { TOOL_LIMITS, toolSourceSchema, toolViewSchema } from './tools';

describe('tool presentation boundary', () => {
  it('refuses executable styling, non-finite geometry and impossible boxes', () => {
    expect(toolViewSchema.safeParse({ instructor: 'Draw', style: 'background:red' }).success).toBe(false);
    for (const x of [NaN, Infinity, 1e13]) expect(toolViewSchema.safeParse({ instructor: 'Draw', overlay: [{ kind: 'point', position: [x, 0, 0], color: '#ffffff', shape: 'circle' }] }).success).toBe(false);
    expect(toolViewSchema.safeParse({ instructor: '', overlay: [{ kind: 'circle', center: [0, 0, 0], normal: [0, 0, 0], radius: 1, color: '#ffffff' }] }).success).toBe(false);
    expect(toolViewSchema.safeParse({ instructor: '', overlay: [{ kind: 'box', min: [1, 0, 0], max: [0, 0, 0], color: '#ffffff' }] }).success).toBe(false);
  });
  it('bounds aggregate preview points and primitive counts before rendering', () => {
    const line = { kind: 'polyline', points: Array.from({ length: TOOL_LIMITS.points / 2 + 1 }, () => [0, 0, 0]), color: '#ffffff' };
    expect(toolViewSchema.safeParse({ instructor: '', overlay: [line, line] }).success).toBe(false);
    expect(toolViewSchema.safeParse({ instructor: '', overlay: Array.from({ length: 513 }, () => ({ kind: 'point', position: [0, 0, 0], color: '#ffffff', shape: 'circle' })) }).success).toBe(false);
  });
  it('keeps labelled field/choice identities unambiguous', () => {
    const field = { id: 'width', label: 'Width', kind: 'length', value: '10mm' };
    expect(toolViewSchema.safeParse({ instructor: '', fields: [field, field] }).success).toBe(false);
    expect(toolViewSchema.safeParse({ instructor: '', choices: [{ id: 'mode', label: 'Mode', value: 'x', options: [{ value: 'y', label: 'Y' }] }] }).success).toBe(false);
    expect(toolViewSchema.safeParse({ instructor: '', choices: [{ id: 'mode', label: 'Mode', value: 'x', options: [{ value: 'x', label: 'X' }, { value: 'x', label: 'Again' }] }] }).success).toBe(false);
  });
  it('accepts captured measurement text for the tool parser without executing it', () => {
    expect(toolSourceSchema.parse({ kind: 'measurement', data: { text: '@+10mm', defaultUnit: 'mm' } }).data).toEqual({ text: '@+10mm', defaultUnit: 'mm' });
    expect(toolSourceSchema.safeParse({ kind: 'measurement', data: { text: '1', defaultUnit: 'mm', command: 'edit.delete' } }).success).toBe(false);
  });
  it('requires complete portable references and keeps universal cancel/navigation keys host-owned', () => {
    for (const ref of [{ kind: 'face', id: 1, path: [] }, { kind: 'edge', id: 1, path: [], edgeKey: 'not-an-edge' }, { kind: 'body', id: 1, path: [], faceId: 2 }])
      expect(toolViewSchema.safeParse({ instructor: '', inference: { ignore: [ref] } }).success).toBe(false);
    for (const key of ['Escape', 'Space', 'Control', 'Meta', 'KeyS']) expect(toolViewSchema.safeParse({ instructor: '', keys: [key] }).success).toBe(false);
    expect(toolViewSchema.parse({ instructor: '', keys: ['Enter', 'ArrowRight'] }).keys).toEqual(['Enter', 'ArrowRight']);
  });
});
