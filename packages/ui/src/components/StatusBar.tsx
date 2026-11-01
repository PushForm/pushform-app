// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useContext } from 'react';
import type { JSX } from 'react';
import { AppContext } from '../AppContext';
import { useCommandNotices } from '../hooks/useCommandNotices';
import { useAppStore } from '../store';

export function StatusBar(): JSX.Element {
  const app = useContext(AppContext);
  useCommandNotices(app);
  const instructor = useAppStore((s) => s.instructor);
  const notice = useAppStore((s) => s.notice);
  return (
    <footer className="pf-statusbar">
      <div className="pf-status-left" aria-label="Status hints">
        <span className="pf-status-dot" aria-hidden="true" />
        <span>Ready</span>
      </div>
      <div className={`pf-status-mid${notice ? ' pf-status-notice' : ''}`} role="status">
        {notice ?? instructor}
      </div>
    </footer>
  );
}
