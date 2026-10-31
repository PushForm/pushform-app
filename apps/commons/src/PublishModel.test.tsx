// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PublishModel, type PublishModelProps } from './PublishModel';
const revisionId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';const profileId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';const assetId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const metadata={title:'Contributor fixture',description:'A model for publishing tests.',creator:'Example Maker',category:'Hardware',tags:[],formats:['STL'],imageUrl:null,source:null,
  licenses:[{name:'CC0 1.0',url:'https://creativecommons.org/publicdomain/zero/1.0/',commercialUse:'allowed',conditions:[] as string[]}],credits:[{name:'Example Maker',url:'https://example.com/maker',text:'Original author notice.'}]};
const draft={id:revisionId,model_id:'contributor-model',number:1,status:'pending',asset_version:2,rights_basis:'Original files owned by this contributor.',creator_profile_id:profileId,self_service:true,metadata};
const asset={id:assetId,revision_id:revisionId,filename:'original.stl',format:'stl',size_bytes:3,sha256:'a'.repeat(64),status:'ready',created_at:'2026-10-31T00:00:00Z',verified_at:'2026-10-31T00:00:01Z'};
function setup(existing=false,value=draft){
  let current=existing?{models:[{id:value.model_id,latest_submission:revisionId,published_revision:null as string|null}],revisions:[value]}:{models:[],revisions:[]};
  const rpc=vi.fn((name:string,args:Record<string,unknown>)=>{const execute=async()=>{
    if(name==='commons_my_models')return{data:current,error:null};
    if(name==='commons_model_assets')return{data:existing?[asset]:[],error:null};
    if(name==='commons_submit_model'){const saved={...value,metadata:args.p_metadata};current={models:[{id:value.model_id,latest_submission:revisionId,published_revision:null}],revisions:[saved as typeof value]};return{data:saved,error:null};}
    if(name==='commons_publish_model'){current={models:[{id:value.model_id,latest_submission:revisionId,published_revision:revisionId}],revisions:[{...value,status:'published'}]};return{data:current.revisions[0],error:null};}
    throw new Error('Unexpected operation');
  };const promise=execute();return Object.assign(promise,{abortSignal:()=>promise});});
  render(<PublishModel client={{rpc} as unknown as PublishModelProps['client']} session={{getAccessToken:async()=>'token'} as PublishModelProps['session']} filesUrl="http://localhost:8788" profile={{id:profileId,displayName:'Example Maker'}}/>);return rpc;
}
afterEach(cleanup);
it('saves a private structured draft without a staff approval operation',async()=>{
  const rpc=setup();await screen.findByText('You haven’t published a model yet.');
  fireEvent.change(screen.getByLabelText('Title'),{target:{value:'My shelf bracket'}});
  fireEvent.click(screen.getByRole('button',{name:'Save private draft'}));
  await screen.findByText('Draft saved. Attach files, then publish when ready.');
  const submission=rpc.mock.calls.find(([name])=>name==='commons_submit_model')!;
  expect(submission[1]).toMatchObject({p_original_work:true,p_expected_revision:null,p_metadata:{title:'My shelf bracket',creator:'Example Maker'}});
  expect(rpc.mock.calls.some(([name])=>name.startsWith('admin_'))).toBe(false);
  expect((screen.getByRole('button',{name:'Publish model'}) as HTMLButtonElement).disabled).toBe(true);
});
it('requires explicit rights confirmation for the exact verified asset version and publishes directly',async()=>{
  const rpc=setup(true);fireEvent.click(await screen.findByRole('button',{name:'Contributor fixture'}));await screen.findByText(/original.stl ·/);
  const publish=screen.getByRole('button',{name:'Publish model'}) as HTMLButtonElement;expect(publish.disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox',{name:/I have permission to redistribute/}));expect(publish.disabled).toBe(false);fireEvent.click(publish);
  await screen.findByText('Model published.');
  expect(rpc).toHaveBeenCalledWith('commons_publish_model',{p_revision:revisionId,p_expected_published:null,p_expected_asset_version:2,p_rights_confirmed:true});
});
it('retains every original license and attribution URL when creating a correction',async()=>{
  const previous={...draft,metadata:{...metadata,licenses:[...metadata.licenses,{name:'Asset License 2',url:'https://example.com/asset-license',commercialUse:'restricted',conditions:['Retain texture notice.']}],credits:[...metadata.credits,{name:'Texture artist',url:'https://example.com/artist',text:'Texture notice.'}]}};
  const rpc=setup(true,previous);fireEvent.click(await screen.findByRole('button',{name:'Contributor fixture'}));
  fireEvent.click(screen.getByRole('button',{name:'Create a correction'}));fireEvent.click(screen.getByRole('button',{name:'Save private draft'}));
  await waitFor(()=>expect(rpc.mock.calls.some(([name])=>name==='commons_submit_model')).toBe(true));
  const submitted=rpc.mock.calls.find(([name])=>name==='commons_submit_model')![1].p_metadata as typeof metadata;
  expect(submitted.licenses).toEqual(previous.metadata.licenses);expect(submitted.credits).toEqual(previous.metadata.credits);
});
