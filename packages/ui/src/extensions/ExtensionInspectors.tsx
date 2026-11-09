// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type JSX } from 'react';
import { newGuid } from '@pushform/core';
import { pluginTargetKey, type DocumentState, type EntityRef } from '@pushform/model';
import type { ContributionEntry, ExtensionPlatform } from '@pushform/extensions';
import type { InspectorCapture } from '@pushform/extension-protocol';
import { useApp } from '../AppContext';
import { ExtensionMount } from './ExtensionMount';
import { ExtensionRecovery } from './ExtensionRecovery';
import { inspectorNoticeTargets, inspectorPlacementCount, inspectorTargets } from './inspectorSelection';

export const ExtensionInspectorContext = createContext<{ platform: ExtensionPlatform | null; documentId: string | null; ownerId: string; reveal?: { target: string; seq: number } | null }>({ platform: null, documentId: null, ownerId: 'local' });

function readOpen(key: string): boolean { try { return localStorage.getItem(key) === 'open'; } catch { return false; } }
function writeOpen(key: string, open: boolean): void { try { localStorage.setItem(key, open ? 'open' : 'closed'); } catch { /* Preference storage can be unavailable. */ } }

/** Core fields stay in Entity Info; plugin code runs only inside a deliberately opened subsection. */
export function ExtensionInspectors({ state, refs }: { state: DocumentState; refs: readonly EntityRef[] }): JSX.Element | null {
  const { platform, documentId, ownerId } = useContext(ExtensionInspectorContext);
  useSyncExternalStore(notify => platform?.subscribe(notify) ?? (() => {}), () => platform?.revision ?? 0);
  const entries = platform?.contributions('modeling').filter(entry => entry.target === 'model.inspector.block' && entry.inspector) ?? [];
  if (!entries.length && !state.pluginData?.size) return null;
  const keys = inspectorNoticeTargets(state, refs);
  const savedOwners = [...state.pluginData ?? []].filter(([, record]) => [...record.entries.values()].some(entry => keys.has(pluginTargetKey(entry.target)))).map(([id]) => id);
  const shown = new Set<string>();
  return <>
    {entries.map(entry => {
      const applicable = inspectorTargets(state, refs, entry.inspector!, 'placement');
      const shared = inspectorTargets(state, refs, entry.inspector!, 'shared');
      if (!applicable.targets.length && !shared.targets.length && !savedOwners.includes(entry.extensionId)) return null;
      shown.add(entry.extensionId);
      return <InspectorSection key={entry.id} platform={platform!} documentId={documentId} entry={entry} state={state} refs={refs} ownerId={ownerId} />;
    })}
    {savedOwners.filter(id => !shown.has(id)).map(id => <UnavailableSection key={id} id={id} platform={platform} dataVersion={state.pluginData?.get(id)?.dataVersion ?? 1} />)}
  </>;
}

function UnavailableSection({ id, platform, dataVersion }: { id: string; platform: ExtensionPlatform | null; dataVersion: number }): JSX.Element {
  const record = platform?.state(id)?.record;
  const [error, setError] = useState('');
  return <details className="pf-ei-plugin"><summary>{record?.manifest.name ?? id}</summary>
    <p className="pf-ei-muted">Properties are saved with this model. {record ? 'This plugin is unavailable for this selection or is turned off.' : 'Install a compatible plugin to edit them.'}</p>
    {platform && (!record || platform.state(id)?.failure) ? <ExtensionRecovery platform={platform} id={id} requiredDataVersion={dataVersion} /> : null}
    {record && !record.enabled ? <button type="button" className="pf-btn" onClick={() => void platform!.setEnabled(id, true).catch(error => setError(String(error)))}>Enable {record.manifest.name}</button> : null}
    {error ? <p role="alert">{error}</p> : null}
  </details>;
}

