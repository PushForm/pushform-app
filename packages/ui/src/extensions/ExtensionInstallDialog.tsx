// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { JSX } from 'react';
import type { InstallRequest } from '@pushform/extensions';
import { Dialog } from '../components/DialogParts';
import { INTEGRITY_TEXT, PERMISSION_TEXT, destinationText } from './permissionText';

/**
 * The install dialog, drawn by PushForm itself: every word comes from the verified manifest or from PushForm, never
 * from the extension's own interface. It names the extension, its publisher and version, what it is allowed to do
 * in plain sentences, where it may connect, which editors it supports, its license and its integrity. For an update
 * or a developer reload it marks what is new. Installing grants exactly the permissions shown.
 */
export function ExtensionInstallDialog({ request, onInstall, onCancel, busy = false, error = null }: {
  readonly request: InstallRequest;
  readonly onInstall: () => void;
  readonly onCancel: () => void;
  readonly busy?: boolean;
  readonly error?: string | null;
}): JSX.Element {
  const { manifest, integrity, replaces } = request;
  const newPermissions = new Set(request.newPermissions);
  const newDestinations = new Set(request.newDestinations);
  const action = replaces ? (replaces.version === manifest.version ? 'Reload' : 'Update') : 'Install';
  return (
    <Dialog title={`${action} ${manifest.name}?`} onClose={onCancel}>
      <div className="pf-xinstall">
        <p className="pf-xinstall-meta">
          <span>{manifest.publisher}</span> · <span>version {manifest.version}</span>
          {replaces && replaces.version !== manifest.version ? <span> (installed: {replaces.version})</span> : null}
        </p>
        <p className={`pf-xinstall-integrity is-${integrity}`} role="note">{INTEGRITY_TEXT[integrity]}</p>
        {integrity === 'unsigned'
          ? <p className="pf-xinstall-warning">PushForm has not reviewed this extension. Install it only if you trust where it came from.</p>
          : null}
        {manifest.description ? <p className="pf-xinstall-description">{manifest.description}</p> : null}

        <h3 className="pf-xinstall-heading">Permissions</h3>
        {manifest.permissions.length ? (
          <ul className="pf-xinstall-list">
            {manifest.permissions.map((p) => (
              <li key={p}>{PERMISSION_TEXT[p]}{replaces && newPermissions.has(p) ? <strong className="pf-xinstall-new"> New</strong> : null}</li>
            ))}
          </ul>
        ) : <p>It needs no permissions.</p>}

        {manifest.destinations.length ? <>
          <h3 className="pf-xinstall-heading">Internet addresses</h3>
          <ul className="pf-xinstall-list">
            {manifest.destinations.map((d) => (
              <li key={d.url}>{destinationText(d)}{replaces && newDestinations.has(d.url) ? <strong className="pf-xinstall-new"> New</strong> : null}</li>
            ))}
          </ul>
        </> : null}

        <dl className="pf-xinstall-facts">
          <dt>Works in</dt><dd>{manifest.editors.map((e) => (e === 'modeling' ? 'Modeling' : 'Layout')).join(' and ')}</dd>
          <dt>Extension API</dt><dd>{manifest.apiVersion} (compatible)</dd>
          <dt>License</dt><dd>{manifest.license}{manifest.sourceUrl ? <> · <a href={manifest.sourceUrl} target="_blank" rel="noreferrer noopener">Source code</a></> : null}</dd>
          <dt>Identifier</dt><dd><code>{manifest.id}</code></dd>
        </dl>
        {error ? <p className="pf-xinstall-error" role="alert">{error}</p> : null}
        <div className="pf-form-actions">
          <button type="button" className="pf-btn pf-xui-button is-primary" disabled={busy} onClick={onInstall}>{busy ? `${action}ing…` : action}</button>
          <button type="button" className="pf-btn" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </Dialog>
  );
}
