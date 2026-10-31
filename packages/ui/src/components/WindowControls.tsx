// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { JSX } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { desktopPlatform } from '../desktopShell';

/** Minimize, maximize and close for the frameless desktop window; macOS keeps its native traffic lights, and the browser has none. */
export function WindowControls(): JSX.Element | null {
  if (desktopPlatform() !== 'other') return null;
  const win = getCurrentWindow();
  return (
    <div className="pf-window-controls">
      <button type="button" aria-label="Minimize window" onClick={() => { void win.minimize(); }}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5h10" stroke="currentColor" fill="none" /></svg>
      </button>
      <button type="button" aria-label="Maximize window" onClick={() => { void win.toggleMaximize(); }}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" fill="none" /></svg>
      </button>
      <button type="button" className="is-close" aria-label="Close window" onClick={() => { void win.close(); }}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" fill="none" /></svg>
      </button>
    </div>
  );
}
