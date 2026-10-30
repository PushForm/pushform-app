// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useRef, useSyncExternalStore, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { desktopUpdates, type DesktopUpdates as Updater } from '../desktopUpdates';
import { useModalFocus } from './useModalFocus';

/**
 * Desktop update prompts: the ready notice and the Update required dialog; `App` starts the checks.
 * `saveAll` saves every document with changes before a restart. Renders nothing in the browser.
 */
export function DesktopUpdates({ saveAll, updates = desktopUpdates() }: {
  saveAll: () => Promise<void>; updates?: Updater | null | undefined;
}): JSX.Element | null {
  if (!updates) return null;
  return <>
    <UpdateNotice updates={updates} saveAll={saveAll} />
    <UpdateRequired updates={updates} saveAll={saveAll} />
  </>;
}

/** Not modal; Later hides it until the next start or a newer version. */
function UpdateNotice({ updates, saveAll }: { updates: Updater; saveAll: () => Promise<void> }): JSX.Element | null {
  const state = useSyncExternalStore(updates.subscribe, updates.getSnapshot);
  if (!state.ready || state.required || (state.dismissed && !state.error)) return null;
  return createPortal(<div className="pf-update-notice" role="status">
    <p>{state.error ?? `PushForm ${state.ready} is ready to install.`}</p>
    <div className="pf-update-notice-actions">
      <button type="button" disabled={state.installing} onClick={() => { void updates.install(saveAll); }}>
        {state.installing ? 'Restarting…' : 'Restart to update'}
      </button>
      <button type="button" disabled={state.installing} onClick={() => updates.dismiss()}>Later</button>
    </div>
  </div>, document.body);
}

function UpdateRequired({ updates, saveAll }: { updates: Updater; saveAll: () => Promise<void> }): JSX.Element | null {
  const state = useSyncExternalStore(updates.subscribe, updates.getSnapshot);
  if (!state.required || !state.ready) return null;
  return <UpdateRequiredDialog version={state.ready} installing={state.installing} error={state.error}
    onInstall={() => { void updates.install(saveAll); }} onCancel={() => updates.closeRequired()} />;
}

/** Shown instead of opening another document once an update has waited a week. */
function UpdateRequiredDialog({ version, installing, error, onInstall, onCancel }: {
  version: string; installing: boolean; error: string | null; onInstall: () => void; onCancel: () => void;
}): JSX.Element {
  const dialog = useRef<HTMLDivElement>(null);
  useModalFocus(dialog, () => { if (!installing) onCancel(); });
  return createPortal(<div className="pf-modal-backdrop">
    <div ref={dialog} className="pf-modal pf-update-required" role="dialog" aria-modal="true" aria-labelledby="pf-update-required-title">
      <h2 id="pf-update-required-title">Update required</h2>
      <p>PushForm {version} has been ready to install for a week. Restart to update before opening another document; your open documents are saved first.</p>
      {error ? <p role="alert">{error}</p> : null}
      <div className="pf-modal-actions">
        <button type="button" disabled={installing} onClick={onInstall}>{installing ? 'Restarting…' : 'Restart and update'}</button>
        <button type="button" disabled={installing} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  </div>, document.body);
}
