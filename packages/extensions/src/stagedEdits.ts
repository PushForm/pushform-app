// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import {
  ExtensionError, STAGED_EDIT_LIMITS as LIMITS, metadataValueMatches, sha256Hex,
  type ExtensionManifest, type StagedEditCommitResult, type StagedEditResultPage, type StagedEditProgress, type StagedMetadata, type MetadataTarget,
  type stagedEditBeginSchema, type stagedEditAppendSchema,
} from '@pushform/extension-protocol';
import { encodePluginValue, PluginDataError } from '@pushform/model';
import type { z } from 'zod';
import { validateStagedAppearance, type MaterialAppearanceStaging, type StagedMaterialAppearance } from './materialAssets';
import { applyStagedModelWithMetadata } from './modelMetadataBatch';
import type { ModelMetadataApi } from './metadataApi';
import type { ExtensionModelAccess } from './runtime/documents';

type Begin = z.infer<typeof stagedEditBeginSchema>;
type Chunk = z.infer<typeof stagedEditAppendSchema>;
interface Draft {
  token: string; document: string; header: Begin; container: number[]; expires: number;
  operations: Chunk['operations']; metadata: StagedMetadata | undefined;
  assets: Map<string, StagedMaterialAppearance>; ids: Set<string>; jsonBytes: number;
  receipts: { hash: string; result: StagedEditProgress }[];
  controller: AbortController; busy: boolean; cancelled: boolean; result?: StagedEditCommitResult; allowedTargets: readonly MetadataTarget[] | undefined;
  created: [string, number][]; changed: string[];
}
const invalid = (message: string): never => { throw new ExtensionError('validation.failed', message); };
const limit = (message: string): never => { throw new ExtensionError('limit.exceeded', message); };
const stale = (): never => { throw new ExtensionError('revision.stale', 'The model changed while preparing this edit. Prepare it again at the current revision.'); };

/** Session-owned preparation; only commit reaches the document's normal command and Undo boundary. */
export class StagedModelEdits {
  private readonly drafts = new Map<string, Draft>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  constructor(private readonly manifest: ExtensionManifest, private readonly appearances: MaterialAppearanceStaging,
    private readonly now = () => Date.now()) {}

  get imageBytes(): number { return this.images([...this.drafts.values()].flatMap(d => [...d.assets.values()])); }
  private images(assets: readonly StagedMaterialAppearance[]): number {
    // Rebinding scale/color/grain shares the exact owned bytes, including their full backing allocation.
    return [...new Set(assets.map(asset => asset.bytes.buffer))].reduce((sum, buffer) => sum + buffer.byteLength, 0);
  }

  begin(document: string, model: ExtensionModelAccess, metadata: ModelMetadataApi | undefined, input: Begin, signal: AbortSignal, allowedTargets?: readonly MetadataTarget[]): StagedEditProgress {
    this.reap(); signal.throwIfAborted();
    if (this.disposed) throw new ExtensionError('unavailable', 'The extension has stopped.');
    if (!model.applyStaged) throw new ExtensionError('unavailable', 'This document does not support staged edits.');
    if (model.revision !== input.expectedRevision) return stale();
    if (input.metadata) {
      if (!metadata) return invalid('This document does not support plugin metadata.');
      metadata.assertWritable(this.manifest, input.expectedRevision, input.metadata.expectedDataVersion, input.metadata.replaceRecord, input.metadata.upgradeCompatible);
    }
    if (this.drafts.size >= LIMITS.drafts) return limit('Finish or discard an existing staged edit first.');
    const draft: Draft = { token: `edit_${crypto.randomUUID().replaceAll('-', '')}`, document,
      header: structuredClone(input), container: [...(input.container ?? model.container ?? model.getDocument().editContext.path)],
      expires: this.now() + LIMITS.lifetimeMs, operations: [], metadata: input.metadata ? { ...input.metadata, upserts: [], deletes: [] } : undefined,
      assets: new Map(), ids: new Set(), jsonBytes: 0, receipts: [], controller: new AbortController(), busy: false, cancelled: false, allowedTargets: allowedTargets ? structuredClone(allowedTargets) : undefined, created: [], changed: [] };
    this.drafts.set(draft.token, draft); this.reap(); return this.progress(draft);
  }

