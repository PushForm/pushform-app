// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { formatLength, type Vec3 } from '@pushform/core';
import { definitionAt, instanceAt, type DocumentState } from '@pushform/model';
import type { LayoutModelAttachment } from './modelAttachments';
import type { LayoutEntity } from './LayoutDocument';

/** Auto-Text fields supported by a native vertex attachment. */
export function layoutModelLabelFields(attachment: LayoutModelAttachment, view: LayoutEntity,
  model: DocumentState, point: Vec3): Record<string, string> {
  const fields: Record<string, string> = {};
  const viewport = view.image!.viewport!;
  fields.SceneName = viewport.scene ?? 'Last saved view';
  if (viewport.camera.projection === 'parallel') {
    const scale = viewport.camera.scale;
    fields.Ratio = scale <= 1 ? `1:${Number((1 / scale).toPrecision(12))}` : `${Number(scale.toPrecision(12))}:1`;
  }
  const axes = ['x', 'y', 'z'];
  for (let mask = 1; mask < 8; mask++) {
    const selected = axes.filter((_, index) => mask & (1 << index));
    fields[`Coordinates(${selected.join(',')})`] = point.filter((_, index) => mask & (1 << index))
      .map(value => formatLength(value, model.meta.units)).join(', ');
  }
  fields.Coordinates = fields['Coordinates(x,y,z)']!;
  const instance = instanceAt(model, attachment.anchor.path);
  if (!instance) return fields;
  const definition = definitionAt(model, attachment.anchor.path);
  fields.ComponentInstance = instance.name;
  fields.ComponentDefinition = definition.name;
  fields.ComponentDescription = definition.description;
  if (definition.isGroup) fields.GroupName = instance.name || definition.name;
  for (const [key, value] of Object.entries(instance.attributes.dynamic_attributes ?? {})) {
    if (key.startsWith('_') || /[<>\r\n()]/.test(key) || !['string', 'number', 'boolean'].includes(typeof value)) continue;
    const display = String(value);
    fields[`DynamicComponent(${key})`] = display;
    // Direct custom names are supported; built-in names retain their own meaning.
    if (!Object.hasOwn(fields, key)) Object.defineProperty(fields, key, { value: display, enumerable: true, configurable: true });
  }
  return fields;
}
