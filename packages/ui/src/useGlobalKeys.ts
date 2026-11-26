// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect } from 'react';
import type { AppInstance } from './bootstrap';
import { beginEntry } from './components/EntryFields';
import { toolKeyName, toolModifiers } from './platformKeys';

const VCB_START = /^[0-9.,'"\-+[\]<>:*/a-zA-Z°]$/;

/**
 * Global keyboard routing: tool keys (Esc/Space/arrows) → keymap shortcuts →
 * printable characters start a value in the viewport's value fields without clicking one.
 */
export function useGlobalKeys(app: AppInstance, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && isTextField(target)) {
        return; // the field (including a value field) handles its own keys
      }
      const mac = app.keymap.platform === 'mac';
      const modifiers = toolModifiers(e, mac);
      if (app.toolManager.keyDown({ key: toolKeyName(e.key, mac), code: e.code, modifiers, repeat: e.repeat })) {
        e.preventDefault();
        return;
      }
      const cmd = app.keymap.resolve(e);
      if (cmd && app.commands.has(cmd)) {
        e.preventDefault();
        if (app.commands.isEnabled(cmd)) app.commands.tryExecute(cmd);
        return;
      }
      if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1 && (VCB_START.test(e.key) || e.key === '@' && app.toolManager.visualTool?.onRawVcb)) {
        e.preventDefault();
        beginEntry(e.key);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && isTextField(target)) return;
      const mac = app.keymap.platform === 'mac';
      app.toolManager.keyUp({ key: toolKeyName(e.key, mac), code: e.code, modifiers: toolModifiers(e, mac), repeat: e.repeat });
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [app, enabled]);
}

function isTextField(el: HTMLElement): boolean {
  const tag = el.tagName;
  return Boolean(el.closest?.('[role=dialog], [aria-modal=true]')) || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}
