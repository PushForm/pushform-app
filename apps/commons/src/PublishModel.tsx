// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useMemo, useRef, useState, type FormEvent, type JSX } from 'react';
import { CommonsPublishing, uploadCommonsFile, removeCommonsFile, type CloudSession, type createBrowserRpc, type CommonsOwnModels, type CommonsOwnRevision, type CommonsSubmission, type CommonsUpload } from '@pushform/cloud';

export interface PublishModelProps {
  client:ReturnType<typeof createBrowserRpc>['client'];session:CloudSession;filesUrl?:string;profile:{id:string;displayName:string};
}
const licenses={
  'CC BY 4.0':{url:'https://creativecommons.org/licenses/by/4.0/',commercialUse:'allowed' as const,conditions:['Credit the original creator.']},
  'CC BY-NC 4.0':{url:'https://creativecommons.org/licenses/by-nc/4.0/',commercialUse:'restricted' as const,conditions:['Credit the original creator.','Non-commercial use only.']},
  'CC0 1.0':{url:'https://creativecommons.org/publicdomain/zero/1.0/',commercialUse:'allowed' as const,conditions:[]},
};

/** A draft and its files stay private until their owner explicitly publishes. */
export function PublishModel({client,session,filesUrl,profile}:PublishModelProps):JSX.Element {
  const api=useMemo(()=>new CommonsPublishing(client),[client]);
  const [state,setState]=useState<CommonsOwnModels|null>(null);const [selected,setSelected]=useState('');
  const [editing,setEditing]=useState(true);const [copyFrom,setCopyFrom]=useState<CommonsOwnRevision|null>(null);
  const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);const [message,setMessage]=useState('');
  const control=useRef<AbortController|null>(null);
  const refresh=async()=>{const next=await api.mine();setState(next);return next;};
  useEffect(()=>{let live=true;const abort=new AbortController();void api.mine(abort.signal).then(data=>{if(live)setState(data);},failure=>{if(live)setError(failure instanceof Error?failure.message:'Your models could not be loaded.');});return()=>{live=false;abort.abort();control.current?.abort();};},[api]);
  const revision=state?.revisions.find(item=>item.id===selected);
  const run=async(work:(signal:AbortSignal)=>Promise<void>):Promise<void>=>{
    if(busy)return;setBusy(true);setError(null);setMessage('');const abort=new AbortController();control.current=abort;
    try{await work(abort.signal);}catch(failure){setError(abort.signal.aborted?'Operation cancelled. Refresh to check any upload that finished.':failure instanceof Error?failure.message:'The operation could not be completed.');}
    finally{setBusy(false);control.current=null;}
  };
  return <section className="publish-page"><a href="#browse">← Browse models</a><h1>Publish a model</h1>
    <p>Share your work with the community. Saving a draft keeps it private until you choose Publish.</p>
    {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
    <h2>Your models</h2>{!state?<p role="status">Loading your models…</p>:state.models.length===0?<p>You haven’t published a model yet.</p>:<ul className="own-models">{state.models.map(model=>{
      const latest=state.revisions.find(item=>item.id===model.latest_submission);return <li key={model.id}><button disabled={busy} onClick={()=>{setSelected(model.latest_submission??'');setEditing(false);setError(null);}}>{latest?.metadata.title??model.id}</button> <span>{model.published_revision?'Published':latest?.status==='pending'?'Draft':'Unpublished'}</span></li>;
    })}</ul>}
    <button disabled={busy} onClick={()=>{setSelected('');setCopyFrom(null);setEditing(true);setError(null);}}>New model</button>
    {!editing&&revision&&<><h2>{revision.metadata.title}</h2><p>Revision {revision.number} · {revision.status}</p>
      {revision.status==='published'&&<a href={`#models/${encodeURIComponent(revision.model_id)}`}>View published model</a>}
      <button disabled={busy} onClick={()=>{setCopyFrom(revision);setEditing(true);}}>Create a correction</button>
      {state?.models.find(model=>model.id===revision.model_id)?.published_revision&&<button disabled={busy} onClick={()=>void run(async()=>{
        const model=state.models.find(item=>item.id===revision.model_id)!;await api.withdraw(model.id,model.published_revision!);await refresh();setMessage('Model withdrawn. Existing downloaded copies keep their licenses.');
      })}>Withdraw publication</button>}
    </>}
    {editing?<ModelForm key={copyFrom?.id??'new'} profile={profile} previous={copyFrom} busy={busy} save={(metadata,basis,original)=>run(async(signal)=>{
      const id=copyFrom?.model_id??'model-'+crypto.randomUUID();
      const draft=await api.submit(id,metadata,basis,original,copyFrom?.id??null,signal);await refresh();setSelected(draft.id);setEditing(false);setMessage('Draft saved. Attach files, then publish when ready.');
    })}/>:revision&&<DraftFiles key={`${revision.id}:${revision.asset_version}`} api={api} revision={revision} filesUrl={filesUrl} busy={busy} run={run}
      token={async()=>{const value=await session.getAccessToken();if(!value)throw new Error('Sign in to manage your files.');return value;}}
      refresh={refresh} published={state?.models.find(model=>model.id===revision.model_id)?.published_revision??null} done={setMessage}/>}
    {busy&&<button onClick={()=>control.current?.abort()}>Cancel operation</button>}
  </section>;
}

