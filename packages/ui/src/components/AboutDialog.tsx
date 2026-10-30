// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useRef, useSyncExternalStore, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { formatBuildDate, type BuildInfo } from '../buildInfo';
import { desktopUpdates, type DesktopUpdates } from '../desktopUpdates';
import { Icon } from './Icon';
import { useModalFocus } from './useModalFocus';

/**
 * Modal About box with the version, build commit and build time of the running bundle
 * and the product's copyright owner; desktop builds that update also show the update channel.
 * Traps focus, closes with Escape or its close button, and restores focus afterwards.
 */
export function AboutDialog({ build, onClose }: { build: BuildInfo; onClose: () => void }): JSX.Element {
  const dialog = useRef<HTMLDivElement>(null);
  useModalFocus(dialog, onClose);
  const updates = desktopUpdates();
  return createPortal(<div className="pf-modal-backdrop">
    <div ref={dialog} className="pf-modal pf-about-dialog" role="dialog" aria-modal="true" aria-labelledby="pf-about-title">
      <div className="pf-about-heading">
        <img src="/pf-logo-mark.svg" alt="" width={24} height={24} />
        <h2 id="pf-about-title">About PushForm</h2>
        <button type="button" className="pf-iconbtn" aria-label="Close about dialog" onClick={onClose}><Icon name="close" /></button>
      </div>
      <dl className="pf-about-facts">
        <dt>Version</dt><dd>{build.version || 'unknown'}</dd>
        <dt>Build</dt><dd><code>{build.commit || 'unknown'}</code></dd>
        <dt>Built</dt><dd>{build.date ? <time dateTime={build.date}>{formatBuildDate(build.date)}</time> : 'unknown'}</dd>
        {updates ? <UpdateChannel updates={updates} /> : null}
      </dl>
      <p className="pf-about-copyright">© 2026 JobCraft, Inc.</p>
      <p>Planned open-source release: <a href="https://www.gnu.org/licenses/gpl-3.0.html" target="_blank" rel="noopener noreferrer">GNU GPLv3 license</a></p>
    </div>
  </div>, document.body);
}

/** The update channel and a button to switch to the other. */
function UpdateChannel({ updates }: { updates: DesktopUpdates }): JSX.Element | null {
  const { enabled, channel, checkStatus, ready } = useSyncExternalStore(updates.subscribe, updates.getSnapshot);
  if (!enabled) return null;
  const other = channel === 'stable' ? 'nightly' : 'stable';
  const status = checkStatus === 'checking' ? 'Checking for updates…'
    : checkStatus === 'current' ? 'PushForm is up to date.'
    : checkStatus === 'ready' ? `PushForm ${ready} is ready to install.`
    : checkStatus === 'failed' ? 'Could not check for updates. Try again.' : '';
  return <>
    <dt>Updates</dt>
    <dd className="pf-about-channel">
      {channel === 'stable' ? 'Stable' : 'Nightly'}
      <button type="button" onClick={() => { void updates.setChannel(other); }}>Switch to {other === 'stable' ? 'Stable' : 'Nightly'}</button>
      <button type="button" className="pf-about-link" disabled={checkStatus === 'checking'} onClick={() => { void updates.check(); }}>Check for updates</button>
      <span className="pf-about-update-status" role="status">{status}</span>
    </dd>
  </>;
}
