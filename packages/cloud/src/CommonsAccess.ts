// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './db.types';
import { callRpc } from './rpc';
const statusSchema=z.object({
  termsAccepted:z.boolean(),termsVersion:z.string().nullable(),termsAcceptedAt:z.string().nullable(),
  mailingOptIn:z.boolean(),mailingUpdatedAt:z.string().nullable(),
}).strict();
export type CommonsAccountStatus=z.infer<typeof statusSchema>;
type Client=Pick<SupabaseClient<Database>,'rpc'>;
/** This private account status is separate from a creator's optional public profile. */
export async function readCommonsAccountStatus(client:Client):Promise<CommonsAccountStatus>{
  const result=await callRpc(client,'commons_account_status',{});
  if(result.error)throw new Error('Could not load your account preferences. Try again.');
  return statusSchema.parse(result.data);
}
export async function setCommonsMailingPreference(client:Client,optIn:boolean):Promise<CommonsAccountStatus>{
  const result=await callRpc(client,'commons_set_mailing_preference',{p_opt_in:optIn});
  if(result.error)throw new Error('Could not save your mailing preference. Try again.');
  return statusSchema.parse(result.data);
}
