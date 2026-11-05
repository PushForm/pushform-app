// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectActivityQueue, validProjectActivity, type ProjectActivityEvent } from './ProjectActivity';
afterEach(()=>vi.useRealTimers());
const uuid='11111111-1111-4111-8111-111111111111';
const event=():ProjectActivityEvent=>({id:crypto.randomUUID(),kind:'project_started',documentKey:uuid,documentType:'model',fingerprint:'a'.repeat(64),storage:'local',at:new Date().toISOString()});
function storage():Storage{const m=new Map<string,string>();return {get length(){return m.size;},key:i=>[...m.keys()][i]??null,getItem:k=>m.get(k)??null,setItem:(k,v)=>{m.set(k,v);},removeItem:k=>{m.delete(k);},clear:()=>m.clear()};}
it('persists immutable events and retries with the same IDs without losing another tab’s events',async()=>{
 vi.useFakeTimers();const store=storage(),transport=vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValue(undefined);
 const a=new ProjectActivityQueue(uuid,()=>true,()=>0,transport,store),e=event();a.record(e);await a.flush();expect(store.length).toBe(1);
 const b=new ProjectActivityQueue(uuid,()=>true,()=>0,transport,store);const other=event();b.record(other);await b.flush();
 expect(transport.mock.calls[1]![0].map((x:ProjectActivityEvent)=>x.id).sort()).toEqual([e.id,other.id].sort());expect(store.length).toBe(0);a.clear();b.clear();
});
it('discards pending evidence after withdrawal/account change and excludes pre-choice data',async()=>{
 vi.useFakeTimers();const store=storage(),transport=vi.fn().mockResolvedValue(undefined);let enabled=true;
 const q=new ProjectActivityQueue(uuid,()=>enabled,()=>Date.now()-1000,transport,store);q.record(event());enabled=false;await q.flush();expect(store.length).toBe(0);expect(transport).not.toHaveBeenCalled();
 enabled=true;q.record({...event(),at:new Date(Date.now()-2000).toISOString()});await q.flush();expect(transport).not.toHaveBeenCalled();q.clear();
});
it('refuses arbitrary/personal fields and malformed fingerprints without affecting the caller',()=>{
 expect(validProjectActivity({...event(),filename:'private.pf'})).toBe(false);expect(validProjectActivity({...event(),fingerprint:'geometry'})).toBe(false);
 expect(validProjectActivity({...event(),fingerprint:{toString:null}})).toBe(false);
 expect(validProjectActivity({...event(),storage:'cloud'})).toBe(false);expect(validProjectActivity(event())).toBe(true);
});
it('sends at most fifty events per batch and preserves newly queued observations during a send',async()=>{
 vi.useFakeTimers();let finish!:()=>void;const transport=vi.fn().mockImplementationOnce(()=>new Promise<void>(r=>{finish=r;})).mockResolvedValue(undefined);
 const q=new ProjectActivityQueue(uuid,()=>true,()=>0,transport,storage());for(let i=0;i<51;i++)q.record(event());const sending=q.flush();q.record(event());finish();await sending;await q.flush();
 expect(transport.mock.calls.every(c=>c[0].length<=50)).toBe(true);expect(transport.mock.calls.reduce((n,c)=>n+c[0].length,0)).toBe(52);q.clear();
});

it('retains already-consented pending observations during a temporary profile reload without collecting new events',async()=>{
 vi.useFakeTimers();let enabled=true;const store=storage(),transport=vi.fn().mockResolvedValue(undefined);
 const q=new ProjectActivityQueue(uuid,()=>enabled,()=>0,transport,store,()=>true);q.record(event());enabled=false;q.record(event());await q.flush();
 expect(store.length).toBe(1);expect(transport).not.toHaveBeenCalled();enabled=true;await q.flush();expect(transport.mock.calls[0]![0]).toHaveLength(1);q.clear();
});
