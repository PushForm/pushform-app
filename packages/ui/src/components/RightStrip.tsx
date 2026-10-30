// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { JSX } from 'react';
import { useAppStore } from '../store';
import { PANELS } from '../panels';
import { Icon } from './Icon';
import { ToolButton } from './ToolButton';

/** Right icon strip: opens one panel at a time. */
export function RightStrip(): JSX.Element {
  const openPanel = useAppStore((s) => s.openPanel);
  const togglePanel = useAppStore((s) => s.togglePanel);
  return (
    <nav className="pf-rightstrip" aria-label="Panels">
      {PANELS.map((p) => (
        <ToolButton
          key={p.id}
          type="button"
          className={`pf-toolbtn${openPanel === p.id ? ' is-active' : ''}`}
          title={p.title}
          aria-label={p.title}
          aria-pressed={openPanel === p.id}
          onClick={() => togglePanel(p.id)}
        >
          <Icon name={`panel-${p.id}`} size={24} />
        </ToolButton>
      ))}
    </nav>
  );
}
