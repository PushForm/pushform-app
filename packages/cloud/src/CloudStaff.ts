// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './db.types';
import { callRpc } from './rpc';

/**
 * Whether the signed-in account belongs to PushForm staff, for features shown to staff before everyone. It only
 * decides what the app shows; every server function still checks the caller itself. Any failure reads as "not staff".
 */
export class CloudStaff {
  constructor(private readonly client: Pick<SupabaseClient<Database>, 'rpc'>) {}

  async isStaff(): Promise<boolean> {
    try {
      const { data, error } = await callRpc(this.client, 'admin_session');
      if (error || typeof data !== 'object' || data === null) return false;
      const role = (data as { role?: unknown }).role;
      return typeof role === 'string' && role !== 'none';
    } catch {
      return false;
    }
  }
}
