// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { m4invert, newGuid, PushFormError, type MMat4 } from '@pushform/core';
import type { DocumentState, PluginEntry } from '@pushform/model';
import { defineCommand } from '../registry/Command';
import { hostOf } from '../host/services';
import type { DocumentHost } from '../host/DocumentHost';
import { captureContainerOccurrence, isolateContainerOccurrence } from './groups';
import { pasteModelClipboard, type ModelClipboard, type ModelPasteIdentity } from './clipboard';
import type { PhysicalCopyResult, PhysicalCopySize } from './physicalCopy';

/** Trusted native input, never accepted as a runtime message or persisted handle. */
export interface NativePhysicalPlacement { readonly identity: object; readonly clipboard: ModelClipboard; readonly size: PhysicalCopySize }
type SharedEntries = Map<string, { dataVersion: number; entries: Map<string, PluginEntry> }>;
type Reuse = { identity: ModelPasteIdentity; records: { store: 'definitions' | 'materials' | 'images' | 'tags'; id: number; value: unknown }[]; shared: Set<number>; entries: SharedEntries };
const reusedImports = new WeakMap<object, WeakMap<DocumentHost, Reuse>>();
function sharedEntries(state: DocumentState, shared: ReadonlySet<number>): SharedEntries {
  const found: SharedEntries = new Map();
  for (const [owner, record] of state.pluginData ?? []) {
    const entries = new Map([...record.entries].filter(([, entry]) => entry.target.kind !== 'document' && entry.target.kind !== 'bodyOccurrence' && shared.has(entry.target.id)));
    if (entries.size) found.set(owner, { dataVersion: record.dataVersion, entries });
  }
  return found;
}
function reusable(host: DocumentHost, placement: NativePhysicalPlacement): Reuse | undefined {
  const receipt = reusedImports.get(placement.identity)?.get(host); if (!receipt) return undefined;
  const state = host.doc.state;
  if (receipt.records.some(row => (state[row.store] as ReadonlyMap<number, unknown>).get(row.id) !== row.value)) return undefined;
  const entries = sharedEntries(state, receipt.shared);
  if (entries.size !== receipt.entries.size) return undefined;
  for (const [owner, old] of receipt.entries) {
    const current = entries.get(owner);
    if (!current || current.dataVersion !== old.dataVersion || current.entries.size !== old.entries.size || [...old.entries].some(([id, entry]) => current.entries.get(id) !== entry)) return undefined;
  }
  return receipt;
}
function remember(host: DocumentHost, placement: NativePhysicalPlacement, identity: ModelPasteIdentity): void {
  const state = host.doc.state, records: Reuse['records'] = [], shared = new Set<number>();
  for (const [store, ids] of [['definitions', identity.definitions], ['materials', identity.materials], ['images', identity.images], ['tags', identity.tags]] as const)
    for (const id of new Set<number>(ids.values())) { const value = (state[store] as ReadonlyMap<number, unknown>).get(id); if (value) records.push({ store, id, value }); }
  for (const id of identity.definitions.values()) {
    shared.add(id); const def = state.definitions.get(id)!;
    for (const key of def.entities.bodies.keys()) shared.add(key);
    for (const key of def.entities.instances.keys()) shared.add(key);
  }
  for (const id of identity.materials.values()) shared.add(id);
  let documents = reusedImports.get(placement.identity);
  if (!documents) { documents = new WeakMap(); reusedImports.set(placement.identity, documents); }
  documents.set(host, { identity, records, shared, entries: sharedEntries(state, shared) });
}
type Prepared = { host: DocumentHost; placement: NativePhysicalPlacement; independent: boolean; completed?: ModelPasteIdentity };
const prepared = new Map<string, Prepared>();

/** One-use command receipt. The host owns its lifetime even when validation or a later operation fails. */
export function prepareNativePlacement(host: DocumentHost, placement: NativePhysicalPlacement, independent: boolean): { token: string; committed(): void; dispose(): void } {
  const token = crypto.randomUUID();
  const receipt: Prepared = { host, placement, independent };
  prepared.set(token, receipt);
  return { token, committed: () => { if (receipt.completed) remember(host, placement, receipt.completed); }, dispose: () => { prepared.delete(token); delete receipt.completed; } };
}

export const placeNativeFragment = defineCommand({
  id: 'part.placeNative', title: 'Place Native Module', category: 'internal', undoable: true,
  params: z.object({ prepared: z.string().refine(token => prepared.has(token), 'This native placement was not prepared by the host'),
    container: z.array(z.number().int().nonnegative()).max(64), worldMatrix: z.array(z.number().finite()).length(16) }),
  run(ctx, params): PhysicalCopyResult {
    const receipt = prepared.get(params.prepared)!; prepared.delete(params.prepared);
    const host = hostOf(ctx), matrix = params.worldMatrix as MMat4;
    if (receipt.host !== host) throw new PushFormError('part.target', 'This native placement belongs to another document.');
    if (matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1 || !m4invert(matrix)?.every(Number.isFinite))
      throw new PushFormError('part.matrix', 'Choose an invertible affine world transform.');
    captureContainerOccurrence(host, params.container, true);
    const source = receipt.placement.clipboard;
    const root = source.state.definitions.get(source.state.rootDefinitionId)!.entities.instances.values().next().value;
    const component = root && !source.state.definitions.get(root.definitionId)!.isGroup;
    const reuse = !receipt.independent && component ? reusable(host, receipt.placement) : undefined;
    // Change definition identity only in this owned copy of the snapshot's definition headers.
    const clipboard: ModelClipboard = { ...source, state: { ...source.state, definitions: new Map([...source.state.definitions].map(([id, def]) =>
      [id, id !== source.state.rootDefinitionId && (receipt.independent || def.isGroup) ? { ...def, guid: newGuid() } : def])) } };
    let identity: ModelPasteIdentity | undefined;
    const result = host.edit('Place Native Module', draft => {
      const isolated = isolateContainerOccurrence(draft, params.container);
      const refs = pasteModelClipboard(draft, clipboard, isolated.path, matrix, host.images, { ...(reuse ? { reuse: reuse.identity } : {}), captured: value => { identity = value; } }), ref = refs[0];
      if (refs.length !== 1 || ref?.kind !== 'instance') throw new PushFormError('part.target', 'The native module must have one complete assembly root.');
      return { ref, changes: isolated.changes, size: receipt.placement.size };
    });
    if (!receipt.independent && component && identity) receipt.completed = identity;
    return result;
  },
});
