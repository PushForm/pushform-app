// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { FILE_TRANSFER_LIMITS as LIMITS, extensionManifestSchema, sha256Hex, type FileReadDescription, type FileReadChunk, type FileStageResult } from '@pushform/extension-protocol';
import { ExtensionFileTransfers } from './fileTransfers';
import type { FilePicker, FileRequest } from './io';
import type { ServiceCall } from './host';

const manifest = extensionManifestSchema.parse({ id:'io.example.files',name:'File Library',publisher:'Example',version:'1.0.0',apiVersion:'^0.1.0',editors:['modeling'],defaultLocale:'en',license:'MIT',files:{},permissions:['file.read','file.export'],contributions:[{ target:'model.panel',id:'io.example.files.panel',name:'Files' }] });
const transfers: ExtensionFileTransfers[] = [];
afterEach(() => { for (const host of transfers.splice(0)) host.dispose(); });
function host(picker: Partial<FilePicker> = {}, now?: () => number): ExtensionFileTransfers {
  const instance = new ExtensionFileTransfers(manifest,{ open:async () => null,save:async () => null,...picker },now); transfers.push(instance); return instance;
}
const call = async <T>(host: ExtensionFileTransfers,method: string,input: unknown,signal = new AbortController().signal): Promise<T> =>
  await host.services()[`files.${method}`]!(input,{ signal } as ServiceCall) as T;
async function stage(h: ExtensionFileTransfers,bytes: Uint8Array): Promise<string> {
  const first = await call<FileStageResult>(h,'stage',{ byteLength:bytes.length,sha256:await sha256Hex(bytes),bytes:bytes.slice(0,LIMITS.chunkBytes) });
  for (let at = first.received; at < bytes.length; at += LIMITS.chunkBytes)
    await call(h,'stage',{ upload:first.upload,offset:at,bytes:bytes.slice(at,at + LIMITS.chunkBytes) });
  return first.upload;
}

it('captures immutable chosen bytes once, returns bounded detached chunks, and releases a closed read', async () => {
  const bytes = Uint8Array.from({ length:LIMITS.chunkBytes + 31 },(_,i) => i % 251);
  const picker = vi.fn(async () => ({ name:'library.zip',type:'application/zip',data:bytes }));
  const h = host({ open:picker });
  const chosen = await call<FileReadDescription>(h,'openRead',{ purpose:'Import materials' });
  const expected = bytes.slice(); bytes.fill(9);
  expect(chosen).toMatchObject({ name:'library.zip',byteLength:expected.length,sha256:await sha256Hex(expected) });
  expect(Object.keys(chosen).sort()).toEqual(['byteLength','name','sha256','transfer','type']);
  const first = await call<FileReadChunk>(h,'read',{ transfer:chosen.transfer });
  expect(first.bytes).toEqual(expected.slice(0,LIMITS.chunkBytes)); first.bytes.fill(0);
  expect((await call<FileReadChunk>(h,'read',{ transfer:chosen.transfer })).bytes).toEqual(expected.slice(0,LIMITS.chunkBytes));
  const tail = await call<FileReadChunk>(h,'read',{ transfer:chosen.transfer,offset:first.next });
  expect(tail.bytes).toEqual(expected.slice(LIMITS.chunkBytes)); expect(tail.next).toBeNull(); expect(picker).toHaveBeenCalledOnce();
  await call(h,'closeRead',{ transfer:chosen.transfer });
  await expect(call(h,'read',{ transfer:chosen.transfer })).rejects.toMatchObject({ code:'validation.failed' });
});

it('saves a multi-chunk export only after a full checksum and one host prompt', async () => {
  const bytes = Uint8Array.from({ length:5 * 1024 * 1024 + 17 },(_,i) => i % 253);
  const save = vi.fn(async (_request: FileRequest,received: Uint8Array) => { expect(received.length).toBe(bytes.length); expect(await sha256Hex(received)).toBe(await sha256Hex(bytes)); return { name:'materials.zip' }; });
  const h = host({ save }), upload = await stage(h,bytes);
  expect(save).not.toHaveBeenCalled();
  expect(await call(h,'saveStaged',{ upload,purpose:'Export materials',suggestedName:'materials.zip' })).toEqual({ name:'materials.zip' });
  expect(save).toHaveBeenCalledOnce(); expect(save.mock.calls[0]![0]).toMatchObject({ extensionName:'File Library',kind:'save',purpose:'Export materials' });
  await expect(call(h,'saveStaged',{ upload,purpose:'Again' })).rejects.toMatchObject({ code:'validation.failed' });
});

