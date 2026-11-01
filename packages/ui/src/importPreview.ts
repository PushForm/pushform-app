// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Box3, Mat4 } from '@pushform/core';
import type { StepPreview } from '@pushform/io';
import type { Viewport } from '@pushform/render';

/** How far beyond the model the camera frames while an import is drawn, as a share of the model's largest side. */
const FRAME_MARGIN = 0.15;

const contains = (outer: Box3, inner: Box3): boolean =>
  [0, 1, 2].every(k => inner.min[k]! >= outer.min[k]! && inner.max[k]! <= outer.max[k]!);

function grow(box: Box3, share: number): Box3 {
  const pad = share * Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
  return { min: [box.min[0] - pad, box.min[1] - pad, box.min[2] - pad], max: [box.max[0] + pad, box.max[1] + pad, box.max[2] + pad] };
}

/**
 * Draws the parts of a STEP import in a viewport as they are read and keeps them in view: the camera frames
 * the model, with the import, when the parts first appear and again only when they grow past what is framed, so it
 * does not move with every part. Framing while importing stays out of Previous View.
 */
export class ImportPreview {
  private framed: Box3 | null = null;
  private done = false;

  /** `base`: world matrix of the context the import goes into (identity for a new model). */
  constructor(private readonly viewport: Viewport, base?: Mat4) {
    viewport.beginImportPreview(base);
  }

  add(preview: StepPreview): void {
    if (this.done) return;
    const placed = this.viewport.addImportPreview(preview);
    if (!placed || (this.framed && contains(this.framed, placed))) return;
    this.framed = grow(this.viewport.sceneBounds() ?? placed, FRAME_MARGIN);
    this.viewport.camera.zoomBox(this.framed, { history: false });
  }

  /** Remove the drawn parts (the import was applied, failed or was cancelled); later batches are ignored. */
  clear(): void {
    if (this.done) return;
    this.done = true;
    this.viewport.clearImportPreview();
  }
}
