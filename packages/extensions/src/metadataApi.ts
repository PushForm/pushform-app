// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { hostOf, type CommandRegistry, type DocumentHost } from '@pushform/commands';
import { pluginBodyResolver, pluginElementExists, pluginTargetResolver, pluginTargetKey, PluginDataError, preparePluginEntry, readPluginValue, type PluginDataRecord, type PluginEntry, type PluginTarget, type Body } from '@pushform/model';
import { ExtensionError, metadataValueMatches, type ExtensionManifest, type MetadataApplyResult, type MetadataEntryInfo, type MetadataListResult, type MetadataReadResult, type metadataApplySchema, type metadataListSchema, type metadataReadSchema } from '@pushform/extension-protocol';

const COMMAND = 'internal.pluginMetadata.apply';
interface Commit { host: DocumentHost; revision: number; owner: string; record: PluginDataRecord }
const prepared = new Map<string, Commit>();
const stale = (): never => { throw new ExtensionError('revision.stale', 'The document or metadata changed. Read it again before applying the edit.'); };
function installCommand(commands: CommandRegistry): void {
  if (commands.has(COMMAND)) return;
  commands.register({ id: COMMAND, title: 'Edit extension properties', category: 'internal', undoable: true,
    params: z.string().refine(token => prepared.has(token), 'This metadata commit was not prepared by the host'),
    run(ctx, token) {
      const input = prepared.get(token)!;
      prepared.delete(token);
      const host = hostOf(ctx);
      if (host !== input.host || host.doc.version !== input.revision) return stale();
      host.edit('Edit extension properties', draft => { draft.pluginData ??= new Map(); draft.pluginData.set(input.owner, input.record); });
    },
  });
}
function bounded<T>(value: T): T {
  if (JSON.stringify(value).length * 2 > 1024 * 1024) throw new ExtensionError('limit.exceeded', 'This metadata page is too large. Request fewer entries.');
  return value;
}
/** Host-only access, bound to one model. The runtime never chooses an owner or validator. */
export class ModelMetadataApi {
  private readonly host: DocumentHost;
  constructor(private readonly commands: CommandRegistry) { this.host = hostOf(commands.ctx); installCommand(commands); }
  private declaration(manifest: ExtensionManifest) {
    if (!manifest.metadata) throw new ExtensionError('extension.unsupported', 'Declare a metadata schema in the extension manifest first.');
    return manifest.metadata;
  }
  private record(manifest: ExtensionManifest, expectedRevision?: number) {
    this.declaration(manifest);
    if (expectedRevision !== undefined && this.host.doc.version !== expectedRevision) stale();
    return this.host.doc.state.pluginData?.get(manifest.id);
  }
  /** Trusted current header after native model operations inside an already validated batch. */
  dataVersion(manifest: ExtensionManifest): number | null { return this.record(manifest)?.dataVersion ?? null; }
  private info(id: string, entry: PluginEntry, record: PluginDataRecord, exists: (target: PluginTarget) => boolean, bodyOf: (target: PluginTarget) => Body | undefined): MetadataEntryInfo {
    return { id, target: structuredClone(entry.target), references: structuredClone(entry.references), needsReview: !!entry.needsReview || !exists(entry.target) || entry.references.some(ref => ref.unresolved || !exists(ref.target) || ref.element !== undefined && !pluginElementExists(bodyOf(ref.target), ref.element) || ref.entryId !== undefined && (!record.entries.has(ref.entryId) || !!record.entries.get(ref.entryId)!.needsReview || pluginTargetKey(record.entries.get(ref.entryId)!.target) !== pluginTargetKey(ref.target))) };
  }
  list(manifest: ExtensionManifest, input: z.infer<typeof metadataListSchema>): MetadataListResult {
    const declaration = this.declaration(manifest), record = this.record(manifest, input.expectedRevision);
    const exists = pluginTargetResolver(this.host.doc.state), bodyOf = pluginBodyResolver(this.host.doc.state);
    const targets = input.targets ? new Set(input.targets.map(pluginTargetKey)) : null;
    const entries = [...(record?.entries ?? [])].filter(([, entry]) => !targets || targets.has(pluginTargetKey(entry.target)));
    return bounded({ revision: this.host.doc.version, dataVersion: record?.dataVersion ?? null, supportedDataVersion: declaration.dataVersion,
      writable: !record || record.dataVersion <= declaration.dataVersion,
      entries: entries.slice(input.offset, input.offset + input.limit).map(([id, entry]) => this.info(id, entry, record!, exists, bodyOf)),
      next: entries.length > input.offset + input.limit ? input.offset + input.limit : null });
  }
  read(manifest: ExtensionManifest, input: z.infer<typeof metadataReadSchema>): MetadataReadResult {
    const declaration = this.declaration(manifest), record = this.record(manifest, input.expectedRevision);
    if (record && record.dataVersion > declaration.dataVersion) throw new ExtensionError('extension.unsupported', 'This document contains newer plugin data. Update the plugin to read it.');
    const exists = pluginTargetResolver(this.host.doc.state), bodyOf = pluginBodyResolver(this.host.doc.state);
    const entries: MetadataReadResult['entries'] = [], missing: string[] = [];
    for (const id of new Set(input.ids)) {
      const entry = record?.entries.get(id);
      if (!entry || !record) missing.push(id);
      else {
        try { entries.push({ ...this.info(id, entry, record, exists, bodyOf), value: readPluginValue(record, id, declaration.dataVersion) }); }
        catch { throw new ExtensionError('validation.failed', 'This stored plugin entry cannot be decoded. Its bytes have been retained.'); }
      }
    }
    return bounded({ revision: this.host.doc.version, dataVersion: record?.dataVersion ?? null, entries, missing });
  }
  assertWritable(manifest: ExtensionManifest, expectedRevision: number, expectedDataVersion: number | null, replaceRecord = false, upgradeCompatible = false): void {
    const declaration = this.declaration(manifest), old = this.record(manifest, expectedRevision);
    if ((old?.dataVersion ?? null) !== expectedDataVersion) stale();
    if (old && old.dataVersion > declaration.dataVersion) throw new ExtensionError('extension.unsupported', 'Newer plugin data is read-only.');
    if (old && old.dataVersion !== declaration.dataVersion && !replaceRecord && !upgradeCompatible)
      throw new ExtensionError('validation.failed', 'Migrate the complete record explicitly before editing its new schema.');
    if (old && upgradeCompatible && !replaceRecord) {
      try {
        for (const id of old.entries.keys()) if (!metadataValueMatches(declaration.schema, readPluginValue(old, id, declaration.dataVersion)))
          throw new Error('incompatible');
      } catch { throw new ExtensionError('validation.failed', 'The saved properties need an explicit migration. Their original bytes have been retained.'); }
    }
  }
  /** Host-only batch preparation, so native imports can merge with the upgraded namespace atomically. */
  upgradeCompatible(manifest: ExtensionManifest, expectedRevision: number, expectedDataVersion: number | null): boolean {
    this.assertWritable(manifest, expectedRevision, expectedDataVersion, false, true);
    const old = this.record(manifest, expectedRevision), declaration = this.declaration(manifest);
    if (!old || old.dataVersion === declaration.dataVersion) return false;
    const token = crypto.randomUUID();
    prepared.set(token, { host: this.host, revision: expectedRevision, owner: manifest.id, record: { dataVersion: declaration.dataVersion, entries: new Map(old.entries) } });
    try { this.commands.execute(COMMAND, token); } finally { prepared.delete(token); }
    return true;
  }
  apply(manifest: ExtensionManifest, input: z.infer<typeof metadataApplySchema>, signal?: AbortSignal, allowedTargets?: readonly PluginTarget[]): MetadataApplyResult {
    signal?.throwIfAborted();
    const declaration = this.declaration(manifest), old = this.record(manifest, input.expectedRevision);
    if (allowedTargets) {
      const allowed = new Set(allowedTargets.map(pluginTargetKey));
      if (input.replaceRecord || input.upserts.some(entry => {
        const previous = old?.entries.get(entry.id);
        return !allowed.has(pluginTargetKey(entry.target)) || previous !== undefined && !allowed.has(pluginTargetKey(previous.target));
      }) || input.deletes.some(id => { const entry = old?.entries.get(id); return !entry || !allowed.has(pluginTargetKey(entry.target)); })) throw new ExtensionError('permission.denied', 'This inspector edit includes a target outside its captured scope.');
    }
    this.assertWritable(manifest, input.expectedRevision, input.expectedDataVersion, input.replaceRecord, input.upgradeCompatible);
    const upgrading = !!input.upgradeCompatible && !input.replaceRecord;
    const ids = [...input.upserts.map(e => e.id), ...input.deletes];
    if (new Set(ids).size !== ids.length) throw new ExtensionError('validation.failed', 'An entry can be changed only once in a batch.');
    const exists = pluginTargetResolver(this.host.doc.state), bodyOf = pluginBodyResolver(this.host.doc.state);
    const entries = input.replaceRecord ? new Map<string, PluginEntry>() : new Map(old?.entries);
    for (const id of input.deletes) entries.delete(id);
    try {
      for (const update of input.upserts) {
        if (!exists(update.target)) throw new ExtensionError('validation.failed', 'A metadata target is no longer present.');
        const refs = update.references ?? old?.entries.get(update.id)?.references ?? [];
        entries.set(update.id, preparePluginEntry(update.target, update.value, refs, value => metadataValueMatches(declaration.schema, value)));
      }
      for (const update of input.upserts) for (const ref of entries.get(update.id)!.references) {
        if (ref.unresolved) continue;
        if (ref.element && !pluginElementExists(bodyOf(ref.target), ref.element)) throw new ExtensionError('validation.failed', 'The referenced face or edge changed. Read it again before assigning properties.');
        const target = ref.entryId === undefined ? undefined : entries.get(ref.entryId);
        if (ref.entryId !== undefined && (!target || pluginTargetKey(target.target) !== pluginTargetKey(ref.target)) || !exists(ref.target)) throw new ExtensionError('validation.failed', 'A metadata reference cannot be resolved in this record.');
      }
      const changed = new Set(ids);
      if (input.replaceRecord) for (const id of old?.entries.keys() ?? []) if (!entries.has(id)) changed.add(id);
      for (const [id, entry] of entries) {
        const invalid = (ref: PluginEntry['references'][number]): boolean => {
          if (ref.entryId === undefined || ref.unresolved) return false;
          if (upgrading && !changed.has(id) && !changed.has(ref.entryId)) return false;
          const linked = entries.get(ref.entryId);
          return !linked || !!linked.needsReview || pluginTargetKey(linked.target) !== pluginTargetKey(ref.target);
        };
        if (entry.references.some(invalid)) {
          entries.set(id, { ...entry, references: entry.references.map(ref => invalid(ref) ? { ...ref, unresolved: true } : ref) });
          changed.add(id);
        }
      }
      signal?.throwIfAborted();
      const commit: Commit = { host: this.host, revision: input.expectedRevision, owner: manifest.id, record: { dataVersion: declaration.dataVersion, entries } };
      const token = crypto.randomUUID();
      prepared.set(token, commit);
      try { this.commands.execute(COMMAND, token); } finally { prepared.delete(token); }
      return { revision: this.host.doc.version, dataVersion: declaration.dataVersion, changed: [...changed] };
    } catch (error) {
      if (error instanceof PluginDataError) throw new ExtensionError(error.code === 'version.unsupported' ? 'extension.unsupported' : error.code, error.message);
      throw error;
    }
  }
}
