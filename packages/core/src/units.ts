// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/** Internal unit is meters. */
export type LengthUnit = 'in' | 'ft' | 'yd' | 'mm' | 'cm' | 'm';
export type LengthFormat = 'architectural' | 'decimal' | 'engineering' | 'fractional';
export interface UnitSettings {
  format: LengthFormat;
  lengthUnit: LengthUnit;
  lengthPrecision: number; // decimals (decimal/engineering) or denominator power (1/2^n) for fractional
  areaUnit: 'in²' | 'ft²' | 'yd²' | 'mm²' | 'cm²' | 'm²';
  areaPrecision: number;
  volumeUnit: 'in³' | 'ft³' | 'yd³' | 'mm³' | 'cm³' | 'm³' | 'l';
  volumePrecision: number;
  lengthSnap: number | null; // meters, or null = off
  angleSnap: number | null; // degrees, or null = off
  anglePrecision: number;
  displayUnitSuffix: boolean;
  forceZeroInches: boolean;
}
export const DEFAULT_UNITS: UnitSettings = {
  format: 'architectural',
  lengthUnit: 'in',
  lengthPrecision: 4,
  areaUnit: 'ft²',
  areaPrecision: 2,
  volumeUnit: 'ft³',
  volumePrecision: 2,
  lengthSnap: null,
  angleSnap: 15,
  anglePrecision: 1,
  displayUnitSuffix: true,
  forceZeroInches: false,
};
export const METERS_PER: Record<LengthUnit, number> = {
  in: 0.0254,
  ft: 0.3048,
  yd: 0.9144,
  mm: 0.001,
  cm: 0.01,
  m: 1,
};
/**
 * The unit of a length typed without one: inches for architectural and fractional lengths, feet for
 * engineering lengths, and the length unit for decimal lengths.
 */
export function typedLengthUnit(u: Pick<UnitSettings, 'format' | 'lengthUnit'>): LengthUnit {
  switch (u.format) {
    case 'architectural':
    case 'fractional':
      return 'in';
    case 'engineering':
      return 'ft';
    default:
      return u.lengthUnit;
  }
}
export const toMeters = (value: number, unit: LengthUnit): number => value * METERS_PER[unit];
export const fromMeters = (meters: number, unit: LengthUnit): number => meters / METERS_PER[unit];

/**
 * Parse a length string: `10`, `10"`, `10'`, `3' 6"`, `3'6"`, `2.5m`, `10mm`, `1 1/2"`, `-4cm`.
 * A bare number uses `defaultUnit`. Returns meters or null.
 */
