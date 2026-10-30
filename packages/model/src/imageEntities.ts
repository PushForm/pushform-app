// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { m4transformPoint } from '@pushform/core';
import type { Id, ImageId, Mat4, TagId, Vec3 } from '@pushform/core';
import type { ImageEntity } from './entities';

/** Size of one picture pixel when a picture is imported into a model: 1 mm, so a 1000-pixel picture is 1 m wide. */
export const IMAGE_PIXEL_SIZE_M = 0.001;

/** A new image entity on the given tag, visible and casting/receiving shadows like other entities. */
export function newImageEntity(id: Id, imageId: ImageId, transform: Mat4, widthM: number, heightM: number, tagId: TagId): ImageEntity {
  return { id, imageId, transform, widthM, heightM, tagId, hidden: false, locked: false, castShadows: true, receiveShadows: true, attributes: {} };
}

/**
 * The picture's rectangle in its container's coordinates, counter-clockwise seen from its front (local +z): origin
 * corner, then along local x, the far corner, then along local y.
 */
export function imageEntityCorners(image: Pick<ImageEntity, 'transform' | 'widthM' | 'heightM'>): Vec3[] {
  const { transform: m, widthM: w, heightM: h } = image;
  return [m4transformPoint(m, [0, 0, 0]), m4transformPoint(m, [w, 0, 0]), m4transformPoint(m, [w, h, 0]), m4transformPoint(m, [0, h, 0])];
}

/** The picture's size as placed: the lengths of its sides in its container (the transform may scale it). */
export function imageEntitySize(image: Pick<ImageEntity, 'transform' | 'widthM' | 'heightM'>): { width: number; height: number } {
  const [a, b, , d] = imageEntityCorners(image) as [Vec3, Vec3, Vec3, Vec3];
  return { width: Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), height: Math.hypot(d[0] - a[0], d[1] - a[1], d[2] - a[2]) };
}
