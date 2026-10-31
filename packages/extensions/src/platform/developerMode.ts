// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors

/**
 * Developer mode: whether this device accepts side-loaded, unsigned extensions. It is off by default and set per
 * device, never synced. Organization policy can forbid it, which also turns it off.
 */
export interface DeveloperModeSetting {
  enabled(): boolean;
  set(enabled: boolean): void;
  /** False when policy forbids developer mode on this device or account. */
  allowed(): boolean;
}

const KEY = 'pushform:extensions:developer-mode';

export function storedDeveloperMode(storage: Pick<Storage, 'getItem' | 'setItem'>, allowed: () => boolean = () => true): DeveloperModeSetting {
  return {
    enabled: () => allowed() && storage.getItem(KEY) === 'on',
    set: (enabled) => storage.setItem(KEY, enabled && allowed() ? 'on' : 'off'),
    allowed,
  };
}

export function memoryDeveloperMode(initial = false, allowed = true): DeveloperModeSetting {
  let on = initial;
  return { enabled: () => allowed && on, set: (enabled) => { on = enabled; }, allowed: () => allowed };
}
