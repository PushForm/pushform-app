// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useSyncExternalStore, type JSX } from 'react';
import type { CommonsAccount } from './account';
import { CommonsAccessGate } from './CommonsAccess';
import { UploadDialog } from './UploadDialog';
import { openOwnProfile } from './OwnModels';
import { modelPath, navigateCommons } from './route';

/** Upload and edit routes open the contributor dialog. */
export type PublishRoute = { kind: 'upload' } | { kind: 'edit'; model: string };
export function publishRoute(hash: string): PublishRoute | null {
  if (hash === '#upload' || hash === '#publish') return { kind: 'upload' };
  const edit = /^#edit\/([a-z0-9][a-z0-9-]{0,95})$/.exec(hash);
  return edit ? { kind: 'edit', model: edit[1]! } : null;
}

export function PublishPage({ account, filesUrl, route, catalogReady }: { account: CommonsAccount; filesUrl?: string | undefined; route: PublishRoute; catalogReady: boolean }): JSX.Element {
  const user = useSyncExternalStore(account.session.subscribe, account.session.getSnapshot).user;
  const close = () => {
    window.dispatchEvent(new Event('commons:catalog-changed'));
    if (route.kind === 'edit') navigateCommons(modelPath(route.model));
    else void openOwnProfile(account);
  };
  const published = (model: string) => {
    if (catalogReady) navigateCommons(modelPath(model));
    else void openOwnProfile(account);
  };
  return <CommonsAccessGate account={account}><section className="publish-page" key={user?.id ?? 'signed-out'}>
    <h1>{route.kind === 'edit' ? 'Edit model' : 'Upload model'}</h1>
    <UploadDialog key={route.kind === 'edit' ? route.model : 'new'} account={account} filesUrl={filesUrl}
      modelId={route.kind === 'edit' ? route.model : null} onClose={close} onPublished={published}/>
  </section></CommonsAccessGate>;
}
