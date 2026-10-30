// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './db.types';

/** The database functions, from types generated from the migrations (`pnpm db:types`, checked in CI). */
type Functions = Database['public']['Functions'];
export type RpcName = keyof Functions;

/**
 * A function's arguments as a caller passes them. SQL arguments always accept null, which the generated types leave
 * out, so null is allowed; a renamed function, argument or type change still fails the type check.
 */
export type RpcArgs<F extends RpcName> = { [K in keyof Functions[F]['Args']]: Functions[F]['Args'][K] | null };

export interface RpcResult<T> {
  data: T | null;
  error: PostgrestError | null;
  status: number;
}

/**
 * Call a database function by its generated contract: the name and arguments are checked against the function's.
 * Most return `jsonb`, so the data is `unknown` for the caller to read as the shape it expects.
 */
export async function callRpc<F extends RpcName>(client: Pick<SupabaseClient<Database>, 'rpc'>, fn: F, args?: RpcArgs<F>): Promise<RpcResult<unknown>> {
  const result = await client.rpc(fn, args as Functions[F]['Args']);
  return result as RpcResult<unknown>;
}
