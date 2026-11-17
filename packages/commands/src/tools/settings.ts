// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { VcbValue } from '../vcb/parse';
import type { ToolSetting, ToolSettingKey, ToolSettingValue } from './Tool';

/** A whole-number setting such as sides or segments. */
export function countSetting(id: string, label: string, value: number): ToolSetting {
  return { kind: 'quantity', id, label, value: String(value), quantity: 'count' };
}

/** An on/off mode toggle, labelled with the modifier tap that toggles it. */
export function toggleSetting(id: string, label: string, on: boolean, key?: ToolSettingKey): ToolSetting {
  return { kind: 'toggle', id, label, on, ...(key ? { key } : {}) };
}

/** The count a bar field sent: a typed whole number (`8`, or `8s`). */
export function countFrom(value: ToolSettingValue): number | null {
  if (!isVcb(value)) return null;
  if (value.kind === 'segments') return value.count;
  return null;
}

/** The length (meters) a bar field sent. */
export function lengthFrom(value: ToolSettingValue): number | null {
  if (!isVcb(value)) return null;
  return value.kind === 'length' || value.kind === 'radius' ? value.meters : null;
}

/** The angle (degrees) a bar field sent. */
export function degreesFrom(value: ToolSettingValue): number | null {
  if (!isVcb(value)) return null;
  return value.kind === 'angle' || value.kind === 'slope' ? value.degrees : null;
}

function isVcb(value: ToolSettingValue): value is VcbValue {
  return typeof value === 'object' && value !== null && 'kind' in value;
}
