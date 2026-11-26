// SPDX-License-Identifier: MIT
// Copyright 2026 PushForm contributors
import type { MetadataTarget } from './metadata.ts';
export interface InspectorDeclaration {
  targets: ('bodyOccurrence' | 'body' | 'group' | 'instance' | 'definition')[];
  multiSelection: 'none' | 'homogeneous' | 'mixed';
}
/** Captured by the host, never substituted with the current live selection. */
export interface InspectorCapture {
  binding: string; revision: number; scope: 'placement' | 'shared'; targets: MetadataTarget[];
  placementCount: number; overrideCount: number;
}
