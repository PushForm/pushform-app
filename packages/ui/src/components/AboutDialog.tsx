// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useRef, useState, useSyncExternalStore, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { formatBuildDate, type BuildInfo } from '../buildInfo';
import { desktopUpdates, type DesktopUpdates } from '../desktopUpdates';
import { THIRD_PARTY_NOTICES_URL, openThirdPartyNotices } from '../thirdPartyNotices';
import { Icon } from './Icon';
import { useModalFocus } from './useModalFocus';

/**
 * Modal About box with the version, build commit and build time of the running bundle
 * and the product's copyright owner, with links to the license, the source code and the third-party notices; desktop
 * builds that update also show the update channel.
 * Traps focus, closes with Escape or its close button, and restores focus afterwards.
 */
export function AboutDialog({ build, onClose }: { build: BuildInfo; onClose: () => void }): JSX.Element {
  const dialog = useRef<HTMLDivElement>(null);
  useModalFocus(dialog, onClose);
  const updates = desktopUpdates();
  const [noticesMissing, setNoticesMissing] = useState(false);
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
      <p>Open source under the <a href="https://www.gnu.org/licenses/gpl-3.0.html" target="_blank" rel="noopener noreferrer">GNU GPLv3 license</a>. <a href="https://github.com/PushForm/pushform-app" target="_blank" rel="noopener noreferrer">Source code on GitHub</a>. <a href={THIRD_PARTY_NOTICES_URL} target="_blank" rel="noopener noreferrer" onClick={event => { void openThirdPartyNotices(event).then(opened => setNoticesMissing(!opened)); }}>Third-party notices</a></p>
      {noticesMissing ? <p role="status">The third-party notices file is installed with release builds only.</p> : null}
      <p className="pf-about-credits">Icons include <a href="https://game-icons.net/" target="_blank" rel="noopener noreferrer">Game Icons</a> by Lorc, Delapouite and contributors, <a href="https://creativecommons.org/licenses/by/3.0/" target="_blank" rel="noopener noreferrer">CC BY 3.0</a>.</p>
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