function InspectorSection({ platform, documentId, entry, state, refs, ownerId }: {
  platform: ExtensionPlatform; documentId: string | null; entry: ContributionEntry; state: DocumentState; refs: readonly EntityRef[]; ownerId: string;
}): JSX.Element {
  const app = useApp(), preference = `pushform:inspector:${ownerId}:${entry.id}`;
  const [open, setOpen] = useState(() => readOpen(preference));
  const { reveal } = useContext(ExtensionInspectorContext);
  useEffect(() => { if (reveal?.target === entry.id) { setOpen(true); writeOpen(preference, true); setScope(null); } }, [reveal?.seq, reveal?.target, entry.id, preference]);
  const [scopeChoice, setScope] = useState<{ selection: string; value: 'placement' | 'shared' } | null>(null);
  const selectionKey = JSON.stringify(refs);
  const scope = scopeChoice?.selection === selectionKey ? scopeChoice.value : 'placement';
  const selected = inspectorTargets(state, refs, entry.inspector!, scope);
  let placementCount = selected.targets.length, countError = '';
  try { placementCount = inspectorPlacementCount(state, selected.targets); } catch (error) { countError = String(error); }
  const bodyIds = new Set(selected.targets.flatMap(target => target.kind === 'body' || target.kind === 'bodyOccurrence' ? [target.id] : []));
  const record = state.pluginData?.get(entry.extensionId);
  const overrides = new Set([...record?.entries.values() ?? []].filter(value => value.target.kind === 'bodyOccurrence' && bodyIds.has(value.target.id)).map(value => pluginTargetKey(value.target))).size;
  const version = platform.state(entry.extensionId)?.record.manifest.metadata?.dataVersion;
  const newer = record && (version === undefined || record.dataVersion > version);
  const captureKey = JSON.stringify([selected.targets, app.document.doc.version, scope, placementCount, overrides]);
  const capture = useMemo<InspectorCapture>(() => ({ binding: newGuid(), revision: app.document.doc.version, scope, targets: selected.targets, placementCount, overrideCount: overrides }), [captureKey]);
  const canShow = !!documentId && selected.targets.length > 0 && !selected.unsupported && !selected.overflow && !countError && !newer;
  return <details className="pf-ei-plugin" open={open} onToggle={event => { const value = event.currentTarget.open; setOpen(value); writeOpen(preference, value); }}>
    <summary>{entry.extensionName}{entry.integrity === 'unsigned' ? <span className="pf-ei-muted"> · Developer</span> : null}</summary>
    {open ? <>
      {(entry.inspector!.targets.includes('body') || entry.inspector!.targets.includes('bodyOccurrence')) ? <label className="pf-ei-plugin-scope">Apply to
        <select className="pf-ei-select" aria-label={`${entry.extensionName} edit scope`} value={scope} onChange={event => setScope({ selection: selectionKey, value: event.target.value as 'placement' | 'shared' })}>
          <option value="placement">Selected placements</option>
          <option value="shared">Shared body defaults</option>
        </select>
      </label> : null}
      <p className="pf-ei-muted">{scope === 'shared' ? `${placementCount} placements affected. ${overrides} have saved properties; placement overrides are preserved.` : `${selected.targets.length} selected ${selected.targets.every(target => target.kind === 'body' || target.kind === 'bodyOccurrence') ? selected.targets.length === 1 ? 'part' : 'parts' : selected.targets.length === 1 ? 'entity' : 'entities'}`}</p>
      {selected.unsupported || selected.overflow ? <p role="status">{selected.overflow ? 'This selection exceeds the inspector limits. Select 200 or fewer targets in a smaller assembly.' : `${selected.unsupported} selected targets or target combinations are unsupported at this scope. Change the selection or scope before editing.`}</p> : null}
      {newer ? <><p role="status">This model contains newer plugin data. Update {entry.extensionName} to edit it. Saved values are retained.</p>
        <ExtensionRecovery platform={platform} id={entry.extensionId} requiredDataVersion={record.dataVersion} /></> : null}
      {countError ? <p role="alert">{countError}</p> : null}
      {canShow ? <ExtensionMount key={capture.binding} platform={platform} entry={entry} documentId={documentId!} units={state.meta.units} inspector={capture} /> : null}
    </> : null}
  </details>;
}
