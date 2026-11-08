// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Manifold, SimplePolygon } from 'manifold-3d';
import { LENGTH_TOL } from '@pushform/core';
import { resolveHardwareOptions } from '../../hardware';
import type { HardwareRequest, HardwareResult } from '../../protocol';
import { KernelError } from '../../protocol';
import type { KernelContext } from '../context';
import { withScope } from '../context';
import { finalizeManifold } from './finalize';
import { allNewIds } from './normalize';

/** Hardware solids are constructed, normalized and decomposed entirely inside the kernel. */
export function hardware(ctx: KernelContext, req: HardwareRequest): HardwareResult {
  const p = resolveHardwareOptions(req.options);
  const {
    shape,
    length: l,
    width: w,
    projection: h,
    spacing: c,
    grip: g,
    wall: t,
    segments: n,
  } = p;
  return withScope((scope) => {
    const { Manifold: M, CrossSection } = ctx.wasm;
    const keep = <T extends { delete(): void }>(v: T): T => scope.track(v);
    const moved = (s: Manifold, x: number, y: number, z: number) => keep(s.translate([x, y, z]));
    const box = (x: number, y: number, z: number, at: [number, number, number] = [0, 0, 0]) =>
      moved(keep(M.cube([x, y, z], true)), ...at);
    const cylinder = (
      radius: number,
      height: number,
      at: [number, number, number] = [0, 0, 0],
      sides = n,
    ) => moved(keep(M.cylinder(height, radius, radius, sides, false)), ...at);
    const sphere = (x: number, y: number, z: number, at: [number, number, number]) =>
      moved(keep(keep(M.sphere(1, n)).scale([x, y, z])), ...at);
    const add = (a: Manifold, b: Manifold) => keep(a.add(b));
    const sub = (a: Manifold, b: Manifold) => keep(a.subtract(b));
    const cut = (a: Manifold, b: Manifold) => keep(a.intersect(b));
    const lathe = (points: SimplePolygon) => keep(keep(new CrossSection([points])).revolve(n));
    const rod = (
      a: [number, number, number],
      b: [number, number, number],
      radius: number,
    ): Manifold => {
      const d = b.map((v, i) => v - a[i]!) as [number, number, number];
      const len = Math.hypot(...d),
        yaw = (Math.atan2(d[1], d[0]) * 180) / Math.PI,
        pitch = (Math.atan2(Math.hypot(d[0], d[1]), d[2]) * 180) / Math.PI;
      return moved(keep(keep(M.cylinder(len, radius, radius, n)).rotate([0, pitch, yaw])), ...a);
    };
    const mount: [number, number, number][] = [];
    let solid: Manifold;
    const twoPosts = (grip: Manifold, square = false): Manifold => {
      mount.push([-c / 2, 0, 0], [c / 2, 0, 0]);
      let made = grip;
      for (const x of [-c / 2, c / 2])
        made = add(
          made,
          square
            ? box(g, w, h - g / 3, [x, 0, (h - g / 3) / 2])
            : cylinder(g * 0.42, h - g / 3, [x, 0, 0]),
        );
      return made;
    };
    if (shape === 'bar-round' || shape === 'bar-square' || shape === 'bridge') {
      solid = twoPosts(
        shape === 'bar-square'
          ? box(l, w, g, [0, 0, h - g / 2])
          : rod([-l / 2, 0, h - g / 2], [l / 2, 0, h - g / 2], g / 2),
        shape === 'bar-square',
      );
      if (shape === 'bridge')
        for (const x of [-c / 2, c / 2]) {
          solid = add(solid, cylinder(g * 0.8, g * 0.2, [x, 0, 0]));
          solid = add(solid, cylinder(g * 0.6, g * 0.25, [x, 0, h - g * 1.25]));
        }
    } else if (shape === 'wire' || shape === 'arch') {
      mount.push([-c / 2, 0, 0], [c / 2, 0, 0]);
      const pts: [number, number, number][] = [];
      if (shape === 'arch') {
        for (let i = 0; i <= 16; i++) {
          const u = i / 16;
          pts.push([-c / 2 + c * u, 0, g / 2 + (h - g) * Math.sin(Math.PI * u)]);
        }
      } else {
        const r = Math.min(h / 2, c / 4);
        pts.push([-c / 2, 0, g / 2], [-c / 2, 0, h - g / 2 - r]);
        for (let i = 1; i <= 8; i++) {
          const a = Math.PI - (i * Math.PI) / 16;
          pts.push([-c / 2 + r + r * Math.cos(a), 0, h - g / 2 - r + r * Math.sin(a)]);
        }
        for (let i = 0; i <= 8; i++) {
          const a = Math.PI / 2 - (i * Math.PI) / 16;
          pts.push([c / 2 - r + r * Math.cos(a), 0, h - g / 2 - r + r * Math.sin(a)]);
        }
        pts.push([c / 2, 0, g / 2]);
      }
      solid = rod(pts[0]!, pts[1]!, g / 2);
      for (let i = 1; i + 1 < pts.length; i++) solid = add(solid, rod(pts[i]!, pts[i + 1]!, g / 2));
      for (let i = 1; i + 1 < pts.length; i++)
        solid = add(solid, sphere(g / 2, g / 2, g / 2, pts[i]!));
      for (const x of [-c / 2, c / 2]) solid = add(solid, cylinder(g / 2, g, [x, 0, 0]));
    } else if (shape.startsWith('knob-')) {
      mount.push([0, 0, 0]);
      const stemH = h * 0.65,
        headH = h - stemH;
      const stem = cylinder(Math.min(g / 2, w / 4), stemH + headH / 2);
      let head: Manifold;
      if (shape === 'knob-ball') head = sphere(w / 2, w / 2, w / 2, [0, 0, h - w / 2]);
      else if (shape === 'knob-oval') head = sphere(l / 2, w / 2, headH, [0, 0, h - headH]);
      else if (shape === 'knob-t' || shape === 'knob-t-square')
        head =
          shape === 'knob-t'
            ? rod([-l / 2, 0, h - g / 2], [l / 2, 0, h - g / 2], g / 2)
            : box(l, w, g, [0, 0, h - g / 2]);
      else if (shape === 'knob-square' || shape === 'knob-pyramid') {
        const outline: SimplePolygon = [
          [-l / 2, -w / 2],
          [l / 2, -w / 2],
          [l / 2, w / 2],
          [-l / 2, w / 2],
        ];
        head = moved(
          keep(
            keep(new CrossSection([outline])).extrude(
              headH,
              0,
              0,
              shape === 'knob-pyramid' ? [0.4, 0.4] : [1, 1],
            ),
          ),
          0,
          0,
          stemH,
        );
      } else if (shape === 'knob-hex' || shape === 'knob-octagon')
        head = cylinder(
          w / (2 * Math.cos(Math.PI / (shape === 'knob-hex' ? 6 : 8))),
          headH,
          [0, 0, stemH],
          shape === 'knob-hex' ? 6 : 8,
        );
      else if (shape === 'knob-cylinder') {
        solid = cylinder(w / 2, h);
        head = solid;
      } else if (shape === 'knob-disk') head = cylinder(w / 2, headH, [0, 0, stemH]);
      else
        head = lathe([
          [0, stemH],
          [w * 0.3, stemH],
          [w * 0.49, h - headH * 0.45],
          [w / 2, h - headH * 0.3],
          [w * 0.4, h - headH * 0.08],
          [0, h],
        ]);
      solid = add(stem, head);
    } else if (shape === 'cup' || shape === 'cup-square') {
      if (shape === 'cup') {
        const outer = sphere(l / 2, w, h, [0, 0, 0]);
        const inner = sphere(l / 2 - t, w - t, h - t, [0, 0, 0]);
        solid = cut(sub(outer, inner), box(l * 2, w, h, [0, w / 2, h / 2]));
        solid = moved(solid, 0, -w / 2, 0);
      } else solid = sub(box(l, w, h, [0, 0, h / 2]), box(l - 2 * t, w + t, h, [0, -t, h / 2 - t]));
      mount.push(
        [-Math.min(c, l - 2 * t) / 2, w * 0.2, 0],
        [Math.min(c, l - 2 * t) / 2, w * 0.2, 0],
      );
    } else if (shape === 'recessed' || shape === 'recessed-round') {
      const flange = shape === 'recessed-round' ? cylinder(w / 2, t) : box(l, w, t, [0, 0, t / 2]);
      const body =
        shape === 'recessed-round'
          ? cylinder(w / 2 - t, h, [0, 0, -h])
          : box(l - 2 * t, w - 2 * t, h, [0, 0, -h / 2]);
      const pocket =
        shape === 'recessed-round'
          ? cylinder(w / 2 - 2 * t, h + t, [0, 0, -h + t])
          : box(l - 4 * t, w - 4 * t, h + t, [0, 0, -h / 2 + 1.5 * t]);
      solid = sub(add(flange, body), pocket);
    } else if (shape === 'edge' || shape === 'edge-curved') {
      solid = add(box(l, w, t, [0, w / 2, t / 2]), box(l, t, h, [0, t / 2, h / 2]));
      if (shape === 'edge-curved')
        solid = add(solid, rod([-l / 2, 0, h - t / 2], [l / 2, 0, h - t / 2], t));
      mount.push([-Math.min(c, l * 0.8) / 2, w * 0.65, 0], [Math.min(c, l * 0.8) / 2, w * 0.65, 0]);
    } else if (shape === 'ring') {
      const profile = keep(
        new CrossSection([
          Array.from({ length: 12 }, (_, i): [number, number] => {
            const a = (i * Math.PI) / 6;
            return [w / 2 - g / 2 + (Math.cos(a) * g) / 2, (Math.sin(a) * g) / 2];
          }),
        ]),
      );
      const torus = keep(keep(profile.revolve(n)).rotate([90, 0, 0]));
      solid = moved(torus, 0, -w / 2, h - g / 2);
      solid = add(solid, cylinder(g * 0.65, Math.max(t, h - g), [0, 0, 0]));
      mount.push([0, 0, 0]);
    } else if (shape === 'half-moon') {
      const disc = cylinder(l / 2, t, [0, 0, h - t]);
      solid = cut(disc, box(l * 2, l, h * 2, [0, l / 2, h]));
      solid = add(solid, box(l * 0.8, t, h, [0, t / 2, h / 2]));
      mount.push([-Math.min(c, l * 0.7) / 2, 0, 0], [Math.min(c, l * 0.7) / 2, 0, 0]);
    } else {
      solid = sub(cylinder(w / 2, t), cylinder(Math.min(g / 4, w / 8), t * 2, [0, 0, -t / 2]));
      mount.push([0, 0, 0]);
    }
    if (solid.isEmpty() || solid.volume() <= LENGTH_TOL ** 3)
      throw new KernelError('InvalidInput', 'These dimensions produce no hardware solid.');
    const fin = finalizeManifold(ctx, solid, { nextFaceId: req.nextFaceId, chooseId: allNewIds });
    return {
      components: fin.components,
      nextFaceId: fin.nextFaceId,
      mountingCenters: mount,
      resolved: p,
    };
  });
}
