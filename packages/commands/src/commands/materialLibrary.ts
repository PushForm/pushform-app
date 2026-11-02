// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Rgb } from '@pushform/model';
import type * as NodeFs from 'node:fs/promises';

/** Built-in finishes. Image maps are bundled locally and embedded in documents when used. */
export const LIBRARY_CATEGORIES = [
  'Colors', 'Wood', 'Brick', 'Ceramic', 'Concrete & Asphalt', 'Stone', 'Metal', 'Terrain', 'Textiles', 'Plastic', 'Organic', 'Glass',
] as const;

export interface LibraryTexture {
  readonly widthM: number;
  readonly heightM: number;
  /** Original pixel dimensions; rectangular maps keep their aspect ratio. */
  readonly widthPx: number;
  readonly heightPx: number;
  readonly url: string;
  readonly previewUrl: string;
}

export interface LibraryMaterial {
  readonly key: string;
  readonly name: string;
  readonly category: (typeof LIBRARY_CATEGORIES)[number];
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
  {
    key: 'Wood_Ash', name: "Ash", category: 'Wood', color: c(172, 148, 125),
    texture: {
      widthM: 1.0, heightM: 1.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/ash_veneer.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/ash_veneer-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_Bamboo', name: "Bamboo", category: 'Wood', color: c(210, 173, 128),
    texture: {
      widthM: 1.0, heightM: 1.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/bamboo_veneer.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/bamboo_veneer-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_bamboo_wall', name: "Bamboo Wall", category: 'Wood', color: c(133, 107, 83),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/bamboo_wall.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/bamboo_wall-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_bamboo_wall_03', name: "Bamboo Wall 03", category: 'Wood', color: c(149, 115, 85),
    texture: {
      widthM: 1.85, heightM: 1.85, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/bamboo_wall_03.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/bamboo_wall_03-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_beam_wall_01', name: "Beam Wall 01", category: 'Wood', color: c(139, 131, 107),
    texture: {
      widthM: 0.999999, heightM: 0.999999, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/beam_wall_01.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/beam_wall_01-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_black_painted_planks', name: "Black Painted Planks", category: 'Wood', color: c(26, 27, 32),
    texture: {
      widthM: 1.6, heightM: 1.6, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/black_painted_planks.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/black_painted_planks-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_brown_planks_04', name: "Brown Planks 04", category: 'Wood', color: c(127, 111, 101),
    texture: {
      widthM: 1.0, heightM: 1.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/brown_planks_04.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/brown_planks_04-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_brown_planks_05', name: "Brown Planks 05", category: 'Wood', color: c(154, 148, 136),
    texture: {
      widthM: 1.0, heightM: 1.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/brown_planks_05.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/brown_planks_05-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_brown_planks_07', name: "Brown Planks 07", category: 'Wood', color: c(133, 119, 101),
    texture: {
      widthM: 1.0, heightM: 1.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/brown_planks_07.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/brown_planks_07-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_Cherry', name: "Cherry", category: 'Wood', color: c(224, 176, 132),
    texture: {
      widthM: 1.0, heightM: 1.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/cherry_veneer.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/cherry_veneer-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_dark_wood', name: "Dark Wood", category: 'Wood', color: c(93, 42, 24),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/dark_wood.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/dark_wood-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_diagonal_parquet', name: "Diagonal Parquet", category: 'Wood', color: c(164, 102, 54),
    texture: {
      widthM: 2.359999, heightM: 2.359999, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/diagonal_parquet.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/diagonal_parquet-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_embedded_plank_flooring', name: "Embedded Plank Flooring", category: 'Wood', color: c(104, 89, 73),
    texture: {
      widthM: 2.03, heightM: 2.03, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/embedded_plank_flooring.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/embedded_plank_flooring-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_Walnut', name: "Gray Walnut", category: 'Wood', color: c(114, 110, 105),
    texture: {
      widthM: 1.0, heightM: 1.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/american_walnut_veneer.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/american_walnut_veneer-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_grey_lati_veneer', name: "Grey Lati Veneer", category: 'Wood', color: c(133, 106, 84),
    texture: {
      widthM: 1.0, heightM: 1.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/grey_lati_veneer.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/grey_lati_veneer-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_herringbone_parquet', name: "Herringbone Parquet", category: 'Wood', color: c(147, 112, 77),
    texture: {
      widthM: 3.4, heightM: 3.4, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/herringbone_parquet.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/herringbone_parquet-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_japanese_cedar_planks', name: "Japanese Cedar Planks", category: 'Wood', color: c(172, 97, 11),
    texture: {
      widthM: 1.13, heightM: 1.13, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/japanese_cedar_planks.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/japanese_cedar_planks-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_laminate_floor', name: "Laminate Floor", category: 'Wood', color: c(149, 115, 69),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/laminate_floor.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/laminate_floor-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_laminate_floor_02', name: "Laminate Floor 02", category: 'Wood', color: c(155, 128, 99),
    texture: {
      widthM: 1.7, heightM: 1.7, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/laminate_floor_02.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/laminate_floor_02-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_laminate_floor_03', name: "Laminate Floor 03", category: 'Wood', color: c(154, 114, 72),
    texture: {
      widthM: 2.08, heightM: 2.08, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/laminate_floor_03.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/laminate_floor_03-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_natural_walnut_veneer', name: "Natural Walnut Veneer", category: 'Wood', color: c(136, 126, 114),
    texture: {
      widthM: 1.0, heightM: 1.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/natural_walnut_veneer.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/natural_walnut_veneer-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_oak_veneer_05', name: "Oak Veneer 05", category: 'Wood', color: c(169, 138, 113),
    texture: {
      widthM: 1.0, heightM: 1.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/oak_veneer_05.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/oak_veneer_05-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_oak_wood_planks', name: "Oak Wood Planks", category: 'Wood', color: c(162, 117, 84),
    texture: {
      widthM: 1.2, heightM: 1.2, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/oak_wood_planks.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/oak_wood_planks-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_oriented_strand_board', name: "Oriented Strand Board", category: 'Wood', color: c(187, 151, 113),
    texture: {
      widthM: 2.51, heightM: 2.51, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/oriented_strand_board.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/oriented_strand_board-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_Pine', name: "Pine", category: 'Wood', color: c(104, 57, 7),
    texture: {
      widthM: 0.74, heightM: 0.74, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/coated_pine.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/coated_pine-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_plywood', name: "Plywood", category: 'Wood', color: c(126, 97, 64),
    texture: {
      widthM: 0.5, heightM: 0.5, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/plywood.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/plywood-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_rectangular_parquet', name: "Rectangular Parquet", category: 'Wood', color: c(119, 92, 51),
    texture: {
      widthM: 2.25, heightM: 2.25, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/rectangular_parquet.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/rectangular_parquet-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_romantic_veneer', name: "Romantic Veneer", category: 'Wood', color: c(210, 190, 166),
    texture: {
      widthM: 1.0, heightM: 1.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/romantic_veneer.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/romantic_veneer-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_rosewood_veneer1', name: "Rosewood Veneer1", category: 'Wood', color: c(109, 50, 16),
    texture: {
      widthM: 2.43, heightM: 2.43, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/rosewood_veneer1.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/rosewood_veneer1-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_rough_pine_door', name: "Rough Pine Door", category: 'Wood', color: c(76, 37, 14),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/rough_pine_door.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/rough_pine_door-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_sapele_veneer', name: "Sapele Veneer", category: 'Wood', color: c(198, 129, 89),
    texture: {
      widthM: 0.5, heightM: 0.5, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/sapele_veneer.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/sapele_veneer-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_silver_oak_veneer_01', name: "Silver Oak Veneer 01", category: 'Wood', color: c(220, 191, 158),
    texture: {
      widthM: 1.0, heightM: 1.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/silver_oak_veneer_01.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/silver_oak_veneer_01-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_smoke_speckled_veneer', name: "Smoke Speckled Veneer", category: 'Wood', color: c(96, 80, 68),
    texture: {
      widthM: 1.0, heightM: 1.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/smoke_speckled_veneer.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/smoke_speckled_veneer-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_stained_pine', name: "Stained Pine", category: 'Wood', color: c(93, 50, 30),
    texture: {
      widthM: 0.9, heightM: 0.9, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/stained_pine.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/stained_pine-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_synthetic_wood', name: "Synthetic Wood", category: 'Wood', color: c(114, 78, 56),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/synthetic_wood.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/synthetic_wood-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_teak_veneer', name: "Teak Veneer", category: 'Wood', color: c(175, 130, 87),
    texture: {
      widthM: 1.0, heightM: 1.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/teak_veneer.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/teak_veneer-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_walnut_veneer_02', name: "Walnut Veneer 02", category: 'Wood', color: c(169, 137, 113),
    texture: {
      widthM: 1.0, heightM: 1.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/walnut_veneer_02.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/walnut_veneer_02-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_weathered_brown_planks', name: "Weathered Brown Planks", category: 'Wood', color: c(96, 75, 57),
    texture: {
      widthM: 1.8, heightM: 1.8, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/weathered_brown_planks.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/weathered_brown_planks-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_white_maple_veneer', name: "White Maple Veneer", category: 'Wood', color: c(227, 212, 185),
    texture: {
      widthM: 1.0, heightM: 1.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/white_maple_veneer.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/white_maple_veneer-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_Oak', name: "White Oak", category: 'Wood', color: c(161, 126, 87),
    texture: {
      widthM: 1.83, heightM: 1.83, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/oak_veneer_01.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/oak_veneer_01-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_white_oak_veneer', name: "White Oak Veneer", category: 'Wood', color: c(144, 121, 98),
    texture: {
      widthM: 0.5, heightM: 0.5, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/white_oak_veneer.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/white_oak_veneer-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_white_planks_clean', name: "White Planks Clean", category: 'Wood', color: c(180, 166, 157),
    texture: {
      widthM: 1.8, heightM: 1.8, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/white_planks_clean.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/white_planks_clean-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_wood_cabinet_worn_long', name: "Wood Cabinet Worn Long", category: 'Wood', color: c(88, 47, 11),
    texture: {
      widthM: 1.0, heightM: 0.5, widthPx: 1024, heightPx: 512,
      url: new URL('./material-textures/wood_cabinet_worn_long.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/wood_cabinet_worn_long-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_wood_floor', name: "Wood Floor", category: 'Wood', color: c(128, 96, 66),
    texture: {
      widthM: 1.7, heightM: 1.7, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/wood_floor.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/wood_floor-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_wood_floor_deck', name: "Wood Floor Deck", category: 'Wood', color: c(110, 52, 14),
    texture: {
      widthM: 1.8, heightM: 1.8, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/wood_floor_deck.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/wood_floor_deck-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_wood_shutter', name: "Wood Shutter", category: 'Wood', color: c(119, 73, 37),
    texture: {
      widthM: 1.0, heightM: 1.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/wood_shutter.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/wood_shutter-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_wood_table_001', name: "Wood Table 001", category: 'Wood', color: c(62, 25, 10),
    texture: {
      widthM: 1.5, heightM: 1.5, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/wood_table_001.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/wood_table_001-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_wood_table_worn', name: "Wood Table Worn", category: 'Wood', color: c(83, 47, 21),
    texture: {
      widthM: 0.55, heightM: 0.55, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/wood_table_worn.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/wood_table_worn-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_wooden_barrel', name: "Wooden Barrel", category: 'Wood', color: c(64, 51, 43),
    texture: {
      widthM: 1.29, heightM: 1.29, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/wooden_barrel.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/wooden_barrel-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Wood_wooden_rough_planks', name: "Wooden Rough Planks", category: 'Wood', color: c(108, 103, 48),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/wooden_rough_planks.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/wooden_rough_planks-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Tile_Blue', name: "Aged Blue Pavers", category: 'Brick', color: c(149, 139, 113),
    texture: {
      widthM: 2.0, heightM: 2.000001, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/blue_floor_tiles_01.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/blue_floor_tiles_01-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Brick_Antique', name: "Antique Red Brick", category: 'Brick', color: c(100, 74, 60),
    texture: {
      widthM: 3.0, heightM: 3.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/brick_wall_001.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/brick_wall_001-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Brick_Painted', name: "Blue Painted Brick", category: 'Brick', color: c(120, 159, 170),
    texture: {
      widthM: 1.8, heightM: 1.8, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/painted_brick.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/painted_brick-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Brick_brick_4', name: "Brick 4", category: 'Brick', color: c(150, 111, 80),
    texture: {
      widthM: 0.5, heightM: 0.5, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/brick_4.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/brick_4-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Brick_brick_floor', name: "Brick Floor", category: 'Brick', color: c(100, 87, 70),
    texture: {
      widthM: 0.5, heightM: 0.5, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/brick_floor.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/brick_floor-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Brick_concrete_pavement', name: "Concrete Pavement", category: 'Brick', color: c(127, 116, 102),
    texture: {
      widthM: 1.8, heightM: 1.8, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/concrete_pavement.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/concrete_pavement-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Brick_concrete_pavement_02', name: "Concrete Pavement 02", category: 'Brick', color: c(134, 123, 111),
    texture: {
      widthM: 1.8, heightM: 1.8, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/concrete_pavement_02.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/concrete_pavement_02-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Brick_concrete_tile_facade', name: "Concrete Tile Facade", category: 'Brick', color: c(54, 56, 60),
    texture: {
      widthM: 2.09, heightM: 2.09, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/concrete_tile_facade.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/concrete_tile_facade-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Brick_Dark', name: "Dark Brick", category: 'Brick', color: c(83, 71, 57),
    texture: {
      widthM: 1.05, heightM: 1.05, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/dark_brick_wall.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/dark_brick_wall-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Tile_Ceramic', name: "Gray Paving Mosaic", category: 'Brick', color: c(104, 95, 85),
    texture: {
      widthM: 2.4, heightM: 2.4, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/square_tiles.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/square_tiles-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Brick_Herringbone', name: "Herringbone Brick", category: 'Brick', color: c(80, 60, 44),
    texture: {
      widthM: 1.8, heightM: 1.8, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/herringbone_brick.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/herringbone_brick-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Brick_herringbone_concrete_tile', name: "Herringbone Concrete Tile", category: 'Brick', color: c(138, 131, 119),
    texture: {
      widthM: 1.8, heightM: 1.8, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/herringbone_concrete_tile.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/herringbone_concrete_tile-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Brick_herringbone_pavement', name: "Herringbone Pavement", category: 'Brick', color: c(90, 78, 64),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/herringbone_pavement.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/herringbone_pavement-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Brick_large_floor_tiles_02', name: "Large Floor Tiles 02", category: 'Brick', color: c(117, 118, 115),
    texture: {
      widthM: 3.0, heightM: 3.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/large_floor_tiles_02.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/large_floor_tiles_02-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Brick_medieval_blocks_03', name: "Medieval Blocks 03", category: 'Brick', color: c(119, 106, 88),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/medieval_blocks_03.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/medieval_blocks_03-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Brick_patterned_brick_floor', name: "Patterned Brick Floor", category: 'Brick', color: c(132, 128, 121),
    texture: {
      widthM: 1.811, heightM: 1.811, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/patterned_brick_floor.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/patterned_brick_floor-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Brick_patterned_brick_floor_02', name: "Patterned Brick Floor 02", category: 'Brick', color: c(134, 117, 100),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/patterned_brick_floor_02.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/patterned_brick_floor_02-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Brick_patterned_brick_floor_03', name: "Patterned Brick Floor 03", category: 'Brick', color: c(106, 85, 64),
    texture: {
      widthM: 2.1, heightM: 2.1, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/patterned_brick_floor_03.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/patterned_brick_floor_03-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Brick_patterned_brick_wall', name: "Patterned Brick Wall", category: 'Brick', color: c(122, 92, 61),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/patterned_brick_wall.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/patterned_brick_wall-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Brick_patterned_concrete_wall', name: "Patterned Concrete Wall", category: 'Brick', color: c(137, 123, 106),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/patterned_concrete_wall.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/patterned_concrete_wall-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Brick_pavement_02', name: "Pavement 02", category: 'Brick', color: c(150, 128, 106),
    texture: {
      widthM: 2.12, heightM: 2.12, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/pavement_02.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/pavement_02-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Brick_Red', name: "Red Brick", category: 'Brick', color: c(142, 103, 80),
    texture: {
      widthM: 1.4, heightM: 1.4, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/red_brick.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/red_brick-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Brick_red_brick_03', name: "Red Brick 03", category: 'Brick', color: c(106, 83, 75),
    texture: {
      widthM: 1.0, heightM: 1.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/red_brick_03.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/red_brick_03-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Brick_Pavers', name: "Red Brick Pavers", category: 'Brick', color: c(116, 64, 50),
    texture: {
      widthM: 1.8, heightM: 1.8, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/red_brick_pavers.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/red_brick_pavers-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Brick_rough_block_wall', name: "Rough Block Wall", category: 'Brick', color: c(130, 119, 96),
    texture: {
      widthM: 3.04, heightM: 3.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/rough_block_wall.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/rough_block_wall-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_Sandstone', name: "Sandstone", category: 'Brick', color: c(197, 165, 128),
    texture: {
      widthM: 3.0, heightM: 3.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/sandstone_blocks_04.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/sandstone_blocks_04-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Brick_sandstone_blocks_05', name: "Sandstone Blocks 05", category: 'Brick', color: c(175, 155, 132),
    texture: {
      widthM: 3.0, heightM: 3.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/sandstone_blocks_05.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/sandstone_blocks_05-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Brick_square_brick_paving', name: "Square Brick Paving", category: 'Brick', color: c(99, 87, 69),
    texture: {
      widthM: 2.1, heightM: 2.1, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/square_brick_paving.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/square_brick_paving-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Brick_stacked_brick_wall', name: "Stacked Brick Wall", category: 'Brick', color: c(113, 70, 45),
    texture: {
      widthM: 1.731573, heightM: 1.731578, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/stacked_brick_wall.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/stacked_brick_wall-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Brick_stenciled_brick_floor', name: "Stenciled Brick Floor", category: 'Brick', color: c(124, 90, 69),
    texture: {
      widthM: 1.92, heightM: 1.92, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/stenciled_brick_floor.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/stenciled_brick_floor-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Ceramic_anti_skid_tiles', name: "Anti Skid Tiles", category: 'Ceramic', color: c(134, 107, 84),
    texture: {
      widthM: 1.8, heightM: 1.8, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/anti_skid_tiles.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/anti_skid_tiles-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Ceramic_brown_floor_tiles', name: "Brown Floor Tilles", category: 'Ceramic', color: c(137, 110, 84),
    texture: {
      widthM: 1.7, heightM: 1.7, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/brown_floor_tiles.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/brown_floor_tiles-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Ceramic_ceramic_roof_01', name: "Ceramic Roof 01", category: 'Ceramic', color: c(142, 118, 82),
    texture: {
      widthM: 3.5, heightM: 3.5, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/ceramic_roof_01.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/ceramic_roof_01-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Ceramic_clay_roof_tiles', name: "Clay Roof Tiles", category: 'Ceramic', color: c(89, 51, 28),
    texture: {
      widthM: 4.0, heightM: 4.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/clay_roof_tiles.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/clay_roof_tiles-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Ceramic_clay_roof_tiles_02', name: "Clay Roof Tiles 02", category: 'Ceramic', color: c(145, 80, 43),
    texture: {
      widthM: 2.5, heightM: 2.5, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/clay_roof_tiles_02.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/clay_roof_tiles_02-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Ceramic_clay_roof_tiles_03', name: "Clay Roof Tiles 03", category: 'Ceramic', color: c(141, 85, 55),
    texture: {
      widthM: 2.6, heightM: 2.6, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/clay_roof_tiles_03.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/clay_roof_tiles_03-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Ceramic_dirty_tiles', name: "Dirty Tiles", category: 'Ceramic', color: c(68, 34, 16),
    texture: {
      widthM: 2.26, heightM: 2.26, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/dirty_tiles.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/dirty_tiles-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Ceramic_floor_tiles_08', name: "Floor Tiles 08", category: 'Ceramic', color: c(135, 117, 100),
    texture: {
      widthM: 1.5, heightM: 1.5, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/floor_tiles_08.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/floor_tiles_08-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Ceramic_grey_roof_01', name: "Grey Roof 01", category: 'Ceramic', color: c(87, 86, 82),
    texture: {
      widthM: 8.0, heightM: 8.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/grey_roof_01.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/grey_roof_01-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Ceramic_grey_roof_tiles', name: "Grey Roof Tiles", category: 'Ceramic', color: c(97, 92, 75),
    texture: {
      widthM: 3.0, heightM: 3.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/grey_roof_tiles.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/grey_roof_tiles-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Ceramic_interior_tiles', name: "Interior Tiles", category: 'Ceramic', color: c(170, 152, 132),
    texture: {
      widthM: 1.9, heightM: 1.9, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/interior_tiles.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/interior_tiles-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Tile_Subway', name: "Ivory Finger Tile", category: 'Ceramic', color: c(205, 198, 182),
    texture: {
      widthM: 1.27, heightM: 1.27, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/long_white_tiles.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/long_white_tiles-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Tile_Mosaic', name: "Marble Mosaic", category: 'Ceramic', color: c(129, 109, 94),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/marble_mosaic_tiles.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/marble_mosaic_tiles-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Ceramic_old_mosaic_floor', name: "Old Mosaic Floor", category: 'Ceramic', color: c(106, 93, 74),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/old_mosaic_floor.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/old_mosaic_floor-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Ceramic_patio_tiles', name: "Patio Tiles", category: 'Ceramic', color: c(177, 129, 86),
    texture: {
      widthM: 2.15, heightM: 2.15, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/patio_tiles.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/patio_tiles-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Ceramic_patterned_terracotta_tiling', name: "Patterned Terracotta Tiling", category: 'Ceramic', color: c(96, 54, 35),
    texture: {
      widthM: 2.151723, heightM: 2.151724, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/patterned_terracotta_tiling.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/patterned_terracotta_tiling-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Ceramic_roof_07', name: "Roof 07", category: 'Ceramic', color: c(106, 97, 78),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/roof_07.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/roof_07-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Ceramic_roof_09', name: "Roof 09", category: 'Ceramic', color: c(134, 116, 97),
    texture: {
      widthM: 4.0, heightM: 4.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/roof_09.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/roof_09-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Ceramic_roof_3', name: "Roof 3", category: 'Ceramic', color: c(147, 117, 74),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/roof_3.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/roof_3-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Ceramic_roof_tiles', name: "Roof Tiles", category: 'Ceramic', color: c(172, 142, 110),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/roof_tiles.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/roof_tiles-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Ceramic_roof_tiles_14', name: "Roof Tiles 14", category: 'Ceramic', color: c(91, 79, 59),
    texture: {
      widthM: 1.5, heightM: 1.5, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/roof_tiles_14.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/roof_tiles_14-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Ceramic_rounded_square_tiled_wall', name: "Rounded Square Tiled Wall", category: 'Ceramic', color: c(133, 118, 101),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/rounded_square_tiled_wall.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/rounded_square_tiled_wall-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Tile_Terracotta', name: "Terracotta", category: 'Ceramic', color: c(77, 39, 26),
    texture: {
      widthM: 2.08, heightM: 2.08, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/terracotta_floor_tiles.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/terracotta_floor_tiles-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Tile_Terrazzo', name: "Terrazzo", category: 'Ceramic', color: c(137, 109, 87),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/terrazzo_tiles.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/terrazzo_tiles-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Ceramic_tiled_floor_001', name: "Tiled Floor 001", category: 'Ceramic', color: c(114, 92, 74),
    texture: {
      widthM: 1.5, heightM: 1.5, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/tiled_floor_001.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/tiled_floor_001-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Ceramic_worn_tile_floor', name: "Worn Tile Floor", category: 'Ceramic', color: c(74, 69, 58),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/worn_tile_floor.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/worn_tile_floor-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_aerial_asphalt_01', name: "Aerial Asphalt 01", category: 'Concrete & Asphalt', color: c(102, 98, 103),
    texture: {
      widthM: 30.0, heightM: 30.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/aerial_asphalt_01.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/aerial_asphalt_01-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_asphalt_01', name: "Asphalt 01", category: 'Concrete & Asphalt', color: c(89, 80, 70),
    texture: {
      widthM: 2.079999, heightM: 2.08, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/asphalt_01.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/asphalt_01-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_asphalt_02', name: "Asphalt 02", category: 'Concrete & Asphalt', color: c(90, 90, 85),
    texture: {
      widthM: 3.0, heightM: 3.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/asphalt_02.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/asphalt_02-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_asphalt_04', name: "Asphalt 04", category: 'Concrete & Asphalt', color: c(134, 129, 126),
    texture: {
      widthM: 4.04, heightM: 4.04, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/asphalt_04.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/asphalt_04-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_asphalt_floor', name: "Asphalt Floor", category: 'Concrete & Asphalt', color: c(145, 127, 110),
    texture: {
      widthM: 2.35, heightM: 2.35, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/asphalt_floor.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/asphalt_floor-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_asphalt_pit_lane', name: "Asphalt Pit Lane", category: 'Concrete & Asphalt', color: c(66, 59, 53),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/asphalt_pit_lane.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/asphalt_pit_lane-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_beige_wall_001', name: "Beige Wall 001", category: 'Concrete & Asphalt', color: c(158, 140, 120),
    texture: {
      widthM: 3.0, heightM: 3.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/beige_wall_001.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/beige_wall_001-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_bitumen', name: "Bitumen", category: 'Concrete & Asphalt', color: c(59, 54, 52),
    texture: {
      widthM: 19.999996, heightM: 19.999996, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/bitumen.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/bitumen-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_brushed_concrete', name: "Brushed Concrete ", category: 'Concrete & Asphalt', color: c(106, 99, 88),
    texture: {
      widthM: 2.5, heightM: 2.5, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/brushed_concrete.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/brushed_concrete-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_brushed_concrete_03', name: "Brushed Concrete 03", category: 'Concrete & Asphalt', color: c(107, 93, 77),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/brushed_concrete_03.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/brushed_concrete_03-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_brushed_concrete_2', name: "Brushed Concrete 2", category: 'Concrete & Asphalt', color: c(117, 105, 90),
    texture: {
      widthM: 2.5, heightM: 2.5, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/brushed_concrete_2.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/brushed_concrete_2-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_clay_floor_001', name: "Clay Floor 001", category: 'Concrete & Asphalt', color: c(122, 96, 61),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/clay_floor_001.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/clay_floor_001-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_clay_plaster', name: "Clay Plaster", category: 'Concrete & Asphalt', color: c(114, 90, 60),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/clay_plaster.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/clay_plaster-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_clean_asphalt', name: "Clean Asphalt", category: 'Concrete & Asphalt', color: c(69, 70, 70),
    texture: {
      widthM: 2.1, heightM: 2.1, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/clean_asphalt.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/clean_asphalt-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_cobblestone_embedded_asphalt', name: "Cobblestone Embedded Asphalt", category: 'Concrete & Asphalt', color: c(89, 78, 69),
    texture: {
      widthM: 1.9, heightM: 1.9, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/cobblestone_embedded_asphalt.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/cobblestone_embedded_asphalt-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_concrete', name: "Concrete", category: 'Concrete & Asphalt', color: c(114, 105, 90),
    texture: {
      widthM: 4.0, heightM: 4.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/concrete.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/concrete-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_concrete_debris', name: "Concrete Debris", category: 'Concrete & Asphalt', color: c(146, 134, 120),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/concrete_debris.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/concrete_debris-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_concrete_floor_01', name: "Concrete Floor 01", category: 'Concrete & Asphalt', color: c(118, 107, 89),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/concrete_floor_01.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/concrete_floor_01-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_concrete_floor_02', name: "Concrete Floor 02", category: 'Concrete & Asphalt', color: c(120, 110, 91),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/concrete_floor_02.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/concrete_floor_02-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_concrete_floor_painted', name: "Concrete Floor Painted", category: 'Concrete & Asphalt', color: c(80, 74, 64),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/concrete_floor_painted.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/concrete_floor_painted-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_concrete_floor_worn_001', name: "Concrete Floor Worn 001", category: 'Concrete & Asphalt', color: c(86, 86, 84),
    texture: {
      widthM: 3.0, heightM: 3.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/concrete_floor_worn_001.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/concrete_floor_worn_001-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_concrete_layers', name: "Concrete Layers", category: 'Concrete & Asphalt', color: c(109, 101, 94),
    texture: {
      widthM: 1.55, heightM: 1.55, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/concrete_layers.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/concrete_layers-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_concrete_layers_02', name: "Concrete Layers 02", category: 'Concrete & Asphalt', color: c(125, 122, 116),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/concrete_layers_02.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/concrete_layers_02-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_concrete_slab_wall_02', name: "Concrete Slab Wall 02", category: 'Concrete & Asphalt', color: c(124, 118, 111),
    texture: {
      widthM: 2.102316, heightM: 2.102316, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/concrete_slab_wall_02.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/concrete_slab_wall_02-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_concrete_wall_003', name: "Concrete Wall 003", category: 'Concrete & Asphalt', color: c(206, 184, 157),
    texture: {
      widthM: 3.0, heightM: 3.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/concrete_wall_003.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/concrete_wall_003-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_concrete_wall_007', name: "Concrete Wall 007", category: 'Concrete & Asphalt', color: c(139, 130, 110),
    texture: {
      widthM: 2.16, heightM: 2.16, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/concrete_wall_007.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/concrete_wall_007-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_cracked_concrete_wall', name: "Cracked Concrete Wall", category: 'Concrete & Asphalt', color: c(187, 174, 155),
    texture: {
      widthM: 1.0, heightM: 1.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/cracked_concrete_wall.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/cracked_concrete_wall-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_damaged_plaster', name: "Damaged Plaster", category: 'Concrete & Asphalt', color: c(148, 130, 113),
    texture: {
      widthM: 1.85, heightM: 1.85, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/damaged_plaster.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/damaged_plaster-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_dirty_concrete', name: "Dirty Concrete", category: 'Concrete & Asphalt', color: c(137, 131, 119),
    texture: {
      widthM: 3.0, heightM: 3.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/dirty_concrete.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/dirty_concrete-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_granular_concrete', name: "Granular Concrete", category: 'Concrete & Asphalt', color: c(109, 102, 89),
    texture: {
      widthM: 2.4, heightM: 2.4, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/granular_concrete.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/granular_concrete-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_gravel_concrete_03', name: "Gravel Concrete 03", category: 'Concrete & Asphalt', color: c(90, 90, 83),
    texture: {
      widthM: 2.1, heightM: 2.1, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/gravel_concrete_03.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/gravel_concrete_03-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_gravel_embedded_concrete', name: "Gravel Embedded Concrete", category: 'Concrete & Asphalt', color: c(149, 142, 132),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/gravel_embedded_concrete.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/gravel_embedded_concrete-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_gravel_road', name: "Gravel Road", category: 'Concrete & Asphalt', color: c(121, 88, 64),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/gravel_road.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/gravel_road-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_painted_concrete', name: "Painted Concrete", category: 'Concrete & Asphalt', color: c(72, 106, 79),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/painted_concrete.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/painted_concrete-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_painted_concrete_02', name: "Painted Concrete 02", category: 'Concrete & Asphalt', color: c(86, 83, 76),
    texture: {
      widthM: 4.0, heightM: 4.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/painted_concrete_02.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/painted_concrete_02-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_painted_plaster_wall', name: "Painted Plaster Wall", category: 'Concrete & Asphalt', color: c(171, 163, 160),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/painted_plaster_wall.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/painted_plaster_wall-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_patterned_clay_plaster', name: "Patterned Clay Plaster", category: 'Concrete & Asphalt', color: c(165, 145, 128),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/patterned_clay_plaster.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/patterned_clay_plaster-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_patterned_concrete_pavers_03', name: "Patterned Concrete Pavers 03", category: 'Concrete & Asphalt', color: c(112, 98, 83),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/patterned_concrete_pavers_03.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/patterned_concrete_pavers_03-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_patterned_plaster_wall', name: "Patterned Plaster Wall", category: 'Concrete & Asphalt', color: c(181, 154, 133),
    texture: {
      widthM: 1.8, heightM: 1.8, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/patterned_plaster_wall.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/patterned_plaster_wall-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_peeling_painted_wall', name: "Peeling Painted Wall", category: 'Concrete & Asphalt', color: c(150, 108, 93),
    texture: {
      widthM: 1.8, heightM: 1.8, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/peeling_painted_wall.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/peeling_painted_wall-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_plaster_brick_pattern', name: "Plaster Brick Pattern", category: 'Concrete & Asphalt', color: c(173, 156, 124),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/plaster_brick_pattern.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/plaster_brick_pattern-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_plastered_stone_wall', name: "Plastered Stone Wall", category: 'Concrete & Asphalt', color: c(68, 64, 55),
    texture: {
      widthM: 2.5, heightM: 2.5, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/plastered_stone_wall.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/plastered_stone_wall-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_precast_concrete_wall', name: "Precast Concrete Wall", category: 'Concrete & Asphalt', color: c(151, 135, 116),
    texture: {
      widthM: 1.59, heightM: 1.59, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/precast_concrete_wall.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/precast_concrete_wall-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_ribbed_concrete_wall', name: "Ribbed Concrete Wall", category: 'Concrete & Asphalt', color: c(86, 78, 66),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/ribbed_concrete_wall.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/ribbed_concrete_wall-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_road_damaged', name: "Road Damaged", category: 'Concrete & Asphalt', color: c(73, 56, 45),
    texture: {
      widthM: 2.2, heightM: 2.2, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/road_damaged.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/road_damaged-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_road_damaged_2', name: "Road Damaged 2", category: 'Concrete & Asphalt', color: c(89, 65, 49),
    texture: {
      widthM: 2.2, heightM: 2.2, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/road_damaged_2.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/road_damaged_2-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_rubble', name: "Rubble", category: 'Concrete & Asphalt', color: c(160, 145, 134),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/rubble.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/rubble-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_white_plaster_02', name: "White Plaster 02", category: 'Concrete & Asphalt', color: c(142, 135, 122),
    texture: {
      widthM: 1.0, heightM: 1.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/white_plaster_02.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/white_plaster_02-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_wood_inlaid_concrete_wall', name: "Wood Inlaid Concrete Wall", category: 'Concrete & Asphalt', color: c(71, 59, 51),
    texture: {
      widthM: 1.7, heightM: 1.7, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/wood_inlaid_concrete_wall.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/wood_inlaid_concrete_wall-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Concrete_Asphalt_wood_textured_concrete', name: "Wood Textured Concrete", category: 'Concrete & Asphalt', color: c(117, 106, 90),
    texture: {
      widthM: 1.8, heightM: 1.8, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/wood_textured_concrete.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/wood_textured_concrete-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_aerial_grass_rock', name: "Aerial Grass Rock", category: 'Stone', color: c(114, 97, 36),
    texture: {
      widthM: 15.0, heightM: 15.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/aerial_grass_rock.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/aerial_grass_rock-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_aerial_rocks_01', name: "Aerial Rocks 01", category: 'Stone', color: c(126, 119, 90),
    texture: {
      widthM: 80.0, heightM: 80.000206, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/aerial_rocks_01.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/aerial_rocks_01-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_aerial_rocks_02', name: "Aerial Rocks 02", category: 'Stone', color: c(110, 92, 52),
    texture: {
      widthM: 50.0, heightM: 50.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/aerial_rocks_02.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/aerial_rocks_02-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_aerial_rocks_04', name: "Aerial Rocks 04", category: 'Stone', color: c(97, 80, 40),
    texture: {
      widthM: 80.0, heightM: 80.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/aerial_rocks_04.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/aerial_rocks_04-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_brick_floor_003', name: "Brick Floor 003", category: 'Stone', color: c(94, 79, 67),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/brick_floor_003.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/brick_floor_003-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_cliff_side', name: "Cliff Side", category: 'Stone', color: c(124, 83, 49),
    texture: {
      widthM: 1.83, heightM: 1.83, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/cliff_side.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/cliff_side-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_coast_land_rocks_01', name: "Coast Land Rocks 01", category: 'Stone', color: c(83, 68, 47),
    texture: {
      widthM: 19.99995, heightM: 20.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/coast_land_rocks_01.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/coast_land_rocks_01-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_coast_sand_rocks_02', name: "Coast Sand Rocks 02", category: 'Stone', color: c(75, 68, 45),
    texture: {
      widthM: 15.0, heightM: 15.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/coast_sand_rocks_02.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/coast_sand_rocks_02-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_Cobblestone', name: "Cobblestone", category: 'Stone', color: c(143, 130, 110),
    texture: {
      widthM: 1.0, heightM: 1.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/cobblestone_floor_01.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/cobblestone_floor_01-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_cobblestone_02', name: "Cobblestone 02", category: 'Stone', color: c(135, 110, 79),
    texture: {
      widthM: 1.8, heightM: 1.8, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/cobblestone_02.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/cobblestone_02-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_cobblestone_floor_04', name: "Cobblestone Floor 04", category: 'Stone', color: c(138, 125, 98),
    texture: {
      widthM: 1.5, heightM: 1.5, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/cobblestone_floor_04.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/cobblestone_floor_04-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_cobblestone_floor_08', name: "Cobblestone Floor 08", category: 'Stone', color: c(146, 139, 128),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/cobblestone_floor_08.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/cobblestone_floor_08-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_cobblestone_floor_13', name: "Cobblestone Floor 13", category: 'Stone', color: c(142, 128, 101),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/cobblestone_floor_13.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/cobblestone_floor_13-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_floor_pattern_02', name: "Floor Pattern 02", category: 'Stone', color: c(124, 119, 108),
    texture: {
      widthM: 1.2, heightM: 1.2, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/floor_pattern_02.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/floor_pattern_02-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_floor_tiles_02', name: "Floor Tiles 02", category: 'Stone', color: c(158, 144, 126),
    texture: {
      widthM: 4.0, heightM: 4.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/floor_tiles_02.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/floor_tiles_02-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_floor_tiles_06', name: "Floor Tiles 06", category: 'Stone', color: c(121, 111, 107),
    texture: {
      widthM: 3.0, heightM: 3.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/floor_tiles_06.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/floor_tiles_06-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_granite_tile_02', name: "Granite Tile 02", category: 'Stone', color: c(98, 79, 65),
    texture: {
      widthM: 1.88, heightM: 1.88, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/granite_tile_02.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/granite_tile_02-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_granite_tile_04', name: "Granite Tile 04", category: 'Stone', color: c(113, 100, 86),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/granite_tile_04.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/granite_tile_04-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_Granite', name: "Granite Tiles", category: 'Stone', color: c(78, 78, 79),
    texture: {
      widthM: 2.3, heightM: 2.3, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/granite_tile.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/granite_tile-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_grassy_cobblestone', name: "Grassy Cobblestone", category: 'Stone', color: c(120, 102, 81),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/grassy_cobblestone.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/grassy_cobblestone-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_grey_cartago_02', name: "Grey Cartago 02", category: 'Stone', color: c(98, 91, 83),
    texture: {
      widthM: 1.7, heightM: 1.7, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/grey_cartago_02.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/grey_cartago_02-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_grey_cartago_03', name: "Grey Cartago 03", category: 'Stone', color: c(95, 91, 83),
    texture: {
      widthM: 0.93, heightM: 0.93, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/grey_cartago_03.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/grey_cartago_03-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_Marble', name: "Honed Marble", category: 'Stone', color: c(177, 157, 122),
    texture: {
      widthM: 1.5, heightM: 1.5, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/marble_01.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/marble_01-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_large_grey_tiles', name: "Large Grey Tiles", category: 'Stone', color: c(132, 126, 115),
    texture: {
      widthM: 3.0, heightM: 3.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/large_grey_tiles.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/large_grey_tiles-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_large_pebbles', name: "Large Pebbles", category: 'Stone', color: c(66, 59, 50),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/large_pebbles.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/large_pebbles-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_marble_cliff_03', name: "Marble Cliff 03", category: 'Stone', color: c(155, 125, 91),
    texture: {
      widthM: 5.748309, heightM: 5.748309, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/marble_cliff_03.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/marble_cliff_03-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_marble_cliff_04', name: "Marble Cliff 04", category: 'Stone', color: c(192, 163, 136),
    texture: {
      widthM: 12.656517, heightM: 12.656399, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/marble_cliff_04.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/marble_cliff_04-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_marble_cliff_05', name: "Marble Cliff 05", category: 'Stone', color: c(147, 140, 131),
    texture: {
      widthM: 20.002069, heightM: 20.001801, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/marble_cliff_05.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/marble_cliff_05-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_medieval_blocks_05', name: "Medieval Blocks 05", category: 'Stone', color: c(161, 131, 97),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/medieval_blocks_05.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/medieval_blocks_05-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_rock_01', name: "Rock 01", category: 'Stone', color: c(117, 106, 93),
    texture: {
      widthM: 1.5, heightM: 1.5, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/rock_01.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/rock_01-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_rock_06', name: "Rock 06", category: 'Stone', color: c(126, 97, 70),
    texture: {
      widthM: 1.5, heightM: 1.5, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/rock_06.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/rock_06-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_rock_08', name: "Rock 08", category: 'Stone', color: c(142, 124, 101),
    texture: {
      widthM: 1.5, heightM: 1.5, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/rock_08.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/rock_08-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_rock_boulder_dry', name: "Rock Boulder Dry", category: 'Stone', color: c(168, 155, 140),
    texture: {
      widthM: 1.8, heightM: 1.8, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/rock_boulder_dry.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/rock_boulder_dry-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_rock_face_03', name: "Rock Face 03", category: 'Stone', color: c(131, 105, 80),
    texture: {
      widthM: 2.7, heightM: 2.7, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/rock_face_03.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/rock_face_03-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_rock_pitted_mossy', name: "Rock Pitted Mossy", category: 'Stone', color: c(195, 156, 118),
    texture: {
      widthM: 1.0, heightM: 1.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/rock_pitted_mossy.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/rock_pitted_mossy-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_rock_tile_floor', name: "Rock Tile Floor", category: 'Stone', color: c(148, 141, 131),
    texture: {
      widthM: 1.96, heightM: 1.96, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/rock_tile_floor.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/rock_tile_floor-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_rock_wall_11', name: "Rock Wall 11", category: 'Stone', color: c(199, 173, 134),
    texture: {
      widthM: 1.91, heightM: 1.91, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/rock_wall_11.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/rock_wall_11-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_rock_wall_13', name: "Rock Wall 13", category: 'Stone', color: c(76, 66, 57),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/rock_wall_13.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/rock_wall_13-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_roof_slates_03', name: "Roof Slates 03", category: 'Stone', color: c(113, 110, 104),
    texture: {
      widthM: 3.0, heightM: 3.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/roof_slates_03.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/roof_slates_03-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_rustic_stone_wall_02', name: "Rustic Stone Wall 02", category: 'Stone', color: c(136, 116, 91),
    texture: {
      widthM: 1.5, heightM: 1.5, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/rustic_stone_wall_02.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/rustic_stone_wall_02-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_sandstone_cracks', name: "Sandstone Cracks", category: 'Stone', color: c(209, 161, 116),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/sandstone_cracks.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/sandstone_cracks-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_seaside_rock', name: "Seaside Rock", category: 'Stone', color: c(69, 64, 55),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/seaside_rock.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/seaside_rock-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_Slate', name: "Slate Flagstone", category: 'Stone', color: c(42, 30, 30),
    texture: {
      widthM: 2.29, heightM: 2.29, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/slate_floor.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/slate_floor-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_square_floor', name: "Square Floor", category: 'Stone', color: c(71, 71, 71),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/square_floor.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/square_floor-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_Stacked', name: "Stacked Stone", category: 'Stone', color: c(95, 69, 48),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/stacked_stone_wall.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/stacked_stone_wall-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_stone_tiles', name: "Stone Tiles", category: 'Stone', color: c(82, 87, 73),
    texture: {
      widthM: 3.17, heightM: 3.17, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/stone_tiles.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/stone_tiles-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_stone_tiles_02', name: "Stone Tiles 02", category: 'Stone', color: c(122, 122, 114),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/stone_tiles_02.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/stone_tiles_02-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_stone_wall', name: "Stone Wall", category: 'Stone', color: c(162, 146, 122),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/stone_wall.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/stone_wall-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_wood_inlaid_stone_wall', name: "Wood Inlaid Stone Wall", category: 'Stone', color: c(100, 82, 63),
    texture: {
      widthM: 1.3, heightM: 1.3, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/wood_inlaid_stone_wall.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/wood_inlaid_stone_wall-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Stone_wood_stone_pathway', name: "Wood Stone Pathway", category: 'Stone', color: c(127, 84, 56),
    texture: {
      widthM: 1.85, heightM: 1.85, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/wood_stone_pathway.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/wood_stone_pathway-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Metal_Blue', name: "Blue Painted Metal", category: 'Metal', color: c(41, 62, 76),
    texture: {
      widthM: 2.5, heightM: 2.5, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/blue_metal_plate.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/blue_metal_plate-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Metal_box_profile_metal_sheet', name: "Box Profile Metal Sheet", category: 'Metal', color: c(106, 38, 23),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/box_profile_metal_sheet.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/box_profile_metal_sheet-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Metal_container_side', name: "Container Side", category: 'Metal', color: c(93, 136, 81),
    texture: {
      widthM: 1.94, heightM: 1.94, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/container_side.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/container_side-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Metal_Corrugated', name: "Corrugated Iron", category: 'Metal', color: c(170, 179, 174),
    texture: {
      widthM: 1.12, heightM: 1.12, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/corrugated_iron.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/corrugated_iron-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Metal_corrugated_iron_02', name: "Corrugated Iron 02", category: 'Metal', color: c(89, 88, 81),
    texture: {
      widthM: 2.7, heightM: 2.7, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/corrugated_iron_02.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/corrugated_iron_02-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Metal_corrugated_iron_03', name: "Corrugated Iron 03", category: 'Metal', color: c(108, 118, 118),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/corrugated_iron_03.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/corrugated_iron_03-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Metal_Plate', name: "Diamond Plate", category: 'Metal', color: c(61, 50, 28),
    texture: {
      widthM: 0.5, heightM: 0.5, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/metal_plate.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/metal_plate-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Metal_factory_wall', name: "Factory Wall", category: 'Metal', color: c(97, 118, 75),
    texture: {
      widthM: 3.0, heightM: 3.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/factory_wall.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/factory_wall-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Metal_green_metal_rust', name: "Green Metal Rust", category: 'Metal', color: c(63, 77, 52),
    texture: {
      widthM: 1.0, heightM: 1.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/green_metal_rust.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/green_metal_rust-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Metal_metal_grate_rusty', name: "Metal Grate Rusty", category: 'Metal', color: c(130, 83, 50),
    texture: {
      widthM: 0.5, heightM: 0.5, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/metal_grate_rusty.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/metal_grate_rusty-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Metal_painted_metal_shutter', name: "Painted Metal Shutter", category: 'Metal', color: c(128, 131, 134),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/painted_metal_shutter.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/painted_metal_shutter-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Metal_rust_coarse_01', name: "Rust Coarse 01", category: 'Metal', color: c(98, 57, 32),
    texture: {
      widthM: 2.2, heightM: 2.2, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/rust_coarse_01.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/rust_coarse_01-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Metal_Rusted', name: "Rusted Metal", category: 'Metal', color: c(119, 110, 84),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/rusty_metal_sheet.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/rusty_metal_sheet-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Metal_rusted_shutter', name: "Rusted Shutter", category: 'Metal', color: c(51, 46, 47),
    texture: {
      widthM: 1.8, heightM: 1.8, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/rusted_shutter.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/rusted_shutter-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Metal_rusty_corrugated_iron', name: "Rusty Corrugated Iron", category: 'Metal', color: c(87, 41, 24),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/rusty_corrugated_iron.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/rusty_corrugated_iron-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Metal_rusty_metal', name: "Rusty Metal", category: 'Metal', color: c(162, 98, 46),
    texture: {
      widthM: 1.5, heightM: 1.5, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/rusty_metal.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/rusty_metal-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Metal_rusty_metal_03', name: "Rusty Metal 03", category: 'Metal', color: c(131, 84, 20),
    texture: {
      widthM: 1.35, heightM: 1.35, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/rusty_metal_03.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/rusty_metal_03-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Metal_rusty_metal_04', name: "Rusty Metal 04", category: 'Metal', color: c(87, 66, 53),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/rusty_metal_04.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/rusty_metal_04-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Metal_rusty_metal_05', name: "Rusty Metal 05", category: 'Metal', color: c(100, 61, 36),
    texture: {
      widthM: 1.25, heightM: 1.25, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/rusty_metal_05.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/rusty_metal_05-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Metal_rusty_metal_grid', name: "Rusty Metal Grid", category: 'Metal', color: c(122, 126, 97),
    texture: {
      widthM: 1.8, heightM: 1.8, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/rusty_metal_grid.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/rusty_metal_grid-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Metal_rusty_metal_shutter', name: "Rusty Metal Shutter", category: 'Metal', color: c(139, 119, 97),
    texture: {
      widthM: 1.9, heightM: 1.9, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/rusty_metal_shutter.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/rusty_metal_shutter-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Metal_rusty_painted_metal', name: "Rusty Painted Metal", category: 'Metal', color: c(109, 59, 44),
    texture: {
      widthM: 2.2, heightM: 2.2, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/rusty_painted_metal.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/rusty_painted_metal-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Metal_Diamond', name: "Weathered Metal Plates", category: 'Metal', color: c(84, 73, 62),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/metal_plate_02.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/metal_plate_02-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Metal_Weathered', name: "Weathered Steel", category: 'Metal', color: c(172, 144, 90),
    texture: {
      widthM: 1.0, heightM: 1.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/rusty_metal_02.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/rusty_metal_02-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Metal_worn_corrugated_iron', name: "Worn Corrugated Iron", category: 'Metal', color: c(120, 119, 116),
    texture: {
      widthM: 1.8, heightM: 1.8, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/worn_corrugated_iron.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/worn_corrugated_iron-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Metal_worn_shutter', name: "Worn Shutter", category: 'Metal', color: c(65, 60, 54),
    texture: {
      widthM: 1.37, heightM: 1.37, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/worn_shutter.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/worn_shutter-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_aerial_beach_01', name: "Aerial Beach 01", category: 'Terrain', color: c(145, 134, 122),
    texture: {
      widthM: 30.0, heightM: 30.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/aerial_beach_01.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/aerial_beach_01-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_aerial_mud_1', name: "Aerial Mud 1", category: 'Terrain', color: c(62, 56, 52),
    texture: {
      widthM: 8.0, heightM: 8.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/aerial_mud_1.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/aerial_mud_1-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_aerial_sand', name: "Aerial Sand", category: 'Terrain', color: c(158, 138, 129),
    texture: {
      widthM: 15.0, heightM: 15.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/aerial_sand.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/aerial_sand-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_aerial_wood_snips', name: "Aerial Wood Snips", category: 'Terrain', color: c(133, 108, 86),
    texture: {
      widthM: 30.0, heightM: 30.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/aerial_wood_snips.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/aerial_wood_snips-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_brown_mud', name: "Brown Mud", category: 'Terrain', color: c(94, 86, 75),
    texture: {
      widthM: 1.299996, heightM: 1.299996, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/brown_mud.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/brown_mud-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_brown_mud_02', name: "Brown Mud 02", category: 'Terrain', color: c(77, 68, 55),
    texture: {
      widthM: 1.299996, heightM: 1.299996, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/brown_mud_02.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/brown_mud_02-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_brown_mud_03', name: "Brown Mud 03", category: 'Terrain', color: c(83, 73, 59),
    texture: {
      widthM: 1.299996, heightM: 1.299996, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/brown_mud_03.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/brown_mud_03-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_brown_mud_dry', name: "Brown Mud Dry", category: 'Terrain', color: c(115, 91, 62),
    texture: {
      widthM: 1.299996, heightM: 1.299996, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/brown_mud_dry.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/brown_mud_dry-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_brown_mud_leaves_01', name: "Brown Mud Leaves 01", category: 'Terrain', color: c(101, 84, 51),
    texture: {
      widthM: 1.3, heightM: 1.3, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/brown_mud_leaves_01.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/brown_mud_leaves_01-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_burned_ground_01', name: "Burned Ground 01", category: 'Terrain', color: c(98, 85, 73),
    texture: {
      widthM: 1.0, heightM: 1.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/burned_ground_01.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/burned_ground_01-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_clean_pebbles', name: "Clean Pebbles", category: 'Terrain', color: c(148, 136, 125),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/clean_pebbles.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/clean_pebbles-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_coast_sand_01', name: "Coast Sand 01", category: 'Terrain', color: c(130, 114, 91),
    texture: {
      widthM: 15.0, heightM: 15.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/coast_sand_01.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/coast_sand_01-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_coral_ground_02', name: "Coral Ground 02", category: 'Terrain', color: c(150, 120, 88),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/coral_ground_02.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/coral_ground_02-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_coral_mud_01', name: "Coral Mud 01", category: 'Terrain', color: c(169, 142, 110),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/coral_mud_01.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/coral_mud_01-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_dirt', name: "Dirt", category: 'Terrain', color: c(99, 82, 62),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/dirt.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/dirt-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_dirt_floor', name: "Dirt Floor", category: 'Terrain', color: c(182, 140, 100),
    texture: {
      widthM: 2.07, heightM: 2.07, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/dirt_floor.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/dirt_floor-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_dry_ground_rocks', name: "Dry Ground Rocks", category: 'Terrain', color: c(149, 115, 78),
    texture: {
      widthM: 4.0, heightM: 4.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/dry_ground_rocks.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/dry_ground_rocks-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_forrest_ground_01', name: "Forest Ground 01", category: 'Terrain', color: c(145, 135, 93),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/forrest_ground_01.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/forrest_ground_01-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_forrest_ground_03', name: "Forest Ground 03", category: 'Terrain', color: c(157, 128, 101),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/forrest_ground_03.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/forrest_ground_03-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_forest_ground_04', name: "Forest Ground 04", category: 'Terrain', color: c(106, 90, 68),
    texture: {
      widthM: 3.15, heightM: 3.15, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/forest_ground_04.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/forest_ground_04-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_forest_leaves_02', name: "Forest Leaves 02", category: 'Terrain', color: c(142, 112, 58),
    texture: {
      widthM: 3.000973, heightM: 3.00098, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/forest_leaves_02.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/forest_leaves_02-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_forrest_sand_01', name: "Forest Sand 01", category: 'Terrain', color: c(127, 107, 87),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/forrest_sand_01.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/forrest_sand_01-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_ganges_river_pebbles', name: "Ganges River Pebbles", category: 'Terrain', color: c(127, 117, 105),
    texture: {
      widthM: 2.16, heightM: 2.16, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/ganges_river_pebbles.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/ganges_river_pebbles-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_grass_ground', name: "Grass Ground", category: 'Terrain', color: c(110, 96, 62),
    texture: {
      widthM: 2.51, heightM: 2.51, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/grass_ground.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/grass_ground-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_gravel_floor_02', name: "Gravel Floor 02", category: 'Terrain', color: c(170, 166, 155),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/gravel_floor_02.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/gravel_floor_02-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_gravel_stones', name: "Gravel Stones", category: 'Terrain', color: c(79, 79, 76),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/gravel_stones.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/gravel_stones-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_gravelly_sand', name: "Gravelly Sand", category: 'Terrain', color: c(146, 111, 76),
    texture: {
      widthM: 2.48, heightM: 2.48, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/gravelly_sand.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/gravelly_sand-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_gray_rocks', name: "Gray Rocks", category: 'Terrain', color: c(120, 113, 100),
    texture: {
      widthM: 1.8, heightM: 1.8, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/gray_rocks.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/gray_rocks-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_ground_grey', name: "Ground Grey", category: 'Terrain', color: c(147, 139, 128),
    texture: {
      widthM: 1.0, heightM: 1.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/ground_grey.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/ground_grey-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_leafy_grass', name: "Leafy Grass", category: 'Terrain', color: c(151, 131, 89),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/leafy_grass.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/leafy_grass-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_mud_cracked_dry_03', name: "Mud Cracked Dry 03", category: 'Terrain', color: c(207, 169, 129),
    texture: {
      widthM: 1.5, heightM: 1.5, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/mud_cracked_dry_03.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/mud_cracked_dry_03-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_muddy_tracks', name: "Muddy Tracks", category: 'Terrain', color: c(80, 47, 28),
    texture: {
      widthM: 2.25, heightM: 2.25, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/muddy_tracks.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/muddy_tracks-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_red_dirt_mud_01', name: "Red Dirt Mud 01", category: 'Terrain', color: c(126, 83, 53),
    texture: {
      widthM: 1.5, heightM: 1.5, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/red_dirt_mud_01.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/red_dirt_mud_01-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_red_laterite_soil_stones', name: "Red Laterite Soil Stones", category: 'Terrain', color: c(101, 62, 46),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/red_laterite_soil_stones.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/red_laterite_soil_stones-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_red_mud_stones', name: "Red Mud Stones", category: 'Terrain', color: c(110, 66, 39),
    texture: {
      widthM: 1.5, heightM: 1.5, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/red_mud_stones.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/red_mud_stones-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_rocks_ground_02', name: "Rocks Ground 02", category: 'Terrain', color: c(109, 94, 70),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/rocks_ground_02.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/rocks_ground_02-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_rocks_ground_03', name: "Rocks Ground 03", category: 'Terrain', color: c(124, 111, 85),
    texture: {
      widthM: 3.0, heightM: 3.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/rocks_ground_03.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/rocks_ground_03-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_rocky_terrain', name: "Rocky Terrain", category: 'Terrain', color: c(103, 80, 46),
    texture: {
      widthM: 90.0, heightM: 90.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/rocky_terrain.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/rocky_terrain-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_rocky_terrain_02', name: "Rocky Terrain 02", category: 'Terrain', color: c(80, 78, 28),
    texture: {
      widthM: 90.0, heightM: 90.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/rocky_terrain_02.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/rocky_terrain_02-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_rocky_trail', name: "Rocky Trail", category: 'Terrain', color: c(147, 128, 107),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/rocky_trail.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/rocky_trail-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_rocky_trail_02', name: "Rocky Trail 02", category: 'Terrain', color: c(136, 107, 82),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/rocky_trail_02.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/rocky_trail_02-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_roots', name: "Roots", category: 'Terrain', color: c(115, 95, 68),
    texture: {
      widthM: 1.67, heightM: 1.67, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/roots.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/roots-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_sand_01', name: "Sand 01", category: 'Terrain', color: c(165, 149, 111),
    texture: {
      widthM: 1.5, heightM: 1.5, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/sand_01.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/sand_01-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_sandy_gravel_02', name: "Sandy Gravel 02", category: 'Terrain', color: c(154, 115, 82),
    texture: {
      widthM: 2.53, heightM: 2.53, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/sandy_gravel_02.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/sandy_gravel_02-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_snow_01', name: "Snow 01", category: 'Terrain', color: c(185, 182, 181),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/snow_01.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/snow_01-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_snow_02', name: "Snow 02", category: 'Terrain', color: c(165, 165, 167),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/snow_02.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/snow_02-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_snow_03', name: "Snow 03", category: 'Terrain', color: c(157, 155, 149),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/snow_03.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/snow_03-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_snow_field_aerial', name: "Snow Field Aerial", category: 'Terrain', color: c(135, 134, 148),
    texture: {
      widthM: 80.0, heightM: 80.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/snow_field_aerial.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/snow_field_aerial-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_sparse_grass', name: "Sparse Grass", category: 'Terrain', color: c(79, 61, 21),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/sparse_grass.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/sparse_grass-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Terrain_wood_chips', name: "Wood Chips", category: 'Terrain', color: c(80, 56, 27),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/wood_chips.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/wood_chips-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_bi_stretch', name: "Bi Stretch", category: 'Textiles', color: c(247, 172, 40),
    texture: {
      widthM: 0.264564, heightM: 0.2644, widthPx: 1024, heightPx: 1023,
      url: new URL('./material-textures/bi_stretch.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/bi_stretch-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_book_pattern', name: "Book Pattern", category: 'Textiles', color: c(68, 64, 22),
    texture: {
      widthM: 0.3, heightM: 0.3, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/book_pattern.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/book_pattern-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_brown_leather', name: "Brown Leather", category: 'Textiles', color: c(81, 45, 16),
    texture: {
      widthM: 0.4, heightM: 0.4, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/brown_leather.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/brown_leather-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_caban', name: "Caban", category: 'Textiles', color: c(206, 102, 4),
    texture: {
      widthM: 0.273992, heightM: 0.2733, widthPx: 1024, heightPx: 1021,
      url: new URL('./material-textures/caban.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/caban-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_cotton_jersey', name: "Cotton Jersey", category: 'Textiles', color: c(194, 171, 157),
    texture: {
      widthM: 0.263603, heightM: 0.2638, widthPx: 1024, heightPx: 1025,
      url: new URL('./material-textures/cotton_jersey.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/cotton_jersey-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_crepe_georgette', name: "Crepe Georgette", category: 'Textiles', color: c(134, 222, 201),
    texture: {
      widthM: 0.261195, heightM: 0.2656, widthPx: 1024, heightPx: 1041,
      url: new URL('./material-textures/crepe_georgette.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/crepe_georgette-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_crepe_satin', name: "Crepe Satin", category: 'Textiles', color: c(218, 172, 118),
    texture: {
      widthM: 0.263199, heightM: 0.2679, widthPx: 1024, heightPx: 1042,
      url: new URL('./material-textures/crepe_satin.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/crepe_satin-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_curly_teddy_checkered', name: "Curly Teddy Checkered", category: 'Textiles', color: c(142, 155, 144),
    texture: {
      widthM: 0.561844, heightM: 0.4741, widthPx: 1024, heightPx: 864,
      url: new URL('./material-textures/curly_teddy_checkered.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/curly_teddy_checkered-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_curly_teddy_natural', name: "Curly Teddy Natural", category: 'Textiles', color: c(233, 211, 187),
    texture: {
      widthM: 0.335804, heightM: 0.3309, widthPx: 1024, heightPx: 1009,
      url: new URL('./material-textures/curly_teddy_natural.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/curly_teddy_natural-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_denim_fabric', name: "Denim Fabric", category: 'Textiles', color: c(78, 113, 142),
    texture: {
      widthM: 0.1, heightM: 0.1, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/denim_fabric.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/denim_fabric-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_denmin_fabric_02', name: "Denim Fabric 02", category: 'Textiles', color: c(46, 78, 94),
    texture: {
      widthM: 0.1, heightM: 0.1, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/denmin_fabric_02.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/denmin_fabric_02-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_denim_fabric_03', name: "Denim Fabric 03", category: 'Textiles', color: c(58, 88, 119),
    texture: {
      widthM: 0.271428, heightM: 0.271, widthPx: 1024, heightPx: 1022,
      url: new URL('./material-textures/denim_fabric_03.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/denim_fabric_03-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_denim_fabric_04', name: "Denim Fabric 04", category: 'Textiles', color: c(74, 104, 134),
    texture: {
      widthM: 0.272897, heightM: 0.2693, widthPx: 1024, heightPx: 1011,
      url: new URL('./material-textures/denim_fabric_04.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/denim_fabric_04-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_denim_fabric_05', name: "Denim Fabric 05", category: 'Textiles', color: c(103, 101, 100),
    texture: {
      widthM: 0.270152, heightM: 0.2715, widthPx: 1024, heightPx: 1029,
      url: new URL('./material-textures/denim_fabric_05.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/denim_fabric_05-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_denim_fabric_06', name: "Denim Fabric 06", category: 'Textiles', color: c(29, 34, 45),
    texture: {
      widthM: 0.254158, heightM: 0.254, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/denim_fabric_06.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/denim_fabric_06-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_dirty_carpet', name: "Dirty Carpet", category: 'Textiles', color: c(53, 47, 37),
    texture: {
      widthM: 0.6, heightM: 0.6, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/dirty_carpet.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/dirty_carpet-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_fabric_leather_01', name: "Fabric Leather 01", category: 'Textiles', color: c(126, 84, 60),
    texture: {
      widthM: 0.4, heightM: 0.4, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/fabric_leather_01.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/fabric_leather_01-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_fabric_leather_02', name: "Fabric Leather 02", category: 'Textiles', color: c(129, 78, 26),
    texture: {
      widthM: 0.5, heightM: 0.5, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/fabric_leather_02.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/fabric_leather_02-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_fabric_pattern_05', name: "Fabric Pattern 05", category: 'Textiles', color: c(143, 147, 128),
    texture: {
      widthM: 0.5, heightM: 0.5, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/fabric_pattern_05.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/fabric_pattern_05-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_fabric_pattern_07', name: "Fabric Pattern 07", category: 'Textiles', color: c(154, 89, 85),
    texture: {
      widthM: 0.4, heightM: 0.4, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/fabric_pattern_07.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/fabric_pattern_07-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_faux_fur_geometric', name: "Faux Fur Geometric", category: 'Textiles', color: c(126, 100, 103),
    texture: {
      widthM: 0.302, heightM: 0.301977, widthPx: 1024, heightPx: 1010,
      url: new URL('./material-textures/faux_fur_geometric.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/faux_fur_geometric-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_floral_jacquard', name: "Floral Jacquard", category: 'Textiles', color: c(65, 64, 69),
    texture: {
      widthM: 0.25295, heightM: 0.3836, widthPx: 1024, heightPx: 1553,
      url: new URL('./material-textures/floral_jacquard.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/floral_jacquard-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_gingham_check', name: "Gingham Check", category: 'Textiles', color: c(121, 144, 132),
    texture: {
      widthM: 0.283651, heightM: 0.2968, widthPx: 1024, heightPx: 1071,
      url: new URL('./material-textures/gingham_check.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/gingham_check-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_hessian_230', name: "Hessian 230", category: 'Textiles', color: c(140, 120, 89),
    texture: {
      widthM: 0.268754, heightM: 0.2672, widthPx: 1024, heightPx: 1018,
      url: new URL('./material-textures/hessian_230.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/hessian_230-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_hessian_380', name: "Hessian 380", category: 'Textiles', color: c(176, 144, 106),
    texture: {
      widthM: 0.273866, heightM: 0.2738, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/hessian_380.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/hessian_380-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_jersey_melange', name: "Jersey Melange", category: 'Textiles', color: c(109, 133, 179),
    texture: {
      widthM: 0.290624, heightM: 0.2762, widthPx: 1024, heightPx: 973,
      url: new URL('./material-textures/jersey_melange.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/jersey_melange-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_jogging_melange', name: "Jogging Melange", category: 'Textiles', color: c(179, 176, 169),
    texture: {
      widthM: 0.273497, heightM: 0.2733, widthPx: 1024, heightPx: 1023,
      url: new URL('./material-textures/jogging_melange.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/jogging_melange-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_knitted_fleece', name: "Knitted Fleece", category: 'Textiles', color: c(85, 76, 63),
    texture: {
      widthM: 0.266357, heightM: 0.2704, widthPx: 1024, heightPx: 1040,
      url: new URL('./material-textures/knitted_fleece.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/knitted_fleece-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_leather_red_02', name: "Leather Red 02", category: 'Textiles', color: c(79, 44, 26),
    texture: {
      widthM: 0.6, heightM: 0.6, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/leather_red_02.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/leather_red_02-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_leather_red_03', name: "Leather Red 03", category: 'Textiles', color: c(95, 34, 23),
    texture: {
      widthM: 0.3, heightM: 0.3, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/leather_red_03.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/leather_red_03-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_leather_white', name: "Leather White", category: 'Textiles', color: c(150, 147, 128),
    texture: {
      widthM: 0.3, heightM: 0.3, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/leather_white.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/leather_white-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_polar_fleece', name: "Polar Fleece", category: 'Textiles', color: c(209, 173, 133),
    texture: {
      widthM: 0.273287, heightM: 0.2715, widthPx: 1024, heightPx: 1017,
      url: new URL('./material-textures/polar_fleece.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/polar_fleece-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_poly_wool_herringbone', name: "Poly Wool Herringbone", category: 'Textiles', color: c(121, 117, 113),
    texture: {
      widthM: 0.270079, heightM: 0.2757, widthPx: 1024, heightPx: 1045,
      url: new URL('./material-textures/poly_wool_herringbone.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/poly_wool_herringbone-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_quatrefoil_jacquard_fabric', name: "Quatrefoil Jacquard Fabric", category: 'Textiles', color: c(147, 3, 32),
    texture: {
      widthM: 0.280119, heightM: 0.2838, widthPx: 1024, heightPx: 1037,
      url: new URL('./material-textures/quatrefoil_jacquard_fabric.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/quatrefoil_jacquard_fabric-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_ribbed_corduroy', name: "Ribbed Corduroy", category: 'Textiles', color: c(141, 147, 128),
    texture: {
      widthM: 0.266404, heightM: 0.2667, widthPx: 1024, heightPx: 1025,
      url: new URL('./material-textures/ribbed_corduroy.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/ribbed_corduroy-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_rough_linen', name: "Rough Linen", category: 'Textiles', color: c(145, 171, 205),
    texture: {
      widthM: 0.270708, heightM: 0.2713, widthPx: 1024, heightPx: 1026,
      url: new URL('./material-textures/rough_linen.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/rough_linen-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_scuba_suede', name: "Scuba Suede", category: 'Textiles', color: c(18, 95, 108),
    texture: {
      widthM: 0.28522, heightM: 0.2789, widthPx: 1024, heightPx: 1001,
      url: new URL('./material-textures/scuba_suede.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/scuba_suede-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_stretch_poplin', name: "Stretch Poplin", category: 'Textiles', color: c(183, 212, 99),
    texture: {
      widthM: 0.291023, heightM: 0.2808, widthPx: 1024, heightPx: 988,
      url: new URL('./material-textures/stretch_poplin.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/stretch_poplin-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_tatami_mat', name: "Tatami Mat", category: 'Textiles', color: c(143, 130, 96),
    texture: {
      widthM: 1.8, heightM: 1.8, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/tatami_mat.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/tatami_mat-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_terlenka', name: "Terlenka", category: 'Textiles', color: c(197, 175, 153),
    texture: {
      widthM: 0.265708, heightM: 0.2663, widthPx: 1024, heightPx: 1026,
      url: new URL('./material-textures/terlenka.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/terlenka-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_terry_cloth', name: "Terry Cloth", category: 'Textiles', color: c(5, 72, 150),
    texture: {
      widthM: 0.367054, heightM: 0.3632, widthPx: 1024, heightPx: 1013,
      url: new URL('./material-textures/terry_cloth.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/terry_cloth-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_velour_velvet', name: "Velour Velvet", category: 'Textiles', color: c(174, 45, 71),
    texture: {
      widthM: 0.284228, heightM: 0.2735, widthPx: 1024, heightPx: 985,
      url: new URL('./material-textures/velour_velvet.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/velour_velvet-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_waffle_pique_cotton', name: "Waffle Pique Cotton", category: 'Textiles', color: c(225, 156, 5),
    texture: {
      widthM: 0.280787, heightM: 0.2768, widthPx: 1024, heightPx: 1010,
      url: new URL('./material-textures/waffle_pique_cotton.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/waffle_pique_cotton-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Textiles_wool_boucle', name: "Wool Boucle", category: 'Textiles', color: c(118, 109, 97),
    texture: {
      widthM: 0.314782, heightM: 0.3901, widthPx: 1024, heightPx: 1269,
      url: new URL('./material-textures/wool_boucle.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/wool_boucle-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Plastic_linoleum_brown', name: "Linoleum Brown", category: 'Plastic', color: c(153, 122, 89),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/linoleum_brown.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/linoleum_brown-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Plastic_old_linoleum_flooring_01', name: "Old Linoleum Flooring 01", category: 'Plastic', color: c(176, 131, 79),
    texture: {
      widthM: 1.99, heightM: 1.99, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/old_linoleum_flooring_01.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/old_linoleum_flooring_01-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Plastic_polystyrene', name: "Polystyrene", category: 'Plastic', color: c(219, 222, 222),
    texture: {
      widthM: 1.5, heightM: 1.5, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/polystyrene.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/polystyrene-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Plastic_rubber_tiles', name: "Rubber Tiles", category: 'Plastic', color: c(32, 33, 37),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/rubber_tiles.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/rubber_tiles-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Plastic_rubberized_track', name: "Rubberized Track", category: 'Plastic', color: c(116, 61, 53),
    texture: {
      widthM: 2.0, heightM: 2.0, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/rubberized_track.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/rubberized_track-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Plastic_running_track', name: "Running Track", category: 'Plastic', color: c(105, 122, 130),
    texture: {
      widthM: 2.42, heightM: 2.42, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/running_track.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/running_track-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Organic_flour', name: "Flour", category: 'Organic', color: c(230, 220, 203),
    texture: {
      widthM: 1.27, heightM: 1.27, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/flour.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/flour-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Organic_macro_flour', name: "Macro Flour", category: 'Organic', color: c(218, 205, 189),
    texture: {
      widthM: 0.3, heightM: 0.3, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/macro_flour.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/macro_flour-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Organic_reed_roof_03', name: "Reed Roof 03", category: 'Organic', color: c(138, 118, 90),
    texture: {
      widthM: 2.5, heightM: 2.5, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/reed_roof_03.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/reed_roof_03-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Organic_reed_roof_04', name: "Reed Roof 04", category: 'Organic', color: c(156, 134, 103),
    texture: {
      widthM: 2.5, heightM: 2.5, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/reed_roof_04.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/reed_roof_04-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Organic_riet_01', name: "Riet 01", category: 'Organic', color: c(95, 89, 82),
    texture: {
      widthM: 2.5, heightM: 2.5, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/riet_01.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/riet_01-preview.jpg?no-inline', import.meta.url).href,
    },
  },
  {
    key: 'Organic_thatch_roof_angled', name: "Thatch Roof Angled", category: 'Organic', color: c(84, 80, 73),
    texture: {
      widthM: 0.54, heightM: 0.54, widthPx: 1024, heightPx: 1024,
      url: new URL('./material-textures/thatch_roof_angled.jpg', import.meta.url).href,
      previewUrl: new URL('./material-textures/thatch_roof_angled-preview.jpg?no-inline', import.meta.url).href,
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
