// SPDX-License-Identifier: MIT
// Copyright 2026 PushForm contributors

/** Complete portable appearance; image bytes are transferred separately in bounded chunks. */
export interface MaterialAppearance {
  name: string; color: [number, number, number]; opacity: number;
  texture: {
    widthM: number; heightM: number; colorize: boolean;
    colorizeType?: 'shift' | 'tint' | undefined; grain?: 'width' | 'height' | 'none' | undefined;
    image: { name: string; mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/bmp' | 'image/webp'; width: number; height: number; byteLength: number };
  } | null;
}
export interface MaterialReadInput { document?: string | undefined; expectedRevision: number; materialId: number; offset?: number | undefined; limit?: number | undefined }
export interface MaterialReadResult { revision: number; materialId: number; appearance: MaterialAppearance; bytes: Uint8Array; next: number | null }
export interface MaterialStageInput {
  document?: string | undefined; expectedRevision: number; upload?: string | undefined; appearance?: MaterialAppearance | undefined;
  offset?: number | undefined; bytes?: Uint8Array | undefined; discard?: boolean | undefined;
}
export interface MaterialStageResult { upload: string; received: number; complete: boolean }
