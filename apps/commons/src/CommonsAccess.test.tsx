// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { CloudSession,CLOUD_TERMS_VERSION,type AuthApi } from '@pushform/cloud';
import { CommonsAccessGate,CommonsDownloadButton,type CommonsAccessAccount,rememberCommonsReturnRoute,restoreCommonsReturnRoute } from './CommonsAccess';
const disposals:(()=>void)[]=[];
afterEach(()=>{cleanup();disposals.splice(0).forEach(fn=>fn());vi.restoreAllMocks();sessionStorage.clear();window.history.replaceState(null,'','/');});
const row={first_name:'Ada',last_name:'Lovelace',account_type:'individual',company_name:null,company_size:null,industry:'hobbyist',industry_other:null,terms_version:CLOUD_TERMS_VERSION,terms_accepted_at:'2026-10-31T00:00:00Z',completed_at:'2026-10-31T00:00:00Z',updated_at:'2026-10-31T00:00:00Z'};
function account(initial:typeof row|null,signedIn=true){
  const current=signedIn?{access_token:'test-session',expires_at:Math.floor(Date.now()/1000)+3600,user:{id:'11111111-1111-4111-8111-111111111111',email:'ada@example.com'}}:null;
  const session=new CloudSession({initialize:async()=>({error:null}),getSession:async()=>({data:{session:current},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe:()=>{}}}})} as unknown as AuthApi);
  disposals.push(()=>session.dispose());let stored=initial;
  const rpc=vi.fn(async()=>{stored=row;return {data:row,error:null};});
  const client={rpc,from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:stored,error:null})})})})} as unknown as CommonsAccessAccount['client'];
  return {session,client,rpc};
}
it('reuses the initial account fields, keeps mailing optional unchecked, and gates downloads until the form is saved',async()=>{
  const auth=account(null);render(<CommonsAccessGate account={auth}><p>Download is ready</p></CommonsAccessGate>);
  expect(await screen.findByRole('heading',{name:'Tell us about yourself'})).toBeTruthy();
  expect(screen.queryByText('Download is ready')).toBeNull();
  expect((screen.getByRole('checkbox',{name:/Send me PushForm news/}) as HTMLInputElement).checked).toBe(false);
  fireEvent.change(screen.getByLabelText('First name'),{target:{value:'Ada'}});fireEvent.change(screen.getByLabelText('Last name'),{target:{value:'Lovelace'}});
  fireEvent.click(screen.getByRole('radio',{name:'As an individual'}));fireEvent.change(screen.getByLabelText('Industry'),{target:{value:'hobbyist'}});
  expect((screen.getByRole('button',{name:'Continue'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox',{name:/I accept the Terms of Use/}));fireEvent.click(screen.getByRole('button',{name:'Continue'}));
  expect(await screen.findByText('Download is ready')).toBeTruthy();
  expect(auth.rpc).toHaveBeenCalledWith('cloud_save_profile',expect.objectContaining({p_first_name:'Ada',p_terms_version:CLOUD_TERMS_VERSION,p_mailing_opt_in:false}));
});
it('skips onboarding for an existing completed account and offers sign-in to a signed-out visitor',async()=>{
  const auth=account(row);const view=render(<CommonsAccessGate account={auth}><p>Download is ready</p></CommonsAccessGate>);
  expect(await screen.findByText('Download is ready')).toBeTruthy();expect(screen.queryByRole('checkbox')).toBeNull();
  view.unmount();const visitor=account(null,false);render(<CommonsAccessGate account={visitor}><p>Private action</p></CommonsAccessGate>);
  expect(await screen.findByRole('heading',{name:'Sign in to continue'})).toBeTruthy();expect(screen.queryByText('Private action')).toBeNull();
});
it('never exposes an anonymous file link and downloads using the current session after account setup',async()=>{
  const auth=account(row);const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('ZIP',{headers:{'Content-Type':'application/zip'}}));
  const create=vi.fn(()=> 'blob:local-test');Object.defineProperty(URL,'createObjectURL',{value:create,configurable:true});Object.defineProperty(URL,'revokeObjectURL',{value:vi.fn(),configurable:true});
  vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});
  render(<CommonsDownloadButton account={auth} filesUrl="https://files.example" file={{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',name:'part.step',format:'STEP',sizeBytes:3,sha256:'a'.repeat(64)}}/>);
  expect(screen.queryByRole('link')).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Download ZIP — part.step'}));
  await waitFor(()=>expect(create).toHaveBeenCalledOnce());expect(new Headers(fetcher.mock.calls[0]![1]!.headers).get('Authorization')).toBe('Bearer test-session');
});
it('preserves only safe local routes through the email callback',()=>{
  window.history.replaceState(null,'','/#models/example-part');rememberCommonsReturnRoute();window.history.replaceState(null,'','/');restoreCommonsReturnRoute();expect(window.location.hash).toBe('#models/example-part');
  sessionStorage.setItem('pushform:commons:return','https://untrusted.example/');window.history.replaceState(null,'','/');restoreCommonsReturnRoute();expect(window.location.hash).toBe('');
});

it('resumes only the same pending model asset after an email callback reload and clears the intent on success',async()=>{
  const file={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',name:'part.step',format:'STEP',sizeBytes:3,sha256:'a'.repeat(64)};
  window.history.replaceState(null,'','/#models/example-part');
  const visitor=account(null,false);const first=render(<CommonsDownloadButton account={visitor} filesUrl="https://files.example" file={file}/>);
  fireEvent.click(screen.getByRole('button',{name:'Download ZIP — part.step'}));
  await screen.findByRole('heading',{name:'Sign in to continue'});
  const stored=JSON.parse(sessionStorage.getItem('pushform:commons:download')!);
  expect(stored).toMatchObject({version:1,assetId:file.id,route:'#models/example-part'});expect(Object.keys(stored).sort()).toEqual(['assetId','requestedAt','route','version']);
  first.unmount();window.history.replaceState(null,'','/');restoreCommonsReturnRoute();expect(window.location.hash).toBe('#models/example-part');
  const auth=account(row);const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('ZIP',{headers:{'Content-Type':'application/zip'}}));
  const create=vi.fn(()=> 'blob:callback-test');Object.defineProperty(URL,'createObjectURL',{value:create,configurable:true});Object.defineProperty(URL,'revokeObjectURL',{value:vi.fn(),configurable:true});vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});
  render(<CommonsDownloadButton account={auth} filesUrl="https://files.example" file={file}/>);
  await screen.findByText('Download started. Keep the included license and attribution notices.');
  expect(fetcher).toHaveBeenCalledOnce();expect(create).toHaveBeenCalledOnce();expect(sessionStorage.getItem('pushform:commons:download')).toBeNull();
});
it('does not auto-download stale, malformed, wrong-route or nonmatching asset intents',async()=>{
  const auth=account(row);const file={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',name:'part.step',format:'STEP',sizeBytes:3,sha256:'a'.repeat(64)};
  const fetcher=vi.spyOn(globalThis,'fetch');window.history.replaceState(null,'','/#models/example-part');
  const base={version:1,assetId:file.id,route:'#models/example-part',requestedAt:Date.now()};
  for(const value of [JSON.stringify({...base,requestedAt:Date.now()-15*60*1000}),'{bad-json',JSON.stringify({...base,route:'https://untrusted.example/'}),JSON.stringify({...base,assetId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}),JSON.stringify({...base,route:'#models/other-model'}),JSON.stringify({...base,requestedAt:Date.now()+60000}),JSON.stringify({...base,token:'must-never-be-accepted'})]){
    sessionStorage.setItem('pushform:commons:download',value);const view=render(<CommonsDownloadButton account={auth} filesUrl="https://files.example" file={file}/>);
    expect(screen.queryByRole('button',{name:'Cancel download'})).toBeNull();expect(fetcher).not.toHaveBeenCalled();view.unmount();
  }
});
it('lets a visitor cancel a pending authenticated download without retaining an automatic transfer intent',async()=>{
  const auth=account(null,false);const file={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',name:'part.step',format:'STEP',sizeBytes:3,sha256:'a'.repeat(64)};
  window.history.replaceState(null,'','/#models/example-part');render(<CommonsDownloadButton account={auth} filesUrl="https://files.example" file={file}/>);
  fireEvent.click(screen.getByRole('button',{name:'Download ZIP — part.step'}));await screen.findByRole('heading',{name:'Sign in to continue'});
  expect(sessionStorage.getItem('pushform:commons:download')).not.toBeNull();fireEvent.click(screen.getByRole('button',{name:'Cancel download'}));
  expect(sessionStorage.getItem('pushform:commons:download')).toBeNull();expect(sessionStorage.getItem('pushform:commons:return')).toBeNull();expect(screen.queryByRole('heading',{name:'Sign in to continue'})).toBeNull();
});
