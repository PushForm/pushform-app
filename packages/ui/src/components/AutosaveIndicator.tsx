// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useSyncExternalStore, type JSX } from 'react';
import { LuCheck, LuCloud, LuCloudOff, LuLoaderCircle } from 'react-icons/lu';
import type { CloudAutosave } from '../cloudAutosave';
import { cloudLocation } from '../cloudDocuments';
import type { DocumentTab } from '../session';

/** The cloud save state of the active document; a trashed file offers Restore and Save a copy. */
export function AutosaveIndicator({ autosave, tab, onSaveCopy }: { autosave: CloudAutosave; tab: DocumentTab; onSaveCopy?: (() => void) | undefined }): JSX.Element {
  useSyncExternalStore(autosave.subscribe, autosave.getSnapshot);
  const state = autosave.state(tab);
  const trashed = state.code === 'trashed';
  const label = state.status === 'saving' ? 'Saving…' : state.status === 'waiting' ? 'Changes pending' :
    state.status === 'offline' ? 'Offline · changes on this device' : state.status === 'conflict' ? 'Newer cloud version' :
    state.status === 'error' ? (trashed ? 'In the Trash' : 'Could not save') : cloudLocation(tab.identity) ? 'All changes saved' : 'Not saved yet';
  const Glyph = state.status === 'saving' ? LuLoaderCircle : state.status === 'offline' ? LuCloudOff : state.status === 'saved' ? LuCheck : LuCloud;
  return <div className={`pf-autosave is-${state.status}`}>
    <span role="status" aria-label="Cloud save status" title={state.error ?? label}><Glyph aria-hidden="true" /><span>{label}</span></span>
    {state.error ? <span className="pf-autosave-error" role="alert">{state.error}
      {trashed ? <>
        <button type="button" onClick={() => { void autosave.restore(tab).catch(() => {}); }}>Restore</button>
        {onSaveCopy ? <button type="button" onClick={onSaveCopy}>Save a copy</button> : null}
      </> : state.status !== 'conflict' ? <button type="button" onClick={() => { void autosave.saveNow(tab).catch(() => {}); }}>Retry</button> : null}
    </span> : null}
  </div>;
}
