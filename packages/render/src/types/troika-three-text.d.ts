// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
declare module 'troika-three-text' {
  import type { Color, Mesh } from 'three';
  export class Text extends Mesh {
    text: string;
    fontSize: number;
    color: Color | number | string;
    anchorX: number | string;
    anchorY: number | string;
    textAlign: string;
    outlineWidth: number | string;
    outlineColor: Color | number | string;
    depthOffset: number;
    /** Layout result once `sync` has run; `blockBounds` is [minX, minY, maxX, maxY] in font units. */
    readonly textRenderInfo: { readonly blockBounds: readonly [number, number, number, number] } | null;
    sync(callback?: () => void): void;
    dispose(): void;
  }
  export function preloadFont(options: { font?: string; characters?: string }, callback: () => void): void;
}
