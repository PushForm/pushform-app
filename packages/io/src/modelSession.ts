// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { FORMAT_VERSION, type DocumentState } from '@pushform/model';

/**
 * Tagged JSON form of model state, shared by the browser refresh snapshot and the .pf manifest:
 * Maps become `{ $map: entries }` and typed arrays `{ $float64 | $uint32 | $uint8: numbers }`.
 */
export function modelSessionJson(state: DocumentState): string {
  return JSON.stringify(state, (_key, value: unknown) => {
    if (value instanceof Map) return { $map: [...value.entries()] };
    if (value instanceof Float64Array) return { $float64: [...value] };
    if (value instanceof Uint32Array) return { $uint32: [...value] };
    if (value instanceof Uint8Array) return { $uint8: [...value] };
    return value;
  });
}

const TYPED_TAGS = [
  ['$float64', Float64Array],
  ['$uint32', Uint32Array],
  ['$uint8', Uint8Array],
] as const;

/** Revive one node whose children are already revived. */
function reviveTagged(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const tagged = value as Record<string, unknown>;
  if ('$map' in tagged) {
    if (!Array.isArray(tagged.$map)) throw new Error('Invalid model map');
    return new Map(tagged.$map as [unknown, unknown][]);
  }
  for (const [tag, Type] of TYPED_TAGS) {
    if (tag in tagged) {
      if (!Array.isArray(tagged[tag])) throw new Error('Invalid model array');
      return new Type(tagged[tag] as number[]);
    }
  }
  return value;
}

/** Revive tags throughout an already-parsed JSON value, bottom-up like a `JSON.parse` reviver. */
function reviveDeep(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = reviveDeep(value[i]);
    return value;
  }
  const record = value as Record<string, unknown>;
  // Typed-array payloads are plain numbers; the constructor coerces them without a walk.
  for (const [tag] of TYPED_TAGS) if (tag in record && Array.isArray(record[tag])) return reviveTagged(record);
  for (const key of Object.keys(record)) record[key] = reviveDeep(record[key]);
  return reviveTagged(record);
}

/**
 * Build model state from parsed tagged JSON (see `modelSessionJson`) without re-serializing it.
 * The .pf reader hydrates its migrated manifest this way; `decodeModelSessionJson` revives while
 * parsing. Both end in `validateModelState`.
 */
export function hydrateModelState(parsed: unknown): DocumentState {
  return validateModelState(reviveDeep(parsed));
}

export function decodeModelSessionJson(json: string): DocumentState {
  return validateModelState(JSON.parse(json, (_key, value: unknown) => reviveTagged(value)));
}

/** Structural check of revived state: Maps and typed arrays where the document expects them. */
export function validateModelState(state: unknown): DocumentState {
  if (!state || typeof state !== 'object') throw new Error('Invalid model snapshot');
  const doc = state as Partial<DocumentState>;
  if (!doc.meta || typeof doc.meta.guid !== 'string' ||
      doc.meta.formatVersion !== FORMAT_VERSION || !Number.isSafeInteger(doc.meta.nextId) ||
      !(doc.definitions instanceof Map) || typeof doc.rootDefinitionId !== 'number' ||
      !doc.definitions.has(doc.rootDefinitionId) ||
      !(doc.tags instanceof Map) || !(doc.tagFolders instanceof Map) ||
      !(doc.materials instanceof Map) || !(doc.images instanceof Map) ||
      !(doc.styles instanceof Map) || !(doc.scenes instanceof Map) ||
      !Array.isArray(doc.sceneOrder)) throw new Error('Invalid model snapshot');
  for (const definition of doc.definitions.values()) {
    const entities = definition?.entities;
    // Snapshots saved before mesh parts existed have no map; they hold none.
    if (entities && !('meshParts' in entities)) (entities as { meshParts?: Map<unknown, unknown> }).meshParts = new Map();
    if (!entities || !(entities.bodies instanceof Map) || !(entities.meshParts instanceof Map) ||
        !(entities.sketch?.vertices instanceof Map) ||
        !(entities.sketch.edges instanceof Map) ||
        !(entities.sketch.faces instanceof Map) ||
        !(entities.instances instanceof Map) || !(entities.images instanceof Map) || !Array.isArray(entities.order))
      throw new Error('Invalid model snapshot');
    for (const body of entities.bodies.values()) {
      const mesh = body?.mesh;
      if (!mesh || !(mesh.verts instanceof Float64Array) ||
          !(mesh.tris instanceof Uint32Array) ||
          !(mesh.faceId instanceof Uint32Array) ||
          mesh.verts.length % 3 !== 0 || mesh.tris.length % 3 !== 0 ||
          mesh.faceId.length !== mesh.tris.length / 3 ||
          !(body.faces instanceof Map) || !(body.edges instanceof Map))
        throw new Error('Invalid model snapshot');
    }
    for (const part of entities.meshParts.values()) {
      const g = part?.geometry;
      if (!g || !(g.positions instanceof Float64Array) || !(g.triangles instanceof Uint32Array) || !(g.triangleFace instanceof Uint32Array) ||
          !(g.faceMaterials instanceof Uint32Array) || !(g.edgeOffsets instanceof Uint32Array) || !(g.edgePositions instanceof Float64Array) ||
          !(g.edgeFlags instanceof Uint8Array) || typeof part.name !== 'string' || typeof part.source?.format !== 'string')
        throw new Error('Invalid model snapshot');
    }
  }
  return doc as DocumentState;
}
