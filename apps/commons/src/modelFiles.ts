// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { CommonsFile } from '@pushform/cloud';

const formats = ['pf', 'step', 'stp', 'stl', 'glb', 'gltf', 'obj', 'dae', '3ds', 'skp', 'skb', 'dxf', 'kmz', 'zip', 'fcstd'];
/** Keep native and commonly exchanged models ahead of archives and authoring sources. */
export function sortedModelFiles(files: readonly CommonsFile[]): CommonsFile[] {
  const rank = (name: string) => { const index = formats.indexOf(name.split('.').at(-1)?.toLowerCase() ?? ''); return index < 0 ? formats.length : index; };
  return [...files].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}
