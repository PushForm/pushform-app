// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useMemo, useRef, useState, type FormEvent, type JSX } from 'react';
import { CommonsPublishing, uploadCommonsFile, removeCommonsFile, type CloudSession, type createBrowserRpc, type CommonsOwnModels, type CommonsOwnRevision, type CommonsSubmission, type CommonsUpload } from '@pushform/cloud';

export interface PublishModelProps {
  client:ReturnType<typeof createBrowserRpc>['client'];session:CloudSession;filesUrl?:string;profile:{id:string;displayName:string};
  /** `publish` starts a new model; `manage` lists the user's models for corrections, files and withdrawal. */
  mode?:'publish'|'manage';
}
const credit='Credit the creator.';
/** The licenses a publisher can choose. Other records the publisher's own terms, which have no standard license link. */
export const publishLicenses={
  'CC BY 4.0':{url:'https://creativecommons.org/licenses/by/4.0/',commercialUse:'allowed' as const,conditions:[credit]},
  'CC BY-SA 4.0':{url:'https://creativecommons.org/licenses/by-sa/4.0/',commercialUse:'allowed' as const,conditions:[credit,'Share adaptations under the same license.']},
  'CC BY-NC 4.0':{url:'https://creativecommons.org/licenses/by-nc/4.0/',commercialUse:'restricted' as const,conditions:[credit,'Non-commercial use only.']},
  'CC BY-NC-SA 4.0':{url:'https://creativecommons.org/licenses/by-nc-sa/4.0/',commercialUse:'restricted' as const,conditions:[credit,'Non-commercial use only.','Share adaptations under the same license.']},
  'CC BY-ND 4.0':{url:'https://creativecommons.org/licenses/by-nd/4.0/',commercialUse:'allowed' as const,conditions:[credit,'Do not share modified versions.']},
  'CC BY-NC-ND 4.0':{url:'https://creativecommons.org/licenses/by-nc-nd/4.0/',commercialUse:'restricted' as const,conditions:[credit,'Non-commercial use only.','Do not share modified versions.']},
  'CC0 1.0':{url:'https://creativecommons.org/publicdomain/zero/1.0/',commercialUse:'allowed' as const,conditions:[]},
};
type LicenseChoice=keyof typeof publishLicenses|'other';
export const CUSTOM_LICENSE='Custom license';
const rightsBasis='I created and own this model, or have the right to redistribute it and every included file under the selected license.';

