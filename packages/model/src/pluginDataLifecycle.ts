// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { produceWithPatches, type Patch } from 'immer';
import { newGuid, type Id } from '@pushform/core';
import type { DocumentDraft } from './Document';
import type { DocumentState } from './entities/document';
import type { Body, EdgeKey } from './entities/body';
import type { FaceLocalId } from '@pushform/core';
import { continueTopologyElement, type TopologyElement } from './body/TopologyReferences';
import { PluginDataError, type PluginData, type PluginTarget } from './pluginData';

export const pluginTargetKey = (target: PluginTarget): string => target.kind === 'document' ? 'document' : `${target.kind}:${target.id}:${target.kind === 'bodyOccurrence' ? target.path.join('/') : ''}`;
export type PluginTargetMap = (target: PluginTarget) => PluginTarget | undefined;
export type PluginEntryCopies = Map<string, Map<string, string>>;

/** Index shared identities once; occurrence paths are checked without enumerating every placement. */
export function pluginTargetResolver(state: DocumentState): (target: PluginTarget) => boolean {
  const bodies = new Set<number>(), instances = new Set<number>(), groups = new Set<number>();
  for (const def of state.definitions.values()) {
    for (const id of def.entities.bodies.keys()) bodies.add(id);
    for (const inst of def.entities.instances.values()) {
      instances.add(inst.id);
      if (state.definitions.get(inst.definitionId)?.isGroup) groups.add(inst.id);
    }
  }
  return target => {
    if (target.kind === 'document') return true;
    if (target.kind === 'material') return state.materials.has(target.id as never);
    if (target.kind === 'definition') return state.definitions.has(target.id as never);
    if (target.kind === 'body') return bodies.has(target.id);
    if (target.kind === 'group') return groups.has(target.id);
    if (target.kind === 'instance') return instances.has(target.id);
    if (target.kind !== 'bodyOccurrence') return false;
    let def = state.definitions.get(state.rootDefinitionId);
    for (const id of target.path) {
      const inst = def?.entities.instances.get(id as Id);
      def = inst ? state.definitions.get(inst.definitionId) : undefined;
      if (!def) return false;
    }
    return !!def?.entities.bodies.has(target.id as Id);
  };
}

/** Body lookup for reference validation, without expanding every occurrence. */
export function pluginBodyResolver(state: DocumentState): (target: PluginTarget) => Body | undefined {
  let bodies: Map<number, Body> | undefined;
  return target => {
    if (target.kind === 'body') {
      if (!bodies) { bodies = new Map(); for (const def of state.definitions.values()) for (const body of def.entities.bodies.values()) bodies.set(body.id, body); }
      return bodies.get(target.id);
    }
    if (target.kind !== 'bodyOccurrence') return undefined;
    let def = state.definitions.get(state.rootDefinitionId);
    for (const id of target.path) { const instance = def?.entities.instances.get(id as Id); def = instance ? state.definitions.get(instance.definitionId) : undefined; }
    return def?.entities.bodies.get(target.id as Id);
  };
}
export function pluginElementExists(body: Body | undefined, element: TopologyElement): boolean {
  return !!body && body.version === element.bodyVersion && (element.kind === 'face' ? body.faces.has(element.faceId as FaceLocalId) : body.edges.has(element.edgeKey as EdgeKey));
}

/** Copy opaque attachments, with one map for the complete operation so internal links stay internal. */
export function copyPluginEntries(draft: DocumentDraft, map: PluginTargetMap, source: PluginData | undefined = draft.pluginData, external = false): PluginEntryCopies {
  const copied: PluginEntryCopies = new Map();
  const bodyOf = pluginBodyResolver(draft as unknown as DocumentState);
  if (!source?.size) return copied;
  for (const [owner, record] of [...source]) {
    const copies = [...record.entries].flatMap(([id, entry]) => {
      const target = map(entry.target);
      return target ? [{ id, entry, target, copyId: `copy:${newGuid()}` }] : [];
    });
    if (!copies.length) continue;
    draft.pluginData ??= new Map();
    let destination = draft.pluginData.get(owner);
    if (destination && destination.dataVersion !== record.dataVersion) throw new PluginDataError('version.unsupported', 'Pasted extension data uses a different version. Migrate the documents before combining it.');
    if (!destination) { destination = { dataVersion: record.dataVersion, entries: new Map() }; draft.pluginData.set(owner, destination); }
    const ids = new Map(copies.map(copy => [copy.id, copy.copyId]));
    copied.set(owner, ids);
    for (const copy of copies) {
      const references = copy.entry.references.map(ref => {
        const target = map(ref.target);
        const entryId = ref.entryId === undefined ? undefined : ids.get(ref.entryId);
        const body = !ref.unresolved && ref.element && target && bodyOf(target), element = body && ref.element && continueTopologyElement(body, ref.element, external || !!target && 'id' in target && 'id' in ref.target && target.id !== ref.target.id);
        return { ...ref, target: target ?? ref.target, ...(element ? { element } : {}),
          ...(ref.element && target && !element ? { unresolved: true } : {}), ...(entryId !== undefined ? { entryId } : {}),
          ...(external && (!target || ref.entryId !== undefined && entryId === undefined) ? { unresolved: true } : {}) };
      });
      destination.entries.set(copy.copyId, { ...copy.entry, target: copy.target, references, payload: new Uint8Array(copy.entry.payload) });
    }
  }
  return copied;
}

