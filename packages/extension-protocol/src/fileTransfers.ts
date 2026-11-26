// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';

export const FILE_TRANSFER_LIMITS = {
  chunkBytes: 256 * 1024, fileBytes: 64 * 1024 * 1024,
  sessionBytes: 128 * 1024 * 1024, transfers: 4, lifetimeMs: 5 * 60 * 1000,
} as const;
export interface FileReadDescription {
  transfer: string; name: string; type: string; byteLength: number; sha256: string;
}
export interface FileReadChunk { transfer: string; bytes: Uint8Array; next: number | null }
export interface FileStageResult { upload: string; received: number; complete: boolean }
const readHandle = z.string().regex(/^read_[0-9a-f]{32}$/);
const saveHandle = z.string().regex(/^save_[0-9a-f]{32}$/);
export const fileOpenReadSchema = z.object({
  purpose: z.string().min(1).max(200),
  accept: z.array(z.object({ description: z.string().min(1).max(100), extensions: z.array(z.string().regex(/^[A-Za-z0-9]{1,16}$/)).min(1).max(100) }).strict()).max(20).optional(),
}).strict();
export const fileReadChunkSchema = z.object({
  transfer: readHandle, offset: z.number().int().nonnegative().max(FILE_TRANSFER_LIMITS.fileBytes).default(0),
  limit: z.number().int().min(1).max(FILE_TRANSFER_LIMITS.chunkBytes).default(FILE_TRANSFER_LIMITS.chunkBytes),
}).strict();
export const fileCloseReadSchema = z.object({ transfer: readHandle }).strict();
export const fileStageSchema = z.object({
  upload: saveHandle.optional(), byteLength: z.number().int().nonnegative().max(FILE_TRANSFER_LIMITS.fileBytes).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  offset: z.number().int().nonnegative().max(FILE_TRANSFER_LIMITS.fileBytes).default(0),
  bytes: z.custom<Uint8Array>(value => value instanceof Uint8Array && value.length <= FILE_TRANSFER_LIMITS.chunkBytes, 'Send a bounded Uint8Array file chunk.'),
}).strict();
export const fileDiscardSchema = z.object({ upload: saveHandle }).strict();
export const fileSaveStagedSchema = fileOpenReadSchema.extend({ upload: saveHandle, suggestedName: z.string().min(1).max(200).optional() }).strict();
