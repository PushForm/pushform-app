// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { BuilderPlanError } from '../builders/parts';
import { planFiller } from './plan';

const inch = 0.0254;
const refused = (run: () => unknown): BuilderPlanError => {
  try { run(); } catch (e) { if (e instanceof BuilderPlanError) return e; throw e; }
  throw new Error('expected a refusal');
};
const strip = (plan: ReturnType<typeof planFiller>) => plan.parts.find(p => p.name === 'Filler')!;

describe('planFiller', () => {
  it('matches the front of a base cabinet, flush with its doors, by default', () => {
    const plan = planFiller({ width: 3 * inch });
    expect(plan.at).toEqual([-3 * inch, -0.75 * inch, 4 * inch]);
    strip(plan).size.forEach((v, i) => expect(v).toBeCloseTo([30.5, 3, 0.75][i]! * inch, 9));
  });

  it('runs its grain up the strip', () => {
    expect(strip(planFiller({ width: 3 * inch })).x).toEqual([0, 0, 1]);
  });

  it('hangs a wall filler at wall cabinet height with no toe kick', () => {
    const plan = planFiller({ width: 3 * inch, type: 'wall' });
    expect(plan.at[2]).toBeCloseTo(54 * inch, 9);
    expect(strip(plan).size[0]).toBeCloseTo(30 * inch, 9);
  });

  it('takes a tall height of 80 in, the cabinet less its toe kick', () => {
    expect(strip(planFiller({ width: 3 * inch, type: 'tall' })).size[0]).toBeCloseTo(80 * inch, 9);
  });

  it('adds a return behind the chosen edge, touching the strip', () => {
    const left = planFiller({ width: 3 * inch, return: { side: 'left' } }).parts.find(p => p.name === 'Filler Return')!;
    left.size.forEach((v, i) => expect(v).toBeCloseTo([30.5, 3, 0.75][i]! * inch, 9));
    expect(left.origin[0]).toBeCloseTo(0.75 * inch, 9);
    expect(left.origin[1]).toBeCloseTo(0.75 * inch, 9);
    const right = planFiller({ width: 3 * inch, return: { side: 'right', depth: 2 * inch } }).parts.find(p => p.name === 'Filler Return')!;
    expect(right.size[1]).toBeCloseTo(2 * inch, 9);
    expect(right.origin[0]).toBeCloseTo(3 * inch, 9);
  });

  it('takes the stain or paint it is given', () => {
    expect(planFiller({ width: 3 * inch, finish: { stain: 'Wood_oak' } }).materials.finish).toEqual({ library: 'Wood_oak' });
    expect(planFiller({ width: 3 * inch, finish: { paint: '#102030' } }).materials.finish).toEqual({ paint: '#102030' });
  });

  it('refuses sizes outside the trade range and contradictory finishes', () => {
    expect(refused(() => planFiller({ width: 0.25 * inch })).code).toBe('invalid_geometry');
    expect(refused(() => planFiller({ width: 13 * inch })).code).toBe('invalid_geometry');
    expect(refused(() => planFiller({ width: 3 * inch, thickness: 2 * inch })).code).toBe('invalid_geometry');
    expect(refused(() => planFiller({ width: 0.5 * inch, return: { side: 'left' } })).code).toBe('invalid_geometry');
    expect(refused(() => planFiller({ width: 3 * inch, finish: { paint: '#ffffff', stain: 'x' } })).code).toBe('invalid_operation');
  });
});
