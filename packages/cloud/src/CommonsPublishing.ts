// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { catalogModelSchema, commonsUploadSchema } from './CommonsCatalog';
import type { Database } from './db.types';

export const commonsSubmissionSchema = catalogModelSchema.pick({
  title:true,description:true,creator:true,category:true,tags:true,formats:true,imageUrl:true,source:true,licenses:true,credits:true,
}).strict();
export type CommonsSubmission = z.infer<typeof commonsSubmissionSchema>;
const revisionSchema = z.object({
  id:z.uuid(),model_id:z.string(),number:z.number().int(),metadata:commonsSubmissionSchema,
  status:z.enum(['pending','published','rejected']),asset_version:z.number().int(),rights_basis:z.string(),
  creator_profile_id:z.uuid().nullable(),self_service:z.boolean(),
}).strip();
const stateSchema=z.object({
  models:z.array(z.object({id:z.string(),latest_submission:z.uuid().nullable(),published_revision:z.uuid().nullable()}).strip()),
  revisions:z.array(revisionSchema),
}).strip();
export type CommonsOwnRevision=z.infer<typeof revisionSchema>;
export type CommonsOwnModels=z.infer<typeof stateSchema>;

function failure(message:string):Error {
  return new Error(message==='commons_onboarding_required'?'Finish your account setup before publishing.':
    message==='commons_profile_required'?'Create or restore your public profile before publishing original work.':
    message==='commons_source_required'?'Redistributed models need their original source link.':
    message==='commons_forbidden'?'Only this model’s owner can change it.':
    message==='commons_conflict'?'This model changed. Refresh and confirm the current files again.':
    message==='commons_asset_incomplete'?'Attach at least one verified file and finish or remove incomplete uploads.':
    message==='commons_rights_required'?'Confirm your right to redistribute every included file and its notices.':
    message==='commons_draft_limit'?'Finish an existing draft before starting another model.':
    message==='commons_catalog_limit'?'The library has reached its current publication limit. Try again later.':
    message==='commons_invalid'?'Check the model metadata, license, source and rights declaration.':'Your model could not be saved or published. Try again.');
}

/** Only the current account's own model/revision operations are exposed by this client. */
export class CommonsPublishing {
  constructor(private readonly client:Pick<SupabaseClient<Database>,'rpc'>){}
  private async rpc(name:string,args:Record<string,unknown>,signal?:AbortSignal):Promise<unknown>{
    const invoke=this.client.rpc as unknown as (name:string,args:Record<string,unknown>)=>ReturnType<SupabaseClient<Database>['rpc']>;
    const query=invoke.call(this.client,name,args);const result=await(signal?query.abortSignal(signal):query);
    if(result.error)throw failure(result.error.message);return result.data;
  }
  async mine(signal?:AbortSignal):Promise<CommonsOwnModels>{return stateSchema.parse(await this.rpc('commons_my_models',{},signal));}
  async submit(id:string,metadata:CommonsSubmission,rightsBasis:string,originalWork:boolean,expectedRevision:string|null,signal?:AbortSignal):Promise<CommonsOwnRevision>{
    if(!/^[a-z0-9][a-z0-9-]{0,95}$/.test(id))throw new Error('Use a lowercase model identifier with letters, numbers and hyphens.');
    if(rightsBasis.trim().length<20||rightsBasis.trim().length>4000)throw new Error('Describe your redistribution rights in 20–4,000 characters.');
    const checked=commonsSubmissionSchema.safeParse(metadata);if(!checked.success)throw new Error('Check the model metadata, license links and attribution before saving.');
    return revisionSchema.parse(await this.rpc('commons_submit_model',{p_id:id,p_metadata:checked.data,p_rights_basis:rightsBasis,p_original_work:originalWork,p_expected_revision:expectedRevision},signal));
  }
  async assets(revision:string,signal?:AbortSignal){return commonsUploadSchema.array().parse(await this.rpc('commons_model_assets',{p_revision:revision},signal));}
  async publish(revision:string,expectedPublished:string|null,assetVersion:number,rightsConfirmed:boolean,signal?:AbortSignal):Promise<CommonsOwnRevision>{
    return revisionSchema.parse(await this.rpc('commons_publish_model',{p_revision:revision,p_expected_published:expectedPublished,p_expected_asset_version:assetVersion,p_rights_confirmed:rightsConfirmed},signal));
  }
  async withdraw(id:string,expectedPublished:string,signal?:AbortSignal):Promise<void>{await this.rpc('commons_withdraw_model',{p_id:id,p_expected_published:expectedPublished},signal);}
}
