// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { ExtensionError, type ExtensionManifest, type MetadataApplyResult, type MetadataBatchTarget, type MetadataTarget, type ModelBatchResult, type StagedMetadata, type modelMetadataBatchSchema } from '@pushform/extension-protocol';
import type { StagedMaterialAppearance } from './materialAssets';
import type { z } from 'zod';
import type { ModelDocumentApi, ModelBatchCreated, ModelBatchFinalize } from './modelApi';
import type { ModelMetadataApi } from './metadataApi';

/** Apply the installed plugin's metadata after model operations, inside that batch's rollback/undo boundary. */
export async function applyModelWithMetadata(model: Pick<ModelDocumentApi, 'revision' | 'apply'>, metadata: ModelMetadataApi, manifest: ExtensionManifest,
  batch: { expectedRevision: number; label: string; operations: { op: string; [key: string]: unknown }[]; container?: number[] | undefined; metadata: z.infer<typeof modelMetadataBatchSchema> },
  signal?: AbortSignal, assets?: ReadonlyMap<string, StagedMaterialAppearance>, replaceRecord = false, allowedTargets?: readonly MetadataTarget[]): Promise<ModelBatchResult & { metadata: MetadataApplyResult }> {
  signal?.throwIfAborted();
  metadata.assertWritable(manifest, batch.expectedRevision, batch.metadata.expectedDataVersion,replaceRecord,batch.metadata.upgradeCompatible);
  let changed!: MetadataApplyResult;
  let finalFailure: { cause: unknown } | undefined;
  let result: ModelBatchResult;
  const finalize: ModelBatchFinalize = (created,continueTarget) => {
      try {
        const target = (value: MetadataBatchTarget): MetadataTarget => resolveTarget(value, created, continueTarget??(target=>target));
        const { upserts, deletes } = batch.metadata;
        changed = metadata.apply(manifest, {
          expectedRevision: model.revision, expectedDataVersion: metadata.dataVersion(manifest), replaceRecord, deletes, ...(batch.metadata.upgradeCompatible ? { upgradeCompatible: true } : {}),
          upserts: upserts.map(({ target: owner, references, ...update }) => ({
            ...update, target: target(owner),
            ...(references ? { references: references.map(ref => ({ ...ref, target: target(ref.target) })) } : {}),
          })),
        }, signal, allowedTargets);
      } catch (cause) { finalFailure = { cause }; throw cause; }
  };
  if (batch.metadata.upgradeCompatible && !replaceRecord) finalize.prepare = () => {
    try { metadata.upgradeCompatible(manifest, model.revision, batch.metadata.expectedDataVersion); }
    catch (cause) { finalFailure = { cause }; throw cause; }
  };
  try {
    result = await model.apply(batch, signal, finalize, assets);
  } catch (cause) {
    // The model batch has rolled back; preserve metadata failure codes such as quota and schema refusal.
    if (finalFailure) throw finalFailure.cause;
    throw cause;
  }
  return { ...result, metadata: { ...changed, revision: result.revision } };
}

/** The same command/rollback path, reached only after the host has captured and bounded a complete draft. */
export function applyStagedModelWithMetadata(model: Pick<ModelDocumentApi,'revision'|'applyStaged'>, metadata: ModelMetadataApi, manifest: ExtensionManifest,
  batch: { expectedRevision:number;label:string;operations:{ op:string;[key:string]:unknown }[];container?:number[] | undefined;metadata:StagedMetadata },
  signal?:AbortSignal, assets?:ReadonlyMap<string,StagedMaterialAppearance>, progress?: (value:number) => void, allowedTargets?: readonly MetadataTarget[]): Promise<ModelBatchResult & { metadata:MetadataApplyResult }> {
  const adapter = { get revision() { return model.revision; },apply:(input:unknown,signal?:AbortSignal,finalize?: ModelBatchFinalize,assets?:ReadonlyMap<string,StagedMaterialAppearance>) => model.applyStaged(input,signal,finalize,assets,progress) };
  return applyModelWithMetadata(adapter,metadata,manifest,batch,signal,assets,batch.metadata.replaceRecord,allowedTargets);
}

function resolveTarget(target: MetadataBatchTarget, created: ReadonlyMap<string, ModelBatchCreated>, continueTarget:(target:MetadataTarget)=>MetadataTarget): MetadataTarget {
  if (!('created' in target)) return continueTarget(target);
  const entity = created.get(target.created);
  const invalid = (): never => { throw new ExtensionError('validation.failed', `Created target "${target.created}" is unavailable or has a different kind.`); };
  if (!entity) return invalid();
  if (target.kind === 'definition') {
    if (entity.definitionId === undefined) return invalid();
    return { kind: 'definition', id: entity.definitionId };
  }
  if (target.kind === 'bodyOccurrence') {
    if (entity.kind !== 'body') return invalid();
    const path=target.path??entity.path;if(!path)return invalid();
    return continueTarget({ kind: 'bodyOccurrence', id: entity.id, path });
  }
  if (entity.kind !== (target.kind === 'group' ? 'instance' : target.kind)) return invalid();
  return { kind: target.kind, id: entity.id };
}
