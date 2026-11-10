// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { assetKeySchema, assetRevisionSchema, ExtensionError, NATIVE_FRAGMENT_MIME, sha256Hex, type AssetDescriptor } from '@pushform/extension-protocol';
import type { ExtensionAssetStore } from './assetStore';
import { encodeNativeModelFragment, openNativeModelFragment, type NativeModelFragment } from './modelFragments';

/** Trusted account/extension-owned adapter; the runtime broker must supply the namespace and check grants. */
export class NativeFragmentLibrary {
 private readonly extensionId:string;
 private readonly store:ExtensionAssetStore;
 constructor(extensionId:string,store:ExtensionAssetStore){this.extensionId=extensionId;this.store=store;}
 async save(fragment:NativeModelFragment,key:string,expectedRevision:number|null,signal:AbortSignal):Promise<AssetDescriptor>{
  signal.throwIfAborted();key=assetKeySchema.parse(key);if(expectedRevision!==null)assetRevisionSchema.parse(expectedRevision);
  const bytes=await encodeNativeModelFragment(fragment,signal),sha256=await sha256Hex(bytes);signal.throwIfAborted();
  return this.store.put(this.extensionId,{key,version:1,contentType:NATIVE_FRAGMENT_MIME,byteLength:bytes.byteLength,sha256},bytes,expectedRevision,signal);
 }
 async open(key:string,expectedRevision:number,signal:AbortSignal):Promise<NativeModelFragment>{
  signal.throwIfAborted();key=assetKeySchema.parse(key);assetRevisionSchema.parse(expectedRevision);
  const stored=await this.store.read(this.extensionId,key,signal);signal.throwIfAborted();
  if(!stored)throw new ExtensionError('unavailable','This saved native module no longer exists. Refresh the library.');
  const {asset,bytes}=stored;
  if(asset.revision!==expectedRevision)throw new ExtensionError('revision.stale','The saved native module changed. Refresh its preview.');
  if(asset.contentType!==NATIVE_FRAGMENT_MIME||asset.version!==1)throw new ExtensionError('extension.unsupported','This saved asset is not a supported native module.');
  if(bytes.byteLength!==asset.byteLength||await sha256Hex(bytes)!==asset.sha256)throw new ExtensionError('validation.failed','The saved native module is incomplete or failed its checksum.');
  signal.throwIfAborted();return openNativeModelFragment(bytes,key,signal);
 }
}
