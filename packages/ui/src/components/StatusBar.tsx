// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useContext } from 'react';
import type { JSX, ReactNode } from 'react';
import { AppContext } from '../AppContext';
import { useCommandNotices } from '../hooks/useCommandNotices';
import { useAppStore } from '../store';
import { platformKeyText } from '../platformKeys';

export function StatusHint({ children, className = '' }: { children: ReactNode; className?: string }): JSX.Element {
  return <div className={`pf-status-mid ${className}`} role="status" title={typeof children === 'string' ? children : undefined}>{children}</div>;
}

export function StatusBar({ saveStatus, units, hint }: { saveStatus?: ReactNode; units?: string | undefined; hint?: string | undefined } = {}): JSX.Element {
  const app = useContext(AppContext);
  useCommandNotices(app);
  const instructor = useAppStore((s) => s.instructor);
  const notice = useAppStore((s) => s.notice);
  return (
    <footer className="pf-statusbar" aria-label="Document status">
      <StatusHint className={notice ? 'pf-status-notice' : ''}>
        {hint ?? notice ?? platformKeyText(instructor, app?.keymap.platform === 'mac')}
      </StatusHint>
      {saveStatus}
      {units && <span className="pf-status-units" title="Document units">{units}</span>}
    </footer>
  );
}
