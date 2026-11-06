// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import {describe,expect,it,vi} from 'vitest';
import {CommonsPublishing} from './CommonsPublishing';

describe('one owned model state',()=>{
  it('requests only the selected model and forwards cancellation',async()=>{
    const signal=new AbortController().signal;
    const result={models:[],revisions:[],assets:[]};
    const abortSignal=vi.fn().mockResolvedValue({data:result,error:null});
    const rpc=vi.fn().mockReturnValue({abortSignal});
    const client=new CommonsPublishing({rpc} as never);
    expect(await client.model('workshop-table',signal)).toEqual(result);
    expect(rpc).toHaveBeenCalledWith('commons_my_model',{p_id:'workshop-table'});
    expect(abortSignal).toHaveBeenCalledWith(signal);
  });
  it('rejects unsafe identifiers before making a request',async()=>{
    const rpc=vi.fn();const client=new CommonsPublishing({rpc} as never);
    for(const id of ['', '../model','UPPER','a'.repeat(97)])await expect(client.model(id)).rejects.toThrow('model identifier');
    expect(rpc).not.toHaveBeenCalled();
  });
  it('validates the returned state envelope',async()=>{
    const rpc=vi.fn().mockResolvedValue({data:{models:[{id:'selected'}],revisions:[],assets:[]},error:null});
    await expect(new CommonsPublishing({rpc} as never).model('selected')).rejects.toThrow();
  });
});
