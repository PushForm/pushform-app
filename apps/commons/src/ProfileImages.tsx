// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type PointerEvent } from 'react';
import { commonsProfileImageUrl, removeCommonsProfileImage, uploadCommonsProfileImage, type CommonsProfile, type CommonsProfileImageKind,
  type CommonsPublicProfile, type CommonsUploadProgress } from '@pushform/cloud';
import { MAX_ZOOM, initialCrop, loadSourceImage, outputSize, panCrop, renderCrop, sourceRect, zoomCrop, type Crop, type Size } from './crop';

const labels = { avatar: 'Profile picture', banner: 'Banner' } as const;
const lower = { avatar: 'profile picture', banner: 'banner' } as const;

/** Shows the cropped area of an image at any displayed size, using percentages so it scales with its frame. */
function CropView({url,source,kind,crop,className,alt=''}:{url:string;source:Size;kind:CommonsProfileImageKind;crop:Crop;className:string;alt?:string}){
  const rect=sourceRect(source,outputSize(kind),crop);
  return <div className={`crop-view ${className}`}><img src={url} alt={alt} draggable={false} style={{width:`${source.width/rect.width*100}%`,left:`${-rect.x/rect.width*100}%`,top:`${-rect.y/rect.height*100}%`}}/></div>;
}

interface Source { image: CanvasImageSource; size: Size; url: string; release(): void }
export interface ProfileImageServices {
  filesUrl: string;
  token: () => Promise<string>;
  load?: (file: File) => Promise<Source>;
  render?: (image: CanvasImageSource, size: Size, kind: CommonsProfileImageKind, crop: Crop) => Promise<Blob>;
  upload?: typeof uploadCommonsProfileImage;
  remove?: typeof removeCommonsProfileImage;
}
const defaultLoad = async (file: File): Promise<Source> => {
  const loaded = await loadSourceImage(file);
  return { ...loaded, url: (loaded.image as HTMLImageElement).src };
};

/** Drag to move, use the slider, wheel or +/- to zoom, and arrow keys to nudge. */
export function ProfileImageCropper({kind,source,busy,onCancel,onSave}:{kind:CommonsProfileImageKind;source:Source;busy:boolean;onCancel:()=>void;onSave:(crop:Crop)=>void}){
  const frame=outputSize(kind);const [crop,setCrop]=useState(()=>initialCrop(source.size));
  const drag=useRef<{x:number;y:number}|null>(null);const element=useRef<HTMLDivElement>(null);
  const width=()=>element.current?.clientWidth||frame.width;
  const pan=(dx:number,dy:number)=>setCrop(current=>panCrop(source.size,frame,current,dx,dy,width()));
  const zoom=(value:number)=>setCrop(current=>zoomCrop(source.size,frame,current,value));
  const down=(event:PointerEvent<HTMLDivElement>)=>{if(busy)return;drag.current={x:event.clientX,y:event.clientY};event.currentTarget.setPointerCapture?.(event.pointerId);};
  const move=(event:PointerEvent<HTMLDivElement>)=>{const last=drag.current;if(!last)return;drag.current={x:event.clientX,y:event.clientY};pan(event.clientX-last.x,event.clientY-last.y);};
  const up=()=>{drag.current=null;};
  // A non-passive listener lets the wheel zoom the image without also scrolling the page.
  useEffect(()=>{
    const target=element.current;if(!target||busy)return;
    const wheel=(event:globalThis.WheelEvent)=>{event.preventDefault();setCrop(current=>zoomCrop(source.size,frame,current,current.zoom*(event.deltaY<0?1.1:1/1.1)));};
    target.addEventListener('wheel',wheel,{passive:false});return()=>target.removeEventListener('wheel',wheel);
  },[busy,source.size,frame]);
  const key=(event:KeyboardEvent<HTMLDivElement>)=>{
    const step=event.shiftKey?40:10;const moves:Record<string,[number,number]>={ArrowLeft:[step,0],ArrowRight:[-step,0],ArrowUp:[0,step],ArrowDown:[0,-step]};
    if(moves[event.key]){event.preventDefault();pan(...moves[event.key]!);}else if(event.key==='+'||event.key==='='){event.preventDefault();zoom(crop.zoom*1.1);}else if(event.key==='-'){event.preventDefault();zoom(crop.zoom/1.1);}
  };
  return <div className={`profile-cropper profile-cropper-${kind}`}>
    <div ref={element} className={`crop-frame crop-frame-${kind}`} role="group" tabIndex={0} aria-label={`Crop ${lower[kind]}. Drag or use the arrow keys to move, plus and minus to zoom.`}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onKeyDown={key}>
      <CropView url={source.url} source={source.size} kind={kind} crop={crop} className="crop-frame-image"/>
    </div>
    <label className="crop-zoom">Zoom<input type="range" min={1} max={MAX_ZOOM} step={0.01} value={crop.zoom} disabled={busy} onChange={event=>zoom(Number(event.target.value))}/></label>
    <div className="crop-previews" aria-label="Preview">
      <span className="eyebrow">Preview</span>
      {kind==='avatar'?<><CropView url={source.url} source={source.size} kind={kind} crop={crop} className="profile-avatar crop-preview-large" alt="Profile picture preview, large"/>
        <CropView url={source.url} source={source.size} kind={kind} crop={crop} className="profile-avatar crop-preview-small" alt="Profile picture preview, small"/></>:
        <CropView url={source.url} source={source.size} kind={kind} crop={crop} className="crop-preview-banner" alt="Banner preview, narrow screen"/>}
    </div>
    <div className="profile-actions"><button type="button" disabled={busy} onClick={()=>onSave(crop)}>{busy?'Saving…':`Save ${lower[kind]}`}</button><button type="button" className="secondary" disabled={busy} onClick={onCancel}>Cancel</button></div>
  </div>;
}

