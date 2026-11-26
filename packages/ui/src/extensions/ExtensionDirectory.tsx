// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useState, useSyncExternalStore, type JSX } from 'react';
import type { RegistryRelease } from '@pushform/extension-protocol';
import type { ExtensionPlatform } from '@pushform/extensions';
import { ExtensionIcon } from './ExtensionIcon';
import { PERMISSION_TEXT } from './permissionText';

/** Discovery renders signed metadata without downloading or activating any extension code. */
export function ExtensionDirectory({ platform, busy, available, onPrepare }: {
  readonly platform: ExtensionPlatform; readonly busy: boolean; readonly available: boolean;
  readonly onPrepare: (release: RegistryRelease) => void;
}): JSX.Element {
  const registry = platform.registry;
  useSyncExternalStore(notify => registry?.subscribe(notify) ?? (() => {}), () => registry?.revision ?? 0);
  const [search, setSearch] = useState(''), [refreshing, setRefreshing] = useState(false);
  const status = registry?.status();
  const all = registry?.releases().filter(release => release.recommended) ?? [];
  const needle = search.trim().toLocaleLowerCase();
  const releases = all.filter(({ manifest }) => `${manifest.name} ${manifest.publisher} ${manifest.description ?? ''}`.toLocaleLowerCase().includes(needle));
  const refresh = async (): Promise<void> => { setRefreshing(true); try { await registry?.refresh(); } finally { setRefreshing(false); } };
  return <section className="pf-xmanager-browse" aria-labelledby="pf-xmanager-browse-title">
    <div className="pf-xdirectory-heading">
      <h3 id="pf-xmanager-browse-title" className="pf-xinstall-heading">Browse</h3>
      {registry ? <button type="button" className="pf-btn" disabled={refreshing || busy} onClick={() => void refresh()}>{refreshing ? 'Checking\u2026' : 'Check for updates'}</button> : null}
    </div>
    {!registry ? <p className="pf-xmanager-muted">The extension directory is coming soon.</p> : <>
      {!status?.fresh ? <p className="pf-xdirectory-status" role="status">{status?.available
        ? 'Showing the saved directory. Connect and check for updates before installing.' : 'Check for updates to load the official extension directory.'}</p> : null}
      {status?.error ? <p className="pf-xinstall-error" role="status">{status.error}</p> : null}
      {all.length > 1 ? <label className="pf-xdirectory-search">Search extensions<input type="search" className="pf-input" value={search} onChange={event => setSearch(event.target.value)} /></label> : null}
      <ul className="pf-xmanager-list pf-xdirectory-list" aria-label="Official extension directory">
        {releases.map(release => {
          const installed = platform.state(release.manifest.id)?.record;
          const same = installed?.contentHash === release.contentHash;
          const developer = installed?.source === 'developer';
          const before = new Set(installed?.grants ?? []);
          const destinations = new Set(installed?.manifest.destinations.map(entry => `${entry.url}\0${entry.sendsModelData}`) ?? []);
          const approval = installed && !same && (release.manifest.permissions.some(permission => !before.has(permission))
            || release.manifest.destinations.some(entry => !destinations.has(`${entry.url}\0${entry.sendsModelData}`)));
          return <li className="pf-xmanager-row pf-xdirectory-card" key={release.contentHash}>
            <div className="pf-xdirectory-identity"><span className="pf-xdirectory-icon"><ExtensionIcon platform={platform} extensionId={release.manifest.id} icon={release.manifest.icon} size={20} /></span><div>
              <strong>{release.manifest.name}</strong><span className="pf-xmanager-muted">{release.manifest.publisher}{' \u00b7 '}{release.manifest.version}</span>
            </div></div>
            {release.manifest.description ? <p>{release.manifest.description}</p> : null}
            <div className="pf-xdirectory-footer"><span className="pf-xinstall-integrity is-official">Official, countersigned by PushForm</span>
              <button type="button" className="pf-btn" disabled={!available || busy || !status?.fresh || same || developer}
                onClick={() => onPrepare(release)} aria-label={`${installed && !same ? 'Review update for' : 'Install'} ${release.manifest.name}`}>
                {developer ? 'Developer package installed' : same ? 'Installed' : installed ? 'Review update' : 'Install'}
              </button></div>
            {approval ? <p className="pf-xdirectory-status">Update needs approval for new permissions or destinations.</p> : null}
            <details className="pf-xdirectory-details"><summary>Permissions and release notes</summary>
              <ul className="pf-xinstall-list">{release.manifest.permissions.map(permission => <li key={permission}>{PERMISSION_TEXT[permission]}</li>)}</ul>
              {release.manifest.destinations.map(destination => <p key={destination.url}>{new URL(destination.url).host}: {destination.purpose}{destination.sendsModelData ? ' (receives model data)' : ''}</p>)}
              {release.releaseNotes ? <p className="pf-xdirectory-notes">{release.releaseNotes}</p> : null}
              <p className="pf-xmanager-muted">{release.manifest.license}{' \u00b7 '}Requires PushForm {release.minimumAppVersion}</p>
              {release.manifest.sourceUrl ? <a href={release.manifest.sourceUrl} target="_blank" rel="noopener noreferrer">Source code</a> : null}
            </details>
          </li>;
        })}
      </ul>
      {status?.available && !releases.length ? <p className="pf-xmanager-empty">{needle ? 'No matching extensions.' : 'No official extensions are currently available.'}</p> : null}
    </>}
  </section>;
}