function ModelForm({profile,previous,busy,save}:{profile:{displayName:string};previous:CommonsOwnRevision|null;busy:boolean;save:(metadata:CommonsSubmission,basis:string,original:boolean)=>Promise<void>}):JSX.Element {
  const meta=previous?.metadata;const [title,setTitle]=useState(meta?.title??'');const [description,setDescription]=useState(meta?.description??'');
  const [category,setCategory]=useState(meta?.category??'Hardware and joinery');const [tags,setTags]=useState(meta?.tags.join(', ')??'');
  const [original,setOriginal]=useState(previous?previous.creator_profile_id!==null:true);const [creator,setCreator]=useState(meta?.creator??'');
  const [license,setLicense]=useState<keyof typeof licenses>((meta?.licenses[0]?.name??'') in licenses ? meta!.licenses[0]!.name as keyof typeof licenses : 'CC BY 4.0');const [licenseName,setLicenseName]=useState(meta?.licenses[0]?.name??'');const [licenseUrl,setLicenseUrl]=useState(meta?.licenses[0]?.url??'');
  const [commercial,setCommercial]=useState<'allowed'|'restricted'|'unknown'>(meta?.licenses[0]?.commercialUse??'unknown');const [conditions,setConditions]=useState(meta?.licenses[0]?.conditions.join('\n')??'');
  const [sourceName,setSourceName]=useState(meta?.source?.name??'');const [sourceUrl,setSourceUrl]=useState(meta?.source?.url??'');
  const [credits,setCredits]=useState(meta?.credits??[{name:'',url:null,text:''}]);
  const [extraLicenses,setExtraLicenses]=useState(meta?.licenses.slice(1).map(item=>({...item,conditions:item.conditions.join('\n')}))??[]);const [formats,setFormats]=useState(meta?.formats.join(', ')??'STL');
  const [basis,setBasis]=useState(previous?.rights_basis??'I created this model and may distribute all included files under the selected license.');
  const [formError,setFormError]=useState('');
  const submit=(event:FormEvent)=>{
    event.preventDefault();setFormError('');
    if(!original&&(!sourceName.trim()||!sourceUrl.trim()||!creator.trim()||!licenseName.trim()||!licenseUrl.trim())){setFormError('Include the original creator, source and exact upstream license.');return;}
    const name=original?profile.displayName:creator.trim();
    const metadata:CommonsSubmission={title:title.trim(),description,category:category.trim(),creator:name,tags:tags.split(',').map(value=>value.trim()).filter(Boolean),formats:formats.split(',').map(value=>value.trim().toUpperCase()).filter(Boolean),imageUrl:null,
      source:sourceUrl.trim()?{name:sourceName.trim()||'Original source',url:sourceUrl.trim()}:null,
      licenses:[...(original?[{name:license,...licenses[license]}]:[{name:licenseName.trim(),url:licenseUrl.trim(),commercialUse:commercial,conditions:conditions.split('\n').map(value=>value.trim()).filter(Boolean)}]),...extraLicenses.map(item=>({...item,conditions:item.conditions.split('\n').map(value=>value.trim()).filter(Boolean)}))],
      credits:credits.map(item=>({name:item.name.trim()||name,url:item.url?.trim()||null,text:item.text.trim()||`Original model by ${name}.`}))};
    void save(metadata,basis,original);
  };
  return <form className="publish-form" onSubmit={submit}><h2>{previous?'Create a new revision':'Model details'}</h2>
    <label>Title<input required maxLength={1000} value={title} onChange={event=>setTitle(event.target.value)} disabled={busy}/></label>
    <label>Description<textarea maxLength={12000} value={description} onChange={event=>setDescription(event.target.value)} disabled={busy}/></label>
    <label>Category<input required maxLength={1000} value={category} onChange={event=>setCategory(event.target.value)} disabled={busy}/></label>
    <label>Tags (comma separated)<input value={tags} onChange={event=>setTags(event.target.value)} disabled={busy}/></label>
    <label>File formats (comma separated)<input required value={formats} onChange={event=>setFormats(event.target.value)} disabled={busy}/></label>
    <label>Authorship<select value={original?'original':'redistributed'} onChange={event=>{const own=event.target.value==='original';setOriginal(own);setBasis(own?'I created this model and may distribute all included files under the selected license.':'');}} disabled={busy}><option value="original">My original work</option><option value="redistributed">Redistributed with permission</option></select></label>
    {original?<label>License<select value={license} onChange={event=>setLicense(event.target.value as keyof typeof licenses)} disabled={busy}>{Object.keys(licenses).map(value=><option key={value}>{value}</option>)}</select></label>:<>
      <label>Original creator<input required value={creator} onChange={event=>setCreator(event.target.value)} disabled={busy}/></label>
      <label>Original license name and version<input required value={licenseName} onChange={event=>setLicenseName(event.target.value)} disabled={busy}/></label>
      <label>Original license URL<input type="url" required value={licenseUrl} onChange={event=>setLicenseUrl(event.target.value)} disabled={busy}/></label>
      <label>Commercial permission<select value={commercial} onChange={event=>setCommercial(event.target.value as typeof commercial)} disabled={busy}><option value="unknown">Unknown</option><option value="allowed">Allowed</option><option value="restricted">Restricted</option></select></label>
      <label>License conditions (one per line)<textarea value={conditions} onChange={event=>setConditions(event.target.value)} disabled={busy}/></label>
    </>}
    {extraLicenses.map((item,index)=><fieldset key={index}><legend>Additional asset license {index+1}</legend>
      <label>License name and version<input required value={item.name} onChange={event=>setExtraLicenses(rows=>rows.map((row,i)=>i===index?{...row,name:event.target.value}:row))} disabled={busy}/></label>
      <label>License URL<input required type="url" value={item.url} onChange={event=>setExtraLicenses(rows=>rows.map((row,i)=>i===index?{...row,url:event.target.value}:row))} disabled={busy}/></label>
      <label>Commercial use<select value={item.commercialUse} onChange={event=>setExtraLicenses(rows=>rows.map((row,i)=>i===index?{...row,commercialUse:event.target.value as typeof item.commercialUse}:row))} disabled={busy}><option value="unknown">Unknown</option><option value="allowed">Allowed</option><option value="restricted">Restricted</option></select></label>
      <label>Required conditions<textarea value={item.conditions} onChange={event=>setExtraLicenses(rows=>rows.map((row,i)=>i===index?{...row,conditions:event.target.value}:row))} disabled={busy}/></label>
      <button type="button" disabled={busy} onClick={()=>setExtraLicenses(rows=>rows.filter((_,i)=>i!==index))}>Remove additional license {index+1}</button>
    </fieldset>)}
    <button type="button" disabled={busy||extraLicenses.length>=49} onClick={()=>setExtraLicenses(rows=>[...rows,{name:'',url:'',commercialUse:'unknown',conditions:''}])}>Add another asset license</button>
    <label>Source name<input required={!original} value={sourceName} onChange={event=>setSourceName(event.target.value)} disabled={busy}/></label>
    <label>Source URL<input type="url" required={!original} value={sourceUrl} onChange={event=>setSourceUrl(event.target.value)} disabled={busy}/></label>
    {credits.map((item,index)=><fieldset key={index}><legend>Attribution {index+1}</legend>
      <label>Credit name<input value={item.name} placeholder={original?profile.displayName:creator} onChange={event=>setCredits(rows=>rows.map((row,i)=>i===index?{...row,name:event.target.value}:row))} disabled={busy}/></label>
      <label>Credit URL<input type="url" value={item.url??''} onChange={event=>setCredits(rows=>rows.map((row,i)=>i===index?{...row,url:event.target.value||null}:row))} disabled={busy}/></label>
      <label>Attribution and included notices<textarea maxLength={4000} value={item.text} onChange={event=>setCredits(rows=>rows.map((row,i)=>i===index?{...row,text:event.target.value}:row))} disabled={busy}/></label>
      {credits.length>1&&<button type="button" disabled={busy} onClick={()=>setCredits(rows=>rows.filter((_,i)=>i!==index))}>Remove attribution {index+1}</button>}
    </fieldset>)}
    <button type="button" disabled={busy||credits.length>=100} onClick={()=>setCredits(rows=>[...rows,{name:'',url:null,text:''}])}>Add attribution</button>
    <label>Redistribution rights declaration<textarea required minLength={20} maxLength={4000} value={basis} onChange={event=>setBasis(event.target.value)} disabled={busy}/></label>
    {formError&&<p role="alert">{formError}</p>}<button disabled={busy} type="submit">Save private draft</button>
  </form>;
}

