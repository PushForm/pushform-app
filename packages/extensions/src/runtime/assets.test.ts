// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it } from 'vitest';
import { ASSET_LIMITS, NATIVE_FRAGMENT_MIME, sha256Hex, type AssetDescription, type AssetDescriptor, type AssetReadResult, type AssetStageResult } from '@pushform/extension-protocol';
import { memoryAssetStore } from '../assetStore';
import { ExtensionAssetHost } from './assets';
const hosts: ExtensionAssetHost[] = [];
afterEach(() => { for (const host of hosts.splice(0)) host.dispose(); });
const make = (id: string, store = memoryAssetStore(), now?: () => number) => { const host = new ExtensionAssetHost(id,store,now); hosts.push(host); return host; };
const call = async <T>(host: ExtensionAssetHost, method: string, input: unknown = {}, signal = new AbortController().signal) => await host.services()[`assets.${method}`]!(input,{ signal } as never) as T;
const description = async (key: string, bytes: Uint8Array): Promise<AssetDescription> => ({ key, version: 1, contentType:'application/octet-stream', byteLength:bytes.length, sha256:await sha256Hex(bytes) });
it('keeps host native snapshots opaque and refuses guest-written protected asset uploads',async()=>{
 const store=memoryAssetStore(),host=make('com.example.owner',store),bytes=new Uint8Array([1,2,3]),native={...await description('Native module',bytes),contentType:NATIVE_FRAGMENT_MIME},saved=await store.put('com.example.owner',native,bytes,null);
 await expect(call(host,'read',{key:saved.key,expectedRevision:saved.revision})).rejects.toMatchObject({code:'permission.denied'});
 await expect(call(host,'stage',{description:native,expectedRevision:null,bytes})).rejects.toMatchObject({code:'validation.failed'});
 const ordinary=await call<AssetDescriptor>(host,'commit',{upload:await stage(host,'Ordinary library',bytes)});expect((await call<AssetReadResult>(host,'read',{key:ordinary.key,expectedRevision:ordinary.revision})).bytes).toEqual(bytes);
});
async function stage(host: ExtensionAssetHost, key: string, bytes: Uint8Array, expectedRevision: number | null = null) {
  const upload = await call<AssetStageResult>(host,'stage',{ description:await description(key,bytes), expectedRevision,bytes }); return upload.upload;
}
it('publishes complete bytes atomically, returns detached chunks, and isolates namespaces and upload handles', async () => {
  const store = memoryAssetStore(), a = make('com.example.a',store), b = make('com.example.b',store);
  const bytes = new Uint8Array([1,2,3,4]), upload = await stage(a,'Maple / birch',bytes); bytes.fill(9);
  expect((await store.list('com.example.a',null,100)).entries).toEqual([]);
  await expect(call(b,'commit',{ upload })).rejects.toMatchObject({ code:'validation.failed' });
  const saved = await call<AssetDescriptor>(a,'commit',{ upload });
  expect(saved).toMatchObject({ key:'Maple / birch',byteLength:4,revision:1 });
  expect((await store.list('com.example.b',null,100)).entries).toEqual([]);
  const first = await call<AssetReadResult>(a,'read',{ key:saved.key,expectedRevision:saved.revision,limit:2 });
  expect(first.bytes).toEqual(new Uint8Array([1,2])); expect(first.next).toBe(2); first.bytes.fill(0);
  const again = await call<AssetReadResult>(a,'read',{ key:saved.key,expectedRevision:saved.revision });
  expect(again.bytes).toEqual(new Uint8Array([1,2,3,4]));
  await expect(call(b,'read',{ key:saved.key,expectedRevision:saved.revision })).rejects.toMatchObject({ code:'unavailable' });
  await expect(call(a,'read',{ key:saved.key,expectedRevision:9 })).rejects.toMatchObject({ code:'revision.stale' });
  await expect(call(a,'stage',{ description:await description('Bad',bytes),expectedRevision:null,bytes,extensionId:'com.example.b' })).rejects.toMatchObject({ code:'validation.failed' });
});
it('handles concurrent replacement and delete/recreate without accepting an ABA revision', async () => {
  const store = memoryAssetStore(), a = make('com.example.a',store), b = make('com.example.a',store);
  const original = await call<AssetDescriptor>(a,'commit',{ upload:await stage(a,'Library',new Uint8Array([1])) });
  const left = await stage(a,'Library',new Uint8Array([2]),original.revision), right = await stage(b,'Library',new Uint8Array([3]),original.revision);
  const results = await Promise.allSettled([call<AssetDescriptor>(a,'commit',{upload:left}),call<AssetDescriptor>(b,'commit',{upload:right})]);
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  expect(results.find(result=>result.status==='rejected')).toMatchObject({reason:{code:'revision.stale'}});
  const current = (await store.read('com.example.a','Library'))!.asset;
  await expect(call(a,'remove',{key:'Library',expectedRevision:original.revision})).rejects.toMatchObject({code:'revision.stale'});
  await call(a,'remove',{key:'Library',expectedRevision:current.revision});
  const recreated = await call<AssetDescriptor>(a,'commit',{ upload:await stage(a,'Library',new Uint8Array([4])) });
  expect(recreated.revision).toBeGreaterThan(current.revision);
  await expect(call(b,'commit',{upload:right})).rejects.toMatchObject({code:'revision.stale'});
});
it('refuses incomplete, corrupt and out-of-order uploads; expiry/discard never publish partial blobs', async () => {
  let now = 0; const store = memoryAssetStore(), host = make('com.example.a',store,()=>now), bytes = new Uint8Array([1,2,3,4]);
  const start = await call<AssetStageResult>(host,'stage',{description:await description('Library',bytes),expectedRevision:null,bytes:bytes.slice(0,2)});
  await expect(call(host,'commit',{upload:start.upload})).rejects.toMatchObject({code:'validation.failed'});
  await expect(call(host,'stage',{upload:start.upload,offset:1,bytes:bytes.slice(2)})).rejects.toMatchObject({code:'validation.failed'});
  await call(host,'stage',{upload:start.upload,offset:2,bytes:bytes.slice(2)});
  await call(host,'discard',{upload:start.upload});
  await expect(call(host,'commit',{upload:start.upload})).rejects.toMatchObject({code:'validation.failed'});
  const bad = await call<AssetStageResult>(host,'stage',{description:{...await description('Bad',bytes),sha256:'0'.repeat(64)},expectedRevision:null,bytes});
  await expect(call(host,'commit',{upload:bad.upload})).rejects.toMatchObject({code:'validation.failed'});
  const expired = await stage(host,'Expired',bytes); now += ASSET_LIMITS.lifetimeMs;
  await expect(call(host,'commit',{upload:expired})).rejects.toMatchObject({code:'validation.failed'});
  expect((await store.list('com.example.a',null,100)).entries).toEqual([]);
  const pending = await stage(host,'Aborted',bytes);
  await expect(call(host,'commit',{upload:pending},AbortSignal.abort())).rejects.toThrow();
  host.dispose(); expect((await store.list('com.example.a',null,100)).entries).toEqual([]);
});
it('requires durable storage and verifies read checksums before returning any bytes', async () => {
  const missing = new ExtensionAssetHost('com.example.a',null); hosts.push(missing);
  await expect(call(missing,'list')).rejects.toMatchObject({code:'unavailable'});
  const store = memoryAssetStore(), writer = make('com.example.a',store), bytes = new Uint8Array([1,2]);
  await expect(call(writer,'stage',{})).rejects.toMatchObject({ code:'validation.failed' });
  const saved = await call<AssetDescriptor>(writer,'commit',{upload:await stage(writer,'Saved',bytes)});
  const broken = make('com.example.a',{...store,read:async()=>({asset:saved,bytes:new Uint8Array([8,9])})});
  await expect(call(broken,'read',{key:'Saved',expectedRevision:saved.revision})).rejects.toMatchObject({code:'validation.failed'});
});
it('transfers multiple bounded chunks and retains an exact read snapshot across another session replacement', async () => {
  const store = memoryAssetStore(), writer = make('com.example.a',store), reader = make('com.example.a',store);
  const bytes = Uint8Array.from({ length:ASSET_LIMITS.chunkBytes + 73 },(_,i) => i % 251);
  const started = await call<AssetStageResult>(writer,'stage',{ description:await description('Large',bytes),expectedRevision:null,bytes:bytes.slice(0,ASSET_LIMITS.chunkBytes) });
  expect(started.complete).toBe(false);
  await call(writer,'stage',{ upload:started.upload,offset:ASSET_LIMITS.chunkBytes,bytes:bytes.slice(ASSET_LIMITS.chunkBytes) });
  const saved = await call<AssetDescriptor>(writer,'commit',{ upload:started.upload });
  const first = await call<AssetReadResult>(reader,'read',{ key:'Large',expectedRevision:saved.revision });
  expect(first.bytes.length).toBe(ASSET_LIMITS.chunkBytes);
  const replacement = await call<AssetDescriptor>(writer,'commit',{ upload:await stage(writer,'Large',new Uint8Array([9]),saved.revision) });
  const tail = await call<AssetReadResult>(reader,'read',{ key:'Large',expectedRevision:saved.revision,offset:first.next });
  expect(Array.from(tail.bytes)).toEqual(Array.from(bytes.slice(ASSET_LIMITS.chunkBytes)));
  expect(tail.next).toBeNull();
  expect((await call<AssetReadResult>(reader,'read',{ key:'Large',expectedRevision:replacement.revision })).bytes).toEqual(new Uint8Array([9]));
});
it('bounds temporary reservations and durable entry counts while retaining existing data on quota failure', async () => {
  const store = memoryAssetStore(), host = make('com.example.a',store);
  const desc = {key:'Large',version:1,contentType:'application/octet-stream',byteLength:ASSET_LIMITS.blobBytes,sha256:'0'.repeat(64)};
  const first = await call<AssetStageResult>(host,'stage',{description:desc,expectedRevision:null,bytes:new Uint8Array()});
  await call(host,'stage',{description:{...desc,key:'Other'},expectedRevision:null,bytes:new Uint8Array()});
  await expect(call(host,'stage',{description:{...desc,key:'Overflow'},expectedRevision:null,bytes:new Uint8Array()})).rejects.toMatchObject({code:'limit.exceeded'});
  await call(host,'discard',{upload:first.upload});
  const empty = new Uint8Array(), hash = await sha256Hex(empty);
  for (let i=0;i<ASSET_LIMITS.extensionCount;i++) await store.put('com.example.a',{key:`Library ${i}`,version:1,contentType:'application/octet-stream',byteLength:0,sha256:hash},empty,null);
  await expect(store.put('com.example.a',{key:'Overflow',version:1,contentType:'application/octet-stream',byteLength:0,sha256:hash},empty,null)).rejects.toMatchObject({code:'limit.exceeded'});
  expect((await store.list('com.example.a',null,100)).entries).toHaveLength(100);
});