/** A draft and its files stay private until their owner explicitly publishes. */
export function PublishModel({client,session,filesUrl,profile,mode='publish'}:PublishModelProps):JSX.Element {
  const api=useMemo(()=>new CommonsPublishing(client),[client]);
  const [state,setState]=useState<CommonsOwnModels|null>(null);const [selected,setSelected]=useState('');
  const [editing,setEditing]=useState(mode==='publish');const [copyFrom,setCopyFrom]=useState<CommonsOwnRevision|null>(null);
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
  const manage=mode==='manage';
  return <section className="publish-page"><a href="#browse">← Browse models</a><h1>{manage?'My models':'Publish a model'}</h1>
    <p>{manage?'Your drafts and published models. Choose one to attach files, publish, correct or withdraw it.':'Share your work with the community. Saving a draft keeps it private until you choose Publish.'}</p>
    {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
    {manage&&(!state?<p role="status">Loading your models…</p>:state.models.length===0?<p>You haven’t published a model yet. <a href="#publish">Publish a model</a></p>:<ul className="own-models">{state.models.map(model=>{
      const latest=state.revisions.find(item=>item.id===model.latest_submission);return <li key={model.id}><button disabled={busy} onClick={()=>{setSelected(model.latest_submission??'');setEditing(false);setError(null);}}>{latest?.metadata.title??model.id}</button> <span>{model.published_revision?'Published':latest?.status==='pending'?'Draft':'Unpublished'}</span></li>;
    })}</ul>)}
    {!editing&&revision&&<><h2>{revision.metadata.title}</h2><p>Revision {revision.number} · {revision.status}</p>
      {revision.status==='published'&&<a href={`#models/${encodeURIComponent(revision.model_id)}`}>View published model</a>}
      <button disabled={busy} onClick={()=>{setCopyFrom(revision);setEditing(true);}}>Create a correction</button>
      {state?.models.find(model=>model.id===revision.model_id)?.published_revision&&<button disabled={busy} onClick={()=>void run(async()=>{
        const model=state.models.find(item=>item.id===revision.model_id)!;await api.withdraw(model.id,model.published_revision!);window.dispatchEvent(new Event('commons:catalog-changed'));await refresh();setMessage('Model withdrawn. Existing downloaded copies keep their licenses.');
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
  const [formats,setFormats]=useState(meta?.formats.join(', ')??'STL');
  const first=meta?.licenses[0];
  const [license,setLicense]=useState<LicenseChoice>(!first?'CC BY 4.0':first.name in publishLicenses?first.name as keyof typeof publishLicenses:'other');
  const [terms,setTerms]=useState(first&&!(first.name in publishLicenses)?[...(first.name===CUSTOM_LICENSE?[]:[first.name]),...first.conditions].join('\n'):'');
  const [formError,setFormError]=useState('');
  const submit=(event:FormEvent)=>{
    event.preventDefault();setFormError('');
    const lines=terms.split('\n').map(value=>value.trim()).filter(Boolean);
    if(license==='other'&&(lines.length===0||lines.length>50||lines.some(line=>line.length>1000))){setFormError('Describe your license terms in up to 50 lines of at most 1,000 characters each.');return;}
    const name=profile.displayName;
    const chosen=license==='other'?{name:CUSTOM_LICENSE,url:null,commercialUse:'unknown' as const,conditions:lines}:{name:license,...publishLicenses[license],conditions:[...publishLicenses[license].conditions]};
    // A correction keeps notices recorded on earlier revisions; new models credit the publisher.
    const metadata:CommonsSubmission={title:title.trim(),description,category:category.trim(),creator:name,tags:tags.split(',').map(value=>value.trim()).filter(Boolean),formats:formats.split(',').map(value=>value.trim().toUpperCase()).filter(Boolean),imageUrl:meta?.imageUrl??null,
      source:meta?.source??null,licenses:[chosen,...(meta?.licenses.slice(1)??[])],credits:meta?.credits??[{name,url:null,text:`Original model by ${name}.`}]};
    void save(metadata,rightsBasis,true);
  };
  return <form className="publish-form" onSubmit={submit}><h2>{previous?'Create a new revision':'Model details'}</h2>
    <label>Title<input required maxLength={1000} value={title} onChange={event=>setTitle(event.target.value)} disabled={busy}/></label>
    <label>Description<textarea maxLength={12000} value={description} onChange={event=>setDescription(event.target.value)} disabled={busy}/></label>
    <label>Category<input required maxLength={1000} value={category} onChange={event=>setCategory(event.target.value)} disabled={busy}/></label>
    <label>Tags (comma separated)<input value={tags} onChange={event=>setTags(event.target.value)} disabled={busy}/></label>
    <label>File formats (comma separated)<input required value={formats} onChange={event=>setFormats(event.target.value)} disabled={busy}/></label>
    <label>License<select value={license} onChange={event=>setLicense(event.target.value as LicenseChoice)} disabled={busy}>
      {Object.keys(publishLicenses).map(value=><option key={value} value={value}>{value}</option>)}<option value="other">Other (describe the terms)</option>
    </select></label>
    {license==='other'&&<label>License terms<textarea required value={terms} onChange={event=>setTerms(event.target.value)} disabled={busy} placeholder="Describe how others may use, share and credit this model."/></label>}
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
      <label>Preview image (optional PNG or JPEG, up to 8 MiB)<input type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg" disabled={busy||!filesUrl||files?.some(file=>/\.(png|jpe?g)$/i.test(file.filename))} onChange={event=>{
        const file=event.target.files?.[0];event.target.value='';if(file)void run(async(signal)=>{setConfirmed(false);await uploadCommonsFile(filesUrl!,await token(),revision.id,file,signal);await reload();done('Preview image uploaded and verified.');});
      }}/></label><p>Commons generates a preview from supported model geometry. An uploaded image becomes the listing image. The selected license also applies to the image.</p>
      <p>Publishing makes these files and their license notices available to the community.</p>
      <label className="publish-confirm"><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)} disabled={busy}/>I created and own these files, or have the right to redistribute them and everything they include under the selected license.</label>
      <button disabled={busy||!confirmed||!files?.some(file=>!/\.(png|jpe?g)$/i.test(file.filename))||files.some(file=>file.status!=='ready')} onClick={()=>void run(async(signal)=>{await api.publish(revision.id,published,revision.asset_version,confirmed,signal);window.dispatchEvent(new Event('commons:catalog-changed'));await reload();done('Model published.');})}>Publish model</button>
    </>}
  </section>;
}
