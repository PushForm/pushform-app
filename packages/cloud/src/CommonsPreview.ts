// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { studioColor, type StudioLightingPreset } from '@pushform/core';
/** Small display derivatives only: no editor, kernel, textures, scripts or external resources. */
export const PREVIEW_BYTE_LIMIT = 8 * 1024 * 1024;
export const PREVIEW_TRIANGLE_LIMIT = 12000;
export interface PreviewMesh { version: 1; positions: number[]; colors?: number[] }
export const COMMONS_RENDER_VERSION = 'viewport-1';
export const isPreviewModelFile = (name: string): boolean => /\.(pf|step|stp|fcstd|stl|obj|glb|gltf|dae|3ds|skp|zip)$/i.test(name);
// Front-right-top isometric view: eye along +X, -Y, +Z with world Z up.
export const DEFAULT_PREVIEW_VIEW = { yaw: -Math.PI / 4, pitch: Math.asin(1 / Math.sqrt(3)), zoom: 1 };
export interface PreviewView { yaw: number; pitch: number; zoom: number }

export function stlPreview(bytes: Uint8Array): PreviewMesh {
  if (!bytes.length || bytes.length > PREVIEW_BYTE_LIMIT) throw new Error('This model exceeds the 8 MiB preview limit.');
  const positions: number[] = [];
  const append = (values: number[]) => {
    if (values.length !== 9 || !values.every(Number.isFinite)) throw new Error('The STL has invalid coordinates.');
    if (positions.length / 9 >= PREVIEW_TRIANGLE_LIMIT) throw new Error('This model exceeds the 12,000 triangle preview limit.');
    positions.push(...values);
  };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = bytes.length >= 84 ? view.getUint32(80, true) : 0;
  if (bytes.length >= 84 && 84 + count * 50 === bytes.length) {
    if (count > PREVIEW_TRIANGLE_LIMIT) throw new Error('This model exceeds the 12,000 triangle preview limit.');
    for (let triangle = 0; triangle < count; triangle++) append(Array.from({ length: 9 }, (_, i) => view.getFloat32(96 + triangle * 50 + i * 4, true)));
  } else {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!/^\s*solid\b/i.test(text) || !/\bendsolid\b/i.test(text)) throw new Error('This file is not a supported STL model.');
    let corners: number[] | null = null;
    for (let at = 0; at < text.length;) {
      const end = text.indexOf('\n', at); const line = text.slice(at, end < 0 ? text.length : end); at = end < 0 ? text.length : end + 1;
      const words = line.trim().split(/\s+/); const keyword = words[0]?.toLowerCase();
      if (keyword === 'outer') { if (corners !== null) throw new Error('The STL contains an incomplete triangle.'); corners = []; }
      else if (keyword === 'vertex') {
        if (corners === null || words.length !== 4 || corners.length >= 9) throw new Error('The STL contains an invalid triangle.');
        corners.push(...words.slice(1).map(Number));
      } else if (keyword === 'endloop') {
        if (corners === null) throw new Error('The STL contains an invalid triangle.');
        append(corners); corners = null;
      }
    }
    if (corners !== null) throw new Error('The STL contains an incomplete triangle.');
  }
  return normalizePreview(positions);
}

export function normalizePreview(positions: number[], colors?: number[]): PreviewMesh {
  if (positions.length % 9 || positions.length > PREVIEW_TRIANGLE_LIMIT * 9 || !positions.every(Number.isFinite)) throw new Error('Preview geometry exceeds its limit or has invalid coordinates.');
  if (colors && (colors.length !== positions.length / 3 || !colors.every(n => Number.isFinite(n) && n >= 0 && n <= 1))) throw new Error('Invalid preview colors.');
  if (!positions.length) throw new Error('This STL contains no triangles.');
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  positions.forEach((value, i) => { const axis = i % 3; min[axis] = Math.min(min[axis]!, value); max[axis] = Math.max(max[axis]!, value); });
  const span = Math.max(...max.map((value, i) => value - min[i]!));
  if (!Number.isFinite(span) || span <= 0) throw new Error('This STL has no visible geometry.');
  const center = min.map((value, i) => value + (max[i]! - value) / 2);
  const normalized = positions.map((value, i) => Number(((value - center[i % 3]!) / span).toFixed(6)));
  const result: number[] = [], keptColors: number[] = [];
  for (let i = 0; i < normalized.length; i += 9) {
    const a = normalized.slice(i, i + 3), b = normalized.slice(i + 3, i + 6), c = normalized.slice(i + 6, i + 9);
    const u = b.map((v, k) => v - a[k]!), v = c.map((n, k) => n - a[k]!);
    if (Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!) > 0) { result.push(...normalized.slice(i, i + 9)); if (colors) keptColors.push(...colors.slice(i / 3, i / 3 + 3)); }
  }
  if (!result.length) throw new Error('This STL has no visible geometry.');
  return { version: 1, positions: result, ...(colors ? { colors: keptColors } : {}) };
}

