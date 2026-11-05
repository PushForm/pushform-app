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
/** The one card used for every grid of models: the library, profile pages and My models. `art` replaces the
 * public thumbnail (My models shows owner-only previews of drafts) and `footer` adds status and actions. */
export function ModelCard({ model, filesUrl, href = `#models/${model.id}`, art, footer, typeLabel }: {
  model: Pick<CatalogModel, 'id' | 'revision' | 'title' | 'category' | 'licenses' | 'source' | 'creator'> & Partial<CatalogModel>;
  filesUrl: string | undefined; href?: string; art?: ReactNode; footer?: ReactNode; typeLabel?: string;
}) {
  return <article className="model-card">
    <a href={href} className="model-art" aria-label={`${href.startsWith('#edit/') ? 'Edit' : 'View'} ${model.title}`}>
      {art ?? <CommonsThumbnail key={model.id + model.revision} model={model as CatalogModel} filesUrl={filesUrl} />}</a>
    <div className="card-body"><p className="eyebrow">{typeLabel ? `${typeLabel} · ${model.formats?.join(' · ') ?? model.category}` : model.category}</p><h3><a href={href}>{model.title}</a></h3>
      <p className="creator"><CreatorCredit model={model}/></p><p className="license-label">{[...new Set(model.licenses.map((license) => license.name))].join(' · ')}</p>
      {footer}</div>
  </article>;
}
export function ModelGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className ? `model-grid ${className}` : 'model-grid'}>{children}</div>;
}
