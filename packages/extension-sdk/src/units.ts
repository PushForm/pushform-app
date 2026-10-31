// SPDX-License-Identifier: MIT
// Copyright 2026 PushForm contributors

/**
 * The API measures lengths in meters, areas in square meters, volumes in cubic meters and angles in degrees. These
 * convert common workshop units; PushForm shows every value in the document's own units.
 */
export const units = {
  millimeters: (mm: number): number => mm / 1000,
  centimeters: (cm: number): number => cm / 100,
  inches: (inches: number): number => inches * 0.0254,
  feet: (feet: number): number => feet * 0.3048,
  toMillimeters: (meters: number): number => meters * 1000,
  toInches: (meters: number): number => meters / 0.0254,
  /** Board feet (144 cubic inches) to cubic meters. */
  boardFeet: (boardFeet: number): number => boardFeet * 144 * 0.0254 ** 3,
  toBoardFeet: (cubicMeters: number): number => cubicMeters / (144 * 0.0254 ** 3),
} as const;
