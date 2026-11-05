// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it, vi } from 'vitest';
import { CommonsUnavailableError, createCommonsClient, readCommonsCatalog } from './CommonsClient';
import type { Database } from './db.types';
import type { SupabaseClient } from '@supabase/supabase-js';
import { parseCommonsCatalog } from './CommonsCatalog';

function rpc(data: unknown, error: {message:string}|null = null) {
  const abortSignal = vi.fn().mockResolvedValue({data,error});
  const call = vi.fn().mockReturnValue({abortSignal});
  return {client:{rpc:call} as unknown as Pick<SupabaseClient<Database>,'rpc'>,call,abortSignal};
}
it('calls the catalog RPC with cancellation and validates the public response', async () => {
  const {client,call,abortSignal}=rpc({version:1,models:[],nextCursor:null,asOf:'2026-11-05T00:00:00Z'});const signal=new AbortController().signal;
  expect(await readCommonsCatalog(client,signal)).toEqual([]);
  expect(call).toHaveBeenCalledWith('commons_catalog_page',{p_limit:100});expect(abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
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

const model = (n:number) => ({id:`model-${String(n).padStart(4,'0')}`,revision:'revision',title:'Part',description:'',creator:'Source author',category:'Other',tags:[],formats:['PF'],imageUrl:null,source:null,
  publishedAt:`2026-11-${n%2===0?'05':'04'}T00:00:00Z`,licenses:[{name:'CC0',url:null,commercialUse:'allowed',conditions:[]}],credits:[{name:'Source author',url:null,text:'Original model'}]});
const asOf='2026-11-05T00:00:00.000000Z';
it('loads more than a thousand models in bounded pages and sorts by publication time',async()=>{
  const values=Array.from({length:1003},(_,i)=>model(i)),call=vi.fn().mockImplementation((_name,args)=>{
    const start=args.p_after?Number(args.p_after.slice(6))+1:0;
    const models=values.slice(start,start+100);
    return {abortSignal:vi.fn().mockResolvedValue({error:null,data:{version:1,models,asOf,nextCursor:start+100<values.length?models.at(-1)!.id:null}})};
  });
  const result=await readCommonsCatalog({rpc:call} as unknown as Pick<SupabaseClient<Database>,'rpc'>,new AbortController().signal);
  expect(result).toHaveLength(1003);expect(new Set(result.map(m=>m.id)).size).toBe(1003);expect(result[0]!.id).toBe('model-0000');expect(result[1]!.id).toBe('model-0002');
  expect(call).toHaveBeenCalledTimes(11);expect(call.mock.calls[1]![1]).toEqual({p_limit:100,p_after:'model-0099',p_as_of:asOf});
});
it('supports a legacy server without imposing a total model limit',async()=>{
  const values=Array.from({length:1001},(_,i)=>model(i));
  const call=vi.fn().mockReturnValueOnce({abortSignal:vi.fn().mockResolvedValue({error:{code:'PGRST202'},data:null})}).mockReturnValueOnce({abortSignal:vi.fn().mockResolvedValue({error:null,data:{version:1,models:values}})});
  expect(await readCommonsCatalog({rpc:call} as unknown as Pick<SupabaseClient<Database>,'rpc'>,new AbortController().signal)).toHaveLength(1001);
  expect(parseCommonsCatalog({version:1,models:values})).toHaveLength(1001);
});
it('rejects duplicated pages and changed traversal boundaries instead of silently dropping models',async()=>{
  for(const second of [{version:1,models:[model(0)],asOf,nextCursor:null},{version:1,models:[model(1)],asOf:'2026-11-06T00:00:00Z',nextCursor:null}]){
    const call=vi.fn().mockReturnValueOnce({abortSignal:vi.fn().mockResolvedValue({error:null,data:{version:1,models:[model(0)],asOf,nextCursor:model(0).id}})}).mockReturnValueOnce({abortSignal:vi.fn().mockResolvedValue({error:null,data:second})});
    await expect(readCommonsCatalog({rpc:call} as unknown as Pick<SupabaseClient<Database>,'rpc'>,new AbortController().signal)).rejects.toThrow(/pagination/);
  }
});