function DraftFiles({api,revision,filesUrl,busy,run,token,refresh,published,done}:{api:CommonsPublishing;revision:CommonsOwnRevision;filesUrl:string|undefined;busy:boolean;run:(work:(signal:AbortSignal)=>Promise<void>)=>Promise<void>;token:()=>Promise<string>;refresh:()=>Promise<CommonsOwnModels>;published:string|null;done:(message:string)=>void}):JSX.Element {
  const [files,setFiles]=useState<CommonsUpload[]|null>(null);const [error,setError]=useState('');const [confirmed,setConfirmed]=useState(false);
  useEffect(()=>{const abort=new AbortController();void api.assets(revision.id,abort.signal).then(setFiles,failure=>{if(!abort.signal.aborted)setError(failure instanceof Error?failure.message:'Files could not be loaded.');});return()=>abort.abort();},[api,revision.id]);
  const reload=async()=>{setFiles(null);setConfirmed(false);await refresh();setFiles(await api.assets(revision.id));};
  const pending=revision.status==='pending';
  return <section className="publish-files"><h2>Model files</h2>{error&&<p role="alert">{error}</p>}
    {!files?<p role="status">Loading files…</p>:files.length===0?<p>Attach at least one model file before publishing.</p>:<ul>{files.map(file=><li key={file.id}>{file.filename} · {(file.size_bytes/1024).toFixed(1)} KiB · {file.status}
      {pending&&<button disabled={busy||!filesUrl} onClick={()=>void run(async(signal)=>{await removeCommonsFile(filesUrl!,await token(),file.id,signal);await reload();done('File removed.');})}>Remove {file.filename}</button>}</li>)}</ul>}
    {pending&&<><label>Attach model file or ZIP (up to 128 MiB)<input type="file" accept=".pf,.step,.stp,.obj,.stl,.glb,.gltf,.dae,.3ds,.zip,.fcstd,.blend,.skp" disabled={busy||!filesUrl} onChange={event=>{
      const file=event.target.files?.[0];event.target.value='';if(file)void run(async(signal)=>{setConfirmed(false);await uploadCommonsFile(filesUrl!,await token(),revision.id,file,signal);await reload();done('File uploaded and verified.');});
    }}/></label>{!filesUrl&&<p>File uploads are unavailable in this build.</p>}
      <p>Publishing makes these files and their license notices available to the community.</p>
      <label className="publish-confirm"><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)} disabled={busy}/>I have permission to redistribute every included file and have preserved all required licenses, conditions and credits.</label>
      <button disabled={busy||!confirmed||!files?.length||files.some(file=>file.status!=='ready')} onClick={()=>void run(async(signal)=>{await api.publish(revision.id,published,revision.asset_version,confirmed,signal);await reload();done('Model published.');})}>Publish model</button>
    </>}
  </section>;
}
