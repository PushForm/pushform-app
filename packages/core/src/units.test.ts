// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { parseLength, formatLength, DEFAULT_UNITS, toMeters, typedLengthUnit } from './units';

describe('parseLength', () => {
  it('parses bare numbers in the default unit', () => {
    expect(parseLength('10', 'in')).toBeCloseTo(toMeters(10, 'in'));
    expect(parseLength('2.5', 'm')).toBeCloseTo(2.5);
  });
  it('parses explicit units', () => {
    expect(parseLength('10"', 'm')).toBeCloseTo(0.254);
    expect(parseLength("10'", 'm')).toBeCloseTo(3.048);
    expect(parseLength('10mm', 'in')).toBeCloseTo(0.01);
    expect(parseLength('2.5m', 'in')).toBeCloseTo(2.5);
  });
  it('parses feet and inches and fractions', () => {
    expect(parseLength(`3' 6"`, 'm')).toBeCloseTo(3 * 0.3048 + 6 * 0.0254);
    expect(parseLength(`3'6`, 'm')).toBeCloseTo(3 * 0.3048 + 6 * 0.0254);
    expect(parseLength(`1 1/2"`, 'm')).toBeCloseTo(1.5 * 0.0254);
    expect(parseLength(`-4cm`, 'm')).toBeCloseTo(-0.04);
  });
  it('rejects garbage', () => {
    expect(parseLength('abc', 'm')).toBeNull();
    expect(parseLength('', 'm')).toBeNull();
  });
});

describe('formatLength', () => {
  it('formats architectural', () => {
    expect(formatLength(toMeters(42.5, 'in'), DEFAULT_UNITS)).toBe(`3' 6 1/2"`);
    expect(formatLength(toMeters(36, 'in'), DEFAULT_UNITS)).toBe(`3'`);
    expect(formatLength(toMeters(5, 'in'), DEFAULT_UNITS)).toBe(`5"`);
  });
  it('formats decimal metric', () => {
    expect(formatLength(1.2345, { ...DEFAULT_UNITS, format: 'decimal', lengthUnit: 'm', lengthPrecision: 2 })).toBe('1.23m');
  });
});

describe('typedLengthUnit', () => {
  it('reads architectural and fractional lengths in inches, engineering in feet and decimal in the length unit', () => {
    expect(typedLengthUnit({ format: 'architectural', lengthUnit: 'in' })).toBe('in');
    expect(typedLengthUnit({ format: 'fractional', lengthUnit: 'in' })).toBe('in');
    expect(typedLengthUnit({ format: 'engineering', lengthUnit: 'ft' })).toBe('ft');
    for (const unit of ['mm', 'cm', 'm', 'in', 'ft', 'yd'] as const) expect(typedLengthUnit({ format: 'decimal', lengthUnit: unit })).toBe(unit);
    expect(parseLength('1 1/2', typedLengthUnit({ format: 'fractional', lengthUnit: 'in' }))).toBeCloseTo(0.0381, 9);
    expect(parseLength('12.5', typedLengthUnit({ format: 'engineering', lengthUnit: 'ft' }))).toBeCloseTo(3.81, 9);
  });
});
