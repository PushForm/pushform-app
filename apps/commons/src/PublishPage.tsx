// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useState, useSyncExternalStore, type JSX } from 'react';
import type { CommonsProfile } from '@pushform/cloud';
import type { CommonsAccount } from './account';
import { CommonsAccessGate } from './CommonsAccess';
import { PublishModel } from './PublishModel';

/** The ordinary account setup is shared; public creator information remains an explicit choice. */
export function PublishPage({account,filesUrl}:{account:CommonsAccount;filesUrl?:string|undefined}):JSX.Element {
  const user=useSyncExternalStore(account.session.subscribe,account.session.getSnapshot).user;
  return <CommonsAccessGate account={account}><OwnPublication key={user?.id??'signed-out'} account={account} filesUrl={filesUrl}/></CommonsAccessGate>;
}
function OwnPublication({account,filesUrl}:{account:CommonsAccount;filesUrl:string|undefined}):JSX.Element {
  const [profile,setProfile]=useState<CommonsProfile|null|undefined>();const [error,setError]=useState('');const [attempt,setAttempt]=useState(0);
  useEffect(()=>{const abort=new AbortController();setProfile(undefined);setError('');void account.profiles.mine(abort.signal).then(setProfile,failure=>{if(!abort.signal.aborted)setError(failure instanceof Error?failure.message:'Your profile could not be loaded.');});return()=>abort.abort();},[account.profiles,attempt]);
  if(error)return <section className="publish-page"><p role="alert">{error}</p><button onClick={()=>setAttempt(value=>value+1)}>Try again</button></section>;
  if(profile===undefined)return <p role="status">Loading your creator profile…</p>;
  if(!profile?.active)return <section className="publish-page"><h1>Create your public creator profile</h1><p>Choose the public name and handle people will see with your contributions. Your private account details stay private.</p><a href="#account">Set up your public profile</a></section>;
  return <PublishModel client={account.client} session={account.session} profile={profile} {...(filesUrl?{filesUrl}:{})}/>;
}
