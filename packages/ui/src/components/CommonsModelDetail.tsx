// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useState, type ReactNode } from 'react';
import { LuArrowLeft, LuArrowUpRight, LuImageOff } from 'react-icons/lu';
import { commonsFileUrl, isCommonsOpenable, type CatalogModel } from '@pushform/cloud';
import { isPreviewModelFile } from '@pushform/cloud/preview';

function ModelImage({ model, filesUrl }: { model: CatalogModel; filesUrl: string | undefined }) {
  const [failed, setFailed] = useState<string[]>([]);
  const geometry = model.files.find(file => isPreviewModelFile(file.name));
  const sources = [model.previewImage ? commonsFileUrl(filesUrl, 'images', model.previewImage.id) : null,
    model.imageUrl, geometry ? commonsFileUrl(filesUrl, 'thumbnails', geometry.id) : null];
  const src = sources.find((url): url is string => !!url && !failed.includes(url));
  return src ? <img src={src} alt={model.title} crossOrigin="anonymous" referrerPolicy="no-referrer"
    onError={() => setFailed(current => [...current, src])} />
    : <div className="pf-commons-preview-unavailable"><LuImageOff aria-hidden="true"/><span>Preview unavailable</span></div>;
}

export function CommonsModelDetail({ model, filesUrl, busy, importing, destinationName, destinationPicker, onBack, onOpen, onInsert }: {
  model: CatalogModel; filesUrl: string | undefined; busy: boolean; importing: boolean;
  destinationName: string | undefined; destinationPicker: ReactNode;
  onBack(): void; onOpen(): void; onInsert(): void;
}) {
  const file = model.files.find(item => /\.pf$/i.test(item.name)) ?? model.files.find(item => isCommonsOpenable(item.name));
  const open = <button type="button" className={!importing ? 'pf-commons-primary' : ''} disabled={busy || !file} onClick={onOpen}>Open in new tab<LuArrowUpRight aria-hidden="true"/></button>;
  const insert = destinationName && <button type="button" className={importing ? 'pf-commons-primary' : ''} disabled={busy || !file} onClick={onInsert}>Insert into {destinationName}</button>;
  return <article className="pf-commons-detail">
    <button type="button" className="pf-commons-back" onClick={onBack}><LuArrowLeft aria-hidden="true"/>Back to results</button>
    <div className="pf-commons-detail-hero">
      <figure className="pf-commons-detail-preview">
        <div className="pf-commons-detail-image"><ModelImage key={model.id + model.revision} model={model} filesUrl={filesUrl}/></div>
        <figcaption><span>Model preview</span><span>{model.formats.join(' · ')}</span></figcaption>
      </figure>
      <div className="pf-commons-detail-summary">
        <p className="pf-commons-eyebrow">{model.category}</p>
        <h3>{model.title}</h3>
        <p className="pf-commons-detail-creator">by <strong>{model.creator}</strong></p>
        {model.description && <p className="pf-commons-detail-description">{model.description}</p>}
        <div className="pf-commons-detail-actions">
          {destinationPicker}
          {importing ? <>{insert}{open}</> : <>{open}{insert}</>}
          {busy ? <p role="status">Preparing model…</p> : file ? <p className="pf-commons-action-note">{importing ? 'Place a component in your design, or open a separate copy.' : 'Open an editable copy. Original licenses and credits stay with the model.'}</p>
            : <p className="pf-commons-action-note">A supported representation is required before this model can be opened or inserted.</p>}
        </div>
        <dl className="pf-commons-detail-metadata">
          <div><dt>Formats</dt><dd>{model.formats.join(', ')}</dd></div>
          <div><dt>Published</dt><dd><time dateTime={model.publishedAt}>{new Date(model.publishedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</time></dd></div>
        </dl>
        {file && <p className="pf-commons-detail-filename">{file.name}</p>}
      </div>
    </div>
    <section className="pf-commons-detail-rights" aria-label="Licenses and credits">
      <h4>Licenses &amp; credits</h4>
      <div className="pf-commons-rights-columns">
        <div>{model.licenses.map((license, index) => <section className="pf-commons-license" key={index}>
          <h5>{license.url ? <a href={license.url} target="_blank" rel="noreferrer">{license.name}<LuArrowUpRight aria-hidden="true"/></a> : license.name}</h5>
          <p>{license.commercialUse === 'allowed' ? 'Commercial use permitted under this license.' : license.commercialUse === 'restricted' ? 'Commercial use is restricted by this license.' : 'Commercial-use permission has not been established.'}</p>
          {license.conditions.length > 0 && <ul>{license.conditions.map((condition, i) => <li key={i}>{condition}</li>)}</ul>}
        </section>)}</div>
        <div className="pf-commons-detail-credits"><h5>Attribution</h5>{model.credits.map((credit, index) => <div key={index}>
          <strong>{credit.url ? <a href={credit.url} target="_blank" rel="noreferrer">{credit.name}<LuArrowUpRight aria-hidden="true"/></a> : credit.name}</strong>
          {credit.text && <p>{credit.text}</p>}
        </div>)}
          {model.source && <p>Original source: <a href={model.source.url} target="_blank" rel="noreferrer">{model.source.name}<LuArrowUpRight aria-hidden="true"/></a></p>}
        </div>
      </div>
    </section>
  </article>;
}
