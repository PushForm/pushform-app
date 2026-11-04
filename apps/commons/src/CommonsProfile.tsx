// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import { commonsProfileFieldsSchema, type CommonsProfile, type CommonsProfileFields, type CommonsProfilePage, type CommonsProfiles } from '@pushform/cloud';
import { navigateCommons, profilePath } from './route';
import { ProfileHero, ProfileImagesEditor, type ProfileImageServices } from './ProfileImages';

/** Links to a public profile page and opens it without reloading Commons. */
export function ProfileLink({handle,children}:{handle:string;children:ReactNode}){
  const open=(event:MouseEvent<HTMLAnchorElement>)=>{
    if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    event.preventDefault();navigateCommons(profilePath(handle));
  };
  return <a href={profilePath(handle)} onClick={open}>{children}</a>;
}
export function CreatorCredit({model}:{model:{creator:string;creatorProfile?:{handle:string}|null}}){
  return <>By {model.creatorProfile?<ProfileLink handle={model.creatorProfile.handle}>{model.creator}</ProfileLink>:model.creator}</>;
}
/** Opens a profile by handle, or by account ID for older links, which then move to the handle address. */
export type ProfileLookup={handle:string}|{id:string};
/** `ownProfileId` is the signed-in user's own profile ID; that profile shows an Edit profile link. */
export function CommonsProfilePageView({lookup,profiles,filesUrl,ownProfileId=null}:{lookup:ProfileLookup;profiles:CommonsProfiles|null;filesUrl?:string|undefined;ownProfileId?:string|null}){
  const [page,setPage]=useState<CommonsProfilePage|null|undefined>();const [error,setError]=useState(false);const [attempt,setAttempt]=useState(0);
  const shown=useRef<CommonsProfilePage|null|undefined>(undefined);shown.current=page;
  const handle='handle' in lookup?lookup.handle:null;const id='id' in lookup?lookup.id:null;
  useEffect(()=>{
    // An older ID link that just moved to its handle address already has this page loaded.
    if(handle!==null&&shown.current?.profile.handle===handle)return;
    setPage(undefined);setError(false);if(!profiles)return;
    const controller=new AbortController();
    const request=handle!==null?profiles.getByHandle(handle,controller.signal):profiles.get(id??'',controller.signal);
    void request.then(value=>{if(controller.signal.aborted)return;setPage(value);if(handle===null&&value)navigateCommons(profilePath(value.profile.handle),true);},()=>{if(!controller.signal.aborted)setError(true);});
    return()=>controller.abort();
  },[handle,id,profiles,attempt]);
  useEffect(()=>{document.title=page?`${page.profile.displayName} — PushForm Commons`:'Profile — PushForm Commons';},[page]);
  if(!profiles)return <section className="status-panel"><h1>Profiles are unavailable in this build.</h1><a href="#browse">Browse models</a></section>;
  if(error)return <section className="status-panel" role="alert"><h1>We couldn’t load this profile.</h1><button onClick={()=>setAttempt(value=>value+1)}>Try again</button></section>;
  if(page===undefined)return <p className="status-panel" role="status">Loading profile…</p>;
  if(page===null)return <section className="status-panel"><h1>This profile isn’t available.</h1><p>It may be hidden or the account may have been removed.</p><a href="#browse">Browse models</a></section>;
  return <article className="profile-page"><a className="back-link" href="#browse">← All models</a>
    <ProfileHero profile={page.profile} filesUrl={filesUrl} actions={ownProfileId!==null&&page.profile.id===ownProfileId?<a className="button-link secondary" href="#account">Edit profile</a>:undefined}/>
    {page.profile.bio&&<p className="profile-bio">{page.profile.bio}</p>}
    {page.profile.links.length>0&&<ul className="profile-links">{page.profile.links.map((link,index)=><li key={index}><a href={link.url} target="_blank" rel="noreferrer noopener">{link.label} ↗</a></li>)}</ul>}
    <h2>Published models</h2>{page.models.length===0?<p>No published models to show.</p>:<div className="profile-models">{page.models.map(model=><article key={model.id}><p className="eyebrow">{model.category}</p><h3><a href={`#models/${model.id}`}>{model.title}</a></h3><p>{model.description}</p><p>{model.licenses.map(license=>license.name).join(' · ')}</p></article>)}</div>}
  </article>;
}
const emptyFields:CommonsProfileFields={handle:'',displayName:'',bio:'',avatarUrl:null,links:[]};
export function CommonsProfileEditor({profiles,images}:{profiles:CommonsProfiles;images?:ProfileImageServices|undefined}){
  const [profile,setProfile]=useState<CommonsProfile|null|undefined>();const [fields,setFields]=useState<CommonsProfileFields>(emptyFields);
  const [error,setError]=useState('');const [message,setMessage]=useState('');const [busy,setBusy]=useState(false);
  useEffect(()=>{
    const controller=new AbortController();setProfile(undefined);setError('');
    void profiles.mine(controller.signal).then(value=>{if(!controller.signal.aborted){setProfile(value);setFields(value?{handle:value.handle,displayName:value.displayName,bio:value.bio,avatarUrl:value.avatarUrl,links:value.links}:emptyFields);}},()=>{if(!controller.signal.aborted)setError('Your public profile could not be loaded. Try again.');});
    return()=>controller.abort();
  },[profiles]);
  // Image changes do not affect the form or its version, so only the image fields are refreshed.
  const imagesChanged=async()=>{const value=await profiles.mine();setProfile(current=>current&&value?{...current,avatarImage:value.avatarImage,bannerImage:value.bannerImage}:current);};
  const update=(patch:Partial<CommonsProfileFields>)=>{setFields(current=>({...current,...patch}));setMessage('');};
  const save=(event:FormEvent)=>{
    event.preventDefault();setError('');setMessage('');
    const parsed=commonsProfileFieldsSchema.safeParse(fields);if(!parsed.success){setError('Enter a valid handle, display name and HTTPS links.');return;}
    // Saving is the public opt-in, so the request always confirms that these fields are public.
    setBusy(true);void profiles.save(parsed.data,profile?.version??null,true).then(value=>{
      setProfile(value);setMessage('Your public profile is saved.');window.dispatchEvent(new Event('commons:catalog-changed'));navigateCommons(profilePath(value.handle));
    },failure=>setError(failure instanceof Error?failure.message:'Your profile could not be saved.')).finally(()=>setBusy(false));
  };
  return <section className="profile-editor" aria-labelledby="profile-edit-title"><h1 id="profile-edit-title">Your public profile</h1>
    <p>Your account details stay private. Only the fields below appear on your public Commons profile. Downloading models does not require a public profile.</p>
    {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
    {profile===undefined?!error&&<p role="status">Loading your profile…</p>:<>
      {profile&&<p>{profile.active?<ProfileLink handle={profile.handle}>View your public profile</ProfileLink>:'Your profile is currently hidden.'}</p>}
      {images&&(profile?<ProfileImagesEditor profile={profile} services={images} onChanged={imagesChanged}/>:<p className="field-note">You can add a profile picture and a banner after you publish your profile.</p>)}
      <form onSubmit={save} className="profile-form">
        <label>Public handle<input value={fields.handle} onChange={event=>update({handle:event.target.value.toLowerCase()})} required pattern="[a-z][a-z0-9-]{1,30}[a-z0-9]" minLength={3} maxLength={32} disabled={busy||profile!==null}/></label>
        <p className="field-note">3–32 lowercase letters, numbers or hyphens; start with a letter and end with a letter or number. Your handle stays reserved and cannot be changed.</p>
        <label>Display name<input value={fields.displayName} onChange={event=>update({displayName:event.target.value})} required maxLength={100} disabled={busy}/></label>
        <label>Bio<textarea value={fields.bio} onChange={event=>update({bio:event.target.value})} maxLength={2000} rows={4} disabled={busy}/></label>
        <fieldset disabled={busy}><legend>Public links (optional)</legend>{fields.links.map((link,index)=><div className="profile-link-fields" key={index}>
          <label>Link {index+1} label<input value={link.label} maxLength={80} required onChange={event=>update({links:fields.links.map((item,i)=>i===index?{...item,label:event.target.value}:item)})}/></label>
          <label>Link {index+1} URL<input type="url" value={link.url} required onChange={event=>update({links:fields.links.map((item,i)=>i===index?{...item,url:event.target.value}:item)})}/></label>
          <button type="button" onClick={()=>update({links:fields.links.filter((_,i)=>i!==index)})}>Remove link {index+1}</button>
        </div>)}<button type="button" disabled={fields.links.length>=5} onClick={()=>update({links:[...fields.links,{label:'',url:''}]})}>Add link</button></fieldset>
        <div className="profile-actions"><button type="submit" disabled={busy}>{busy?'Saving…':profile?.active?'Save public profile':'Publish public profile'}</button></div>
      </form>
    </>}
  </section>;
}
