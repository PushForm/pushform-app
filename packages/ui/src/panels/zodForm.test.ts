// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { describeSchema, parseNumberInput } from './zodForm';

describe('describeSchema', () => {
  it('maps a z.object shape to field specs (wrappers unwrapped, tuples of 3 numbers as vec3)', () => {
    const schema = z
      .object({
        n: z.number().default(3),
        i: z.number().int().optional(),
        s: z.string(),
        b: z.boolean().nullable(),
        e: z.enum(['a', 'b']),
        lit: z.literal('x'),
        v: z.tuple([z.number(), z.number(), z.number()]),
        t2: z.tuple([z.number(), z.number()]),
        o: z.object({ x: z.number() }),
        arr: z.array(z.number()),
        u: z.union([z.string(), z.number()]),
      })
      .refine(() => true);
    expect(describeSchema(schema)).toEqual([
      { key: 'n', kind: 'number', optional: true, int: false },
      { key: 'i', kind: 'number', optional: true, int: true },
      { key: 's', kind: 'string', optional: false },
      { key: 'b', kind: 'boolean', optional: true },
      { key: 'e', kind: 'enum', optional: false, options: ['a', 'b'] },
      { key: 'lit', kind: 'enum', optional: false, options: ['x'] },
      { key: 'v', kind: 'vec3', optional: false },
      { key: 't2', kind: 'json', optional: false },
      { key: 'o', kind: 'json', optional: false },
      { key: 'arr', kind: 'json', optional: false },
      { key: 'u', kind: 'json', optional: false },
    ]);
  });

  it('returns null for non-object schemas and undefined', () => {
    expect(describeSchema(z.number())).toBeNull();
    expect(describeSchema(undefined)).toBeNull();
    expect(describeSchema(z.object({}))).toEqual([]);
  });

  it('parseNumberInput', () => {
    expect(parseNumberInput(' 2.5 ', false)).toBe(2.5);
    expect(parseNumberInput('2.5', true)).toBe(3);
    expect(parseNumberInput('', false)).toBeNull();
    expect(parseNumberInput('abc', false)).toBeNull();
  });
});
