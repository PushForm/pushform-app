// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { streamNativeNumbers } from './numericStream';
describe('lazy numeric conversion', () => {
  it('bounds source traversal by one page and closes iteration on cancellation', async () => {
    let read = 0, closed = false;
    function* values() { try { for (let i = 0; i < 100; i++) { read++; yield i; } } finally { closed = true; } }
    const stream = streamNativeNumbers(values(), 'float64', 100, () => 1, { pageBytes: 32 });
    await stream.next(); expect(read).toBe(4); await stream.return([]); expect(closed).toBe(true); expect(read).toBe(4);
  });
  it('rejects wrong counts, invalid values and misaligned pages', async () => {
    await expect(streamNativeNumbers([1], 'uint32', 2, () => 1).next()).rejects.toThrow('Truncated');
    await expect(streamNativeNumbers([1], 'uint8', 0, () => 1).next()).rejects.toThrow();
    await expect(streamNativeNumbers([256], 'uint8', 1, () => 1).next()).rejects.toThrow();
    await expect(streamNativeNumbers([1.5], 'uint32', 1, () => 1).next()).rejects.toThrow();
    await expect(streamNativeNumbers([1], 'float64', 1, () => 1, { pageBytes: 4 }).next()).rejects.toThrow();
  });
});
