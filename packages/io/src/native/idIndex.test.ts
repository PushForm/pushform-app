// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { NativeIdIndex } from './idIndex';
import { NativeColumnBudget } from './columns';
describe('numeric persistent-ID index', () => {
  it('finds source rows without reordering IDs and accounts for four bytes per row', () => {
    const ids = new Uint32Array([0xffff_ffff, 3, 0, 20]), budget = new NativeColumnBudget(16), index = new NativeIdIndex(ids, budget);
    expect(budget.usedBytes).toBe(16); expect(ids).toEqual(new Uint32Array([0xffff_ffff, 3, 0, 20]));
    for (let row = 0; row < ids.length; row++) expect(index.find(ids[row]!)).toBe(row);
    for (const id of [-1, 0.5, NaN, 1, 0x1_0000_0000]) expect(index.find(id)).toBe(-1);
  });
  it('rejects duplicates and restores failed allocation reservations', () => {
    const budget = new NativeColumnBudget(8); expect(() => new NativeIdIndex(new Uint32Array([1, 1]), budget)).toThrow('Duplicate'); expect(budget.usedBytes).toBe(0);
    expect(() => new NativeIdIndex(new Uint32Array(3), budget)).toThrow('budget'); expect(budget.usedBytes).toBe(0);
  });
});
