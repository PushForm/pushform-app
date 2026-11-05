// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it, vi } from 'vitest';
import { rememberCampaign, followCampaign } from './CloudCampaign';
import type { CloudSession } from './CloudSession';
import type { CloudProfileStore } from './CloudProfile';
const token='11111111-1111-4111-8111-111111111111';
it('retains the token through auth callbacks and refuses ambiguous or misplaced incoming tokens',()=>{
 const store=new Map<string,string>(); const storage={getItem:(k:string)=>store.get(k)??null,setItem:(k:string,v:string)=>{store.set(k,v);},removeItem:(k:string)=>{store.delete(k);}};
 expect(rememberCampaign(new URL(`https://app.test/?campaignHandoff=${token}`),storage)).toBe(token);
 expect(rememberCampaign(new URL('https://app.test/auth/callback?code=secret'),storage)).toBe(token);
 expect(rememberCampaign(new URL(`https://app.test/?campaignHandoff=${token}&campaignHandoff=${token}`),storage)).toBeNull();
 expect(rememberCampaign(new URL(`https://app.test/auth/callback?campaignHandoff=${token}`),storage)).toBeNull();
});
function fixture(){
 let owner:string|null=null, consent:boolean|null=null, allowed=true;
 const events=new Set<()=>void>();const subscribe=(f:()=>void)=>{events.add(f);return()=>{events.delete(f);};};
 const session={subscribe,getSnapshot:()=>({status:owner?'signedIn':'signedOut',user:owner?{id:owner}:null})} as Pick<CloudSession,'subscribe'|'getSnapshot'>;
 const profiles={subscribe,getSnapshot:()=>({status:'ready',ownerId:owner,profile:owner?{analyticsOptIn:consent}:null})} as unknown as CloudProfileStore;
 const claim=vi.fn().mockResolvedValue(undefined),clear=vi.fn();
 followCampaign(session,profiles,{claim},token,clear,()=>allowed);
 return {claim,clear,set:(value:string|null,choice:boolean|null)=>{owner=value;consent=choice;for(const f of events)f();},disable:()=>{allowed=false;}};
}
it('waits for sign-in and submitted consent, then claims for one expected owner',async()=>{
 const f=fixture();expect(f.claim).not.toHaveBeenCalled();f.set('alice',true);
 expect(f.claim).toHaveBeenCalledExactlyOnceWith(token,'alice');await Promise.resolve();expect(f.clear).toHaveBeenCalled();
});
it('never replays a pending token after account switch, opt-out or a privacy signal',()=>{
 const f=fixture();f.set('alice',null);f.set('bob',true);expect(f.claim).not.toHaveBeenCalled();
 const g=fixture();g.disable();g.set('alice',true);expect(g.claim).not.toHaveBeenCalled();
 const h=fixture();h.set('alice',false);h.set('alice',true);expect(h.claim).not.toHaveBeenCalled();
});
