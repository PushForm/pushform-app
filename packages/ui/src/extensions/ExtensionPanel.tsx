// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useMemo, useState, useSyncExternalStore, type JSX } from 'react';
import type { UnitSettings } from '@pushform/core';
import type { ContributionEntry, ExtensionPlatform } from '@pushform/extensions';
import { Icon } from '../components/Icon';
import { ExtensionTarget } from './ExtensionUi';
import { INTEGRITY_TEXT } from './permissionText';

/**
 * An extension panel docked in the side panel area. PushForm draws its frame: the header names the panel and the
 * extension and, for a side-loaded one, says it is unsigned, so the extension's own content can never pass for
 * PushForm's. Opening the panel runs its contribution, which starts the extension if needed and mounts its
 * interface; closing it, or switching documents, cancels that run and removes the interface.
 */
export function ExtensionPanel({ platform, entry, units, documentId, onClose }: {
  readonly platform: ExtensionPlatform;
  readonly entry: ContributionEntry;
  readonly units: UnitSettings;
  /** The document the panel acts on. */
  readonly documentId: string;
  readonly onClose: () => void;
}): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const revision = useSyncExternalStore((notify) => platform.subscribe(notify), () => platform.revision);
  // The revision says when the state changed.
  const state = useMemo(() => platform.state(entry.extensionId), [platform, entry.extensionId, revision]);
  // The interface host exists only while the extension runs; it changes after a restart.
  const host = state?.run === 'running' ? platform.ui(entry.extensionId) : null;

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    platform.invoke(entry.extensionId, entry.id, {}, { signal: controller.signal, userAction: true, scopes: [`panel:${entry.id}`], document: documentId })
      .catch((e: unknown) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)); });
    return () => {
      controller.abort();
      platform.ui(entry.extensionId)?.close(entry.id);
    };
    // A restart (a new generation) runs the panel again.
  }, [platform, entry.extensionId, entry.id, documentId, state?.generation]);

  const failure = state?.run === 'failed' ? state.failure?.error.message ?? 'The extension stopped.' : error;
  const status = state?.run === 'starting' || !host ? 'Starting…' : 'Loading…';
  return (
    <section className="pf-xpanel" aria-label={`${entry.name}, from ${entry.extensionName}`} data-extension={entry.extensionId}>
      <header className="pf-xpanel-head">
        <span className="pf-xpanel-icon" aria-hidden="true"><Icon name="extensions" size={14} /></span>
        <div className="pf-xpanel-title">
          <h2>{entry.name}</h2>
          <span className="pf-xpanel-source">{entry.extensionName}
            {entry.integrity === 'unsigned' ? <span className="pf-xpanel-unsigned"> · {INTEGRITY_TEXT.unsigned}</span> : null}</span>
        </div>
        <button type="button" className="pf-iconbtn" aria-label={`Close ${entry.name}`} onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </header>
      <div className="pf-xpanel-body">
        {failure ? <div className="pf-xpanel-failed">
            <p className="pf-xinstall-error" role="alert">{failure}</p>
            {state?.run === 'failed' ? <button type="button" className="pf-btn" onClick={() => void platform.restart(entry.extensionId)}>Restart {entry.extensionName}</button> : null}
          </div>
          : host ? <ExtensionTarget host={host} target={entry.id} units={units} empty={<p className="pf-xpanel-status" role="status">{status}</p>} />
          : <p className="pf-xpanel-status" role="status">{status}</p>}
      </div>
    </section>
  );
}
