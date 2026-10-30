// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { base64ToBytes } from '@pushform/model';
import type { Rgb } from '@pushform/model';

/**
 * Built-in material library (Materials › libraries): a small set of
 * named colors plus a few procedural textures drawn with Canvas (256 px PNGs, generated lazily
 * in the browser; `generateLibraryTexture` returns null where no 2D canvas exists, e.g. Node).
 */

export interface LibraryTexture {
  readonly widthM: number;
  readonly heightM: number;
  /** Pixel size of the generated image (square). */
  readonly px: number;
}

export interface LibraryMaterial {
  readonly key: string;
  readonly name: string;
  readonly category: 'Colors' | 'Wood' | 'Brick' | 'Tile' | 'Glass' | 'Metal' | 'Stone';
  readonly color: Rgb;
  readonly alpha?: number | undefined;
  readonly texture?: LibraryTexture | undefined;
}

const c = (r: number, g: number, b: number): Rgb => [r / 255, g / 255, b / 255];

export const BUILTIN_LIBRARY: readonly LibraryMaterial[] = [
  // Colors
  { key: 'Color_A01', name: 'Color_A01', category: 'Colors', color: c(255, 255, 255) },
  { key: 'Color_A02', name: 'Color_A02', category: 'Colors', color: c(230, 230, 230) },
  { key: 'Color_A03', name: 'Color_A03', category: 'Colors', color: c(179, 179, 179) },
  { key: 'Color_A04', name: 'Color_A04', category: 'Colors', color: c(128, 128, 128) },
  { key: 'Color_A05', name: 'Color_A05', category: 'Colors', color: c(77, 77, 77) },
  { key: 'Color_A06', name: 'Color_A06', category: 'Colors', color: c(26, 26, 26) },
  { key: 'Color_B01', name: 'Color_B01', category: 'Colors', color: c(255, 0, 0) },
  { key: 'Color_B02', name: 'Color_B02', category: 'Colors', color: c(255, 128, 0) },
  { key: 'Color_B03', name: 'Color_B03', category: 'Colors', color: c(255, 255, 0) },
  { key: 'Color_B04', name: 'Color_B04', category: 'Colors', color: c(0, 255, 0) },
  { key: 'Color_B05', name: 'Color_B05', category: 'Colors', color: c(0, 255, 255) },
  { key: 'Color_B06', name: 'Color_B06', category: 'Colors', color: c(0, 0, 255) },
  { key: 'Color_B07', name: 'Color_B07', category: 'Colors', color: c(128, 0, 255) },
  { key: 'Color_B08', name: 'Color_B08', category: 'Colors', color: c(255, 0, 255) },
  { key: 'Color_C01', name: 'Color_C01', category: 'Colors', color: c(237, 207, 181) },
  { key: 'Color_C02', name: 'Color_C02', category: 'Colors', color: c(214, 167, 118) },
  { key: 'Color_C03', name: 'Color_C03', category: 'Colors', color: c(160, 108, 66) },
  { key: 'Color_C04', name: 'Color_C04', category: 'Colors', color: c(102, 66, 38) },
  { key: 'Color_D01', name: 'Color_D01', category: 'Colors', color: c(197, 220, 244) },
  { key: 'Color_D02', name: 'Color_D02', category: 'Colors', color: c(118, 171, 227) },
  { key: 'Color_D03', name: 'Color_D03', category: 'Colors', color: c(54, 110, 186) },
  { key: 'Color_E01', name: 'Color_E01', category: 'Colors', color: c(206, 232, 191) },
  { key: 'Color_E02', name: 'Color_E02', category: 'Colors', color: c(141, 196, 108) },
  { key: 'Color_E03', name: 'Color_E03', category: 'Colors', color: c(68, 136, 48) },
  // Translucent
  { key: 'Translucent_Glass_Blue', name: 'Translucent_Glass_Blue', category: 'Glass', color: c(170, 205, 235), alpha: 0.45 },
  { key: 'Translucent_Glass_Gray', name: 'Translucent_Glass_Gray', category: 'Glass', color: c(180, 185, 190), alpha: 0.5 },
  // Metal / stone (plain colors)
  { key: 'Metal_Aluminum', name: 'Metal_Aluminum', category: 'Metal', color: c(196, 199, 204) },
  { key: 'Metal_Brushed_Steel', name: 'Metal_Brushed_Steel', category: 'Metal', color: c(150, 154, 160) },
  { key: 'Stone_Granite', name: 'Stone_Granite', category: 'Stone', color: c(130, 126, 122) },
  // Procedural textures
  { key: 'Wood_Cherry', name: 'Wood_Cherry', category: 'Wood', color: c(150, 82, 52), texture: { widthM: 0.6, heightM: 0.6, px: 256 } },
  { key: 'Wood_Pine', name: 'Wood_Pine', category: 'Wood', color: c(214, 176, 120), texture: { widthM: 0.6, heightM: 0.6, px: 256 } },
  { key: 'Brick_Antique', name: 'Brick_Antique', category: 'Brick', color: c(150, 84, 66), texture: { widthM: 0.5, heightM: 0.5, px: 256 } },
  { key: 'Tile_Ceramic', name: 'Tile_Ceramic', category: 'Tile', color: c(226, 226, 220), texture: { widthM: 0.3, heightM: 0.3, px: 256 } },
];

