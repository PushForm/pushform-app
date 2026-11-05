// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './db.types';
import type { RpcArgs, RpcName } from './rpc';
import { catalogModelSchema } from './CommonsCatalog';
import { commonsPublicProfileSchema } from './CommonsProfiles';

const modelId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,95}$/);
const unique = <T>(items: T[]) => new Set(items).size === items.length;
export const commonsCollectionSchema = z.object({
  id: z.uuid(), title: z.string().trim().min(1).max(100), description: z.string().max(2000),
  visibility: z.enum(['private', 'public']), version: z.number().int().positive(),
  updatedAt: z.iso.datetime({ offset: true }),
  curator: z.object({ handle: z.string().regex(/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/), displayName: z.string().min(1).max(100) }).strict().nullable(),
  modelIds: z.array(modelId).max(100).refine(unique, 'Duplicate collection member.'),
}).strict();
export type CommonsCollection = z.infer<typeof commonsCollectionSchema>;
export type CollectionFields = Pick<CommonsCollection, 'title' | 'description' | 'visibility' | 'modelIds'>;
export const commonsFeaturedItemSchema = z.object({ id: z.uuid(), type: z.enum(['model', 'collection', 'creator']), targetId: z.string().min(1).max(96) }).strict()
  .refine(item => (item.type === 'model' ? modelId : z.uuid()).safeParse(item.targetId).success, 'Invalid featured target.');
export const commonsDiscoverySchema = z.object({
  version: z.literal(1), creators: z.array(commonsPublicProfileSchema).max(24).default([]), collections: z.array(commonsCollectionSchema).max(1000), featured: z.array(commonsFeaturedItemSchema).max(24),
}).strict().superRefine((value, ctx) => {
  if (!unique(value.creators.map(item => item.id))) ctx.addIssue({ code: 'custom', message: 'Duplicate creator.' });
  if (!unique(value.collections.map(item => item.id)) || !unique(value.featured.map(item => item.id)) || !unique(value.featured.map(item => item.type + ':' + item.targetId))) {
    ctx.addIssue({ code: 'custom', message: 'Duplicate discovery entry.' });
  }
  if (value.collections.some(item => item.visibility !== 'public')) ctx.addIssue({ code: 'custom', message: 'Private collection in public discovery.' });
});
export type CommonsDiscovery = z.infer<typeof commonsDiscoverySchema>;
const adminFeaturedItemSchema = z.object({ id: z.uuid(), type: z.enum(['model', 'collection', 'creator']), targetId: z.string(), title: z.string(), available: z.boolean() }).strict();
export const commonsFeaturedStateSchema = z.object({
  version: z.number().int().positive(), enabled: z.boolean(), items: z.array(adminFeaturedItemSchema).max(24),
  creators: z.array(commonsPublicProfileSchema).default([]), models: z.array(catalogModelSchema).max(1000), collections: z.array(commonsCollectionSchema).max(1000),
}).strict();
export type CommonsFeaturedState = z.infer<typeof commonsFeaturedStateSchema>;

export function commonsCollectionError(error: { message?: string }): Error {
  const messages: Record<string, string> = {
    commons_unavailable: 'The Commons catalog is currently unavailable.',
    commons_onboarding_required: 'Sign in and finish your account setup to manage collections.',
    commons_forbidden: 'You can only change your own collections.',
    admin_forbidden: 'Commons admin permission is required to manage featured items.',
    commons_collection_invalid: 'Use a title of up to 100 characters, a description of up to 2,000 characters and up to 100 distinct models.',
    commons_collection_conflict: 'This collection changed in another tab. Reload the collection before saving your changes.',
    commons_collection_limit: 'The collection limit has been reached. Remove an unused collection or try again later.',
    commons_model_unavailable: 'A selected model is no longer published. Reload and choose an available model.',
    commons_feature_unavailable: 'Only published models, nonempty public collections and active public creators can be featured.',
    commons_feature_limit: 'Up to 24 items can be featured. Remove an item before adding another.',
    commons_feature_conflict: 'The featured list changed. Reload it before changing the order.',
    commons_feature_invalid: 'The featured selection is invalid. Reload and try again.',
  };
  return new Error(messages[error.message ?? ''] ?? 'Commons could not complete this request. Try again.');
}

/** Sessions decide ownership on the server. Public discovery contains no private account fields. */
export class CommonsCollections {
  constructor(private readonly client: Pick<SupabaseClient<Database>, 'rpc'>) {}
  private async request<F extends RpcName>(name: F, args: RpcArgs<F>, signal?: AbortSignal): Promise<unknown> {
    const query = this.client.rpc(name, args as Database['public']['Functions'][F]['Args']);
    const result = await (signal ? query.abortSignal(signal) : query);
    if (result.error) throw commonsCollectionError(result.error);
    return result.data;
  }
  async discovery(signal?: AbortSignal): Promise<CommonsDiscovery> {
    return commonsDiscoverySchema.parse(await this.request('commons_discovery', {}, signal));
  }
  async get(id: string, signal?: AbortSignal): Promise<CommonsCollection | null> {
    const value = await this.request('commons_collection', { p_id: z.uuid().parse(id) }, signal);
    return value === null ? null : commonsCollectionSchema.parse(value);
  }
  async mine(signal?: AbortSignal): Promise<CommonsCollection[]> {
    return commonsCollectionSchema.array().max(100).parse(await this.request('commons_my_collections', {}, signal));
  }
  async save(id: string | null, fields: CollectionFields, expectedVersion: number | null, signal?: AbortSignal): Promise<CommonsCollection> {
    return commonsCollectionSchema.parse(await this.request('commons_save_collection', {
      p_id: id, p_title: fields.title, p_description: fields.description, p_public: fields.visibility === 'public',
      p_model_ids: fields.modelIds, p_expected_version: expectedVersion,
    }, signal));
  }
  async delete(id: string, expectedVersion: number): Promise<void> {
    await this.request('commons_delete_collection', { p_id: id, p_expected_version: expectedVersion });
  }
  async canFeature(signal?: AbortSignal): Promise<boolean> {
    try {
      const result = await this.request('admin_session', {}, signal);
      const role = z.object({ role: z.string() }).passthrough().parse(result).role;
      return role === 'admin' || role === 'owner';
    } catch { return false; }
  }
  async featured(signal?: AbortSignal): Promise<CommonsFeaturedState> {
    return commonsFeaturedStateSchema.parse(await this.request('admin_commons_featured', {}, signal));
  }
  async feature(type: 'model' | 'collection' | 'creator', targetId: string): Promise<CommonsFeaturedState> {
    return commonsFeaturedStateSchema.parse(await this.request('admin_commons_feature', { p_type: type, p_target_id: targetId }));
  }
  async updateFeatured(ids: string[], expectedVersion: number): Promise<CommonsFeaturedState> {
    return commonsFeaturedStateSchema.parse(await this.request('admin_commons_update_featured', { p_ids: ids, p_expected_version: expectedVersion }));
  }
}
