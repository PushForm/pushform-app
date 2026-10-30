// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { current, isDraft } from 'immer';
import type { LayoutDocumentState, LayoutEntity, LayoutImage, LayoutViewport, LayoutViewportCamera, LayoutViewportSource, ModelReference } from './LayoutDocument';

type V3 = [number, number, number];
type P2 = [number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

export function isViewport(entity: LayoutEntity | null | undefined): entity is LayoutEntity & { image: { viewport: LayoutViewport } } {
  return entity?.kind === 'image' && !!entity.image?.viewport;
}

export function isCloudSource(source: LayoutViewportSource): source is { referenceId: number } {
  return 'referenceId' in source;
}

/** A cloud model reference, as the document's views see it. */
export type CloudModelReference = ModelReference & { target: Extract<ModelReference['target'], { kind: 'cloud' }> };

export function isCloudReference(reference: ModelReference | undefined): reference is CloudModelReference {
  return reference?.target.kind === 'cloud';
}

/** The cloud reference a view looks through, or undefined for an embedded model or a missing reference. */
export function viewportCloudReference(state: LayoutDocumentState, source: LayoutViewportSource): CloudModelReference | undefined {
  if (!isCloudSource(source)) return undefined;
  const reference = state.references.get(source.referenceId);
  return isCloudReference(reference) ? reference : undefined;
}

/** Stable identity of what a view shows: the embedded model, or the cloud model at its referenced revision. */
export function viewportSourceKey(state: LayoutDocumentState, source: LayoutViewportSource): string {
  if (!isCloudSource(source)) return `${source.archiveId}\u0000${source.modelReferenceId}`;
  const reference = viewportCloudReference(state, source);
  return reference ? `cloud\u0000${reference.target.documentId}\u0000${reference.target.sha256}` : `cloud\u0000missing\u0000${source.referenceId}`;
}

/** An independent copy of a picture. A copied viewport keeps its source and settings but is no longer the imported original. */
export function copyLayoutImage(image: LayoutImage): LayoutImage {
  const copy = structuredClone(isDraft(image) ? current(image) : image);
  if (copy.viewport) copy.viewport.originalId = null;
  return copy;
}

/** A frame's paper size in millimeters, measured along its own (possibly rotated) edges. */
export function layoutFrameSize(points: readonly P2[]): { width: number; height: number } {
  const [tl, tr, , bl] = points;
  if (!tl || !tr || !bl) return { width: 0, height: 0 };
  return { width: Math.hypot(tr[0] - tl[0], tr[1] - tl[1]), height: Math.hypot(bl[0] - tl[0], bl[1] - tl[1]) };
}

/** Screen axes of a camera: forward, right, and orthogonalized up. */
export function viewportCameraBasis(camera: LayoutViewportCamera): { forward: V3; right: V3; up: V3 } {
  const forward = unit(sub(camera.target, camera.eye));
  let right = cross(forward, camera.up);
  if (Math.hypot(...right) < 1e-9) right = cross(forward, Math.abs(forward[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]);
  right = unit(right);
  return { forward, right, up: cross(right, forward) };
}

/** Visible model height across a frame of `heightMm`, in meters (parallel projection). */
export function viewportOrthoHeight(camera: LayoutViewportCamera, heightMm: number): number {
  return heightMm / 1000 / camera.scale;
}

/** Resize the frame without moving its model on paper, or scale its contents with frame height. */
export function resizedViewportCamera(camera: LayoutViewportCamera, before: readonly P2[], after: readonly P2[], preserve = true): LayoutViewportCamera {
  const oldSize = layoutFrameSize(before), size = layoutFrameSize(after);
  if (oldSize.width <= 0 || oldSize.height <= 0 || size.height <= 0) return camera;
  const ratio = size.height / oldSize.height;
  if (!preserve) return camera.projection === 'parallel' ? { ...camera, scale: camera.scale * ratio } : camera;
  const [a, b, c, d] = before;
  if (!a || !b || !c || !d || !after[0] || !after[2]) return camera;
  const dx = (after[0][0] + after[2][0] - a[0] - c[0]) / 2;
  const dy = (after[0][1] + after[2][1] - a[1] - c[1]) / 2;
  const x = (dx * (b[0] - a[0]) + dy * (b[1] - a[1])) / oldSize.width;
  const y = (dx * (d[0] - a[0]) + dy * (d[1] - a[1])) / oldSize.height;
  const perspective = camera.projection === 'perspective';
  const k = perspective ? oldSize.height / (2 * Math.tan(camera.fov * Math.PI / 360)) : camera.scale * 1000;
  const [sx, sy] = camera.shift ?? [0, 0];
  return { ...camera, shift: [sx + x / k, sy - y / k],
    ...(perspective ? { fov: 2 * Math.atan(Math.tan(camera.fov * Math.PI / 360) * ratio) * 180 / Math.PI } : {}),
  };
}

/**
 * Where a model point lands on the page, in paper millimeters, or null behind a perspective eye.
 * The frame center sits on the
 * view axis plus `shift`, perspective spans `fov` across the frame height, and parallel views use `scale`.
 */
export function viewportPaperPoint(points: readonly P2[], camera: LayoutViewportCamera, model: V3): P2 | null {
  const [tl, tr, , bl] = points;
  if (!tl || !tr || !bl) return null;
  const { width, height } = layoutFrameSize(points);
  if (width <= 0 || height <= 0) return null;
  const { forward, right, up } = viewportCameraBasis(camera);
  const d = sub(model, camera.eye);
  const depth = dot(d, forward);
  const perspective = camera.projection === 'perspective';
  if (perspective && depth <= 1e-9) return null;
  const x = perspective ? dot(d, right) / depth : dot(d, right);
  const y = perspective ? dot(d, up) / depth : dot(d, up);
  // Millimeters per image-plane unit.
  const k = perspective ? height / (2 * Math.tan(camera.fov * Math.PI / 360)) : camera.scale * 1000;
  const [sx, sy] = camera.shift ?? [0, 0];
  const u = (width / 2 + k * (x - sx)) / width, v = (height / 2 - k * (y - sy)) / height;
  return [tl[0] + (tr[0] - tl[0]) * u + (bl[0] - tl[0]) * v, tl[1] + (tr[1] - tl[1]) * u + (bl[1] - tl[1]) * v];
}

const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b));