export function libraryMaterial(key: string): LibraryMaterial | undefined {
  return BUILTIN_LIBRARY.find((m) => m.key === key);
}

const pngCache = new Map<string, Uint8Array | null>();

/**
 * PNG bytes of a procedural library texture, drawn with the 2D canvas; cached per key. Null when
 * the entry has no texture or no canvas is available (Node tests, jsdom).
 */
export function generateLibraryTexture(key: string): Uint8Array | null {
  const entry = libraryMaterial(key);
  if (!entry?.texture) return null;
  if (pngCache.has(key)) return pngCache.get(key)!;
  const png = drawTexture(key, entry.texture.px);
  pngCache.set(key, png);
  return png;
}

/** Deterministic pseudo random (textures look the same every time). */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 10000) / 10000;
  };
}

function drawTexture(key: string, px: number): Uint8Array | null {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc?.createElement) return null;
  let canvas: HTMLCanvasElement;
  let g: CanvasRenderingContext2D | null;
  try {
    canvas = doc.createElement('canvas');
    canvas.width = px;
    canvas.height = px;
    g = canvas.getContext('2d');
  } catch {
    return null;
  }
  if (!g) return null;
  switch (key) {
    case 'Wood_Cherry':
      drawWood(g, px, '#8f4a2c', '#6e3520', '#a75f3d', 11);
      break;
    case 'Wood_Pine':
      drawWood(g, px, '#d9b57c', '#b98f58', '#e6c894', 17);
      break;
    case 'Brick_Antique':
      drawBrick(g, px);
      break;
    case 'Tile_Ceramic':
      drawTile(g, px);
      break;
    default:
      return null;
  }
  try {
    const url = canvas.toDataURL('image/png');
    if (!url.startsWith('data:image/png')) return null;
    return base64ToBytes(url);
  } catch {
    return null;
  }
}

function drawWood(g: CanvasRenderingContext2D, px: number, base: string, dark: string, light: string, seed: number): void {
  const r = rng(seed);
  g.fillStyle = base;
  g.fillRect(0, 0, px, px);
  // grain: wavy vertical lines
  for (let i = 0; i < 48; i++) {
    const x0 = (i / 48) * px + r() * 6;
    g.strokeStyle = r() > 0.5 ? dark : light;
    g.globalAlpha = 0.25 + r() * 0.35;
    g.lineWidth = 1 + r() * 2;
    g.beginPath();
    g.moveTo(x0, 0);
    for (let y = 0; y <= px; y += 8) g.lineTo(x0 + Math.sin((y / px) * Math.PI * (2 + r() * 2) + i) * 3, y);
    g.stroke();
  }
  g.globalAlpha = 1;
}

function drawBrick(g: CanvasRenderingContext2D, px: number): void {
  const r = rng(23);
  g.fillStyle = '#b9ada2'; // mortar
  g.fillRect(0, 0, px, px);
  const rows = 8, cols = 4;
  const bh = px / rows, bw = px / cols, gap = 3;
  const tones = ['#9a5240', '#8d4a3b', '#a65a46', '#7f4034', '#b06a52'];
  for (let row = 0; row < rows; row++) {
    const offset = row % 2 ? bw / 2 : 0;
    for (let col = -1; col <= cols; col++) {
      const x = col * bw + offset, y = row * bh;
      g.fillStyle = tones[Math.floor(r() * tones.length)]!;
      g.fillRect(x + gap / 2, y + gap / 2, bw - gap, bh - gap);
      // weathering speckles
      g.fillStyle = 'rgba(0,0,0,0.12)';
      for (let k = 0; k < 6; k++) g.fillRect(x + gap + r() * (bw - 2 * gap), y + gap + r() * (bh - 2 * gap), 2, 2);
    }
  }
}

function drawTile(g: CanvasRenderingContext2D, px: number): void {
  const r = rng(7);
  g.fillStyle = '#c9c9c3'; // grout
  g.fillRect(0, 0, px, px);
  const n = 4, size = px / n, gap = 4;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const v = 222 + Math.floor(r() * 18);
      g.fillStyle = `rgb(${v},${v},${v - 6})`;
      g.fillRect(i * size + gap / 2, j * size + gap / 2, size - gap, size - gap);
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.fillRect(i * size + gap / 2, j * size + gap / 2, size - gap, 2);
      g.fillRect(i * size + gap / 2, j * size + gap / 2, 2, size - gap);
    }
  }
}
