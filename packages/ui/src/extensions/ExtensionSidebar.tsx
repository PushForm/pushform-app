// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useState, type JSX } from 'react';
import type { UnitSettings } from '@pushform/core';
import type { ContributionEntry, ExtensionEntry, ExtensionPlatform } from '@pushform/extensions';
import { Icon } from '../components/Icon';
import { ExtensionIcon } from './ExtensionIcon';
import { ExtensionMount } from './ExtensionMount';
import { extensionSidebars } from './extensionContributions';
import { INTEGRITY_TEXT } from './permissionText';

/**
 * An extension's side panel, docked beside the editor when its activity bar icon is chosen. PushForm draws the
 * frame: the header shows the extension's icon and name and, for a side-loaded one, says it is unsigned, so the
 * extension's own content can never pass for PushForm's. Below it, the extension's sidebar contributions: one is
 * mounted directly; several show as a tabbed strip, and only the chosen one runs. Opening the panel runs the
 * contribution on the active document; closing it, or switching documents, cancels that run and removes the interface.
 */
export function ExtensionSidebar({ platform, extension, units, documentId, onClose }: {
  readonly platform: ExtensionPlatform;
  readonly extension: ExtensionEntry;
  readonly units: UnitSettings;
  /** The document the panel acts on. */
  readonly documentId: string;
  readonly onClose: () => void;
}): JSX.Element {
  const sidebars = extensionSidebars(extension);
  const [chosen, setChosen] = useState<string | null>(null);
  const shown: ContributionEntry | undefined = sidebars.find((s) => s.id === chosen) ?? sidebars[0];
  return (
    <section className="pf-xpanel" aria-label={`${extension.name} side panel`} data-extension={extension.id}>
      <header className="pf-xpanel-head">
        <span className="pf-xpanel-icon"><ExtensionIcon platform={platform} extensionId={extension.id} icon={extension.icon} size={16} /></span>
        <div className="pf-xpanel-title">
          <h2>{extension.name}</h2>
          {extension.integrity === 'unsigned' ? <span className="pf-xpanel-source"><span className="pf-xpanel-unsigned">{INTEGRITY_TEXT.unsigned}</span></span> : null}
        </div>
        <button type="button" className="pf-iconbtn" aria-label={`Close ${extension.name}`} title="Close" onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </header>
      {sidebars.length > 1 ? <div className="pf-xpanel-tabs" role="tablist" aria-label={`${extension.name} views`}>
        {sidebars.map((s) => <button key={s.id} type="button" role="tab" className={`pf-xpanel-tab${s.id === shown?.id ? ' is-active' : ''}`}
          aria-selected={s.id === shown?.id} onClick={() => setChosen(s.id)}>{s.name}</button>)}
      </div> : null}
      <div className="pf-xpanel-body">
        {shown ? <ExtensionMount key={`${shown.id}:${documentId}`} platform={platform} entry={shown} units={units} documentId={documentId} />
          : <p className="pf-xpanel-status">{extension.name} has no side panel.</p>}
      </div>
    </section>
  );
}