  async append(document: string, model: ExtensionModelAccess, input: Chunk, signal: AbortSignal): Promise<StagedEditProgress> {
    const draft = this.owned(input.batch, document); signal.throwIfAborted();
    if (draft.busy || draft.result) return invalid('This staged edit is committing or already complete.');
    if (input.sequence > draft.receipts.length) return invalid('Edit chunks must arrive in sequence.');
    if (model.revision !== draft.header.expectedRevision) return stale();
    draft.busy = true;
    try {
      if (input.metadata && !draft.metadata) return invalid('Declare the metadata version when beginning this edit.');
      // Validate opaque values before JSON serialization; JSON must never silently drop a field or nonfinite number.
      for (const entry of input.metadata?.upserts ?? []) {
        try { encodePluginValue(entry.value); }
        catch (cause) { if (cause instanceof PluginDataError) throw new ExtensionError(cause.code === 'version.unsupported' ? 'extension.unsupported' : cause.code, cause.message); throw cause; }
        if (!this.manifest.metadata || !metadataValueMatches(this.manifest.metadata.schema, entry.value)) return invalid('Metadata does not match the installed plugin schema.');
      }
      const bytes = new TextEncoder().encode(JSON.stringify(input));
      if (bytes.length > LIMITS.draftJsonBytes) return limit('The edit chunk exceeds the prepared JSON quota.');
      const hash = await sha256Hex(bytes);
      this.reap();
      signal.throwIfAborted(); draft.controller.signal.throwIfAborted();
      if (model.revision !== draft.header.expectedRevision) return stale();
      const receipt = draft.receipts[input.sequence];
      if (receipt) { if (receipt.hash !== hash) return invalid('A previously accepted sequence cannot change its content.'); return receipt.result; }
      if (draft.receipts.length >= LIMITS.chunks) return limit('The staged edit has too many chunks.');
      if (draft.operations.length + input.operations.length > LIMITS.operations) return limit('The staged edit has too many model operations.');
      const changes = (draft.metadata?.upserts.length ?? 0) + (draft.metadata?.deletes.length ?? 0) + (input.metadata?.upserts.length ?? 0) + (input.metadata?.deletes.length ?? 0);
      if (changes > LIMITS.metadataChanges) return limit('The staged edit has too many metadata changes.');
      const total = [...this.drafts.values()].reduce((sum, d) => sum + d.jsonBytes, 0);
      if (draft.jsonBytes + bytes.length > LIMITS.draftJsonBytes || total + bytes.length > LIMITS.sessionJsonBytes) return limit('The prepared edit JSON quota is full.');
      const ids = [...(input.metadata?.upserts.map(e => e.id) ?? []), ...(input.metadata?.deletes ?? [])];
      if (new Set(ids).size !== ids.length || ids.some(id => draft.ids.has(id))) return invalid('An entry can be changed only once in a staged edit.');
      const assets = new Map(draft.assets), consumed = new Map<string, StagedMaterialAppearance>();
      for (const binding of input.appearances) {
        if (assets.has(binding.id)) return invalid('An appearance binding cannot be changed or declared twice.');
        let source: StagedMaterialAppearance | undefined;
        if (binding.source) {
          source = assets.get(binding.source) ?? consumed.get(binding.source);
          if (!source) {
            source = this.appearances.resolve(document, model.revision, [{ op: 'add_material_appearance', asset: binding.source }]).get(binding.source)!;
            consumed.set(binding.source, source);
          }
        }
        const appearance = binding.appearance ?? source?.appearance;
        if (!appearance) return invalid('Provide a complete appearance description.');
        const value = { appearance: structuredClone(appearance), bytes: source?.bytes ?? new Uint8Array() };
        validateStagedAppearance(value); assets.set(binding.id, value);
      }
      if (assets.size > LIMITS.operations) return limit('The staged edit has too many appearance bindings.');
      for (const op of input.operations) if ((op.op === 'add_material_appearance' || op.op === 'set_material_appearance') && !assets.has(op.asset))
        return invalid('Bind each appearance in this edit before using it.');
      if (this.images([...assets.values(), ...[...this.drafts.values()].filter(d => d !== draft).flatMap(d => [...d.assets.values()])]) > LIMITS.sessionImageBytes)
        return limit('The prepared image quota is full.');
      // Publish only after the entire chunk is valid. In particular, failed chunks keep their upload handles.
      draft.operations.push(...structuredClone(input.operations));
      if (input.metadata) { draft.metadata!.upserts.push(...structuredClone(input.metadata.upserts)); draft.metadata!.deletes.push(...input.metadata.deletes); }
      for (const id of ids) draft.ids.add(id);
      draft.assets = assets; draft.jsonBytes += bytes.length;
      this.appearances.consume(consumed);
      const result = { ...this.progress(draft), next: draft.receipts.length + 1 };
      draft.receipts.push({ hash, result }); return result;
    } finally { draft.busy = false; if (draft.cancelled) this.drafts.delete(draft.token); this.reap(); }
  }

