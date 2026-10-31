// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useState, useSyncExternalStore, type FormEvent, type JSX, type ReactNode } from 'react';
import {
  CloudProfiles, cloudProfileComplete, commonsFileUrl, downloadCommonsFile,
  readCommonsAccountStatus, setCommonsMailingPreference,
  type CloudSession, type CloudProfileState, type CommonsAccountStatus, type CommonsFile, type createBrowserRpc,
} from '@pushform/cloud';
import { ProfileForm } from '@pushform/account-ui';

export interface CommonsAccessAccount { session: CloudSession; client: ReturnType<typeof createBrowserRpc>['client'] }
const RETURN_KEY = 'pushform:commons:return';
const validReturn = (value: string | null): value is string => value !== null && /^(#models\/[a-z0-9][a-z0-9-]{0,95}|#account|#publish)$/.test(value);
/** Keep only a local Commons route while the ordinary email callback clears authentication parameters. */
export function rememberCommonsReturnRoute(): void {
  try { if (validReturn(window.location.hash)) sessionStorage.setItem(RETURN_KEY, window.location.hash); } catch { /* Storage may be unavailable. */ }
}
export function restoreCommonsReturnRoute(): void {
  try {
    const route = sessionStorage.getItem(RETURN_KEY);
    if (validReturn(route) && !window.location.hash) {
      window.history.replaceState(window.history.state, '', '/' + route);
      sessionStorage.removeItem(RETURN_KEY);
    }
  } catch { /* OTP sign-in still works when storage is unavailable. */ }
}
const noProfile: CloudProfileState = {status:'loading',ownerId:null,profile:null,saving:false,error:null};
const noSubscribe = (): (()=>void) => () => {};
const noSnapshot = (): CloudProfileState => noProfile;

/** The same private account details and initial Terms step used by the editor; no public profile is required. */
export function CommonsAccessGate({account,children}:{account:CommonsAccessAccount;children:ReactNode}):JSX.Element {
  const session=useSyncExternalStore(account.session.subscribe,account.session.getSnapshot);
  const [profiles,setProfiles]=useState<CloudProfiles|null>(null);
  useEffect(()=>{void account.session.start();const store=new CloudProfiles(account.client,account.session);setProfiles(store);return()=>store.dispose();},[account.client,account.session]);
  const state=useSyncExternalStore(profiles?.subscribe??noSubscribe,profiles?.getSnapshot??noSnapshot);
  if(session.status!=='signedIn')return <SignIn session={account.session}/>;
  if(!profiles||state.status==='loading'||state.status==='signedOut'||state.ownerId!==session.user?.id)return <p role="status">Loading your account…</p>;
  if(state.status==='error')return <section className="commons-account"><p role="alert">{state.error}</p><button onClick={()=>void profiles.reload()}>Try again</button></section>;
  if(!cloudProfileComplete(state.profile))return <section className="commons-account" aria-label="Set up your account">
    <h2>{state.profile?'Review the updated terms':'Tell us about yourself'}</h2>
    <p>Signed in as <strong>{session.user?.email}</strong>. These are your PushForm account details; creating a public creator profile is optional.</p>
    <ProfileForm profiles={profiles} state={state} submitLabel="Continue" savingLabel="Saving…" termsLocked={false}/>
    <button onClick={()=>void account.session.signOut()} disabled={session.pending!==null}>Sign out</button>
  </section>;
  return <>{children}</>;
}
function SignIn({session}:{session:CloudSession}):JSX.Element {
  const state=useSyncExternalStore(session.subscribe,session.getSnapshot);
  const [email,setEmail]=useState('');const [code,setCode]=useState('');
  if(state.status==='unavailable')return <p role="alert">Sign-in is not configured for this build.</p>;
  if(state.status==='restoring')return <p role="status">Restoring your session…</p>;
  const submit=(event:FormEvent):void=>{event.preventDefault();rememberCommonsReturnRoute();void (state.emailSentTo?session.verifyCode(code):session.sendSignInEmail(email));};
  return <section className="commons-account" aria-label="Sign in to Commons"><h2>Sign in to continue</h2>
    <p>Use your PushForm account to download models. New accounts complete the same account setup as the editor.</p>
    <form onSubmit={submit}>{state.emailSentTo?<><p>Enter the code sent to <strong>{state.emailSentTo}</strong>.</p><label>Email code <input autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6,10}" maxLength={10} required value={code} onChange={event=>setCode(event.target.value.replace(/\s/g,''))} disabled={state.pending!==null}/></label></>:<label>Email address <input type="email" autoComplete="email" required value={email} onChange={event=>setEmail(event.target.value)} disabled={state.pending!==null}/></label>}
      {state.error&&<p role="alert">{state.error}</p>}<button disabled={state.pending!==null}>{state.emailSentTo?'Verify code':'Send sign-in email'}</button>
      {state.emailSentTo&&<button type="button" disabled={state.pending!==null} onClick={()=>session.changeEmail()}>Use a different email</button>}
    </form>
  </section>;
}

/** An optional private mailing choice; it never controls model access or public profile visibility. */
export function CommonsMailingPreference({account}:{account:CommonsAccessAccount}):JSX.Element {
  const session=useSyncExternalStore(account.session.subscribe,account.session.getSnapshot);
  const [state,setState]=useState<{owner:string|null;value:CommonsAccountStatus|null;error:string|null;busy:boolean}>({owner:null,value:null,error:null,busy:false});
  useEffect(()=>{let live=true;const owner=session.user?.id??null;setState({owner,value:null,error:null,busy:false});if(owner)void readCommonsAccountStatus(account.client).then(value=>{if(live)setState({owner,value,error:null,busy:false});},()=>{if(live)setState({owner,value:null,error:'Could not load your mailing preference.',busy:false});});return()=>{live=false;};},[account.client,session.user?.id]);
  const owner=session.user?.id??null;
  if(!owner||owner!==state.owner)return <></>;
  if(!state.value)return <p role={state.error?'alert':'status'}>{state.error??'Loading mailing preference…'}</p>;
  return <section className="commons-account" aria-label="Mailing list"><h2>Email updates</h2>
    <label><input type="checkbox" checked={state.value.mailingOptIn} disabled={state.busy} onChange={event=>{
      const checked=event.target.checked;setState(current=>({...current,busy:true,error:null}));
      void setCommonsMailingPreference(account.client,checked).then(value=>setState(current=>current.owner===owner?{owner,value,error:null,busy:false}:current),()=>setState(current=>current.owner===owner?{...current,busy:false,error:'Could not save your mailing preference.'}:current));
    }}/> Send me PushForm news and updates by email (optional)</label>
    <p>You can change this choice here. It does not affect downloads.</p>{state.error&&<p role="alert">{state.error}</p>}
  </section>;
}

export function CommonsDownloadButton({account,filesUrl,file}:{account?:CommonsAccessAccount|undefined;filesUrl?:string|undefined;file:CommonsFile}):JSX.Element {
  const [request,setRequest]=useState(0);
  if(!commonsFileUrl(filesUrl,'downloads',file.id))return <span>Downloads are unavailable in this build.</span>;
  if(!account)return <span>Sign-in is unavailable in this build.</span>;
  return <div className="commons-download">
    <button onClick={()=>{rememberCommonsReturnRoute();setRequest(value=>value+1);}}>Download ZIP — {file.name}</button>
    {request>0&&<CommonsAccessGate account={account}><DownloadTransfer key={`${file.id}:${request}`} account={account} filesUrl={filesUrl!} file={file}/></CommonsAccessGate>}
  </div>;
}
function DownloadTransfer({account,filesUrl,file}:{account:CommonsAccessAccount;filesUrl:string;file:CommonsFile}):JSX.Element {
  const [result,setResult]=useState<{error:string|null;done:boolean}>({error:null,done:false});const [attempt,setAttempt]=useState(0);
  useEffect(()=>{const controller=new AbortController();let live=true;const owner=account.session.getSnapshot().user?.id;
    setResult({error:null,done:false});
    void (async()=>{
      const token=await account.session.getAccessToken();if(!token)throw new Error('Sign in again to download this model.');
      const blob=await downloadCommonsFile(filesUrl,token,file.id,controller.signal);
      if(!live||account.session.getSnapshot().user?.id!==owner)return;
      const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=file.name+'.zip';link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
      try { sessionStorage.removeItem(RETURN_KEY); } catch { /* Storage is optional. */ }
      setResult({error:null,done:true});
    })().catch(error=>{if(live&&!controller.signal.aborted)setResult({error:error instanceof Error?error.message:'Could not download this model.',done:false});});
    return()=>{live=false;controller.abort();};
  },[account.session,filesUrl,file.id,file.name,attempt]);
  return result.error?<div><p role="alert">{result.error}</p><button onClick={()=>setAttempt(value=>value+1)}>Try download again</button></div>:<p role="status">{result.done?'Download started. Keep the included license and attribution notices.':'Preparing your model download…'}</p>;
}