/** Move attachments and declared references without interpreting arbitrary JSON strings. */
export function movePluginTargets(draft: DocumentDraft, map: PluginTargetMap, options?: { referencesForMoved: PluginTargetMap; copiedEntries: PluginEntryCopies }): void {
  const bodyOf = pluginBodyResolver(draft as unknown as DocumentState);
  for (const [owner, record] of draft.pluginData ?? []) for (const entry of record.entries.values()) {
    const target = map(entry.target);
    if (target) entry.target = target;
    for (const ref of entry.references) {
      const shared = target ? options?.referencesForMoved(ref.target) : undefined;
      const mapped = shared ?? map(ref.target);
      if (mapped) {
        if (!ref.unresolved && ref.element && (mapped.kind === 'body' || mapped.kind === 'bodyOccurrence') && mapped.id !== ('id' in ref.target ? ref.target.id : undefined)) {
          const body = bodyOf(mapped), element = body && continueTopologyElement(body, ref.element, true);
          if (element) ref.element = element; else ref.unresolved = true;
        }
        ref.target = mapped;
        const copiedId = ref.entryId === undefined ? undefined : options?.copiedEntries.get(owner)?.get(ref.entryId);
        if (shared && copiedId) ref.entryId = copiedId;
      }
    }
  }
}

/** Ambiguous edits preserve the old attachment rather than inventing an owner among the outputs. */
export function reviewPluginTargets(draft: DocumentDraft, affected: (target: PluginTarget) => boolean): void {
  for (const record of draft.pluginData?.values() ?? []) for (const entry of record.entries.values()) {
    if (affected(entry.target)) entry.needsReview = true;
    for (const ref of entry.references) if (affected(ref.target)) ref.unresolved = true;
  }
}

export function reviewPluginBodies(draft: DocumentDraft, ids: ReadonlySet<number>): void {
  if (ids.size) reviewPluginTargets(draft, target => (target.kind === 'body' || target.kind === 'bodyOccurrence') && ids.has(target.id));
}

/** Typed identity mapping for copied shared entities and nested occurrences. */
export function pluginIdentityMap(ids: ReadonlyMap<number, number>): PluginTargetMap {
  return target => {
    if (target.kind === 'document') return undefined;
    if (target.kind === 'bodyOccurrence') {
      if (!ids.has(target.id) && !target.path.some(id => ids.has(id))) return undefined;
      return { ...target, id: ids.get(target.id) ?? target.id, path: target.path.map(id => ids.get(id) ?? id) };
    }
    const id = ids.get(target.id);
    return id === undefined ? undefined : { ...target, id };
  };
}

/** Deletion reconciliation is patch-gated and joins the model command's undo entry. */
export function reconcilePluginTargets(before: DocumentState, state: DocumentState, patches: readonly Patch[]): [DocumentState, Patch[], Patch[]] | null {
  if (!state.pluginData?.size || !patches.some(({ path }) => path[0] === 'materials' && path.length <= 2 || path[0] === 'definitions' && (path.length <= 3 || path[2] === 'entities' && (path.length <= 4 || (path[3] === 'bodies' || path[3] === 'instances' && (path.length <= 5 || path[5] === 'definitionId')))))) return null;
  const existed = pluginTargetResolver(before), exists = pluginTargetResolver(state);
  const bodyOf = pluginBodyResolver(state);
  const deletions: [string, string][] = [], invalid: [string, string, number][] = [], mapped: [string, string, number, TopologyElement][] = [];
  for (const [owner, record] of state.pluginData) {
    const removed = new Set<string>();
    for (const [id, entry] of record.entries) if (!entry.needsReview && existed(entry.target) && !exists(entry.target)) { removed.add(id); deletions.push([owner, id]); }
    for (const [id, entry] of record.entries) if (!removed.has(id)) entry.references.forEach((ref, index) => {
      if (ref.element && !ref.unresolved) {
        const body = bodyOf(ref.target), element = body && continueTopologyElement(body, ref.element);
        if (!element) invalid.push([owner, id, index]);
        else if (JSON.stringify(element) !== JSON.stringify(ref.element)) mapped.push([owner, id, index, element]);
      }
      const linked = ref.entryId === undefined ? undefined : record.entries.get(ref.entryId);
      if (!ref.unresolved && (!exists(ref.target) || ref.entryId !== undefined && (!linked || removed.has(ref.entryId) || linked.needsReview || pluginTargetKey(linked.target) !== pluginTargetKey(ref.target)))) invalid.push([owner, id, index]);
    });
  }
  if (!deletions.length && !invalid.length && !mapped.length) return null;
  const [next, forward, inverse] = produceWithPatches(state, draft => {
    for (const [owner, id] of deletions) draft.pluginData!.get(owner)!.entries.delete(id);
    for (const [owner, id, index, element] of mapped) draft.pluginData!.get(owner)!.entries.get(id)!.references[index]!.element = element;
    for (const [owner, id, index] of invalid) draft.pluginData!.get(owner)!.entries.get(id)!.references[index]!.unresolved = true;
  });
  return [next, forward, inverse];
}
