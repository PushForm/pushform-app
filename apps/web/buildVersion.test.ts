// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { isoWeek, versionFromCommitTimes } from './buildVersion';

const at = (iso: string): number => Date.parse(iso);

describe('isoWeek', () => {
  it('numbers weeks from Monday with the ISO week-year', () => {
    expect(isoWeek(at('2026-10-26T00:00:00Z'))).toEqual({ year: 2026, week: 44 }); // Monday
    expect(isoWeek(at('2026-10-25T23:59:59Z'))).toEqual({ year: 2026, week: 43 }); // Sunday before
    expect(isoWeek(at('2026-01-01T12:00:00Z'))).toEqual({ year: 2026, week: 1 }); // Thursday
    expect(isoWeek(at('2027-01-01T12:00:00Z'))).toEqual({ year: 2026, week: 53 }); // Friday of 2026's 53rd week
    expect(isoWeek(at('2024-12-30T12:00:00Z'))).toEqual({ year: 2025, week: 1 }); // Monday of 2025-W01
  });
});

describe('versionFromCommitTimes', () => {
  it('counts the built commit and the earlier commits of its week', () => {
    const times = [at('2026-10-28T09:00:00Z'), at('2026-10-27T18:00:00Z'), at('2026-10-26T00:30:00Z'), at('2026-10-25T22:00:00Z')];
    expect(versionFromCommitTimes(times)).toBe('26.44.3');
    expect(versionFromCommitTimes(times.slice(2))).toBe('26.44.1');
    expect(versionFromCommitTimes(times.slice(3))).toBe('26.43.1');
  });

  it('uses the ISO week-year, so late-December commits can belong to the next year', () => {
    expect(versionFromCommitTimes([at('2024-12-31T10:00:00Z'), at('2024-12-29T10:00:00Z')])).toBe('25.1.1');
  });

  it('gives no version when a shallow history may be missing commits of the week', () => {
    expect(versionFromCommitTimes([at('2026-10-27T10:00:00Z')], false)).toBeNull();
    expect(versionFromCommitTimes([at('2026-10-27T10:00:00Z'), at('2026-10-20T10:00:00Z')], false)).toBe('26.44.1');
    expect(versionFromCommitTimes([])).toBeNull();
  });
});
