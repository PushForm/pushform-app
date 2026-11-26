// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { ASSET_LIMITS, ExtensionError, assetDescriptionSchema, assetRevisionSchema, sha256Hex,
  type AssetDescription, type AssetDescriptor, type AssetPage } from '@pushform/extension-protocol';
import type { Database } from './db.types';
import { callRpc, type RpcArgs, type RpcName } from './rpc';

export const EXTENSION_ASSETS_BUCKET = 'extension-assets';
const descriptor = assetDescriptionSchema.extend({ revision: assetRevisionSchema, updatedAt: z.string().datetime({ offset:true }) }).strict();
const path = z.string().regex(/^[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
const ticket = z.object({ upload:z.uuid(),path,expiresAt:z.string() }).strict();
const retired = z.object({ upload:z.uuid(),path }).strict();
const malformed = (): never => { throw new ExtensionError('validation.failed','The saved asset response is invalid.'); };
function parse<T>(schema: z.ZodType<T>, value: unknown): T { const result = schema.safeParse(value); return result.success ? result.data : malformed(); }

/** Account-private binary libraries. Only the trusted host supplies extension IDs or sees physical Storage paths. */
export class CloudExtensionAssets {
  constructor(private readonly client: Pick<SupabaseClient<Database>, 'rpc' | 'storage'>, private readonly fetcher: typeof fetch = globalThis.fetch) {}

  private async rpc<F extends RpcName>(name: F, args: RpcArgs<F>, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const result = await callRpc(this.client,name,args,signal);
    if (result.error) {
      signal?.throwIfAborted();
      const message = result.error.message;
      if (message.includes('ext_asset_conflict')) throw new ExtensionError('revision.stale','This saved asset changed. Refresh its preview before replacing or removing it.');
      if (message.includes('ext_asset_limit')) throw new ExtensionError('limit.exceeded','The saved asset quota is full. Remove unused libraries or presets and try again after cleanup.');
      if (message.includes('ext_asset_invalid')) throw new ExtensionError('validation.failed','The asset request is invalid.');
      throw new ExtensionError('unavailable','The account asset store could not complete this request. Try again.');
    }
    return result.data;
  }

  async list(extensionId: string, after: string | null, limit: number): Promise<AssetPage> {
    return parse(z.object({ entries:z.array(descriptor).max(100),next:z.string().nullable() }).strict(),
      await this.rpc('extension_assets_list',{ p_extension:extensionId,p_after:after,p_limit:limit }));
  }

  async read(extensionId: string, key: string, signal?: AbortSignal): Promise<{ asset: AssetDescriptor; bytes: Uint8Array } | null> {
    const result = await this.rpc('extension_assets_get',{ p_extension:extensionId,p_key:key },signal);
    if (result === null) return null;
    const saved = parse(z.object({ asset:descriptor,path }).strict(),result);
    const downloaded = await this.client.storage.from(EXTENSION_ASSETS_BUCKET).download(saved.path,{},signal ? { signal } : {});
    signal?.throwIfAborted();
    if (downloaded.error || !downloaded.data) throw new ExtensionError('unavailable','The saved asset could not be downloaded. Refresh the library list and try again.');
    if (downloaded.data.size !== saved.asset.byteLength || downloaded.data.size > ASSET_LIMITS.blobBytes) return malformed();
    const bytes = new Uint8Array(await downloaded.data.arrayBuffer()); signal?.throwIfAborted();
    if (await sha256Hex(bytes) !== saved.asset.sha256) throw new ExtensionError('validation.failed','The saved asset failed its content checksum.');
    signal?.throwIfAborted();
    return { asset:saved.asset,bytes };
  }

  async put(extensionId: string, description: AssetDescription, bytes: Uint8Array, expectedRevision: number | null, signal?: AbortSignal): Promise<AssetDescriptor> {
    signal?.throwIfAborted();
    const checked = parse(assetDescriptionSchema,description), owned = bytes.slice();
    if (checked.byteLength !== owned.byteLength || await sha256Hex(owned) !== checked.sha256) return malformed();
    signal?.throwIfAborted();
    const reserved = parse(ticket,await this.rpc('extension_assets_begin',{ p_extension:extensionId,p_key:checked.key,
      p_version:checked.version,p_content_type:checked.contentType,p_size:checked.byteLength,p_sha256:checked.sha256,p_expected_revision:expectedRevision },signal));
    try {
      const signed = await this.client.storage.from(EXTENSION_ASSETS_BUCKET).createSignedUploadUrl(reserved.path,{ upsert:false });
      signal?.throwIfAborted();
      if (signed.error || !signed.data) throw new ExtensionError('unavailable','The asset upload could not be prepared.');
      // The signed endpoint accepts a raw body. Fetch keeps the potentially large upload cancellable; paths/tokens
      // remain inside this trusted client. The server rechecks the pending intent even after this URL was issued.
      const uploaded = await this.fetcher(signed.data.signedUrl,{ method:'PUT',body:owned,
        headers:{ 'content-type':'application/octet-stream','cache-control':'max-age=0','x-upsert':'false' }, ...(signal ? { signal } : {}) });
      if (!uploaded.ok) throw new ExtensionError('unavailable','The asset upload failed. The previous saved asset is unchanged.');
      signal?.throwIfAborted();
      return parse(descriptor,await this.rpc('extension_assets_finish',{ p_upload:reserved.upload },signal));
    } catch (error) {
      // A lost finish response may already have published. Abort returns a cleanup path only if the object is still
      // pending/retired. Never delete reserved.path merely because the network request failed.
      await this.abort(reserved.upload).catch(() => undefined);
      signal?.throwIfAborted();
      if (error instanceof ExtensionError) throw error;
      throw new ExtensionError('unavailable','The asset transfer could not be completed. Refresh the library list before trying again.');
    }
  }

  private async abort(upload: string): Promise<void> {
    const result = await this.rpc('extension_assets_abort',{ p_upload:upload });
    if (result === null) return;
    const cleanup = parse(retired,result);
    const removed = await this.client.storage.from(EXTENSION_ASSETS_BUCKET).remove([cleanup.path]);
    if (!removed.error) await this.rpc('extension_assets_ack',{ p_upload:cleanup.upload });
  }

  async remove(extensionId: string, key: string, expectedRevision: number): Promise<boolean> {
    return parse(z.boolean(),await this.rpc('extension_assets_remove',{ p_extension:extensionId,p_key:key,p_expected_revision:expectedRevision }));
  }
  async clear(extensionId: string): Promise<void> { await this.rpc('extension_assets_clear',{ p_extension:extensionId }); }
}
