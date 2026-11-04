// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { UploadDialog } from '@pushform/commons-ui';
import type { CommonsAccount } from '@pushform/commons-ui/account';
import { cloudChecksum, CommonsPublishing, type CommonsSubmission } from '@pushform/cloud';
import type { PublishingSnapshot } from './SaveVersionDialog';
import { openModelFile } from '@pushform/io';

export function PublishSnapshot({ account, filesUrl, snapshot, onClose }: { account: CommonsAccount; filesUrl: string | undefined; snapshot: PublishingSnapshot; onClose(): void }) {
  useEffect(() => {
    const app = document.querySelector<HTMLElement>('.pf-app'); const inert = app?.inert ?? false; const focus = document.activeElement as HTMLElement | null;
    if (app) app.inert = true;
    return () => { if (app) app.inert = inert; if (focus?.isConnected) focus.focus(); };
  }, []);
  const [scope, setScope] = useState('whole');
  const [setup, setSetup] = useState<{ id: string; existing: boolean; file: File; inherited?: Pick<CommonsSubmission,'source'|'licenses'|'credits'> } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true; setSetup(null); setError('');
    const chosen = scope === 'selection' ? snapshot.selection : null;
    const bytes = chosen?.bytes ?? snapshot.bytes;
    const name = chosen?.name ?? snapshot.file.name;
    void (async () => {
      const id = 'design-' + await cloudChecksum(new TextEncoder().encode(snapshot.file.id + (chosen ? ':' + chosen.key : '')));
      const file = await openModelFile(bytes);
      const notices = file.state.meta.attributions ?? [];
      if (notices.some(n => n.licenses.some(l => /NoDerivatives|\bND\b/i.test(l.name)))) throw new Error('This design includes a source with a no-derivatives condition. A compliant publication must be established before sharing this copy.');
      const mine = await new CommonsPublishing(account.client).mine();
      const inherited = notices.length ? { source: notices[0]!.source ?? { name: 'PushForm Commons', url: `https://commons.pushform.io/#models/${notices[0]!.modelId}` }, licenses: notices.flatMap(n => n.licenses), credits: notices.flatMap(n => n.credits) } : undefined;
      if (alive) setSetup({ id, existing: mine.models.some(m => m.id === id), file: new File([new Uint8Array(bytes)], name, { type: 'application/octet-stream' }), ...(inherited ? { inherited } : {}) });
    })().catch(cause => { if (alive) setError(cause.message); });
    return () => { alive = false; };
  }, [snapshot, account, scope]);
  return createPortal(<div className="pf-publishing-host">{error ? <div className="pf-modal-backdrop"><section className="pf-modal" role="dialog" aria-label="Publication unavailable"><p role="alert">{error}</p><p>The cloud revision is saved privately.</p><button onClick={onClose}>Keep private</button></section></div> : setup ? <UploadDialog key={setup.id} scopeControl={snapshot.selection ? <label>What to share<select value={scope} onChange={event => setScope(event.target.value)}><option value="whole">Entire saved model</option><option value="selection">Selected geometry and used assets</option></select></label> : undefined} account={account} filesUrl={filesUrl} modelId={setup.existing ? setup.id : null} newModelId={setup.id} initialFile={setup.file} inherited={setup.inherited} snapshotLabel={`Private cloud revision ${snapshot.file.revision_number}`} onClose={onClose} onPublished={onClose} /> : <div role="status">Preparing the saved cloud snapshot…</div>}</div>, document.body);
}
