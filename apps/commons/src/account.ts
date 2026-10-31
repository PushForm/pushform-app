// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { CommonsProfiles, createBrowserRpc, releaseCloudConfig, type CloudSession } from '@pushform/cloud';
export interface CommonsAccount {session:CloudSession;profiles:CommonsProfiles;client:ReturnType<typeof createBrowserRpc>['client']}
export function configuredCommonsAccount(env:Record<string,string|undefined>):CommonsAccount|null{
  if(!env.VITE_SUPABASE_URL&&!env.VITE_SUPABASE_PUBLISHABLE_KEY&&!env.VITE_SUPABASE_ANON_KEY)return null;
  try{const {session,client}=createBrowserRpc(releaseCloudConfig(env));return {session,client,profiles:new CommonsProfiles(client)};}catch{return null;}
}
