// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/** Paper sizes and length units for the Document Settings dialog. Sizes are portrait, in millimeters. */

export type PaperUnit = 'mm' | 'in';

export const MM_PER_INCH = 25.4;

/** A size within half a millimeter of a preset is that preset; paper sizes are specified to the millimeter. */
const PAPER_MATCH_MM = 0.5;

export interface PaperPreset {
  readonly id: string;
  /** Short name, as in "Letter" or "A4". */
  readonly name: string;
  readonly label: string;
  readonly standard: 'US' | 'International';
  readonly sizeMm: readonly [number, number];
  readonly unit: PaperUnit;
}

/** Inch sizes are stored rounded to 0.1 µm, so 8.5 in is exactly 215.9 mm. */
const inchMm = (value: number): number => Number((value * MM_PER_INCH).toFixed(4));
const inches = (id: string, name: string, width: number, height: number): PaperPreset =>
  ({ id, name, label: `${name} (${width} × ${height} in)`, standard: 'US', sizeMm: [inchMm(width), inchMm(height)], unit: 'in' });
const iso = (id: string, width: number, height: number): PaperPreset =>
  ({ id, name: id, label: `${id} (${width} × ${height} mm)`, standard: 'International', sizeMm: [width, height], unit: 'mm' });

/** US sizes first, then international (ISO 216 A and B series). */
export const PAPER_PRESETS: readonly PaperPreset[] = [
  inches('letter', 'Letter', 8.5, 11),
  inches('legal', 'Legal', 8.5, 14),
  inches('tabloid', 'Tabloid', 11, 17),
  inches('ansi-c', 'ANSI C', 17, 22),
  inches('ansi-d', 'ANSI D', 22, 34),
  inches('ansi-e', 'ANSI E', 34, 44),
  inches('arch-a', 'Arch A', 9, 12),
  inches('arch-b', 'Arch B', 12, 18),
  inches('arch-c', 'Arch C', 18, 24),
  inches('arch-d', 'Arch D', 24, 36),
  inches('arch-e', 'Arch E', 36, 48),
  iso('A0', 841, 1189),
  iso('A1', 594, 841),
  iso('A2', 420, 594),
  iso('A3', 297, 420),
  iso('A4', 210, 297),
  iso('A5', 148, 210),
  iso('B4', 250, 353),
  iso('B5', 176, 250),
];

/** The preset a page size matches in either orientation, if any. */
export function paperPresetFor(sizeMm: readonly [number, number]): PaperPreset | undefined {
  const [short, long] = [Math.min(...sizeMm), Math.max(...sizeMm)];
  return PAPER_PRESETS.find(preset => Math.abs(preset.sizeMm[0] - short) <= PAPER_MATCH_MM && Math.abs(preset.sizeMm[1] - long) <= PAPER_MATCH_MM);
}

/** A preset's size, landscape: the long side across. */
export function presetSizeMm(preset: PaperPreset): [number, number] {
  const [short, long] = preset.sizeMm;
  return [long, short];
}

/** A length in millimeters shown in `unit`: up to three decimals for inches, two for millimeters. */
export function formatPaperLength(mm: number, unit: PaperUnit): string {
  return unit === 'in' ? String(Number((mm / MM_PER_INCH).toFixed(3))) : String(Number(mm.toFixed(2)));
}

export const toMm = (value: number, unit: PaperUnit): number => unit === 'in' ? value * MM_PER_INCH : value;