export function viewportCamerasEqual(a: LayoutViewportCamera, b: LayoutViewportCamera, tolerance = 1e-9): boolean {
  const v = (p: readonly number[], q: readonly number[]) => p.every((value, i) => near(value, q[i]!, tolerance));
  return a.projection === b.projection && v(a.eye, b.eye) && v(a.target, b.target) && v(a.up, b.up) &&
    (a.projection === 'perspective' ? near(a.fov, b.fov, tolerance) : near(a.scale, b.scale, tolerance)) &&
    v(a.shift ?? [0, 0], b.shift ?? [0, 0]);
}

/**
 * Whether the viewport's picture was rendered for its current camera and frame size and,
 * for a cloud model, from the revision its reference now names.
 */
export function viewportCacheCurrent(viewport: LayoutViewport, points: readonly P2[], state?: LayoutDocumentState): boolean {
  const cache = viewport.cache;
  if (!cache) return false;
  if (isCloudSource(viewport.source)) {
    const reference = state ? viewportCloudReference(state, viewport.source) : undefined;
    if (!reference || cache.sha256 !== reference.target.sha256) return false;
  }
  const { width, height } = layoutFrameSize(points);
  // Paper coordinates round-trip through inches; a micrometer is far below a rendered pixel.
  const sameSize = Math.abs(cache.widthMm - width) < 1e-3 && Math.abs(cache.heightMm - height) < 1e-3;
  // A perspective picture only scales with the frame when the aspect is unchanged.
  const sameAspect = Math.abs(cache.widthMm * height - cache.heightMm * width) < 1e-3 * Math.max(1, width * height);
  return viewportCamerasEqual(viewport.camera, cache.camera) &&
    (sameSize || viewport.camera.projection === 'perspective' && sameAspect);
}
