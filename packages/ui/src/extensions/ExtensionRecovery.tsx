// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useSyncExternalStore, type JSX } from 'react';
import { createPortal } from 'react-dom';
import type { ExtensionPlatform } from '@pushform/extensions';
import { ExtensionInstallDialog } from './ExtensionInstallDialog';
import { useExtensionInstaller } from './useExtensionInstaller';

/** Document metadata can offer a specific verified install; it never initiates one or opens general management. */
export function ExtensionRecovery({ platform, id, requiredDataVersion }: {
  readonly platform: ExtensionPlatform; readonly id: string; readonly requiredDataVersion: number;
}): JSX.Element {
  useSyncExternalStore(notify => platform.subscribe(notify), () => platform.revision);
  const installer = useExtensionInstaller(platform), registry = platform.registry;
  const installed = platform.state(id)?.record;
  const release = registry?.releases().find(release => release.recommended && release.manifest.id === id && release.contentHash !== installed?.contentHash
    && (release.manifest.metadata?.dataVersion ?? 0) >= requiredDataVersion);
  const fresh = registry?.status().fresh;
  return <>
    {release ? <button type="button" className="pf-btn" disabled={!fresh || installer.busy}
      onClick={() => void installer.prepare(signal => platform.prepareOfficial(id, release.contentHash, signal))}>
      {installer.busy ? 'Checking package\u2026' : `${installed ? 'Update' : 'Install'} ${release.manifest.name}`}
    </button> : <p className="pf-ei-muted">A compatible verified {installed ? 'update' : 'install'} is currently unavailable. Saved values are retained.</p>}
    {release && !fresh ? <p className="pf-ei-muted">Connect and check for updates in Extensions before installing.</p> : null}
    {installer.error ? <p role="alert">{installer.error}</p> : null}
    {installer.request ? createPortal(<ExtensionInstallDialog request={installer.request} busy={installer.busy} error={installer.error}
      onInstall={installer.install} onCancel={installer.cancel} />, document.querySelector('.pf-app') ?? document.body) : null}
  </>;
}
