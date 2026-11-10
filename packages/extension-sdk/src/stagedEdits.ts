// SPDX-License-Identifier: MIT
// Copyright 2026 PushForm contributors
import type { ModelOperation } from './model.ts';
import type { ModelMetadataBatchInput } from './metadata.ts';
import type { MaterialAppearance } from './materialAssets.ts';
export interface StagedEditBeginInput {
  document?:string | undefined; expectedRevision:number; label:string; container?:number[] | undefined;
  metadata?: { expectedDataVersion:number | null;replaceRecord?:boolean | undefined;upgradeCompatible?:boolean | undefined;inspectorBinding?:string | undefined } | undefined;
}
export interface StagedEditAppendInput {
  document?:string | undefined;batch:string;sequence:number;
  operations?:ModelOperation[] | undefined;
  metadata?: { upserts?:ModelMetadataBatchInput['upserts'];deletes?:string[] | undefined } | undefined;
  appearances?: { id:string;source?:string | undefined;appearance?:MaterialAppearance | undefined }[] | undefined;
}
export interface StagedEditProgress { batch:string;next:number;operations:number;metadataChanges:number;appearances:number }
export interface StagedEditCommitResult { ok:true;revision:number;label:string;operations:number;created:number;metadataChanges:number }
export interface StagedEditResultPage { created:Record<string,number>;changed:string[];next:number | null }
