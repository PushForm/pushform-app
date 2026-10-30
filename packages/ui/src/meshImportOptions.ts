// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { DEFAULT_MESH_OPTIONS, MESH_FORMATS_WITH_UP_AXIS, MESH_UNITS, type MeshFormatKind, type MeshImportOptions } from '@pushform/io';

const KEY = 'pushform.meshImportOptions';

/** The last OBJ, 3DS, STL or DXF import options chosen in this browser, or the format's defaults. */
export function rememberedMeshOptions(kind: MeshFormatKind): MeshImportOptions {
  try {
    const stored = (JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Record<MeshFormatKind, Partial<MeshImportOptions>>>)[kind];
    const unit = MESH_UNITS.some(u => u.unit === stored?.unit) ? stored!.unit! : DEFAULT_MESH_OPTIONS[kind].unit;
    const up = MESH_FORMATS_WITH_UP_AXIS.includes(kind) && (stored?.up === 'y' || stored?.up === 'z') ? stored.up : DEFAULT_MESH_OPTIONS[kind].up;
    return { unit, up };
  } catch {
    return { ...DEFAULT_MESH_OPTIONS[kind] };
  }
}

export function rememberMeshOptions(kind: MeshFormatKind, options: MeshImportOptions): void {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    localStorage.setItem(KEY, JSON.stringify({ ...all, [kind]: options }));
  } catch {
    // Without storage the choice lasts only for this import.
  }
}
