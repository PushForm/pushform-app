// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it, vi } from 'vitest';
import { CommonsProfiles, commonsProfileFieldsSchema } from './CommonsProfiles';
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const fields={handle:'example-maker',displayName:'Example Maker',bio:'A maker',avatarUrl:null,links:[{label:'Portfolio',url:'https://example.com'}]};
const mine={...fields,id,active:true,version:1};
function client(data:unknown,error:null|{message:string}=null){
  const abortSignal=vi.fn().mockResolvedValue({data,error});const rpc=vi.fn().mockReturnValue(Object.assign(Promise.resolve({data,error}),{abortSignal}));
  return {rpc,abortSignal,profiles:new CommonsProfiles({rpc} as unknown as ConstructorParameters<typeof CommonsProfiles>[0])};
}
it('reads a strict public profile page and never accepts private account fields',async()=>{
  const {profiles,rpc}=client({profile:{...fields,id},models:[]});expect(await profiles.get(id)).toMatchObject({profile:{id,handle:fields.handle},models:[]});expect(rpc).toHaveBeenCalledWith('commons_profile',{p_id:id});
  const bad=client({profile:{...fields,id,email:'private@example.com'},models:[]});await expect(bad.profiles.get(id)).rejects.toThrow();
});
it('validates profile links and IDs before networking and supports cancellation',async()=>{
  const {profiles,rpc,abortSignal}=client(mine);await expect(profiles.get('../escape')).rejects.toThrow('invalid');expect(rpc).not.toHaveBeenCalled();
  expect(commonsProfileFieldsSchema.safeParse({...fields,avatarUrl:'javascript:alert(1)'}).success).toBe(false);
  const signal=new AbortController().signal;expect(await profiles.mine(signal)).toEqual(mine);expect(abortSignal).toHaveBeenCalledWith(signal);
});
it('mutates only the current profile and includes concurrency and explicit public consent',async()=>{
  const {profiles,rpc}=client(mine);await profiles.save(fields,null,true);expect(rpc).toHaveBeenCalledWith('commons_save_profile',{p_handle:fields.handle,p_display_name:fields.displayName,p_bio:fields.bio,p_avatar_url:null,p_links:fields.links,p_expected_version:null,p_public_consent:true});
  await profiles.hide(1);expect(rpc).toHaveBeenCalledWith('commons_hide_profile',{p_expected_version:1});
});
it('reports actionable conflicts and hides raw provider errors',async()=>{
  await expect(client(null,{message:'commons_handle_taken'}).profiles.save(fields,null,true)).rejects.toThrow('already in use');
  await expect(client(null,{message:'commons_profile_conflict'}).profiles.hide(1)).rejects.toThrow('another tab');
  await expect(client(null,{message:'private credentials or diagnostics'}).profiles.mine()).rejects.toThrow('could not be loaded or saved');
});
