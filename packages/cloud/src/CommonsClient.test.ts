// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it, vi } from 'vitest';
import { CommonsUnavailableError, createCommonsClient, readCommonsCatalog } from './CommonsClient';
import type { Database } from './db.types';
import type { SupabaseClient } from '@supabase/supabase-js';

function rpc(data: unknown, error: {message:string}|null = null) {
  const abortSignal = vi.fn().mockResolvedValue({data,error});
  const call = vi.fn().mockReturnValue({abortSignal});
  return {client:{rpc:call} as unknown as Pick<SupabaseClient<Database>,'rpc'>,call,abortSignal};
}
it('calls the catalog RPC with cancellation and validates the public response', async () => {
  const {client,call,abortSignal}=rpc({version:1,models:[]});const signal=new AbortController().signal;
  expect(await readCommonsCatalog(client,signal)).toEqual([]);
  expect(call).toHaveBeenCalledWith('commons_catalog');expect(abortSignal).toHaveBeenCalledWith(signal);
  await expect(readCommonsCatalog(rpc({version:1,models:[{title:'Missing notices'}]}).client,signal)).rejects.toThrow('metadata is invalid');
});
it('distinguishes disabled publication from network/server errors without displaying database details', async () => {
  const signal=new AbortController().signal;
  await expect(readCommonsCatalog(rpc(null,{message:'commons_unavailable'}).client,signal)).rejects.toBeInstanceOf(CommonsUnavailableError);
  await expect(readCommonsCatalog(rpc(null,{message:'internal private error'}).client,signal)).rejects.toThrow('Could not load the Commons catalog.');
});
it('rejects server credentials before creating a browser client', () => {
  expect(()=>createCommonsClient({url:'https://example.com',publishableKey:'sb_secret_not-for-browser'})).toThrow('public publishable');
});
