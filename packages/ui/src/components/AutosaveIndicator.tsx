// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useState, useSyncExternalStore, type JSX } from 'react';
import { LuCheck, LuCloud, LuCloudOff, LuLoaderCircle } from 'react-icons/lu';
import type { CloudAutosave } from '../cloudAutosave';
import { cloudLocation } from '../cloudDocuments';
import type { CloudFilesApi } from '@pushform/cloud';
import type { DocumentSession, DocumentTab } from '../session';

/** Save details live beside the active document's tool hints, with recovery actions above the footer. */
export function AutosaveIndicator({ autosave, tab, onSaveCopy, onSave, session, files }: {
  autosave: CloudAutosave; tab: DocumentTab; session: DocumentSession; files?: CloudFilesApi | undefined;
  onSaveCopy?: (() => void) | undefined; onSave?: (() => void) | undefined;
}): JSX.Element {
  useSyncExternalStore(autosave.subscribe, autosave.getSnapshot);
  useSyncExternalStore(session.subscribeLocal, session.getLocalRevision);
  useSyncExternalStore(session.subscribe, () => session.revision);
  const [number, setNumber] = useState<number | null>(null);
  const [details, setDetails] = useState(false);
  useEffect(() => {
    let alive = true; setNumber(null); setDetails(false);
    const location = cloudLocation(tab.identity);
    if (location && files) void files.head(location.fileId).then(head => { if (alive) setNumber(head.file.revision_number); }, () => {});
    return () => { alive = false; };
  }, [tab.id, tab.identity, files]);
  const state = autosave.state(tab), local = session.localSaveState(tab);
  const localLabel = local === 'saved' ? 'Saved on device' : local === 'waiting' ? 'Saving on device…' : local === 'error' ? 'Local save failed' : 'Local recovery unavailable';
  const trashed = state.code === 'trashed';
  const cloudLabel = state.status === 'saving' ? 'Saving cloud version…' : state.status === 'offline' ? 'Offline' : state.status === 'conflict' ? 'Cloud conflict' : state.status === 'error' ? trashed ? 'In the Trash' : 'Cloud save failed' : number !== null ? 'Cloud v' + number : cloudLocation(tab.identity) ? 'Cloud saved' : 'Not saved to cloud';
  const label = autosave.automatic ? cloudLabel : localLabel + ' · ' + cloudLabel + (state.status === 'waiting' ? ' · local changes' : '');
  const Glyph = state.status === 'saving' ? LuLoaderCircle : state.status === 'offline' || state.status === 'error' ? LuCloudOff : local === 'saved' || state.status === 'saved' ? LuCheck : LuCloud;
  const expanded = details || !!state.error || local === 'error';
  return <div className={`pf-autosave is-${state.status}${local === 'error' ? ' is-local-error' : ''}`}>
    <button type="button" className="pf-save-status-trigger" aria-label="Save details" aria-expanded={expanded} onClick={() => setDetails(value => !value)} title={label}>
      <span role="status" aria-label="Cloud save status"><Glyph aria-hidden="true"/><span>{label}</span></span>
    </button>
    {expanded && <section className="pf-save-status-panel" aria-label="Save details">
      <strong>Document save status</strong>
      <dl><div><dt>On this device</dt><dd>{localLabel}</dd></div><div><dt>Cloud</dt><dd>{cloudLabel}</dd></div></dl>
      {state.error && <p role="alert">{state.error}</p>}
      {local === 'error' && <p role="alert">{session.recoveryError ?? 'The local recovery copy could not be saved.'}</p>}
      <div className="pf-save-status-actions">
        {trashed ? <><button type="button" className="pf-dialog-btn" onClick={() => { void autosave.restore(tab).catch(() => {}); }}>Restore</button>
          {onSaveCopy && <button type="button" className="pf-dialog-btn" onClick={() => { setDetails(false); onSaveCopy(); }}>Save a copy</button>}</>
          : state.error && state.status !== 'conflict' ? <button type="button" className="pf-dialog-btn" onClick={() => { void autosave.saveNow(tab).catch(() => {}); }}>Retry</button> : null}
        {!state.error && onSave && <button type="button" className="pf-dialog-btn is-primary" onClick={() => { setDetails(false); onSave(); }}>Save version</button>}
        {!state.error && local !== 'error' && <button type="button" className="pf-dialog-btn" onClick={() => setDetails(false)}>Close</button>}
      </div>
    </section>}
  </div>;
}
