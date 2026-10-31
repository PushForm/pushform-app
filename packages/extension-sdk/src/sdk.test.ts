// SPDX-License-Identifier: MIT
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { isExtensionError, units } from './index.ts';

describe('isExtensionError', () => {
  it('recognizes host call failures by their code, optionally narrowed', () => {
    const error = Object.assign(new Error('changed'), { code: 'revision.stale' });
    expect(isExtensionError(error)).toBe(true);
    expect(isExtensionError(error, 'revision.stale', 'cancelled')).toBe(true);
    expect(isExtensionError(error, 'cancelled')).toBe(false);
    expect(isExtensionError(new Error('plain'))).toBe(false);
    expect(isExtensionError({ code: 'made.up', message: 'x' })).toBe(false);
    expect(isExtensionError(null)).toBe(false);
  });
});

describe('units', () => {
  it('converts workshop units to and from the API units', () => {
    expect(units.millimeters(19)).toBeCloseTo(0.019);
    expect(units.inches(0.75)).toBeCloseTo(0.01905);
    expect(units.feet(8)).toBeCloseTo(2.4384);
    expect(units.toInches(units.inches(3.5))).toBeCloseTo(3.5);
    expect(units.toBoardFeet(units.boardFeet(12))).toBeCloseTo(12);
    expect(units.boardFeet(1)).toBeCloseTo(0.00235974);
  });
});
