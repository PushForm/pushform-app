// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Vec3 } from '@pushform/core';

/**
 * NOAA solar position (the "NOAA Solar Calculator" spreadsheet algorithm, after Meeus): sun
 * azimuth and elevation for a civil date/time, UTC offset and geographic location. Accurate to
 * well under a degree for 1900–2100, which is all a shadow study needs.
 */

export interface SolarInput {
  /** Calendar year (shadow settings carry month/day only; `DEFAULT_SOLAR_YEAR` is used then). */
  readonly year?: number | undefined;
  /** 1..12 */
  readonly month: number;
  /** 1..31 */
  readonly day: number;
  /** Local civil time as minutes since midnight. */
  readonly minutes: number;
  /** Local time zone offset from UTC in hours (e.g. -7 for MDT). */
  readonly utcOffsetHours: number;
  /** Degrees, north positive. */
  readonly latitude: number;
  /** Degrees, east positive. */
  readonly longitude: number;
}

export interface SolarPosition {
  /** Degrees clockwise from north (0 = N, 90 = E, 180 = S, 270 = W). */
  readonly azimuth: number;
  /** Degrees above the horizon (negative below), with atmospheric refraction applied. */
  readonly elevation: number;
  /** Degrees, the sun's declination. */
  readonly declination: number;
  /** Equation of time in minutes. */
  readonly equationOfTime: number;
  /** Local civil time of solar noon as minutes since midnight. */
  readonly solarNoonMinutes: number;
}

/** A non-leap reference year for month/day-only shadow settings. */
export const DEFAULT_SOLAR_YEAR = 2025;

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/** Julian Day of a civil UTC date/time (Gregorian). */
export function julianDay(year: number, month: number, day: number, hoursUtc: number): number {
  let y = year, m = month;
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  const a = Math.floor(y / 100);
  const b = 2 - a + Math.floor(a / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + day + b - 1524.5 + hoursUtc / 24;
}

export function solarPosition(input: SolarInput): SolarPosition {
  const year = input.year ?? DEFAULT_SOLAR_YEAR;
  const hoursLocal = input.minutes / 60;
  const hoursUtc = hoursLocal - input.utcOffsetHours;
  const jd = julianDay(year, input.month, input.day, hoursUtc);
  const t = (jd - 2451545) / 36525; // Julian century
  const l0 = ((280.46646 + t * (36000.76983 + t * 0.0003032)) % 360 + 360) % 360; // geometric mean longitude
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t); // geometric mean anomaly
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t); // eccentricity
  const mr = m * RAD;
  const c = Math.sin(mr) * (1.914602 - t * (0.004817 + 0.000014 * t)) + Math.sin(2 * mr) * (0.019993 - 0.000101 * t) + Math.sin(3 * mr) * 0.000289;
  const trueLong = l0 + c;
  const omega = 125.04 - 1934.136 * t;
  const apparentLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const obliq0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliq = obliq0 + 0.00256 * Math.cos(omega * RAD);
  const declination = Math.asin(Math.sin(obliq * RAD) * Math.sin(apparentLong * RAD)) * DEG;
  const y = Math.tan((obliq / 2) * RAD) ** 2;
  const l0r = l0 * RAD;
  const eqTime =
    4 *
    DEG *
    (y * Math.sin(2 * l0r) - 2 * e * Math.sin(mr) + 4 * e * y * Math.sin(mr) * Math.cos(2 * l0r) - 0.5 * y * y * Math.sin(4 * l0r) - 1.25 * e * e * Math.sin(2 * mr));
  // true solar time (minutes)
  const tst = (((input.minutes + eqTime + 4 * input.longitude - 60 * input.utcOffsetHours) % 1440) + 1440) % 1440;
  const hourAngle = tst / 4 < 0 ? tst / 4 + 180 : tst / 4 - 180;
  const lat = input.latitude * RAD;
  const dec = declination * RAD;
  const ha = hourAngle * RAD;
  const cosZenith = Math.min(1, Math.max(-1, Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha)));
  const zenith = Math.acos(cosZenith) * DEG;
  let azimuth: number;
  const denom = Math.cos(lat) * Math.sin(zenith * RAD);
  if (Math.abs(denom) > 1e-9) {
    const cosAz = Math.min(1, Math.max(-1, (Math.sin(lat) * cosZenith - Math.sin(dec)) / denom));
    const az = Math.acos(cosAz) * DEG;
    azimuth = hourAngle > 0 ? (az + 180) % 360 : (540 - az) % 360;
  } else {
    azimuth = input.latitude > 0 ? 180 : 0;
  }
  // atmospheric refraction (NOAA)
  const el0 = 90 - zenith;
  let refraction = 0;
  if (el0 <= 85) {
    const te = Math.tan(el0 * RAD);
    if (el0 > 5) refraction = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
    else if (el0 > -0.575) refraction = 1735 + el0 * (-518.2 + el0 * (103.4 + el0 * (-12.79 + el0 * 0.711)));
    else refraction = -20.774 / te;
    refraction /= 3600;
  }
  const solarNoonMinutes = (((720 - 4 * input.longitude - eqTime + 60 * input.utcOffsetHours) % 1440) + 1440) % 1440;
  return { azimuth, elevation: el0 + refraction, declination, equationOfTime: eqTime, solarNoonMinutes };
}

/**
 * Unit vector from the model toward the sun in model coordinates (Z up, +Y = north rotated by
 * `northAngle` degrees clockwise).
 */
export function sunDirection(azimuth: number, elevation: number, northAngle = 0): Vec3 {
  const az = (azimuth + northAngle) * RAD; // clockwise from model +Y
  const el = elevation * RAD;
  const horiz = Math.cos(el);
  // north = +Y, east = +X: azimuth 90 (east) → +X
  return [horiz * Math.sin(az), horiz * Math.cos(az), Math.sin(el)];
}
