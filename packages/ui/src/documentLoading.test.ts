// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { DocumentLoading } from './documentLoading';

describe('DocumentLoading', () => {
  it('publishes before work starts, tracks stages and clears after a final paint', async () => {
    const seen: string[] = [];
    const loading = new DocumentLoading(async () => { seen.push(`paint:${loading.getSnapshot()?.stage}`); });
    const result = await loading.run('Garage.pf', 'Downloading file…', async stage => {
      seen.push('download'); await stage('Preparing workspace…'); seen.push('install'); return 42;
    });
    expect(result).toBe(42);
    expect(seen).toEqual(['paint:Downloading file…', 'download', 'paint:Preparing workspace…', 'install', 'paint:Preparing workspace…']);
    expect(loading.getSnapshot()).toBeNull();
  });

  it('retains feedback until overlapping opens finish, including failures', async () => {
    const loading = new DocumentLoading(async () => {});
    let finish!: () => void;
    const first = loading.run('Garage.pf', 'Reading model…', () => new Promise<void>(resolve => { finish = resolve; }));
    await Promise.resolve();
    await expect(loading.run('Garage V3.pf', 'Reading model…', async () => { throw new Error('broken file'); })).rejects.toThrow('broken file');
    expect(loading.getSnapshot()?.name).toBe('Garage.pf');
    finish(); await first;
    expect(loading.getSnapshot()).toBeNull();
  });
});
