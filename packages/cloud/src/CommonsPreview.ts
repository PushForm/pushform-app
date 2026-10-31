// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/** Small display derivatives only: no editor, kernel, textures, scripts or external resources. */
export const PREVIEW_BYTE_LIMIT = 8 * 1024 * 1024;
export const PREVIEW_TRIANGLE_LIMIT = 12000;
export interface PreviewMesh { version: 1; positions: number[]; colors?: number[] }
export const COMMONS_RENDER_VERSION = 'display-2';
export const isPreviewModelFile = (name: string): boolean => /\.(pf|step|stp|fcstd|stl|obj|glb|gltf|dae|3ds|skp|zip)$/i.test(name);
export const DEFAULT_PREVIEW_VIEW = { yaw: -.65, pitch: .45, zoom: 1 };
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

export function projectPreview(mesh: PreviewMesh, view: PreviewView = DEFAULT_PREVIEW_VIEW): { points: string; fill: string; depth: number }[] {
  const cy = Math.cos(view.yaw), sy = Math.sin(view.yaw), cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
  const projected: { points: string; fill: string; depth: number }[] = [];
  for (let i = 0; i < mesh.positions.length; i += 9) {
    const points = [0, 3, 6].map(k => {
      const x = mesh.positions[i + k]!, y = mesh.positions[i + k + 1]!, z = mesh.positions[i + k + 2]!;
      const rx = cy * x - sy * y, ry = sy * x + cy * y;
      return [rx, cp * z - sp * ry, cp * ry + sp * z];
    });
    const [a, b, c] = points as [number[], number[], number[]];
    const u = b.map((v, k) => v - a[k]!), v = c.map((n, k) => n - a[k]!);
    const nx = u[1]! * v[2]! - u[2]! * v[1]!, ny = u[2]! * v[0]! - u[0]! * v[2]!, nz = u[0]! * v[1]! - u[1]! * v[0]!;
    const length = Math.hypot(nx, ny, nz);
    const light = length ? .5 + .45 * Math.abs((-.4 * nx + .7 * ny + .6 * nz) / length) : .5;
    const color = mesh.colors?.slice(i / 3, i / 3 + 3).map(n => n * 255) ?? [152, 182, 168];
    projected.push({ points: points.map(p => `${(240 + p[0]! * 265 * view.zoom).toFixed(2)},${(200 - p[1]! * 265 * view.zoom).toFixed(2)}`).join(' '),
      fill: `rgb(${Math.round(color[0]! * light)},${Math.round(color[1]! * light)},${Math.round(color[2]! * light)})`, depth: points.reduce((n, p) => n + p[2]!, 0) });
  }
  return projected.sort((a, b) => a.depth - b.depth);
}

export function previewSvg(mesh: PreviewMesh): string {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 400" role="img" aria-label="Model thumbnail"><rect width="480" height="400" fill="#eef0e8"/>' +
    projectPreview(mesh).map(p => `<polygon points="${p.points}" fill="${p.fill}" stroke="#40584e" stroke-width="0.5" stroke-linejoin="round"/>`).join('') + '</svg>';
}
