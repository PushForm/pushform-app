// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from './db.types';
import { callRpc } from './rpc';

/**
 * Extension settings stored with the signed-in account, so an extension's settings follow the user to every device.
 * One versioned JSON object per extension. A save names the revision it was based on and fails with
 * `CloudSettingsConflictError` when the stored settings have changed since, rather than overwriting them.
 */
export interface StoredExtensionSettings {
  readonly version: number;
  readonly value: Record<string, unknown>;
  readonly revision: number;
}

export class CloudSettingsConflictError extends Error {
  constructor() {
    super('The settings changed on another device.');
    this.name = 'CloudSettingsConflictError';
  }
}

export class CloudExtensionSettings {
  constructor(private readonly client: Pick<SupabaseClient<Database>, 'rpc'>) {}

  async load(extensionId: string): Promise<StoredExtensionSettings | null> {
    const { data, error } = await callRpc(this.client, 'extension_settings_get', { p_extension: extensionId });
    if (error) throw new Error(`Could not read the extension settings (${error.message}).`);
    if (data === null) return null;
    const row = data as { version?: unknown; value?: unknown; revision?: unknown };
    if (typeof row.version !== 'number' || typeof row.revision !== 'number' || typeof row.value !== 'object' || row.value === null || Array.isArray(row.value))
      throw new Error('The stored extension settings are malformed.');
    return { version: row.version, value: row.value as Record<string, unknown>, revision: row.revision };
  }

  /** Stores `value` as `version`, based on `expectedRevision` (null when there were none). Returns the new revision. */
  async save(extensionId: string, version: number, value: Record<string, unknown>, expectedRevision: number | null): Promise<number> {
    const { data, error } = await callRpc(this.client, 'extension_settings_put',
      { p_extension: extensionId, p_version: version, p_value: value as Json, p_expected_revision: expectedRevision });
    if (error) {
      if (error.message.includes('ext_settings_conflict')) throw new CloudSettingsConflictError();
      throw new Error(`Could not save the extension settings (${error.message}).`);
    }
    return Number(data);
  }

  /** Deletes the extension's settings, as uninstalling with "delete settings" does. Returns whether any existed. */
  async remove(extensionId: string): Promise<boolean> {
    const { data, error } = await callRpc(this.client, 'extension_settings_delete', { p_extension: extensionId });
    if (error) throw new Error(`Could not delete the extension settings (${error.message}).`);
    return data === true;
  }
}