export function parsePreviewMesh(value: unknown): PreviewMesh {
  const mesh = value as Partial<PreviewMesh> | null;
  if (!mesh || mesh.version !== 1 || !Array.isArray(mesh.positions) || !mesh.positions.length || mesh.positions.length % 9 || mesh.positions.length > PREVIEW_TRIANGLE_LIMIT * 9 ||
    !mesh.positions.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= .500001)) throw new Error('The model preview is invalid.');
  if (mesh.colors !== undefined && (!Array.isArray(mesh.colors) || mesh.colors.length !== mesh.positions.length / 3 || !mesh.colors.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1))) throw new Error('The model preview colors are invalid.');
  return { version: 1, positions: mesh.positions, ...(mesh.colors ? { colors: mesh.colors } : {}) };
}

/** A projected face: its outline, shaded fill and depth for painter's ordering. */
export interface PreviewFace { points: string; fill: string; depth: number }

const LIGHT = (() => { const l = [-.42, .82, .38]; const n = Math.hypot(...l); return l.map(v => v / n); })();
export function projectPreview(mesh: PreviewMesh, view: PreviewView = DEFAULT_PREVIEW_VIEW, lighting: StudioLightingPreset | 'legacy' = 'bright'): PreviewFace[] {
  const cy = Math.cos(view.yaw), sy = Math.sin(view.yaw), cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
  const projected: PreviewFace[] = [];
  for (let i = 0; i < mesh.positions.length; i += 9) {
    const points = [0, 3, 6].map(k => {
      const x = mesh.positions[i + k]!, y = mesh.positions[i + k + 1]!, z = mesh.positions[i + k + 2]!;
      const rx = cy * x - sy * y, ry = -(sy * x + cy * y);
      return [rx, cp * z - sp * ry, cp * ry + sp * z];
    });
    const [a, b, c] = points as [number[], number[], number[]];
    const u = b.map((v, k) => v - a[k]!), v = c.map((n, k) => n - a[k]!);
    let nx = u[1]! * v[2]! - u[2]! * v[1]!, ny = u[2]! * v[0]! - u[0]! * v[2]!, nz = u[0]! * v[1]! - u[1]! * v[0]!;
    const length = Math.hypot(nx, ny, nz) || 1;
    nx /= length; ny /= length; nz /= length;
    // Two-sided: turn every face towards the viewer, then light it with a key light from the upper left plus ambient.
    if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
    const diffuse = Math.max(0, nx * LIGHT[0]! + ny * LIGHT[1]! + nz * LIGHT[2]!);
    const light = Math.min(1.08, .38 + .52 * diffuse + .14 * nz);
    const color = mesh.colors?.slice(i / 3, i / 3 + 3).map(n => n * 255) ?? [158, 184, 172];
    const shade = lighting === 'legacy' ? color.map(c => Math.min(255, Math.round(c * light)))
      : studioColor([color[0]! / 255, color[1]! / 255, color[2]! / 255], [nx, ny, nz], lighting).map(c => Math.round(c * 255));
    const xy = points.map(p => [(240 + p[0]! * 265 * view.zoom).toFixed(2), (200 - p[1]! * 265 * view.zoom).toFixed(2)]);
    projected.push({ points: xy.map(p => p.join(',')).join(' '),
      fill: `rgb(${shade[0]},${shade[1]},${shade[2]})`,
      depth: points.reduce((n, p) => n + p[2]!, 0) });
  }
  return projected.sort((a, b) => a.depth - b.depth);
}

/** No mesh lines are drawn. Each face is outlined in its own colour, which closes the hairline gaps antialiasing
 * leaves between triangles, so the surface reads as one shaded shape. */
export function previewSvg(mesh: PreviewMesh): string {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 400" role="img" aria-label="Model thumbnail"><rect width="480" height="400" fill="#eef0e8"/>' +
    projectPreview(mesh).map(p => `<polygon points="${p.points}" fill="${p.fill}" stroke="${p.fill}" stroke-width="0.6" stroke-linejoin="round"/>`).join('') + '</svg>';
}

