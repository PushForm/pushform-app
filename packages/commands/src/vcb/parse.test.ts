// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { parseVcb } from './parse';

const ok = (s: string, unit: 'in' | 'mm' | 'm' = 'in') => {
  const r = parseVcb(s, unit);
  if (!r.ok) throw new Error(r.error.error);
  return r.value;
};

describe('parseVcb', () => {
  it('parses lengths with default and explicit units', () => {
    expect(ok('10')).toEqual({ kind: 'length', meters: 0.254, raw: 10, unit: null });
    expect(ok('2.5m')).toMatchObject({ kind: 'length', meters: 2.5, unit: 'm' });
    const m = (s: string, unit: 'in' | 'mm' | 'm' = 'in') => {
      const v = ok(s, unit);
      return v.kind === 'length' ? v : null;
    };
    expect(m(`3'6"`)?.unit).toBe('in');
    expect(m(`3'6"`)?.meters).toBeCloseTo(1.0668, 6);
    expect(m('1 1/2"')?.meters).toBeCloseTo(0.0381, 6);
    expect(m('-4cm')?.meters).toBeCloseTo(-0.04, 9);
    expect(m('-4cm')?.unit).toBe('cm');
    expect(m('50mm')).toMatchObject({ raw: 50, unit: 'mm' });
    expect(m('50mm')?.meters).toBeCloseTo(0.05, 9);
    expect(m('10', 'mm')?.meters).toBeCloseTo(0.01, 9);
    expect(m('10', 'mm')?.raw).toBeCloseTo(10, 9);
  });

  it('reads bare lengths in the default unit everywhere a length is taken', () => {
    const v = (s: string, unit: 'mm' | 'm') => {
      const r = parseVcb(s, unit);
      if (!r.ok) throw new Error(r.error.error);
      return r.value;
    };
    expect(v('24r', 'mm')).toEqual({ kind: 'radius', meters: 0.024 });
    expect(v('c24', 'mm')).toEqual({ kind: 'circumscribed', meters: 0.024 });
    expect(v('[1,,2]', 'mm')).toEqual({ kind: 'absolute', coords: [0.001, null, 0.002] });
    expect(v('<1,2,3m>', 'mm')).toEqual({ kind: 'relative', coords: [0.001, 0.002, 3] });
    expect(v('5,2in', 'm')).toMatchObject({ kind: 'list', values: [{ meters: 5, unit: null }, { unit: 'in' }] });
    // Non-length inputs keep the typed number: Scale factors, Protractor degrees and Zoom's field of view read `raw`.
    expect(v('2', 'mm')).toMatchObject({ kind: 'length', raw: 2, unit: null });
  });

  it('parses angles and slopes', () => {
    expect(ok('35deg')).toEqual({ kind: 'angle', degrees: 35 });
    expect(ok('35°')).toEqual({ kind: 'angle', degrees: 35 });
    const slope = ok('1:4');
    expect(slope.kind).toBe('slope');
    if (slope.kind === 'slope') expect(slope.degrees).toBeCloseTo(14.036);
  });

  it('parses arrays', () => {
    expect(ok('3x')).toEqual({ kind: 'array', mode: 'external', count: 3 });
    expect(ok('x3')).toEqual({ kind: 'array', mode: 'external', count: 3 });
    expect(ok('*3')).toEqual({ kind: 'array', mode: 'external', count: 3 });
    expect(ok('3*')).toEqual({ kind: 'array', mode: 'external', count: 3 });
    expect(ok('/3')).toEqual({ kind: 'array', mode: 'internal', count: 3 });
    expect(ok('3/')).toEqual({ kind: 'array', mode: 'internal', count: 3 });
  });

  it('parses coordinates with blanks', () => {
    expect(ok('[1,2,3]', 'm')).toEqual({ kind: 'absolute', coords: [1, 2, 3] });
    expect(ok('<1,,3>', 'm')).toEqual({ kind: 'relative', coords: [1, null, 3] });
    expect(ok('[ , ,10"]', 'm')).toEqual({ kind: 'absolute', coords: [null, null, 0.254] });
    expect(parseVcb('[1,2]').ok).toBe(false);
  });

  it('parses lists', () => {
    const v = ok('3,4', 'm');
    expect(v.kind).toBe('list');
    if (v.kind === 'list') {
      expect(v.values).toHaveLength(2);
      expect(v.values[0]).toMatchObject({ kind: 'length', meters: 3 });
    }
    const w = ok(',4', 'm');
    if (w.kind === 'list') expect(w.values[0]).toBeNull();
    const s = ok('2,,0.5', 'm');
    if (s.kind === 'list') expect(s.values.map((x) => (x ? x.kind === 'length' && x.raw : null))).toEqual([2, null, 0.5]);
  });

  it('parses segments, radius and circumscribed', () => {
    expect(ok('24s')).toEqual({ kind: 'segments', count: 24 });
    expect(ok('24r', 'm')).toEqual({ kind: 'radius', meters: 24 });
    expect(ok('r24', 'm')).toEqual({ kind: 'radius', meters: 24 });
    expect(ok('24c', 'm')).toEqual({ kind: 'circumscribed', meters: 24 });
    // "cm" is a unit, not a circumscribed suffix
    expect(ok('24cm')).toMatchObject({ kind: 'length', unit: 'cm' });
  });

  it('reports errors and empty input', () => {
    expect(ok('')).toEqual({ kind: 'empty' });
    expect(parseVcb('abc').ok).toBe(false);
    expect(parseVcb('0x').ok).toBe(false);
  });
});

