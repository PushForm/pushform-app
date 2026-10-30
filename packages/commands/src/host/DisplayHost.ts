// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { Emitter } from '@pushform/core';

/** Face styles. Photoreal/PBR is a later phase. */
export const FACE_STYLES = ['shaded', 'shadedTextures', 'wireframe', 'hiddenLine', 'monochrome'] as const;
export type FaceStyle = (typeof FACE_STYLES)[number];

/** Display toggles of the "Display" panel. Runtime state, not document state. */
export interface DisplayState {
  hiddenGeometry: boolean;
  edges: boolean;
  profiles: boolean;
  guides: boolean;
  axes: boolean;
  /** Dashed obscured edges; exclusive with `xray`. */
  backEdges: boolean;
  xray: boolean;
  faceStyle: FaceStyle;
  /** Tag new entities get (Tags panel pencil); null = the document's "Untagged" tag. Runtime state. */
  activeTagId: number | null;
}

export const DISPLAY_KEYS = ['hiddenGeometry', 'edges', 'profiles', 'guides', 'axes', 'backEdges', 'xray', 'faceStyle'] as const;
export type DisplayKey = (typeof DISPLAY_KEYS)[number];

export const DEFAULT_DISPLAY: DisplayState = {
  hiddenGeometry: false,
  edges: true,
  profiles: true,
  guides: true,
  axes: true,
  backEdges: false,
  xray: false,
  faceStyle: 'shadedTextures',
  activeTagId: null,
};

/** Where `view.*` commands read and write display state. The UI backs it with its store. */
export interface DisplayHost {
  get(): DisplayState;
  set(patch: Partial<DisplayState>): void;
  onChange(fn: (state: DisplayState) => void): () => void;
}

/** In-memory display host (headless scripts, tests, and before the UI installs its own). */
export class MemoryDisplayHost implements DisplayHost {
  private state: DisplayState;
  private readonly events = new Emitter<{ change: DisplayState }>();
  constructor(initial: Partial<DisplayState> = {}) {
    this.state = { ...DEFAULT_DISPLAY, ...initial };
  }
  get(): DisplayState {
    return this.state;
  }
  set(patch: Partial<DisplayState>): void {
    this.state = { ...this.state, ...patch };
    this.events.emit('change', this.state);
  }
  onChange(fn: (state: DisplayState) => void): () => void {
    return this.events.on('change', fn);
  }
}
