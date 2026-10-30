// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/** Persistent entity id: u32, monotonically allocated per document, never reused. */
export type Id = number & { readonly __brand: 'Id' };
export type DefId = number & { readonly __brand: 'DefId' };
export type TagId = number & { readonly __brand: 'TagId' };
export type TagFolderId = number & { readonly __brand: 'TagFolderId' };
export type MaterialId = number & { readonly __brand: 'MaterialId' };
export type ImageId = number & { readonly __brand: 'ImageId' };
export type StyleId = number & { readonly __brand: 'StyleId' };
export type SceneId = number & { readonly __brand: 'SceneId' };
export type CurveId = number & { readonly __brand: 'CurveId' };
export type SurfaceId = number & { readonly __brand: 'SurfaceId' };
/** Face id local to a body; stored in the mesh faceId array. */
export type FaceLocalId = number & { readonly __brand: 'FaceLocalId' };
/** Globally unique id for component definitions across files. */
export type Guid = string & { readonly __brand: 'Guid' };

export const asId = (n: number): Id => n as Id;

export class IdAllocator {
  constructor(private next = 1) {}
  alloc<T extends number = Id>(): T {
    const v = this.next++;
    if (v > 0xffff_ffff) throw new Error('IdAllocator exhausted');
    return v as T;
  }
  /** Reserve ids without using them; returns the first reserved id. */
  reserve(count: number): number {
    const first = this.next;
    this.next += count;
    return first;
  }
  get current(): number {
    return this.next;
  }
  static from(next: number): IdAllocator {
    return new IdAllocator(next);
  }
}

export function newGuid(): Guid {
  const g =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
        });
  return g as Guid;
}
