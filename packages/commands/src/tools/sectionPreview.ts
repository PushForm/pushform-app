// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Id, Vec3 } from '@pushform/core';

/** A plane in world coordinates: points `x` on it satisfy `normal · x + d = 0`; `normal` points to the side it keeps. */
export interface WorldSectionPlane {
  readonly normal: Vec3;
  readonly d: number;
}

/**
 * How section planes look while a tool drags them, drawn without changing the document: existing planes shown
 * somewhere else (their cuts with them), inactive copies, and a plane about to be added as its container's cut.
 */
export interface SectionPreview {
  /** Existing planes drawn, and cutting if active, at a new place. */
  readonly moved: readonly (WorldSectionPlane & { readonly path: readonly Id[]; readonly id: Id })[];
  /** Copies of planes, which are never active. */
  readonly copies: readonly (WorldSectionPlane & { readonly path: readonly Id[]; readonly id: Id })[];
  /** A plane about to be placed in the container at `path` as its active cut. */
  readonly added: (WorldSectionPlane & { readonly path: readonly Id[] }) | null;
}

/** A tool that previews section planes while it drags them. */
export interface SectionPreviewTool {
  readonly sectionPreview: SectionPreview | null;
}
