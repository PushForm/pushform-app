// SPDX-License-Identifier: MIT
// Copyright 2026 PushForm contributors
export const NATIVE_FRAGMENT_MIME='application/vnd.pushform.model-fragment';
export interface AssetDescription { key: string; version: number; contentType: string; byteLength: number; sha256: string }
export interface AssetDescriptor extends AssetDescription { revision: number; updatedAt: string }
export interface AssetPage { entries: AssetDescriptor[]; next: string | null }
export interface AssetReadResult { asset: AssetDescriptor; bytes: Uint8Array; next: number | null }
export interface AssetStageResult { upload: string; received: number; complete: boolean }
