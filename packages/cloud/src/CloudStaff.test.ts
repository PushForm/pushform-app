// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { CloudStaff } from './CloudStaff';

const client = (result: unknown) => ({ rpc: async () => result }) as never;

describe('CloudStaff', () => {
  it('reads a staff role, and treats none, errors and odd answers as not staff', async () => {
    expect(await new CloudStaff(client({ data: { role: 'owner' }, error: null, status: 200 })).isStaff()).toBe(true);
    expect(await new CloudStaff(client({ data: { role: 'read_only' }, error: null, status: 200 })).isStaff()).toBe(true);
    expect(await new CloudStaff(client({ data: { role: 'none' }, error: null, status: 200 })).isStaff()).toBe(false);
    expect(await new CloudStaff(client({ data: null, error: { message: 'x' }, status: 500 })).isStaff()).toBe(false);
    expect(await new CloudStaff(client({ data: 'owner', error: null, status: 200 })).isStaff()).toBe(false);
    expect(await new CloudStaff({ rpc: async () => { throw new Error('offline'); } } as never).isStaff()).toBe(false);
  });
});