describe('parseVcb: catalog C.1 grammar', () => {
  const len = (s: string, unit: 'in' | 'mm' | 'm' = 'in') => {
    const v = ok(s, unit);
    if (v.kind !== 'length') throw new Error(`expected length, got ${v.kind}`);
    return v;
  };

  it('feet/inches: 3\' 6", 3\'6", 3\'6, 3\'-6", 1 1/2", 3\'6 1/2"', () => {
    for (const s of [`3' 6"`, `3'6"`, `3'6`, `3'-6"`, `3' - 6"`]) expect(len(s).meters).toBeCloseTo(1.0668, 6);
    expect(len(`1 1/2"`).raw).toBeCloseTo(1.5, 9);
    expect(len(`10 1/2"`).raw).toBeCloseTo(10.5, 9);
    expect(len(`3'6 1/2"`).raw).toBeCloseTo(42.5, 9);
    expect(len(`1/2`).raw).toBeCloseTo(0.5, 9);
  });

  it('explicit units override the default: 10", 10\', 10mm, 10cm, 10m, 5ft, 5in, 2yd', () => {
    expect(len('10"', 'mm')).toMatchObject({ unit: 'in', raw: 10 });
    expect(len("10'", 'mm')).toMatchObject({ unit: 'ft', raw: 10 });
    expect(len('10mm', 'in').meters).toBeCloseTo(0.01, 9);
    expect(len('10cm', 'in').meters).toBeCloseTo(0.1, 9);
    expect(len('10m', 'in').meters).toBeCloseTo(10, 9);
    expect(len('5ft', 'mm').meters).toBeCloseTo(1.524, 9);
    expect(len('5 in', 'mm').meters).toBeCloseTo(0.127, 9);
    expect(len('2yd', 'mm').meters).toBeCloseTo(1.8288, 9);
    expect(len('50mm')).toMatchObject({ raw: 50, unit: 'mm' });
  });

  it('negative values reverse direction everywhere a length/angle is accepted', () => {
    expect(len('-10').raw).toBe(-10);
    expect(len("-3'").meters).toBeCloseTo(-0.9144, 9);
    expect(len('-2.5m').meters).toBe(-2.5);
    expect(len(`-1 1/2"`).raw).toBeCloseTo(-1.5, 9);
    expect(len('-.5').raw).toBe(-0.5);
    expect(ok('-35deg')).toEqual({ kind: 'angle', degrees: -35 });
    expect(ok('[-1,,-3]', 'm')).toEqual({ kind: 'absolute', coords: [-1, null, -3] });
    expect(ok('<-1,-2,-3>', 'm')).toEqual({ kind: 'relative', coords: [-1, -2, -3] });
    const list = ok('3,-4', 'm');
    expect(list.kind === 'list' && list.values[1]).toMatchObject({ kind: 'length', meters: -4 });
    expect(ok('-24r', 'm')).toEqual({ kind: 'radius', meters: -24 });
    const slope = ok('-8:12');
    expect(slope.kind === 'slope' && slope.degrees).toBeCloseTo(-33.69, 2);
  });

  it('arrays: *3, 3*, 3x, x3, /3, 3/ (count ≥ 1)', () => {
    expect(ok('*3')).toEqual({ kind: 'array', mode: 'external', count: 3 });
    expect(ok('X3')).toEqual({ kind: 'array', mode: 'external', count: 3 });
    expect(ok('12x')).toEqual({ kind: 'array', mode: 'external', count: 12 });
    expect(ok('/ 3')).toEqual({ kind: 'array', mode: 'internal', count: 3 });
    expect(parseVcb('0/').ok).toBe(false);
  });

  it('coordinates with blanks and units: [x,,z], <x,y,z>, [3\' 6", 2\', 1"]', () => {
    expect(ok('[1,,3]', 'm')).toEqual({ kind: 'absolute', coords: [1, null, 3] });
    expect(ok('<3\'6,,2\'>', 'm')).toEqual({ kind: 'relative', coords: [1.0668000000000002, null, 0.6096] });
    const abs = ok(`[3' 6", 2', 1"]`, 'm');
    expect(abs.kind === 'absolute' && abs.coords.map((c) => (c === null ? null : Math.round(c * 1e4) / 1e4))).toEqual([1.0668, 0.6096, 0.0254]);
    expect(parseVcb('[1,2,3,4]').ok).toBe(false);
    expect(parseVcb('<a,b,c>').ok).toBe(false);
  });

  it('suffixes: 24s, 24r, r24, 20c, c20; segments must be integers', () => {
    expect(ok('24s')).toEqual({ kind: 'segments', count: 24 });
    expect(ok('24S')).toEqual({ kind: 'segments', count: 24 });
    expect(parseVcb('1.5s').ok).toBe(false);
    expect(ok('24r', 'm')).toEqual({ kind: 'radius', meters: 24 });
    expect(ok('r24', 'm')).toEqual({ kind: 'radius', meters: 24 });
    expect(ok('r 0.5', 'm')).toEqual({ kind: 'radius', meters: 0.5 });
    expect(ok('20c', 'm')).toEqual({ kind: 'circumscribed', meters: 20 });
    expect(ok('c20', 'm')).toEqual({ kind: 'circumscribed', meters: 20 });
    expect(ok(`2'r`, 'm')).toEqual({ kind: 'radius', meters: 0.6096 });
  });

  it('angles: 35deg, 35°, 35d and rise:run slopes 8:12', () => {
    expect(ok('35deg')).toEqual({ kind: 'angle', degrees: 35 });
    expect(ok('35 °')).toEqual({ kind: 'angle', degrees: 35 });
    expect(ok('22.5d')).toEqual({ kind: 'angle', degrees: 22.5 });
    const s = ok('8:12');
    expect(s).toMatchObject({ kind: 'slope', rise: 8, run: 12 });
    expect(s.kind === 'slope' && s.degrees).toBeCloseTo(33.69, 2);
    expect(ok('1:1').kind === 'slope' && (ok('1:1') as { degrees: number }).degrees).toBeCloseTo(45);
  });

  it('lists: length,width with either side omitted; x,y,z for Scale', () => {
    const a = ok('3,', 'm');
    expect(a.kind === 'list' && a.values.map((v) => v && v.kind === 'length' && v.meters)).toEqual([3, null]);
    const b = ok(',4', 'm');
    expect(b.kind === 'list' && b.values.map((v) => v && v.kind === 'length' && v.meters)).toEqual([null, 4]);
    const c = ok('2,1.5,0.5', 'm');
    expect(c.kind === 'list' && c.values).toHaveLength(3);
    const d = ok(`3' 6",2'`, 'm');
    expect(d.kind === 'list' && d.values.map((v) => v && v.kind === 'length' && Math.round(v.meters * 1e4) / 1e4)).toEqual([1.0668, 0.6096]);
  });
});
