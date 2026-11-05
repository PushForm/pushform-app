// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useState } from 'react';
import type { CatalogModel } from '@pushform/cloud';
import { commonsImageSources } from '@pushform/commons-ui/modelImages';
import { usePrefetchedImage } from '@pushform/commons-ui/BrowseImages';
import { Icon } from './Icon';

export function CommonsModelImage({ model, filesUrl, decorative = false }: {
  model: CatalogModel; filesUrl: string | undefined; decorative?: boolean;
}) {
  const [failed, setFailed] = useState<string[]>([]);
  const [loaded, setLoaded] = useState<string | null>(null);
  const candidate = commonsImageSources(model, filesUrl).find(url => !failed.includes(url));
  const prefetched = usePrefetchedImage(candidate);
  const src = prefetched?.status === 'ready' ? prefetched.src : prefetched?.status === 'loading' ? undefined : candidate;
  const ready = !!src && (loaded === src || prefetched?.status === 'ready');
  return <div className="pf-commons-model-image">
    {!ready && <div className="pf-commons-image-placeholder" role={decorative ? undefined : 'img'}
      aria-hidden={decorative || undefined} aria-label={decorative ? undefined : `${candidate ? 'Loading preview' : 'Preview unavailable'} for ${model.title}`}>
      <Icon name="document-model" size={48}/>
    </div>}
    {src && <img key={src} src={src} alt={decorative ? '' : model.title} aria-hidden={!ready || decorative || undefined}
      className={ready ? 'is-loaded' : undefined} crossOrigin="anonymous" referrerPolicy="no-referrer"
      onLoad={() => setLoaded(src)} onError={() => { if (candidate) setFailed(current => [...current, candidate]); }}/>}
  </div>;
}