it('rejects incomplete, corrupt and out-of-order exports without opening a picker', async () => {
  const save = vi.fn(), h = host({ save }), bytes = new Uint8Array([1,2]);
  for (const malformed of [null,{}, { bytes:'x' }, { bytes:new Uint16Array([1]) }, { bytes:new Uint8Array(LIMITS.chunkBytes + 1) }])
    await expect(call(h,'stage',malformed)).rejects.toMatchObject({ code:'validation.failed' });
  const first = await call<FileStageResult>(h,'stage',{ byteLength:2,sha256:await sha256Hex(bytes),bytes:bytes.slice(0,1) });
  await expect(call(h,'saveStaged',{ upload:first.upload,purpose:'Incomplete' })).rejects.toMatchObject({ code:'validation.failed' });
  await expect(call(h,'stage',{ upload:first.upload,offset:0,bytes:bytes.slice(1) })).rejects.toMatchObject({ code:'validation.failed' });
  await expect(call(h,'stage',{ upload:first.upload,offset:1,byteLength:2,bytes:bytes.slice(1) })).rejects.toMatchObject({ code:'validation.failed' });
  await call(h,'stage',{ upload:first.upload,offset:1,bytes:new Uint8Array([9]) });
  await expect(call(h,'saveStaged',{ upload:first.upload,purpose:'Corrupt' })).rejects.toMatchObject({ code:'validation.failed' });
  expect(save).not.toHaveBeenCalled();
});

it('isolates session handles and retains a declined save for a deliberate retry', async () => {
  let decline = true; const save = vi.fn(async () => decline ? null : { name:'saved.zip' });
  const a = host({ save }), b = host({ save }), upload = await stage(a,new Uint8Array());
  await expect(call(b,'saveStaged',{ upload,purpose:'Foreign' })).rejects.toMatchObject({ code:'validation.failed' });
  await expect(call(a,'saveStaged',{ upload,purpose:'Save' })).rejects.toMatchObject({ code:'cancelled' });
  decline = false;
  expect(await call(a,'saveStaged',{ upload,purpose:'Retry' })).toEqual({ name:'saved.zip' });
  expect(save).toHaveBeenCalledTimes(2);
});

it('bounds shared upload/read reservations and expires all temporary state', async () => {
  let now = 0; const h = host({},() => now);
  const start = { byteLength:LIMITS.fileBytes,sha256:'0'.repeat(64),bytes:new Uint8Array() };
  const first = await call<FileStageResult>(h,'stage',start);
  await call(h,'stage',start);
  await expect(call(h,'stage',{ ...start,byteLength:1 })).rejects.toMatchObject({ code:'limit.exceeded' });
  await expect(call(h,'openRead',{ purpose:'No room' })).rejects.toMatchObject({ code:'limit.exceeded' });
  now = LIMITS.lifetimeMs;
  await expect(call(h,'stage',{ upload:first.upload,offset:0,bytes:new Uint8Array([1]) })).rejects.toMatchObject({ code:'validation.failed' });
  const tiny = await stage(h,new Uint8Array()); await call(h,'discard',{ upload:tiny });
  for (let i=0;i<LIMITS.transfers;i++) await stage(h,new Uint8Array());
  await expect(stage(h,new Uint8Array())).rejects.toMatchObject({ code:'limit.exceeded' });
});

it('cancels a pending picker on shutdown and refuses late data without reviving the session', async () => {
  let finish!: (value: { name:string;type:string;data:Uint8Array }) => void;
  let active: AbortSignal | undefined;
  const h = host({ open:async (_request,options) => { active = options?.signal; return new Promise(resolve => { finish = resolve; }); } });
  const chosen = call(h,'openRead',{ purpose:'Pending choice' }); h.dispose();
  expect(active?.aborted).toBe(true);
  finish({ name:'late.zip',type:'',data:new Uint8Array([1]) });
  await expect(chosen).rejects.toThrow();
  await expect(call(h,'stage',{ byteLength:0,sha256:await sha256Hex(new Uint8Array()),bytes:new Uint8Array() })).rejects.toMatchObject({ code:'cancelled' });
});

it('cancels a pending save through its signal, prevents simultaneous saves, and keeps bytes retryable', async () => {
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  const save: FilePicker['save'] = async (_request,_bytes,options) => { entered(); return new Promise((_resolve,reject) => options!.signal!.addEventListener('abort',() => reject(options!.signal!.reason),{ once:true })); };
  const h = host({ save }), upload = await stage(h,new Uint8Array([1])), controller = new AbortController();
  const running = call(h,'saveStaged',{ upload,purpose:'Pending save' },controller.signal);
  await ready;
  await expect(call(h,'saveStaged',{ upload,purpose:'Concurrent save' })).rejects.toMatchObject({ code:'validation.failed' });
  controller.abort(); await expect(running).rejects.toThrow();
  await call(h,'discard',{ upload });
  await expect(call(h,'saveStaged',{ upload,purpose:'Discarded' })).rejects.toMatchObject({ code:'validation.failed' });
});
