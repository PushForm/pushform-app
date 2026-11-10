// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type * as Protocol from '@pushform/extension-protocol';
import { EXTENSION_ERROR_CODES as HOST_CODES, EXTENSION_PERMISSIONS } from '@pushform/extension-protocol';
import type * as Sdk from '@pushform/extension-sdk';
import { EXTENSION_ERROR_CODES as SDK_CODES } from '@pushform/extension-sdk';

/**
 * The SDK's types are written separately from the host's (the SDK is MIT, the host GPL), so this file keeps them
 * the same: each pair must be assignable both ways, which the type check enforces.
 */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const same = <A, B>(proof: Same<A, B>): Same<A, B> => proof;

describe('SDK types', () => {
  it('match the host protocol', () => {
    expect(same<Sdk.UiNode, Protocol.UiNode>(true)).toBe(true);
    expect(same<Sdk.UiEvent, Protocol.UiEvent>(true)).toBe(true);
    expect(same<Sdk.UiTreeItem, Protocol.UiTreeItem>(true)).toBe(true);
    expect(same<Sdk.UiQuantity, Protocol.UiQuantity>(true)).toBe(true);
    expect(same<Parameters<Sdk.UiService['mount']>[0], Omit<Protocol.UiMountInput, 'tree'> & { tree: Sdk.UiNode }>(true)).toBe(true);
    expect(same<Sdk.UiPrintRequest, Protocol.UiPrintRequest>(true)).toBe(true);
    expect(same<Parameters<Sdk.UiService['dialog']>[0], Omit<Protocol.UiDialogInput, 'tree'> & { tree: Sdk.UiNode }>(true)).toBe(true);
    expect(same<Parameters<Sdk.UiService['open']>[0], Protocol.UiOpenInput>(true)).toBe(true);
    expect(same<Sdk.ToolbarCategory, Protocol.ToolbarCategory>(true)).toBe(true);
    expect(same<Sdk.UiIcon, Protocol.UiIcon>(true)).toBe(true);
    expect(same<Sdk.ExtensionPermission, Protocol.ExtensionPermission>(true)).toBe(true);
    expect(same<Sdk.ExtensionErrorCode, Protocol.ExtensionErrorCode>(true)).toBe(true);
    expect(same<Sdk.ExtensionErrorData, Protocol.ExtensionErrorData>(true)).toBe(true);
  });

  it('match the model and document API', () => {
    expect(same<Sdk.MetadataSchema, Protocol.MetadataSchema>(true)).toBe(true);
    expect(same<Sdk.InspectorCapture, Protocol.InspectorCapture>(true)).toBe(true);
    expect(same<Sdk.InspectorDeclaration, Protocol.InspectorDeclaration>(true)).toBe(true);
    expect(same<Sdk.MetadataTarget, Protocol.MetadataTarget>(true)).toBe(true);
    expect(same<Sdk.MetadataApplyInput, Protocol.MetadataApplyInput>(true)).toBe(true);
    expect(same<Sdk.MetadataListResult, Protocol.MetadataListResult>(true)).toBe(true);
    expect(same<Sdk.MetadataReadResult, Protocol.MetadataReadResult>(true)).toBe(true);
    expect(same<Sdk.ModelRef, Protocol.ModelRef>(true)).toBe(true);
    expect(same<Sdk.ModelRefInput, Protocol.ModelRefInput>(true)).toBe(true);
    expect(same<Sdk.ModelDocumentSnapshot, Protocol.ModelDocumentSnapshot>(true)).toBe(true);
    expect(same<Sdk.ModelQuery, Protocol.ModelQuery>(true)).toBe(true);
    expect(same<Sdk.ModelQueryResult, Protocol.ModelQueryResult>(true)).toBe(true);
    expect(same<Sdk.FragmentDescription, Protocol.FragmentDescription>(true)).toBe(true);
    expect(same<Sdk.ModelEntitySummary, Protocol.ModelEntitySummary>(true)).toBe(true);
    expect(same<Sdk.ModelCameraInput, Protocol.ModelCameraInput>(true)).toBe(true);
    expect(same<Sdk.ModelOperation, Protocol.ModelOperation>(true)).toBe(true);
    expect(same<Sdk.ModelBatch, Protocol.ModelBatch>(true)).toBe(true);
    expect(same<Sdk.ModelBatchResult, Protocol.ModelBatchResult>(true)).toBe(true);
    expect(same<Sdk.MaterialAppearance, Protocol.MaterialAppearance>(true)).toBe(true);
    expect(same<Sdk.MaterialReadInput, Protocol.MaterialReadInput>(true)).toBe(true);
    expect(same<Sdk.MaterialReadResult, Protocol.MaterialReadResult>(true)).toBe(true);
    expect(same<Sdk.MaterialStageInput, Protocol.MaterialStageInput>(true)).toBe(true);
    expect(same<Sdk.MaterialStageResult, Protocol.MaterialStageResult>(true)).toBe(true);
    expect(same<Sdk.FileReadDescription, Protocol.FileReadDescription>(true)).toBe(true);
    expect(same<Sdk.StagedEditBeginInput, Protocol.StagedEditBeginInput>(true)).toBe(true);
    expect(same<Sdk.StagedEditAppendInput, Protocol.StagedEditAppendInput>(true)).toBe(true);
    expect(same<Sdk.StagedEditProgress, Protocol.StagedEditProgress>(true)).toBe(true);
    expect(same<Sdk.StagedEditCommitResult, Protocol.StagedEditCommitResult>(true)).toBe(true);
    expect(same<Sdk.StagedEditResultPage, Protocol.StagedEditResultPage>(true)).toBe(true);
    expect(same<Sdk.FileReadChunk, Protocol.FileReadChunk>(true)).toBe(true);
    expect(same<Sdk.FileStageResult, Protocol.FileStageResult>(true)).toBe(true);
    expect(same<Sdk.AssetDescription, Protocol.AssetDescription>(true)).toBe(true);
    expect(same<Sdk.AssetDescriptor, Protocol.AssetDescriptor>(true)).toBe(true);
    expect(same<Sdk.AssetPage, Protocol.AssetPage>(true)).toBe(true);
    expect(same<Sdk.AssetReadResult, Protocol.AssetReadResult>(true)).toBe(true);
    expect(same<Sdk.AssetStageResult, Protocol.AssetStageResult>(true)).toBe(true);
    expect(same<Sdk.DocumentUnits, Protocol.DocumentUnits>(true)).toBe(true);
    expect(same<Sdk.DocumentUnitsEvent, Protocol.DocumentUnitsEvent>(true)).toBe(true);
    expect(same<Sdk.DocumentInfo, Protocol.DocumentInfo>(true)).toBe(true);
    expect(same<Sdk.DocumentInfoEvent, Protocol.DocumentInfoEvent>(true)).toBe(true);
    expect(same<Sdk.ModelChangeEvent, Protocol.ModelChangeEvent>(true)).toBe(true);
  });

  it('list the same error codes as the host', () => {
    expect([...SDK_CODES].sort()).toEqual([...HOST_CODES].sort());
    expect(EXTENSION_PERMISSIONS.length).toBe(12);
  });
});
