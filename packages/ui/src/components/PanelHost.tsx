// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { JSX } from 'react';
import { useAppStore } from '../store';
import { PANELS } from '../panels';
import { Icon } from './Icon';

export function PanelHost(): JSX.Element | null {
  const openPanel = useAppStore((s) => s.openPanel);
  const closePanel = useAppStore((s) => s.closePanel);
  const panel = PANELS.find((p) => p.id === openPanel);
  if (!panel) return null;
  const Body = panel.component;
  return (
    <aside className="pf-panel" aria-label={panel.title}>
      <div className="pf-panel-head">
        <h2>{panel.title}</h2>
        <button type="button" className="pf-iconbtn" aria-label="Close panel" onClick={closePanel}>
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="pf-panel-body">
        <Body />
      </div>
    </aside>
  );
}
