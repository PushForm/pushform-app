// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { PAPER_PRESETS, formatPaperLength, paperPresetFor, presetSizeMm, toMm } from './layoutPaper';

describe('paper presets', () => {
  it('lists US sizes before international ones', () => {
    const standards = PAPER_PRESETS.map(preset => preset.standard);
    expect(standards.indexOf('International')).toBeGreaterThan(standards.lastIndexOf('US'));
    expect(PAPER_PRESETS[0]).toMatchObject({ id: 'letter', unit: 'in' });
    expect(PAPER_PRESETS.find(preset => preset.id === 'A4')).toMatchObject({ sizeMm: [210, 297], unit: 'mm' });
  });

  it('matches sizes in either orientation and keeps the current orientation', () => {
    expect(paperPresetFor([297, 210])?.id).toBe('A4');
    expect(paperPresetFor([215.9, 279.4])?.id).toBe('letter');
    expect(paperPresetFor([300, 200])).toBeUndefined();
    const letter = PAPER_PRESETS[0]!;
    expect(presetSizeMm(letter, [297, 210])).toEqual([279.4, 215.9]);
    expect(presetSizeMm(letter, [210, 297])).toEqual([215.9, 279.4]);
  });

  it('formats and converts lengths', () => {
    expect(formatPaperLength(279.4, 'in')).toBe('11');
    expect(formatPaperLength(10, 'in')).toBe('0.394');
    expect(formatPaperLength(215.9, 'mm')).toBe('215.9');
    expect(toMm(8.5, 'in')).toBeCloseTo(215.9, 9);
    expect(toMm(12, 'mm')).toBe(12);
  });
});
