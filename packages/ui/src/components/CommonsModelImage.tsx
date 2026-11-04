// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useState } from 'react';
import { commonsFileUrl, type CatalogModel } from '@pushform/cloud';
import { isPreviewModelFile } from '@pushform/cloud/preview';
import { Icon } from './Icon';

export function CommonsModelImage({ model, filesUrl, decorative = false }: {
  model: CatalogModel; filesUrl: string | undefined; decorative?: boolean;
}) {
  const [failed, setFailed] = useState<string[]>([]);
  const [loaded, setLoaded] = useState<string | null>(null);
  const geometry = model.files.find(file => isPreviewModelFile(file.name));
  const sources = [model.previewImage ? commonsFileUrl(filesUrl, 'images', model.previewImage.id) : null,
    model.imageUrl, geometry ? commonsFileUrl(filesUrl, 'thumbnails', geometry.id) : null];
  const src = sources.find((url): url is string => !!url && !failed.includes(url));
  const ready = !!src && loaded === src;
  return <div className="pf-commons-model-image">
    {!ready && <div className="pf-commons-image-placeholder" role={decorative ? undefined : 'img'}
      aria-hidden={decorative || undefined} aria-label={decorative ? undefined : `${src ? 'Loading preview' : 'Preview unavailable'} for ${model.title}`}>
      <Icon name="document-model" size={48}/>
    </div>}
    {src && <img key={src} src={src} alt={decorative ? '' : model.title} aria-hidden={!ready || decorative || undefined}
      className={ready ? 'is-loaded' : undefined} crossOrigin="anonymous" referrerPolicy="no-referrer"
      onLoad={() => setLoaded(src)} onError={() => setFailed(current => [...current, src])}/>}
  </div>;
}
