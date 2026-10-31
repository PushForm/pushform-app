// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useState, type FormEvent } from 'react';
import { commonsProfileFieldsSchema, type CommonsProfile, type CommonsProfileFields, type CommonsProfilePage, type CommonsProfiles } from '@pushform/cloud';

export function CreatorCredit({model}:{model:{creator:string;creatorProfile?:{id:string}|null}}){
  return <>By {model.creatorProfile?<a href={`#people/${model.creatorProfile.id}`}>{model.creator}</a>:model.creator}</>;
}
export function CommonsProfilePageView({id,profiles}:{id:string;profiles:CommonsProfiles|null}){
  const [page,setPage]=useState<CommonsProfilePage|null|undefined>();const [error,setError]=useState(false);const [attempt,setAttempt]=useState(0);
  useEffect(()=>{
    setPage(undefined);setError(false);if(!profiles)return;
    const controller=new AbortController();void profiles.get(id,controller.signal).then(value=>{if(!controller.signal.aborted)setPage(value);},()=>{if(!controller.signal.aborted)setError(true);});
    return()=>controller.abort();
  },[id,profiles,attempt]);
  useEffect(()=>{document.title=page?`${page.profile.displayName} — PushForm Commons`:'Profile — PushForm Commons';},[page]);
  if(!profiles)return <section className="status-panel"><h1>Profiles are unavailable in this build.</h1><a href="#browse">Browse models</a></section>;
  if(error)return <section className="status-panel" role="alert"><h1>We couldn’t load this profile.</h1><button onClick={()=>setAttempt(value=>value+1)}>Try again</button></section>;
  if(page===undefined)return <p className="status-panel" role="status">Loading profile…</p>;
  if(page===null)return <section className="status-panel"><h1>This profile isn’t available.</h1><p>It may be hidden or the account may have been removed.</p><a href="#browse">Browse models</a></section>;
  return <article className="profile-page"><a className="back-link" href="#browse">← All models</a>
    <header className="profile-heading"><ProfileAvatar name={page.profile.displayName} url={page.profile.avatarUrl}/><div><p className="eyebrow">Community profile</p><h1>{page.profile.displayName}</h1><p>@{page.profile.handle}</p></div></header>
    {page.profile.bio&&<p className="profile-bio">{page.profile.bio}</p>}
    {page.profile.links.length>0&&<ul className="profile-links">{page.profile.links.map((link,index)=><li key={index}><a href={link.url} target="_blank" rel="noreferrer noopener">{link.label} ↗</a></li>)}</ul>}
    <h2>Published models</h2>{page.models.length===0?<p>No published models to show.</p>:<div className="profile-models">{page.models.map(model=><article key={model.id}><p className="eyebrow">{model.category}</p><h3><a href={`#models/${model.id}`}>{model.title}</a></h3><p>{model.description}</p><p>{model.licenses.map(license=>license.name).join(' · ')}</p></article>)}</div>}
  </article>;
}
function ProfileAvatar({name,url}:{name:string;url:string|null}){
  const [failed,setFailed]=useState(false);useEffect(()=>setFailed(false),[url]);
  return url&&!failed?<img className="profile-avatar" src={url} alt={`${name}'s avatar`} referrerPolicy="no-referrer" onError={()=>setFailed(true)}/>:<div className="profile-avatar profile-avatar-fallback" aria-hidden="true">{name.slice(0,1).toUpperCase()}</div>;
}
const emptyFields:CommonsProfileFields={handle:'',displayName:'',bio:'',avatarUrl:null,links:[]};
export function CommonsProfileEditor({profiles}:{profiles:CommonsProfiles}){
  const [profile,setProfile]=useState<CommonsProfile|null|undefined>();const [fields,setFields]=useState<CommonsProfileFields>(emptyFields);const [consent,setConsent]=useState(false);
  const [error,setError]=useState('');const [message,setMessage]=useState('');const [busy,setBusy]=useState(false);const [attempt,setAttempt]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();setProfile(undefined);setError('');setConsent(false);
    void profiles.mine(controller.signal).then(value=>{if(!controller.signal.aborted){setProfile(value);setFields(value?{handle:value.handle,displayName:value.displayName,bio:value.bio,avatarUrl:value.avatarUrl,links:value.links}:emptyFields);}},()=>{if(!controller.signal.aborted)setError('Your public profile could not be loaded. Try again.');});
    return()=>controller.abort();
  },[profiles,attempt]);
  const update=(patch:Partial<CommonsProfileFields>)=>{setFields(current=>({...current,...patch}));setMessage('');};
  const save=(event:FormEvent)=>{
    event.preventDefault();setError('');setMessage('');
    const parsed=commonsProfileFieldsSchema.safeParse(fields);if(!parsed.success){setError('Enter a valid handle, display name and HTTPS links.');return;}
    if(!consent){setError('Confirm that this profile will be public.');return;}
    setBusy(true);void profiles.save(parsed.data,profile?.version??null,true).then(value=>{setProfile(value);setConsent(false);setMessage('Your public profile is saved.');window.dispatchEvent(new Event('commons:catalog-changed'));},failure=>setError(failure instanceof Error?failure.message:'Your profile could not be saved.')).finally(()=>setBusy(false));
  };
  const hide=()=>{if(!profile)return;setBusy(true);setError('');setMessage('');void profiles.hide(profile.version).then(value=>{setProfile(value);setConsent(false);setMessage('Your profile is hidden. Original model attribution remains available.');window.dispatchEvent(new Event('commons:catalog-changed'));},failure=>setError(failure instanceof Error?failure.message:'Your profile could not be hidden.')).finally(()=>setBusy(false));};
  return <section className="profile-editor" aria-labelledby="profile-edit-title"><h1 id="profile-edit-title">Your public profile</h1>
    <p>Your account details stay private. Only the fields below appear on your public Commons profile. Downloading models does not require a public profile.</p>
    {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
    {profile===undefined?<>{!error&&<p role="status">Loading your profile…</p>}<button onClick={()=>setAttempt(value=>value+1)}>Reload profile</button></>:<>
      {profile&&<p>{profile.active?<a href={`#people/${profile.id}`}>View your public profile</a>:'Your profile is currently hidden.'}</p>}
      <form onSubmit={save} className="profile-form">
        <label>Public handle<input value={fields.handle} onChange={event=>update({handle:event.target.value.toLowerCase()})} required pattern="[a-z][a-z0-9-]{1,30}[a-z0-9]" minLength={3} maxLength={32} disabled={busy||profile!==null}/></label>
        <p className="field-note">3–32 lowercase letters, numbers or hyphens; start with a letter and end with a letter or number. Your handle stays reserved and cannot be changed.</p>
        <label>Display name<input value={fields.displayName} onChange={event=>update({displayName:event.target.value})} required maxLength={100} disabled={busy}/></label>
        <label>Bio<textarea value={fields.bio} onChange={event=>update({bio:event.target.value})} maxLength={2000} rows={4} disabled={busy}/></label>
        <label>Avatar URL (optional)<input type="url" value={fields.avatarUrl??''} onChange={event=>update({avatarUrl:event.target.value||null})} placeholder="https://example.com/avatar.jpg" disabled={busy}/></label>
        <p className="field-note">Use an image you may share. External images load from their hosting site.</p>
        <fieldset disabled={busy}><legend>Public links (optional)</legend>{fields.links.map((link,index)=><div className="profile-link-fields" key={index}>
          <label>Link {index+1} label<input value={link.label} maxLength={80} required onChange={event=>update({links:fields.links.map((item,i)=>i===index?{...item,label:event.target.value}:item)})}/></label>
          <label>Link {index+1} URL<input type="url" value={link.url} required onChange={event=>update({links:fields.links.map((item,i)=>i===index?{...item,url:event.target.value}:item)})}/></label>
          <button type="button" onClick={()=>update({links:fields.links.filter((_,i)=>i!==index)})}>Remove link {index+1}</button>
        </div>)}<button type="button" disabled={fields.links.length>=5} onClick={()=>update({links:[...fields.links,{label:'',url:''}]})}>Add link</button></fieldset>
        <label className="profile-consent"><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)} disabled={busy}/> I understand that these profile fields will be public.</label>
        <div className="profile-actions"><button type="submit" disabled={busy||!consent}>{busy?'Saving…':profile?.active?'Save public profile':'Publish public profile'}</button>
          {profile?.active&&<button type="button" disabled={busy} onClick={hide}>Hide public profile</button>}<button type="button" disabled={busy} onClick={()=>setAttempt(value=>value+1)}>Reload profile</button></div>
      </form>
    </>}
  </section>;
}
