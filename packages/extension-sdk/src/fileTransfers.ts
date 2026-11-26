// SPDX-License-Identifier: MIT
// Copyright 2026 PushForm contributors
/** Captured local file; only this running extension session may read its immutable bytes. */
export interface FileReadDescription {
  transfer: string; name: string; type: string; byteLength: number; sha256: string;
}
export interface FileReadChunk { transfer: string; bytes: Uint8Array; next: number | null }
export interface FileStageResult { upload: string; received: number; complete: boolean }