export interface RasterOptions {
  width?: number; height?: number; supersample?: number;
  lighting?: StudioLightingPreset | 'legacy';
  /** Frame the model to fill the image (thumbnails) instead of using the view's fixed scale (interactive view). */
  fit?: boolean;
  /** Outline width in output pixels. */
  edgeWidth?: number;
}
/** Edges are found in the rendered image, not the mesh: where the surface meets the background, where two faces
 * meet at more than this angle, or where a nearer surface overlaps a farther one. Seams between triangles on the same
 * surface (including T-junctions) leave no line. */
const RASTER_CREASE_COS = Math.cos(30 * Math.PI / 180);
const RASTER_DEPTH_STEP = 0.02;
const RASTER_BACKGROUND = [238, 240, 232] as const;
const RASTER_EDGE = [22, 26, 30] as const;

/**
 * Draws the mesh with a depth buffer, so nearer surfaces always hide farther ones, and outlines its silhouette and
 * creases like a modelling viewport. Returns RGBA pixels at `width` x `height`, antialiased by supersampling.
 * The view frame matches `projectPreview` (a 480 x 400 frame, scaled to the requested size).
 */
export function rasterPreview(mesh: PreviewMesh, view: PreviewView = DEFAULT_PREVIEW_VIEW, options: RasterOptions = {}): Uint8ClampedArray {
  const width = Math.max(1, Math.round(options.width ?? 480)), height = Math.max(1, Math.round(options.height ?? 400));
  const s = Math.max(1, Math.min(4, Math.round(options.supersample ?? 2))), W = width * s, H = height * s;
  const cy = Math.cos(view.yaw), sy = Math.sin(view.yaw), cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
  const p = mesh.positions, count = p.length / 9;
  let unit = 265 * view.zoom * Math.min(width / 480, height / 400) * s, ox = W / 2, oy = H / 2;
  if (options.fit && count) {
    // Fit the projected model into the frame with a margin, centred.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i]!, y = p[i + 1]!, z = p[i + 2]!, rx = cy * x - sy * y, ry = -(sy * x + cy * y), vy = cp * z - sp * ry;
      if (rx < minX) minX = rx; if (rx > maxX) maxX = rx; if (vy < minY) minY = vy; if (vy > maxY) maxY = vy;
    }
    const margin = .1, spanX = Math.max(1e-6, maxX - minX), spanY = Math.max(1e-6, maxY - minY);
    unit = Math.min(W * (1 - 2 * margin) / spanX, H * (1 - 2 * margin) / spanY);
    ox = W / 2 - (minX + maxX) / 2 * unit; oy = H / 2 + (minY + maxY) / 2 * unit;
  }
  const depth = new Float32Array(W * H).fill(-Infinity), face = new Int32Array(W * H).fill(-1);
  const normals = new Float32Array(count * 3), shades = new Uint8ClampedArray(count * 3);
  const sx = [0, 0, 0], syy = [0, 0, 0], sz = [0, 0, 0], vx3 = [0, 0, 0], vy3 = [0, 0, 0];
  for (let t = 0; t < count; t++) {
    const i = t * 9;
    for (let k = 0; k < 3; k++) {
      const x = p[i + k * 3]!, y = p[i + k * 3 + 1]!, z = p[i + k * 3 + 2]!;
      const rx = cy * x - sy * y, ry = -(sy * x + cy * y);
      vx3[k] = rx; vy3[k] = cp * z - sp * ry; sz[k] = cp * ry + sp * z;
      sx[k] = ox + rx * unit; syy[k] = oy - vy3[k]! * unit;
    }
    // Normal in view space, turned towards the viewer: winding is not reliable in converted meshes.
    const ux = vx3[1]! - vx3[0]!, uy = vy3[1]! - vy3[0]!, uz = sz[1]! - sz[0]!, vx = vx3[2]! - vx3[0]!, vy = vy3[2]! - vy3[0]!, vz = sz[2]! - sz[0]!;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz) || 1; nx /= length; ny /= length; nz /= length;
    if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
    normals[t * 3] = nx; normals[t * 3 + 1] = ny; normals[t * 3 + 2] = nz;
    const diffuse = Math.max(0, nx * LIGHT[0]! + ny * LIGHT[1]! + nz * LIGHT[2]!);
    // Ambient plus a key light from the upper left and a little facing light, so top, front and side faces separate.
    const light = Math.min(1.15, .46 + .56 * diffuse + .1 * nz);
    const color = mesh.colors ? [mesh.colors[i / 3]! * 255, mesh.colors[i / 3 + 1]! * 255, mesh.colors[i / 3 + 2]! * 255] : [158, 184, 172];
    const shaded = options.lighting === 'legacy' ? color.map(c => c * light)
      : studioColor([color[0]! / 255, color[1]! / 255, color[2]! / 255], [nx, ny, nz], options.lighting ?? 'bright').map(c => c * 255);
    shades[t * 3] = shaded[0]!; shades[t * 3 + 1] = shaded[1]!; shades[t * 3 + 2] = shaded[2]!;
    const area = (sx[1]! - sx[0]!) * (syy[2]! - syy[0]!) - (syy[1]! - syy[0]!) * (sx[2]! - sx[0]!);
    if (Math.abs(area) < 1e-9) continue;
    const x0 = Math.max(0, Math.floor(Math.min(sx[0]!, sx[1]!, sx[2]!))), x1 = Math.min(W - 1, Math.ceil(Math.max(sx[0]!, sx[1]!, sx[2]!)));
    const y0 = Math.max(0, Math.floor(Math.min(syy[0]!, syy[1]!, syy[2]!))), y1 = Math.min(H - 1, Math.ceil(Math.max(syy[0]!, syy[1]!, syy[2]!)));
    for (let py = y0; py <= y1; py++) {
      const cyp = py + .5;
      for (let px = x0; px <= x1; px++) {
        const cxp = px + .5;
        const w0 = ((sx[2]! - sx[1]!) * (cyp - syy[1]!) - (syy[2]! - syy[1]!) * (cxp - sx[1]!)) / area;
        const w1 = ((sx[0]! - sx[2]!) * (cyp - syy[2]!) - (syy[0]! - syy[2]!) * (cxp - sx[2]!)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * sz[0]! + w1 * sz[1]! + w2 * sz[2]!, at = py * W + px;
        if (z > depth[at]!) { depth[at] = z; face[at] = t; }
      }
    }
  }
  // An outline sample: the surface meets the background, a crease, or a depth step to a farther surface.
  const outline = (at: number, other: number): boolean => {
    const f = face[at]!, g = face[other]!;
    if (g < 0) return true;
    if (g === f) return false;
    const dot = normals[f * 3]! * normals[g * 3]! + normals[f * 3 + 1]! * normals[g * 3 + 1]! + normals[f * 3 + 2]! * normals[g * 3 + 2]!;
    return dot < RASTER_CREASE_COS || depth[at]! - depth[other]! > RASTER_DEPTH_STEP;
  };
  // Mark outline samples, then widen them to the requested width.
  const marks = new Uint8Array(W * H);
  for (let Y = 0; Y < H; Y++) for (let X = 0; X < W; X++) {
    const at = Y * W + X;
    if (face[at]! < 0) continue;
    if ((X + 1 < W && outline(at, at + 1)) || (X > 0 && outline(at, at - 1)) || (Y + 1 < H && outline(at, at + W)) || (Y > 0 && outline(at, at - W))) marks[at] = 1;
  }
  const radius = Math.max(0, Math.round((options.edgeWidth ?? 1.6) * s / 2) - 1);
  let edges = marks;
  if (radius > 0) {
    edges = new Uint8Array(W * H);
    for (let Y = 0; Y < H; Y++) for (let X = 0; X < W; X++) {
      if (!marks[Y * W + X]) continue;
      for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
        const x2 = X + dx, y2 = Y + dy;
        if (x2 >= 0 && y2 >= 0 && x2 < W && y2 < H && dx * dx + dy * dy <= radius * radius + radius) edges[y2 * W + x2] = 1;
      }
    }
  }
  const out = new Uint8ClampedArray(width * height * 4), samples = s * s;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let r = 0, g = 0, b = 0;
    for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) {
      const at = (y * s + dy) * W + x * s + dx, f = face[at]!;
      const c: readonly number[] = edges[at] ? RASTER_EDGE : f < 0 ? RASTER_BACKGROUND : [shades[f * 3]!, shades[f * 3 + 1]!, shades[f * 3 + 2]!];
      r += c[0]!; g += c[1]!; b += c[2]!;
    }
    const o = (y * width + x) * 4;
    out[o] = r / samples; out[o + 1] = g / samples; out[o + 2] = b / samples; out[o + 3] = 255;
  }
  return out;
}
