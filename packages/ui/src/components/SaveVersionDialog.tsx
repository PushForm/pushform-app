// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { copyModelSelection } from '@pushform/commands';
import { encodeModelSnapshot } from '@pushform/io';
import type { CloudFilesApi, CloudSavedFile } from '@pushform/cloud';
import { cloudLocation } from '../cloudDocuments';
import type { CloudAutosave } from '../cloudAutosave';
import type { DocumentSession, DocumentTab } from '../session';

export interface PublishingSnapshot extends CloudSavedFile { bytes: Uint8Array; selection?: { bytes: Uint8Array; name: string; key: string } }

export function SaveVersionDialog({ tab, session, files, saves, onClose, onShare }: {
  tab: DocumentTab; session: DocumentSession; files: CloudFilesApi; saves: CloudAutosave;
  onClose(): void; onShare?: ((snapshot: PublishingSnapshot) => void) | undefined;
}) {
  const [number, setNumber] = useState<number | null>(null);
  const [notes, setNotes] = useState(''); const [share, setShare] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const alive = useRef(true); const dialog = useRef<HTMLElement>(null);
  const changed = saves.needsSave?.(tab) ?? (session.isDirty(tab) || !cloudLocation(tab.identity));
  useEffect(() => {
    alive.current = true; const location = cloudLocation(tab.identity);
    if (!location) setNumber(1);
    else void files.head(location.fileId).then(head => { if (alive.current) setNumber(head.file.revision_number + (changed ? 1 : 0)); }, cause => { if (alive.current) setError(String(cause.message)); });
    const app = document.querySelector<HTMLElement>('.pf-app'); const inert = app?.inert ?? false;
    if (app) app.inert = true; dialog.current?.querySelector('textarea')?.focus();
    return () => { alive.current = false; if (app) app.inert = inert; };
  }, [tab, files, changed]);
  const save = async () => {
    if (busy) return; setBusy(true); setError('');
    try {
      const selection = share && tab.type === 'model' ? copyModelSelection(tab.app.document.doc.state, tab.app.document.context.path, tab.app.document.selection.refs, { images: tab.app.document.images }) : null;
      const selectionBytes = selection ? encodeModelSnapshot(selection.state, [...selection.images].map(([id, blob]) => ({ id, blob }))) : null;
      await saves.saveNow(tab, notes);
      const location = cloudLocation(tab.identity); if (!location) throw new Error('The cloud version could not be confirmed. Try again.');
      const snapshot = share ? await files.openRevision(location.revisionId) : null;
      if (!alive.current) return;
      const selectedBytes = selectionBytes ? await selectionBytes : null;
      onClose(); if (snapshot) onShare?.({ ...snapshot, ...(selectedBytes ? { selection: { bytes: selectedBytes, name: snapshot.file.name.replace(/\.pf$/i, '') + ' selection.pf', key: 'selection' } } : {}) });
    } catch (cause) { if (alive.current) { setError(cause instanceof Error ? cause.message : 'Cloud save failed. Local changes are retained.'); setBusy(false); } }
  };
  return createPortal(<div className="pf-modal-backdrop"><section className="pf-modal pf-save-version" role="dialog" aria-modal="true" aria-label="Save version" ref={dialog} onKeyDown={event => {
    if (event.key === 'Escape' && !busy) onClose();
    if (event.key === 'Tab') {
      const controls = [...dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)')];
      const index = controls.indexOf(document.activeElement as HTMLElement);
      if (controls.length && (index < 0 || event.shiftKey && index === 0 || !event.shiftKey && index === controls.length - 1)) { event.preventDefault(); controls[event.shiftKey ? controls.length - 1 : 0]?.focus(); }
    }
  }}><h2>Save {tab.name}</h2><p>{changed ? 'Next cloud revision' : 'Current cloud revision'}: <strong>{number ?? 'Loading…'}</strong></p>
    {!changed && <p>No changes since the last save. This version will be reused.</p>}
    <label>Change notes (optional)<textarea value={notes} maxLength={4000} disabled={busy || !changed} onChange={event => setNotes(event.target.value)} /></label>
    {tab.type === 'model' && onShare && <label><input type="checkbox" checked={share} disabled={busy} onChange={event => setShare(event.target.checked)} /> Share with the community<p>After saving, review the public model and its license before publishing to Commons.</p></label>}
    <p>This cloud version is private. Publishing requires a separate confirmation.</p>
    {error && <p role="alert">{error}</p>}<div className="pf-modal-actions"><button disabled={busy} onClick={onClose}>Cancel</button><button disabled={busy || number === null} onClick={() => { void save(); }}>{busy ? 'Saving…' : share ? 'Save & continue to publishing' : changed ? 'Save version' : 'Done'}</button></div>
  </section></div>, document.body);
}
