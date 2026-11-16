// SPDX-License-Identifier: MIT
// Copyright 2026 PushForm contributors
import type { CallOptions, DocumentTarget } from './context.ts';
import type { ModelBounds, ModelRef, ModelQuery, ModelQueryResult, ModelVec3 } from './model.ts';
import type { MetadataReadResult, MetadataListResult, MetadataTarget, MetadataApplyInput } from './metadata.ts';
import type { AssetDescriptor } from './assets.ts';

/** An immutable snapshot owned by this runtime, expiring five minutes after creation. Native bytes stay in the host. */
export interface FragmentDescription { fragment: string; name: string; revision: number; root: ModelRef; bounds: ModelBounds; byteLength: number; expiresAt: number }
export type FragmentAxes = [ModelVec3, ModelVec3, ModelVec3];
export interface FragmentProjection { axes: FragmentAxes; min: ModelVec3; max: ModelVec3; size: ModelVec3 }
export interface FragmentFitInput { fragment: string; expectedRevision: number; name?: string; axes: FragmentAxes; size: ModelVec3; pose?: number[]; anchor?: ModelVec3; planes?: { normal: ModelVec3; offset: number; side: 'positive' | 'negative'; displacement: ModelVec3 }[] }
export interface FragmentFitResult { description: FragmentDescription; projection: FragmentProjection }
export interface FragmentsService {
  /** model.read; capture one body or assembly without changing the selection, clipboard or source document. */
  capture(input: DocumentTarget & { expectedRevision: number; name: string; ref: { kind: 'body' | 'instance'; id: number; path: number[] } }, options?: CallOptions): Promise<FragmentDescription>;
  /** file.read; use a file this runtime already obtained from files.openRead. */
  openFile(input: { transfer: string; name: string }, options?: CallOptions): Promise<FragmentDescription>;
  /** settings; use an owner-scoped private native asset at the revision shown in assets.list. */
  openAsset(input: { key: string; expectedRevision: number; name: string }, options?: CallOptions): Promise<FragmentDescription>;
  /** model.read; read a verified .pf file declared in this installed package. */
  openPackage(input: { path: string; name: string }, options?: CallOptions): Promise<FragmentDescription>;
  describe(input: { fragment: string }, options?: CallOptions): Promise<FragmentDescription>;
  /** model.read; the same bounded geometry queries as model.query, in the snapshot's coordinates. */
  query(input: { fragment: string; query: Partial<ModelQuery> }, options?: CallOptions): Promise<ModelQueryResult>;
  /** model.read; only this extension's declared metadata namespace. */
  metadataList(input: { fragment: string; query: { expectedRevision?: number; targets?: MetadataTarget[]; offset?: number; limit?: number } }, options?: CallOptions): Promise<MetadataListResult>;
  metadataRead(input: { fragment: string; query: { expectedRevision?: number; ids: string[] } }, options?: CallOptions): Promise<MetadataReadResult>;
  /** model.write; new immutable snapshot with edits only to this extension's declared namespace. */
  derive(input: { fragment: string; expectedRevision: number; name?: string | undefined; metadata: Omit<MetadataApplyInput, 'document' | 'inspectorBinding' | 'expectedRevision'> }, options?: CallOptions): Promise<FragmentDescription>;
  /** model.read; exact projection of the complete native solid graph in orthonormal snapshot axes. */
  project(input: { fragment: string; axes: FragmentAxes }, options?: CallOptions): Promise<FragmentProjection>;
  /** model.write; new snapshot with a distance-preserving pose/stretch, certified against all three sizes. */
  fit(input: FragmentFitInput, options?: CallOptions): Promise<FragmentFitResult>;
  /** settings; atomic create/replace in the configured account/device library. */
  save(input: { fragment: string; key: string; expectedRevision: number | null }, options?: CallOptions): Promise<AssetDescriptor>;
  /** file.export; the host asks where to save, retaining all native/opaque data without returning bytes. */
  export(input: { fragment: string; purpose: string; suggestedName: string }, options?: CallOptions): Promise<{ name: string }>;
  discard(input: { fragment: string }, options?: CallOptions): Promise<null>;
}
