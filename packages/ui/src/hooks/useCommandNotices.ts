// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect } from 'react';
import type { AppInstance } from '../bootstrap';
import { installUiServices } from '../engine/uiServices';
import { useAppStore } from '../store';

const MAX_LEN = 160;

/** One-line, bounded message for a command failure. */
export function noticeFromError(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Command failed';
  const line = raw.split('\n')[0] ?? raw;
  return line.length > MAX_LEN ? `${line.slice(0, MAX_LEN - 1)}…` : line;
}

/**
 * Mirror command outcomes into `store.notice` for the status bar: a `failed` event shows the
 * error, an executed command whose result carries a `message` (e.g. `edit.delete`'s "N items not
 * deleted…") shows it, and any other successful command or a tool change clears the notice.
 */
export function useCommandNotices(app: AppInstance | null): void {
  useEffect(() => {
    if (!app) return;
    installUiServices(app.commands);
    const set = (notice: string | null): void => {
      if (useAppStore.getState().notice !== notice) useAppStore.getState().setNotice(notice);
    };
    const offFailed = app.commands.events.on('failed', ({ error }) => set(noticeFromError(error)));
    const offExecuted = app.commands.events.on('executed', ({ result }) => {
      const message = (result as { message?: unknown } | null | undefined)?.message;
      set(typeof message === 'string' && message.length > 0 ? message : null);
    });
    const offTool = app.toolManager.events.on('toolChanged', () => set(null));
    return () => {
      offFailed();
      offExecuted();
      offTool();
    };
  }, [app]);
}
