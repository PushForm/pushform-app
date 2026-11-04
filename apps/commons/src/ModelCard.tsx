// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { MouseEvent, ReactNode } from 'react';
import { navigateCommons, profilePath } from './route';
import { CommonsThumbnail } from './CommonsPreview';
import type { CatalogModel } from './catalog';

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
/** A model in a list: the browse grid and profile pages show the same card. */
export function ModelCard({ model, filesUrl }: { model: CatalogModel; filesUrl: string | undefined }) {
  return <article className="model-card">
    <a href={`#models/${model.id}`} className="model-art" aria-label={`View ${model.title}`}><CommonsThumbnail key={model.id + model.revision} model={model} filesUrl={filesUrl} /></a>
    <div className="card-body"><p className="eyebrow">{model.category}</p><h3><a href={`#models/${model.id}`}>{model.title}</a></h3>
      <p className="creator"><CreatorCredit model={model}/></p><p className="license-label">{model.licenses.map((license) => license.name).join(' · ')}</p>
      {model.source && <p className="source-label">From {model.source.name}</p>}</div>
  </article>;
}
