// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useContext } from 'react';
import type { JSX, ReactNode } from 'react';
import { AppContext } from '../AppContext';
import { useCommandNotices } from '../hooks/useCommandNotices';
import { useAppStore } from '../store';

export function StatusHint({ children, className = '' }: { children: ReactNode; className?: string }): JSX.Element {
  return <div className={`pf-status-mid ${className}`} role="status" title={typeof children === 'string' ? children : undefined}>{children}</div>;
}

export function StatusBar({ saveStatus, units, hint }: { saveStatus?: ReactNode; units?: string | undefined; hint?: string | undefined } = {}): JSX.Element {
  const app = useContext(AppContext);
  useCommandNotices(app);
  const instructor = useAppStore((s) => s.instructor);
  const notice = useAppStore((s) => s.notice);
  const choices = useAppStore((s) => s.toolChoices);
  return (
    <footer className="pf-statusbar" aria-label="Document status">
      <StatusHint className={notice ? 'pf-status-notice' : ''}>
        {hint ?? notice ?? instructor}
      </StatusHint>
      {(hint ? [] : choices).map((c) => (
        <label key={c.id} className="pf-status-choice">
          <span>{c.label}</span>
          <select
            value={c.value}
            onChange={(e) => {
              app?.toolManager.choose(c.id, e.target.value);
              app?.viewport.container?.focus();
            }}
          >
            {c.options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
      ))}
      {saveStatus}
      {units && <span className="pf-status-units" title="Document units">{units}</span>}
    </footer>
  );
}
