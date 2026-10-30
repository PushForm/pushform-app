// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect } from 'react';
import type { AppInstance } from './bootstrap';
import { VCB_INPUT_ID } from './components/MeasurementsBox';
import { useAppStore } from './store';

const VCB_START = /^[0-9.,'"\-+[\]<>:*/a-zA-Z°]$/;

/**
 * Global keyboard routing: tool keys (Esc/Space/arrows) → keymap shortcuts →
 * printable characters go to the Measurements box without clicking it.
 */
export function useGlobalKeys(app: AppInstance, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && isTextField(target)) {
        return; // the field (including the Measurements box) handles its own keys
      }
      const modifiers = { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey };
      if (app.toolManager.keyDown({ key: e.key, code: e.code, modifiers, repeat: e.repeat })) {
        e.preventDefault();
        return;
      }
      const cmd = app.keymap.resolve(e);
      if (cmd && app.commands.has(cmd)) {
        e.preventDefault();
        if (app.commands.isEnabled(cmd)) app.commands.tryExecute(cmd);
        return;
      }
      if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1 && VCB_START.test(e.key)) {
        const input = document.getElementById(VCB_INPUT_ID) as HTMLInputElement | null;
        if (input) {
          e.preventDefault();
          useAppStore.getState().setVcbInput(e.key, true);
          input.focus();
          requestAnimationFrame(() =>
            input.setSelectionRange(input.value.length, input.value.length),
          );
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && isTextField(target)) return;
      const modifiers = { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey };
      app.toolManager.keyUp({ key: e.key, code: e.code, modifiers, repeat: e.repeat });
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
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}
