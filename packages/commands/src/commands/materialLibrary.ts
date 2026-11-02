// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Rgb } from '@pushform/model';
import type * as NodeFs from 'node:fs/promises';

/** Built-in finishes. Image maps are bundled locally and embedded in documents when used. */
export interface LibraryTexture {
  readonly widthM: number;
  readonly heightM: number;
  /** Pixel size of the square image. */
  readonly px: number;
  readonly url: string;
  readonly previewUrl: string;
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
  // Transparent glass tints; these intentionally have no surface pattern.
  { key: 'Translucent_Glass_Clear', name: 'Clear Glass', category: 'Glass', color: c(230, 242, 242), alpha: 0.18 },
  { key: 'Translucent_Glass_Blue', name: 'Blue Glass', category: 'Glass', color: c(170, 205, 235), alpha: 0.45 },
  { key: 'Translucent_Glass_Gray', name: 'Smoke Glass', category: 'Glass', color: c(180, 185, 190), alpha: 0.5 },
  { key: 'Translucent_Glass_Green', name: 'Green Glass', category: 'Glass', color: c(157, 205, 181), alpha: 0.35 },
  { key: 'Translucent_Glass_Bronze', name: 'Bronze Glass', category: 'Glass', color: c(183, 146, 109), alpha: 0.4 },
  { key: 'Translucent_Glass_Dark', name: 'Dark Glass', category: 'Glass', color: c(73, 83, 91), alpha: 0.65 },
  { key: 'Metal_Aluminum', name: 'Aluminum', category: 'Metal', color: c(196, 199, 204) },
  { key: 'Metal_Brushed_Steel', name: 'Steel', category: 'Metal', color: c(150, 154, 160) },
  {
    key: 'Wood_Cherry', name: 'Cherry', category: 'Wood', color: c(224, 176, 132),
    texture: {
      widthM: 1.0, heightM: 1.0, px: 1024,
      url: new URL('./material-textures/cherry_veneer.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/cherry_veneer-preview.jpg', import.meta.url).href,
    },
  },
  {
    key: 'Wood_Pine', name: 'Pine', category: 'Wood', color: c(104, 57, 7),
    texture: {
      widthM: 0.74, heightM: 0.74, px: 1024,
      url: new URL('./material-textures/coated_pine.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/coated_pine-preview.jpg', import.meta.url).href,
    },
  },
  {
    key: 'Wood_Oak', name: 'White Oak', category: 'Wood', color: c(161, 126, 87),
    texture: {
      widthM: 1.83, heightM: 1.83, px: 1024,
      url: new URL('./material-textures/oak_veneer_01.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/oak_veneer_01-preview.jpg', import.meta.url).href,
    },
  },
  {
    key: 'Wood_Walnut', name: 'Gray Walnut', category: 'Wood', color: c(114, 110, 105),
    texture: {
      widthM: 1.0, heightM: 1.0, px: 1024,
      url: new URL('./material-textures/american_walnut_veneer.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/american_walnut_veneer-preview.jpg', import.meta.url).href,
    },
  },
  {
    key: 'Wood_Ash', name: 'Ash', category: 'Wood', color: c(172, 148, 125),
    texture: {
      widthM: 1.0, heightM: 1.0, px: 1024,
      url: new URL('./material-textures/ash_veneer.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/ash_veneer-preview.jpg', import.meta.url).href,
    },
  },
  {
    key: 'Wood_Bamboo', name: 'Bamboo', category: 'Wood', color: c(210, 173, 128),
    texture: {
      widthM: 1.0, heightM: 1.0, px: 1024,
      url: new URL('./material-textures/bamboo_veneer.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/bamboo_veneer-preview.jpg', import.meta.url).href,
    },
  },
  {
    key: 'Brick_Antique', name: 'Antique Red Brick', category: 'Brick', color: c(100, 74, 60),
    texture: {
      widthM: 3.0, heightM: 3.0, px: 1024,
      url: new URL('./material-textures/brick_wall_001.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/brick_wall_001-preview.jpg', import.meta.url).href,
    },
  },
  {
    key: 'Brick_Red', name: 'Red Brick', category: 'Brick', color: c(142, 103, 80),
    texture: {
      widthM: 1.4, heightM: 1.4, px: 1024,
      url: new URL('./material-textures/red_brick.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/red_brick-preview.jpg', import.meta.url).href,
    },
  },
  {
    key: 'Brick_Dark', name: 'Dark Brick', category: 'Brick', color: c(83, 71, 57),
    texture: {
      widthM: 1.05, heightM: 1.05, px: 1024,
      url: new URL('./material-textures/dark_brick_wall.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/dark_brick_wall-preview.jpg', import.meta.url).href,
    },
  },
  {
    key: 'Brick_Painted', name: 'Blue Painted Brick', category: 'Brick', color: c(120, 159, 170),
    texture: {
      widthM: 1.8, heightM: 1.8, px: 1024,
      url: new URL('./material-textures/painted_brick.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/painted_brick-preview.jpg', import.meta.url).href,
    },
  },
  {
    key: 'Brick_Herringbone', name: 'Herringbone Brick', category: 'Brick', color: c(80, 60, 44),
    texture: {
      widthM: 1.8, heightM: 1.8, px: 1024,
      url: new URL('./material-textures/herringbone_brick.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/herringbone_brick-preview.jpg', import.meta.url).href,
    },
  },
  {
    key: 'Brick_Pavers', name: 'Red Brick Pavers', category: 'Brick', color: c(116, 64, 50),
    texture: {
      widthM: 1.8, heightM: 1.8, px: 1024,
      url: new URL('./material-textures/red_brick_pavers.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/red_brick_pavers-preview.jpg', import.meta.url).href,
    },
  },
  {
    key: 'Tile_Ceramic', name: 'Gray Ceramic Mosaic', category: 'Tile', color: c(104, 95, 85),
    texture: {
      widthM: 2.4, heightM: 2.4, px: 1024,
      url: new URL('./material-textures/square_tiles.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/square_tiles-preview.jpg', import.meta.url).href,
    },
  },
  {
    key: 'Tile_Subway', name: 'Ivory Finger Tile', category: 'Tile', color: c(205, 198, 182),
    texture: {
      widthM: 1.27, heightM: 1.27, px: 1024,
      url: new URL('./material-textures/long_white_tiles.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/long_white_tiles-preview.jpg', import.meta.url).href,
    },
  },
  {
    key: 'Tile_Terracotta', name: 'Terracotta', category: 'Tile', color: c(77, 39, 26),
    texture: {
      widthM: 2.08, heightM: 2.08, px: 1024,
      url: new URL('./material-textures/terracotta_floor_tiles.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/terracotta_floor_tiles-preview.jpg', import.meta.url).href,
    },
  },
  {
    key: 'Tile_Terrazzo', name: 'Terrazzo', category: 'Tile', color: c(137, 109, 87),
    texture: {
      widthM: 2.0, heightM: 2.0, px: 1024,
      url: new URL('./material-textures/terrazzo_tiles.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/terrazzo_tiles-preview.jpg', import.meta.url).href,
    },
  },
  {
    key: 'Tile_Blue', name: 'Aged Blue Pavers', category: 'Tile', color: c(149, 139, 113),
    texture: {
      widthM: 2.0, heightM: 2.0, px: 1024,
      url: new URL('./material-textures/blue_floor_tiles_01.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/blue_floor_tiles_01-preview.jpg', import.meta.url).href,
    },
  },
  {
    key: 'Tile_Mosaic', name: 'Marble Mosaic', category: 'Tile', color: c(129, 109, 94),
    texture: {
      widthM: 2.0, heightM: 2.0, px: 1024,
      url: new URL('./material-textures/marble_mosaic_tiles.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/marble_mosaic_tiles-preview.jpg', import.meta.url).href,
    },
  },
  {
    key: 'Metal_Plate', name: 'Diamond Plate', category: 'Metal', color: c(61, 50, 28),
    texture: {
      widthM: 0.5, heightM: 0.5, px: 1024,
      url: new URL('./material-textures/metal_plate.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/metal_plate-preview.jpg', import.meta.url).href,
    },
  },
  {
    key: 'Metal_Diamond', name: 'Weathered Metal Plates', category: 'Metal', color: c(84, 73, 62),
    texture: {
      widthM: 2.0, heightM: 2.0, px: 1024,
      url: new URL('./material-textures/metal_plate_02.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/metal_plate_02-preview.jpg', import.meta.url).href,
    },
  },
  {
    key: 'Metal_Corrugated', name: 'Corrugated Iron', category: 'Metal', color: c(170, 179, 174),
    texture: {
      widthM: 1.12, heightM: 1.12, px: 1024,
      url: new URL('./material-textures/corrugated_iron.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/corrugated_iron-preview.jpg', import.meta.url).href,
    },
  },
  {
    key: 'Metal_Blue', name: 'Blue Painted Metal', category: 'Metal', color: c(41, 62, 76),
    texture: {
      widthM: 2.5, heightM: 2.5, px: 1024,
      url: new URL('./material-textures/blue_metal_plate.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/blue_metal_plate-preview.jpg', import.meta.url).href,
    },
  },
  {
    key: 'Metal_Weathered', name: 'Weathered Steel', category: 'Metal', color: c(172, 144, 90),
    texture: {
      widthM: 1.0, heightM: 1.0, px: 1024,
      url: new URL('./material-textures/rusty_metal_02.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/rusty_metal_02-preview.jpg', import.meta.url).href,
    },
  },
  {
    key: 'Metal_Rusted', name: 'Rusted Metal', category: 'Metal', color: c(119, 110, 84),
    texture: {
      widthM: 2.0, heightM: 2.0, px: 1024,
      url: new URL('./material-textures/rusty_metal_sheet.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/rusty_metal_sheet-preview.jpg', import.meta.url).href,
    },
  },
  {
    key: 'Stone_Granite', name: 'Granite Tiles', category: 'Stone', color: c(78, 78, 79),
    texture: {
      widthM: 2.3, heightM: 2.3, px: 1024,
      url: new URL('./material-textures/granite_tile.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/granite_tile-preview.jpg', import.meta.url).href,
    },
  },
  {
    key: 'Stone_Marble', name: 'Honed Marble', category: 'Stone', color: c(177, 157, 122),
    texture: {
      widthM: 1.5, heightM: 1.5, px: 1024,
      url: new URL('./material-textures/marble_01.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/marble_01-preview.jpg', import.meta.url).href,
    },
  },
  {
    key: 'Stone_Slate', name: 'Slate Flagstone', category: 'Stone', color: c(42, 30, 30),
    texture: {
      widthM: 2.29, heightM: 2.29, px: 1024,
      url: new URL('./material-textures/slate_floor.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/slate_floor-preview.jpg', import.meta.url).href,
    },
  },
  {
    key: 'Stone_Sandstone', name: 'Sandstone', category: 'Stone', color: c(197, 165, 128),
    texture: {
      widthM: 3.0, heightM: 3.0, px: 1024,
      url: new URL('./material-textures/sandstone_blocks_04.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/sandstone_blocks_04-preview.jpg', import.meta.url).href,
    },
  },
  {
    key: 'Stone_Stacked', name: 'Stacked Stone', category: 'Stone', color: c(95, 69, 48),
    texture: {
      widthM: 2.0, heightM: 2.0, px: 1024,
      url: new URL('./material-textures/stacked_stone_wall.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/stacked_stone_wall-preview.jpg', import.meta.url).href,
    },
  },
  {
    key: 'Stone_Cobblestone', name: 'Cobblestone', category: 'Stone', color: c(143, 130, 110),
    texture: {
      widthM: 1.0, heightM: 1.0, px: 1024,
      url: new URL('./material-textures/cobblestone_floor_01.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/cobblestone_floor_01-preview.jpg', import.meta.url).href,
    },
  },
];

export function libraryMaterial(key: string): LibraryMaterial | undefined {
  return BUILTIN_LIBRARY.find((m) => m.key === key);
}

/** Load the original JPEG only when a material is added; previews use separate small images. */
export async function loadLibraryTexture(key: string): Promise<Uint8Array | null> {
  const texture = libraryMaterial(key)?.texture;
  if (!texture) return null;
  const url = new URL(texture.url);
  if (url.protocol === 'file:') {
    // Headless commands read the same bundled assets without a browser or network.
    const moduleName = 'node:fs/promises';
    const { readFile } = await import(/* @vite-ignore */ moduleName) as typeof NodeFs;
    return new Uint8Array(await readFile(url));
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load material texture (${response.status}). Please try again.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('Could not load material texture: invalid image.');
  return bytes;
}
