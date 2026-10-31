// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it, vi } from 'vitest';
import { CloudExtensionSettings, CloudSettingsConflictError } from './CloudExtensionSettings';

const client = (result: { data: unknown; error: { message: string } | null }) => {
  const rpc = vi.fn(async () => ({ ...result, status: 200 }));
  return { rpc, settings: new CloudExtensionSettings({ rpc } as never) };
};

describe('CloudExtensionSettings', () => {
  it('reads stored settings, or null when there are none', async () => {
    const { rpc, settings } = client({ data: { version: 2, value: { kerf: 0.003 }, revision: 4, updated_at: 'x' }, error: null });
    expect(await settings.load('io.pushform.cut-list')).toEqual({ version: 2, value: { kerf: 0.003 }, revision: 4 });
    expect(rpc).toHaveBeenCalledWith('extension_settings_get', { p_extension: 'io.pushform.cut-list' });
    expect(await client({ data: null, error: null }).settings.load('a.b')).toBeNull();
    await expect(client({ data: { version: 'x' }, error: null }).settings.load('a.b')).rejects.toThrow(/malformed/);
  });

  it('saves with the expected revision and reports conflicts as such', async () => {
    const ok = client({ data: 5, error: null });
    expect(await ok.settings.save('a.b', 2, { k: 1 }, 4)).toBe(5);
    expect(ok.rpc).toHaveBeenCalledWith('extension_settings_put', { p_extension: 'a.b', p_version: 2, p_value: { k: 1 }, p_expected_revision: 4 });
    await expect(client({ data: null, error: { message: 'ext_settings_conflict' } }).settings.save('a.b', 1, {}, null))
      .rejects.toBeInstanceOf(CloudSettingsConflictError);
    await expect(client({ data: null, error: { message: 'cloud_auth' } }).settings.save('a.b', 1, {}, null)).rejects.toThrow(/Could not save/);
  });

  it('deletes settings', async () => {
    expect(await client({ data: true, error: null }).settings.remove('a.b')).toBe(true);
  });
});