export function parseLength(input: string, defaultUnit: LengthUnit): number | null {
  const s = input.trim().replace(/’/g, "'").replace(/”|''/g, '"');
  if (!s) return null;
  let sign = 1;
  let rest = s;
  if (rest.startsWith('-')) {
    sign = -1;
    rest = rest.slice(1).trim();
  } else if (rest.startsWith('+')) rest = rest.slice(1).trim();
  // feet-inches: 3' 6" | 3'6 | 3' 6 1/2"
  const ftIn = rest.match(/^(\d+(?:\.\d+)?)\s*'\s*(?:(\d+(?:\.\d+)?)(?:\s+(\d+)\/(\d+))?\s*"?)?$/);
  if (ftIn) {
    const ft = parseFloat(ftIn[1]!);
    let inches = ftIn[2] ? parseFloat(ftIn[2]) : 0;
    if (ftIn[3] && ftIn[4]) inches += parseInt(ftIn[3]) / parseInt(ftIn[4]);
    return sign * (ft * METERS_PER.ft + inches * METERS_PER.in);
  }
  // mixed fraction inches: 1 1/2" or 1/2"
  const frac = rest.match(/^(?:(\d+)\s+)?(\d+)\/(\d+)\s*("|in|mm|cm|m|ft|yd)?$/);
  if (frac) {
    const whole = frac[1] ? parseInt(frac[1]) : 0;
    const val = whole + parseInt(frac[2]!) / parseInt(frac[3]!);
    const unit = normalizeUnit(frac[4]) ?? defaultUnit;
    return sign * toMeters(val, unit);
  }
  const num = rest.match(/^(\d*\.?\d+)\s*("|'|in|ft|yd|mm|cm|m)?$/);
  if (num) {
    const unit = normalizeUnit(num[2]) ?? defaultUnit;
    return sign * toMeters(parseFloat(num[1]!), unit);
  }
  return null;
}
function normalizeUnit(u: string | undefined): LengthUnit | null {
  switch (u) {
    case '"':
    case 'in':
      return 'in';
    case "'":
    case 'ft':
      return 'ft';
    case 'yd':
    case 'mm':
    case 'cm':
    case 'm':
      return u;
    default:
      return null;
  }
}

const M2_PER: Record<UnitSettings['areaUnit'], number> = {
  'in²': METERS_PER.in ** 2,
  'ft²': METERS_PER.ft ** 2,
  'yd²': METERS_PER.yd ** 2,
  'mm²': METERS_PER.mm ** 2,
  'cm²': METERS_PER.cm ** 2,
  'm²': 1,
};

/** Square meters → the document's area unit with its precision (e.g. `12.50 ft²`). */
export function formatArea(m2: number, u: UnitSettings): string {
  const v = m2 / M2_PER[u.areaUnit];
  return `${v.toFixed(u.areaPrecision)}${u.displayUnitSuffix ? ' ' + u.areaUnit : ''}`;
}

export function formatLength(meters: number, u: UnitSettings): string {
  const suffix = (unit: string) => (u.displayUnitSuffix ? unit : '');
  switch (u.format) {
    case 'architectural': {
      const sign = meters < 0 ? '-' : '';
      const totalIn = Math.abs(fromMeters(meters, 'in'));
      const denom = 2 ** Math.min(6, Math.max(0, u.lengthPrecision));
      let ft = Math.floor(totalIn / 12);
      let inWhole = Math.floor(totalIn - ft * 12);
      let num = Math.round((totalIn - ft * 12 - inWhole) * denom);
      if (num === denom) {
        num = 0;
        inWhole++;
      }
      if (inWhole === 12) {
        inWhole = 0;
        ft++;
      }
      const fracStr = num ? ` ${reduceFraction(num, denom)}` : '';
      const inchPart = `${inWhole}${fracStr}"`;
      if (ft === 0) return `${sign}${inchPart}`;
      if (inWhole === 0 && !num && !u.forceZeroInches) return `${sign}${ft}'`;
      return `${sign}${ft}' ${inchPart}`;
    }
    case 'fractional': {
      const sign = meters < 0 ? '-' : '';
      const totalIn = Math.abs(fromMeters(meters, 'in'));
      const denom = 2 ** Math.min(6, Math.max(0, u.lengthPrecision));
      let whole = Math.floor(totalIn);
      let num = Math.round((totalIn - whole) * denom);
      if (num === denom) {
        num = 0;
        whole++;
      }
      return `${sign}${whole}${num ? ' ' + reduceFraction(num, denom) : ''}${suffix('"')}`;
    }
    case 'engineering': {
      const ft = fromMeters(meters, 'ft');
      return `${ft.toFixed(u.lengthPrecision)}${suffix("'")}`;
    }
    case 'decimal':
    default: {
      const v = fromMeters(meters, u.lengthUnit);
      const unitLabel = u.lengthUnit === 'in' ? '"' : u.lengthUnit === 'ft' ? "'" : u.lengthUnit;
      return `${v.toFixed(u.lengthPrecision)}${suffix(unitLabel)}`;
    }
  }
}
function reduceFraction(num: number, denom: number): string {
  let a = num, b = denom;
  while (b) [a, b] = [b, a % b];
  return `${num / a}/${denom / a}`;
}
export function formatAngleDeg(deg: number, precision: number): string {
  return `${deg.toFixed(precision)}°`;
}
