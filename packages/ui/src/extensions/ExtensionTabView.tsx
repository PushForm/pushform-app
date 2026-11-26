// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { JSX } from 'react';
import type { UnitSettings } from '@pushform/core';
import type { ExtensionPlatform } from '@pushform/extensions';
import { ExtensionIcon } from './ExtensionIcon';
import { ExtensionMount } from './ExtensionMount';
import type { ExtensionTab } from './extensionTabs';
import { INTEGRITY_TEXT } from './permissionText';

/**
 * An extension tab's content, filling the editor area while the tab is in front. PushForm draws a slim header
 * naming the panel and the extension (and that it is unsigned, when it is), so the content can never pass for
 * PushForm's own; the extension's interface fills the rest. Showing it runs the panel contribution on the tab's
 * document; closing the tab, or the document, cancels that run and removes the interface.
 */
export function ExtensionTabView({ platform, tab, units }: {
  readonly platform: ExtensionPlatform;
  readonly tab: ExtensionTab;
  readonly units: UnitSettings;
}): JSX.Element {
  const { entry } = tab;
  return (
    <section className="pf-xtab" aria-label={`${entry.name}, from ${entry.extensionName}`} data-extension={entry.extensionId}>
      <header className="pf-xtab-head">
        <span className="pf-xpanel-icon"><ExtensionIcon platform={platform} extensionId={entry.extensionId} icon={platform.state(entry.extensionId)?.record.manifest.icon} size={16} /></span>
        <h2 className="pf-xtab-title">{entry.name}</h2>
        <span className="pf-xpanel-source">{entry.extensionName}
          {entry.integrity === 'unsigned' ? <span className="pf-xpanel-unsigned"> · {INTEGRITY_TEXT.unsigned}</span> : null}</span>
      </header>
      <div className="pf-xtab-body">
        <ExtensionMount platform={platform} entry={entry} units={units} documentId={tab.documentId} />
      </div>
    </section>
  );
}
