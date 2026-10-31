// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors

const KEY = 'pushform:navigationCube';

/** Whether the navigation cube is shown: a per-browser preference, shown until hidden. */
export function readNavigationCubePreference(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'hidden';
  } catch {
    return true;
  }
}

export function writeNavigationCubePreference(visible: boolean): void {
  try {
    if (visible) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, 'hidden');
  } catch {
    /* Optional preference. */
  }
}