  async commit(document: string, token: string, model: ExtensionModelAccess, metadata: ModelMetadataApi | undefined,
    signal: AbortSignal, progress?: (value: number) => void): Promise<StagedEditCommitResult> {
    const draft = this.owned(token, document); signal.throwIfAborted();
    if (draft.result) return structuredClone(draft.result);
    if (draft.busy) return invalid('This staged edit already has a request in progress.');
    if (model.revision !== draft.header.expectedRevision) return stale();
    if (!model.applyStaged) throw new ExtensionError('unavailable', 'This document does not support staged edits.');
    if (!draft.operations.length && !draft.metadata?.upserts.length && !draft.metadata?.deletes.length && !draft.metadata?.replaceRecord)
      return invalid('The staged edit has no changes to commit.');
    draft.busy = true;
    try {
      const batch = { expectedRevision: draft.header.expectedRevision, label: draft.header.label, container: draft.container, operations: draft.operations };
      const combined = AbortSignal.any([signal, draft.controller.signal]);
      const result = draft.metadata
        ? await applyStagedModelWithMetadata({ get revision() { return model.revision; }, applyStaged: model.applyStaged.bind(model) }, metadata!, this.manifest, { ...batch, metadata: draft.metadata }, combined, draft.assets, progress, draft.allowedTargets)
        : await model.applyStaged(batch, combined, undefined, draft.assets, progress);
      // A late cancellation does not reverse a completed commit. Keep only a small idempotent result receipt.
      draft.created = Object.entries(result.created); draft.changed = result.metadata?.changed ?? [];
      draft.result = { ok: true, revision: result.revision, label: result.label, operations: draft.operations.length, created: draft.created.length, metadataChanges: draft.changed.length };
      draft.operations = []; draft.metadata = undefined; draft.assets.clear(); draft.ids.clear(); draft.receipts = [];
      draft.jsonBytes = new TextEncoder().encode(JSON.stringify([draft.result, draft.created, draft.changed])).length;
      return structuredClone(draft.result);
    } catch (cause) { draft.cancelled = true; throw cause; }
    finally { draft.busy = false; if (draft.cancelled) this.drafts.delete(token); this.reap(); }
  }

  result(document: string, token: string, offset: number, count: number): StagedEditResultPage {
    const draft = this.owned(token, document);
    if (!draft.result) return invalid('Commit this staged edit before reading its result.');
    const end = Math.min(offset + count, draft.created.length + draft.changed.length);
    return { created: Object.fromEntries(draft.created.slice(offset, Math.min(end, draft.created.length))),
      changed: draft.changed.slice(Math.max(0, offset - draft.created.length), Math.max(0, end - draft.created.length)),
      next: end < draft.created.length + draft.changed.length ? end : null };
  }

  discard(document: string, token: string): null { this.cancel(this.owned(token, document)); this.reap(); return null; }
  closed(document: string): void { for (const draft of this.drafts.values()) if (draft.document === document) this.cancel(draft); this.reap(); }
  dispose(): void { this.disposed = true; for (const draft of this.drafts.values()) this.cancel(draft); this.reap(); }
  private cancel(draft: Draft): void { draft.cancelled = true; draft.controller.abort(); if (!draft.busy) this.drafts.delete(draft.token); }
  private progress(d: Draft): StagedEditProgress { return { batch: d.token, next: d.receipts.length, operations: d.operations.length, metadataChanges: (d.metadata?.upserts.length ?? 0) + (d.metadata?.deletes.length ?? 0), appearances: d.assets.size }; }
  private owned(token: string, document: string): Draft {
    this.reap(); const draft = this.drafts.get(token);
    if (!draft || draft.cancelled || draft.document !== document || this.disposed) return invalid('This staged edit is unavailable, expired or belongs to another document/session.');
    return draft;
  }
  private reap(): void {
    if (this.timer !== null) clearTimeout(this.timer); this.timer = null;
    for (const draft of this.drafts.values()) if (!draft.cancelled && draft.expires <= this.now()) this.cancel(draft);
    const pending = [...this.drafts.values()].filter(d => !d.cancelled);
    if (pending.length) this.timer = setTimeout(() => this.reap(), Math.max(1, Math.min(...pending.map(d => d.expires)) - this.now()));
  }
}
