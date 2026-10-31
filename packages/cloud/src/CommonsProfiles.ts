// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { catalogModelSchema, catalogUrlSchema } from './CommonsCatalog';
import type { Database } from './db.types';

export const commonsHandleSchema = z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/);
export const commonsProfileFieldsSchema = z.object({
  handle: commonsHandleSchema,
  displayName: z.string().trim().min(1).max(100).refine(value => !/\p{Cc}/u.test(value)),
  bio: z.string().trim().max(2000).refine(value=>!Array.from(value).some(character=>/\p{Cc}/u.test(character)&&!'\n\r\t'.includes(character))),
  avatarUrl: catalogUrlSchema.nullable(),
  links: z.array(z.object({ label: z.string().trim().min(1).max(80).refine(value=>!/\p{Cc}/u.test(value)), url: catalogUrlSchema }).strict()).max(5),
}).strict();
export const commonsPublicProfileSchema = commonsProfileFieldsSchema.extend({ id: z.uuid() }).strict();
export const commonsProfileSchema = commonsPublicProfileSchema.extend({ active: z.boolean(), version: z.number().int().min(1) }).strict();
export type CommonsProfileFields = z.infer<typeof commonsProfileFieldsSchema>;
export type CommonsPublicProfile = z.infer<typeof commonsPublicProfileSchema>;
export type CommonsProfile = z.infer<typeof commonsProfileSchema>;
export interface CommonsProfilePage { profile: CommonsPublicProfile; models: z.infer<typeof catalogModelSchema>[] }
const pageSchema = z.object({profile:commonsPublicProfileSchema,models:z.array(catalogModelSchema).max(1000)}).strict();

export function commonsProfileError(error: {message?:string}):Error {
  const message=error.message??'';
  return new Error(message==='commons_handle_taken'?'That public handle is already in use. Choose another.':
    message==='commons_handle_immutable'?'Your public handle cannot be changed.':
    message==='commons_profile_conflict'?'Your profile changed in another tab. Reload before saving.':
    message==='commons_profile_consent'?'Confirm that this profile will be public.':
    message==='commons_profile_invalid'?'Check the profile fields and links before saving.':
    message==='commons_terms_required'?'Finish your account setup before publishing your profile.':
    message==='commons_auth_required'?'Sign in to manage your public profile.':'Your profile could not be loaded or saved. Try again.');
}

/** Public reads and owner mutations expose only explicit public-profile fields. */
export class CommonsProfiles {
  constructor(private readonly client:Pick<SupabaseClient<Database>,'rpc'>){}
  private async rpc(name:string,args:Record<string,unknown>,signal?:AbortSignal):Promise<unknown>{
    // The function names are kept inside this client; no caller-controlled RPC or ownership IDs.
    const request=this.client.rpc as unknown as (name:string,args:Record<string,unknown>)=>ReturnType<SupabaseClient<Database>['rpc']>;
    const query=request.call(this.client,name,args);const result=await (signal?query.abortSignal(signal):query);
    if(result.error)throw commonsProfileError(result.error);return result.data;
  }
  async get(id:string,signal?:AbortSignal):Promise<CommonsProfilePage|null>{
    if(!z.uuid().safeParse(id).success)throw new Error('This profile link is invalid.');
    const data=await this.rpc('commons_profile',{p_id:id},signal);return data===null?null:pageSchema.parse(data);
  }
  async mine(signal?:AbortSignal):Promise<CommonsProfile|null>{
    const data=await this.rpc('commons_my_profile',{},signal);return data===null?null:commonsProfileSchema.parse(data);
  }
  async save(fields:CommonsProfileFields,expectedVersion:number|null,publicConsent:boolean,signal?:AbortSignal):Promise<CommonsProfile>{
    const value=commonsProfileFieldsSchema.parse(fields);
    const data=await this.rpc('commons_save_profile',{p_handle:value.handle,p_display_name:value.displayName,p_bio:value.bio,p_avatar_url:value.avatarUrl,p_links:value.links,p_expected_version:expectedVersion,p_public_consent:publicConsent},signal);
    return commonsProfileSchema.parse(data);
  }
  async hide(expectedVersion:number,signal?:AbortSignal):Promise<CommonsProfile>{
    return commonsProfileSchema.parse(await this.rpc('commons_hide_profile',{p_expected_version:expectedVersion},signal));
  }
}
