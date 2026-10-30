// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/load.ts';
import { SAMPLE_CONFIG_INPUT } from '../config/sample.ts';
import { computeEligibility, eligibilityLabel, parseEligibilityLabel } from './eligibility.ts';

const boundaries = loadConfig(SAMPLE_CONFIG_INPUT).boundaries;

describe('retired automation compatibility', () => {
  it('never grants automation eligibility, irrespective of role or class', () => {
    for (const role of ['none','user','builder','maintainer','admin'] as const) {
      for (const estimatedClass of [null,'C1','C7'] as const) {
        expect(computeEligibility({ role, estimatedClass, boundaries })).toBe('none');
      }
    }
  });
  it('labels round-trip', () => {
    expect(eligibilityLabel('auto')).toBe('eligible:auto');
    expect(parseEligibilityLabel('eligible:gated')).toBe('gated');
    expect(parseEligibilityLabel('eligible:maybe')).toBeNull();
    expect(parseEligibilityLabel('class:C1')).toBeNull();
  });
});
