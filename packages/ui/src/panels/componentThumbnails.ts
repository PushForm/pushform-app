// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { DefId, Vec3 } from '@pushform/core';
import type { ComponentDefinition, DocumentState } from '@pushform/model';
import { Viewport, type CameraState, type RenderBody, type RenderSketch } from '@pushform/render';
import { bodiesToRender, imagesToRender, sketchesToRender } from '../engine/renderAdapter';

/**
 * Components panel thumbnails: each component drawn alone, from the iso direction, in an offscreen viewport
 * shared by every panel. A thumbnail is kept while its definition is unchanged (definitions are immutable records).
 */

const cache = new WeakMap<ComponentDefinition, string>();
let offscreen: Viewport | null | undefined;

function renderer(): Viewport | null {
  if (offscreen === undefined) {
    const view = new Viewport({ grid: false });
    offscreen = view.mountOffscreen() ? view : null;
  }
  return offscreen;
}

/** The thumbnail drawn so far for a definition, or undefined until `renderComponentThumbnail` has run for this version. */
export function cachedComponentThumbnail(def: ComponentDefinition): string | undefined {
  return cache.get(def);
}

/** Draw a definition's thumbnail as a PNG data URL, '' where it draws nothing or there is no WebGL. */
export function renderComponentThumbnail(state: DocumentState, id: DefId, width = 96, height = 72): string {
  const def = state.definitions.get(id);
  if (!def) return '';
  const known = cache.get(def);
  if (known !== undefined) return known;
  let picture = '';
  const view = renderer();
  if (view) {
    // The definition drawn as the model: its own geometry and what it places, at the origin.
    const alone: DocumentState = { ...state, rootDefinitionId: id };
    const bodies = bodiesToRender(alone), sketches = sketchesToRender(alone);
    const bounds = drawnBounds(bodies, sketches);
    if (bounds) {
      view.setBodies(bodies);
      view.setSketches(sketches);
      view.setImages(imagesToRender(alone));
      picture = view.snapshot(width, height, isoCamera(bounds, width / height), { background: null });
    }
  }
  cache.set(def, picture);
  return picture;
}

/** A perspective view along (1, −1, 0.8) that fits the bounds' sphere, like the sample check's fitted view. */
export function isoCamera(bounds: { min: Vec3; max: Vec3 }, aspect: number, fov = 35): CameraState {
  const target: Vec3 = [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, (bounds.min[2] + bounds.max[2]) / 2];
  const radius = Math.max(Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]) / 2, 1e-3);
  const vertical = (fov * Math.PI) / 360, horizontal = Math.atan(Math.tan(vertical) * aspect);
  const distance = radius / Math.sin(Math.min(vertical, horizontal));
  const length = Math.hypot(1, 1, 0.8), d: Vec3 = [1 / length, -1 / length, 0.8 / length];
  return { eye: [target[0] + d[0] * distance, target[1] + d[1] * distance, target[2] + d[2] * distance], target, up: [0, 0, 1],
    fov, projection: 'perspective', orthoHeight: 2 * radius };
}

function drawnBounds(bodies: readonly RenderBody[], sketches: readonly RenderSketch[]): { min: Vec3; max: Vec3 } | null {
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const add = (x: number, y: number, z: number): void => {
    min[0] = Math.min(min[0], x); min[1] = Math.min(min[1], y); min[2] = Math.min(min[2], z);
    max[0] = Math.max(max[0], x); max[1] = Math.max(max[1], y); max[2] = Math.max(max[2], z);
  };
  for (const body of bodies) {
    const m = body.transform, v = body.mesh.verts;
    for (let i = 0; i < v.length; i += 3) {
      const x = v[i]!, y = v[i + 1]!, z = v[i + 2]!;
      add(m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!);
    }
  }
  for (const sketch of sketches) for (const edge of sketch.edges) { add(...edge.a); add(...edge.b); }
  return Number.isFinite(min[0]) ? { min, max } : null;
}