function ProfileImageField({kind,profile,services,busy,setBusy,onChanged}:{kind:CommonsProfileImageKind;profile:CommonsProfile;services:ProfileImageServices;busy:boolean;setBusy:(value:boolean)=>void;onChanged:()=>Promise<void>}){
  const [source,setSource]=useState<Source|null>(null);const [error,setError]=useState('');const [message,setMessage]=useState('');const [progress,setProgress]=useState<CommonsUploadProgress|null>(null);
  const control=useRef<AbortController|null>(null);
  useEffect(()=>()=>{control.current?.abort();},[]);
  useEffect(()=>()=>source?.release(),[source]);
  const current=kind==='avatar'?profile.avatarImage:profile.bannerImage;
  const currentUrl=current?commonsProfileImageUrl(services.filesUrl,current.id):null;
  const legacy=kind==='avatar'&&!current?profile.avatarUrl:null;
  const run=async(work:(signal:AbortSignal)=>Promise<string>)=>{
    setBusy(true);setError('');setMessage('');const abort=new AbortController();control.current=abort;
    try{setMessage(await work(abort.signal));}catch(failure){if(!abort.signal.aborted)setError(failure instanceof Error?failure.message:`Your ${lower[kind]} could not be saved.`);}
    finally{setBusy(false);setProgress(null);control.current=null;}
  };
  const choose=(event:ChangeEvent<HTMLInputElement>)=>{
    const file=event.target.files?.[0];event.target.value='';if(!file)return;setError('');setMessage('');
    void (services.load??defaultLoad)(file).then(setSource,failure=>setError(failure instanceof Error?failure.message:'This image could not be read.'));
  };
  const save=(crop:Crop)=>{if(!source)return;void run(async signal=>{
    const blob=await (services.render??renderCrop)(source.image,source.size,kind,crop);
    await (services.upload??uploadCommonsProfileImage)(services.filesUrl,await services.token(),kind,blob,signal,{onProgress:setProgress});
    await onChanged();setSource(null);return `${labels[kind]} saved.`;
  });};
  const remove=()=>void run(async signal=>{await (services.remove??removeCommonsProfileImage)(services.filesUrl,await services.token(),kind,signal);await onChanged();return `${labels[kind]} removed.`;});
  const percent=progress&&progress.total?Math.round(progress.loaded/progress.total*100):0;
  return <section className={`profile-image-field profile-image-field-${kind}`} aria-labelledby={`profile-image-${kind}`}>
    <h2 id={`profile-image-${kind}`}>{labels[kind]}</h2>
    <p className="field-note">{kind==='avatar'?'A square PNG or JPEG, shown as a circle.':'A wide PNG or JPEG shown across the top of your profile, cropped to 3:1.'} You can crop it before saving.</p>
    {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
    {progress&&<p role="status" className="profile-image-progress">{progress.stage==='preparing'?'Preparing…':progress.stage==='uploading'?`Uploading… ${percent}%`:'Checking the image…'}
      <progress max={100} value={progress.stage==='preparing'?0:progress.stage==='uploading'?percent:100}/></p>}
    {source?<ProfileImageCropper kind={kind} source={source} busy={busy} onCancel={()=>{control.current?.abort();setSource(null);}} onSave={save}/>:<>
      <div className={`profile-image-current profile-image-current-${kind}`}>
        {currentUrl||legacy?<img className={kind==='avatar'?'profile-avatar':'profile-banner-image'} src={(currentUrl??legacy)!} alt={`Your current ${lower[kind]}`} referrerPolicy="no-referrer"/>:
          <div className={kind==='avatar'?'profile-avatar profile-avatar-fallback':'profile-banner-empty'} aria-hidden="true">{kind==='avatar'?profile.displayName.slice(0,1).toUpperCase():''}</div>}
      </div>
      <div className="profile-actions">
        <label className="file-button">{current||legacy?`Replace ${lower[kind]}`:`Upload ${lower[kind]}`}<input type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg" disabled={busy} onChange={choose}/></label>
        {current&&<button type="button" className="secondary" disabled={busy} onClick={remove}>Remove {lower[kind]}</button>}
      </div>
      {legacy&&<p className="field-note">This picture loads from another website. Upload one to replace it.</p>}
    </>}
  </section>;
}

/** Owner controls for both images. They take effect immediately, separately from saving the profile form. */
export function ProfileImagesEditor({profile,services,onChanged}:{profile:CommonsProfile;services:ProfileImageServices;onChanged:()=>Promise<void>}){
  const [busy,setBusy]=useState(false);
  return <div className="profile-images">
    <p>Images are public as soon as you save them, while your profile is visible.</p>
    <ProfileImageField kind="avatar" profile={profile} services={services} busy={busy} setBusy={setBusy} onChanged={onChanged}/>
    <ProfileImageField kind="banner" profile={profile} services={services} busy={busy} setBusy={setBusy} onChanged={onChanged}/>
  </div>;
}

function HeroAvatar({name,urls}:{name:string;urls:string[]}){
  const [failed,setFailed]=useState(0);const urlKey=urls.join(' ');useEffect(()=>setFailed(0),[urlKey]);
  const url=urls[failed];
  return url?<img className="profile-avatar" src={url} alt={`${name}'s profile picture`} referrerPolicy="no-referrer" onError={()=>setFailed(value=>value+1)}/>:
    <div className="profile-avatar profile-avatar-fallback" aria-hidden="true">{name.slice(0,1).toUpperCase()}</div>;
}
/** The public profile heading: the banner across the top with the profile picture overlapping its lower edge. */
export function ProfileHero({profile,filesUrl}:{profile:CommonsPublicProfile;filesUrl?:string|undefined}){
  const banner=profile.bannerImage?commonsProfileImageUrl(filesUrl,profile.bannerImage.id):null;const [bannerFailed,setBannerFailed]=useState(false);
  useEffect(()=>setBannerFailed(false),[banner]);
  const uploaded=profile.avatarImage?commonsProfileImageUrl(filesUrl,profile.avatarImage.id):null;
  const urls=[uploaded,profile.avatarUrl].filter((value):value is string=>!!value);
  return <header className="profile-hero">
    <div className="profile-banner">{banner&&!bannerFailed&&<img src={banner} alt={`${profile.displayName}'s banner`} onError={()=>setBannerFailed(true)}/>}</div>
    <div className="profile-hero-body"><HeroAvatar name={profile.displayName} urls={urls}/>
      <div><p className="eyebrow">Community profile</p><h1>{profile.displayName}</h1><p>@{profile.handle}</p></div></div>
  </header>;
}
