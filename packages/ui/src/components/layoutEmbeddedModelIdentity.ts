// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { DocumentState } from '@pushform/model';

/**
 * An embedded SKP is immutable. Its generated native IDs are meaningful only for this exact conversion,
 * not as SketchUp persistent IDs. Detect importer changes before a saved annotation can reuse an ID
 * for another vertex. Native cloud models instead retain their own GUID and IDs across revisions.
 */
export async function layoutEmbeddedModelIdentity(state: DocumentState, bytes: Uint8Array): Promise<string> {
  const sorted = <T>(values: ReadonlyMap<number, T>): [number, T][] => [...values].sort(([a], [b]) => a - b);
  const mapping = [state.rootDefinitionId, sorted(state.definitions).map(([id, definition]) => {
    const entities = definition.entities;
    return [id,
      sorted(entities.sketch.vertices).map(([vertexId, vertex]) => [vertexId, vertex.p]),
      sorted(entities.bodies).map(([bodyId, body]) => [bodyId, sorted(body.faces).map(([faceId, face]) => [faceId, face.loops])]),
      sorted(entities.instances).map(([instanceId, instance]) => [instanceId, instance.definitionId, instance.transform]),
    ];
  })];
  const digest = async (data: Uint8Array): Promise<string> => {
    const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(data).buffer);
    return [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
  };
  const [source, native] = await Promise.all([digest(bytes), digest(new TextEncoder().encode(JSON.stringify(mapping)))]);
  return `${source}:${native}`;
}
