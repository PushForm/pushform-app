// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { SceneId } from '@pushform/core';
import type { DocumentState } from './entities/document';

/** Remove deleted scene/override metadata in the same transaction as its owner. */
export function reconcileNativeSceneFields(state: DocumentState): void {
  const fields = state.nativeSceneUnknownFields;
  if (!fields) return;
  for (const [id, extra] of fields) {
    const scene = state.scenes.get(id as SceneId);
    if (!scene) { fields.delete(id); continue; }
    const ext = extra.extensions;
    if (ext) {
      if (scene.styleId !== null) ext.records.delete('styleId.null');
      if (scene.shadows === null) delete ext.shadows;
      else ext.records.delete('shadows.null');
      if (!Object.hasOwn(scene, 'fog')) ext.records.delete('fog');
      if (scene.fog !== null) ext.records.delete('fog.null');
      if (!Object.hasOwn(scene, 'fog') || scene.fog !== undefined) ext.records.delete('fog.undefined');
      if (scene.fog == null) delete ext.fog;
      if (!Object.hasOwn(scene, 'includeInAnimation')) ext.records.delete('animation');
      if (!Object.hasOwn(scene, 'includeInAnimation') || scene.includeInAnimation !== undefined) ext.records.delete('animation.undefined');
      if (!ext.records.size && !ext.camera.size && !ext.shadows?.size && !ext.fog?.size) delete extra.extensions;
    }
    if (extra.required !== false && !extra.envelopeUnknown?.length && !extra.extensions) fields.delete(id);
  }
  if (!fields.size) delete state.nativeSceneUnknownFields;
}
