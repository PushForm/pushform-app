// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Manifold, SimplePolygon } from 'manifold-3d';
import { LENGTH_TOL } from '@pushform/core';
import { resolveHardwareOptions } from '../../hardware';
import type { HardwareRequest, HardwareResult } from '../../protocol';
import { KernelError } from '../../protocol';
import type { KernelContext } from '../context';
import { manifoldFromSoup } from '../meshio';
import { withScope } from '../context';
import { finalizeManifold } from './finalize';
import { allNewIds } from './normalize';
import { rectangularCupHood } from './cupHood';

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
          solid = add(solid, cylinder(Math.min(g * 0.8, w / 2), g * 0.2, [x, 0, 0]));
          solid = add(solid, cylinder(Math.min(g * 0.6, w / 2), g * 0.25, [x, 0, h - g * 1.25]));
        }
    } else if (shape === 'wire' || shape === 'arch') {
      mount.push([-c / 2, 0, 0], [c / 2, 0, 0]);
      const pts: [number, number, number][] = [];
      if (shape === 'arch') {
        for (let i = 0; i <= 16; i++) {
          const u = i / 16;
          pts.push([-(l - g) / 2 + (l - g) * u, 0, g / 2 + (h - g) * Math.sin(Math.PI * u)]);
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
      // A single lofted tube avoids overlapping rod/sphere seams along the grip.
      const verts: number[] = [],
        tris: number[] = [];
      for (let k = 0; k < pts.length; k++) {
        const a = pts[Math.max(0, k - 1)]!,
          b = pts[Math.min(pts.length - 1, k + 1)]!;
        const dx = b[0] - a[0],
          dz = b[2] - a[2],
          len = Math.hypot(dx, dz);
        for (let j = 0; j < n; j++) {
          const angle = (j * 2 * Math.PI) / n,
            across = (Math.sin(angle) * g) / 2;
          verts.push(
            pts[k]![0] - (dz / len) * across,
            ((Math.cos(angle) * w) / 2) *
              (shape === 'arch' ? 0.6 + 0.4 * Math.abs((2 * k) / (pts.length - 1) - 1) : 1),
            pts[k]![2] + (dx / len) * across,
          );
        }
      }
      for (let k = 0; k + 1 < pts.length; k++)
        for (let j = 0; j < n; j++) {
          const a = k * n + j,
            b = k * n + ((j + 1) % n);
          tris.push(a, b, b + n, a, b + n, a + n);
        }
      for (let j = 1; j + 1 < n; j++) {
        tris.push(0, j + 1, j);
        const top = (pts.length - 1) * n;
        tris.push(top, top + j, top + j + 1);
      }
      solid = keep(
        manifoldFromSoup(
          ctx.wasm,
          {
            verts: new Float64Array(verts),
            tris: new Uint32Array(tris),
            faceId: new Uint32Array(tris.length / 3),
          },
          0,
        ),
      );
      if (shape === 'arch') {
        const bounds = solid.boundingBox();
        solid = keep(solid.scale([l / (bounds.max[0] - bounds.min[0]), 1, 1]));
        for (const x of [-c / 2, c / 2]) {
          const u = (x + (l - g) / 2) / (l - g);
          const z = g / 2 + (h - g) * Math.sin(Math.PI * u);
          solid = add(solid, cylinder(Math.min(g, w) / 2, z + g / 3, [x, 0, 0]));
        }
      } else for (const x of [-c / 2, c / 2]) solid = add(solid, cylinder(g / 2, g, [x, 0, 0]));
    } else if (shape === 'knob-domed') {
      mount.push([0, 0, 0]);
      // Radius/height coordinates; one lathe avoids overlapping head/stem seams.
      // Keep profile sampling independent of radial sampling: cost is about 2*n*m.
      const profile: SimplePolygon = [
        [0, 0],
        [g / 2, 0],
      ];
      let start: [number, number] = [g / 2, 0];
      const curve = (
        a: [number, number],
        b: [number, number],
        end: [number, number],
        count: number,
      ) => {
        for (let i = 1; i <= count; i++) {
          const t = i / count,
            u = 1 - t;
          profile.push(
            [0, 1].map(
              (k) =>
                u ** 3 * start[k]! +
                3 * u ** 2 * t * a[k]! +
                3 * u * t ** 2 * b[k]! +
                t ** 3 * end[k]!,
            ) as [number, number],
          );
        }
        start = end;
      };
      const neck = Math.round(p.profileSegments * 0.2),
        underside = Math.round(p.profileSegments * 0.3);
      curve([g / 2, h * 0.095], [g * 0.4, h * 0.205], [g * 0.46, h * 0.283], neck);
      curve(
        [Math.min(g * 0.56, w / 2), h * 0.417],
        [w / 2, h * 0.425],
        [w / 2, h * 0.677],
        underside,
      );
      curve([w / 2, h * 0.898], [w * 0.276, h], [0, h], p.profileSegments - neck - underside);
      solid = lathe(profile);
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
      // Reserve a narrow border inside the stated overall dimensions, rather than
      // letting the shell hide the mounting rim or enlarging the finished part.
      const lip = Math.min(1.5 * t, l * 0.05, w * 0.08, (l / 2 - t) * 0.5, (w - t) * 0.5);
      const inset = lip * 0.35;
      if (shape === 'cup') {
        const outer = sphere(l / 2 - inset, w - inset, h, [0, 0, 0]);
        const inner = sphere(l / 2 - inset - t, w - inset - t, h - t, [0, 0, 0]);
        solid = cut(sub(outer, inner), box(l * 2, w, h, [0, w / 2, h / 2]));
        const steps = Math.max(8, Math.round(n / 2));
        const rim: SimplePolygon = [];
        for (let i = 0; i <= steps; i++) {
          const a = (i * Math.PI) / steps;
          rim.push([(l / 2) * Math.cos(a), w * Math.sin(a)]);
        }
        for (let i = steps; i >= 0; i--) {
          const a = (i * Math.PI) / steps;
          rim.push([(l / 2 - lip) * Math.cos(a), (w - lip) * Math.sin(a)]);
        }
        solid = add(solid, keep(keep(new CrossSection([rim])).extrude(t)));
        solid = moved(solid, 0, -w / 2, 0);
      } else {
        const rounded = (x: number, y: number, radius: number): SimplePolygon => {
          const pts: SimplePolygon = [];
          for (let k = 0; k < 4; k++) {
            const cx = (k === 0 || k === 3 ? 1 : -1) * (x / 2 - radius),
              cy = (k < 2 ? 1 : -1) * (y / 2 - radius);
            for (let i = 0; i <= 6; i++) {
              const angle = ((k + i / 6) * Math.PI) / 2;
              pts.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]);
            }
          }
          return pts;
        };
        const radius = Math.min(w / 5, t * 2, (l - 2 * inset) / 4, (w - inset) / 4);
        const hood = rectangularCupHood(p, inset, lip);
        const outer = keep(manifoldFromSoup(ctx.wasm, hood.mesh, 0));
        const cavity = keep(
          keep(keep(new CrossSection([hood.cavity])).extrude(hood.interiorLength)).rotate([
            90, 0, 0,
          ]),
        );
        const pocket = moved(keep(cavity.rotate([0, 0, 90])), -hood.interiorLength / 2, 0, 0);
        solid = sub(outer, pocket);
        const rim = keep(keep(new CrossSection([rounded(l, w, radius)])).extrude(t));
        const opening = box(l - 2 * lip, 2 * w, 3 * t, [0, -w / 2 - lip, t / 2]);
        solid = add(solid, sub(rim, opening));
      }
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
        solid = add(solid, rod([-l / 2, t, h - t], [l / 2, t, h - t], t));
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
      const torus = keep(profile.revolve(n));
      solid = moved(torus, 0, -w / 2 + g / 2, h - g / 2);
      solid = add(solid, cylinder(g * 0.65, h - g / 3, [0, 0, 0]));
      mount.push([0, 0, 0]);
    } else if (shape === 'half-moon') {
      const disc = keep(cylinder(l / 2, t, [0, 0, h - t]).scale([1, (2 * w) / l, 1]));
      solid = cut(disc, box(l * 2, l, h * 2, [0, l / 2, h]));
      solid = add(solid, box(l * 0.8, t, h, [0, t / 2, h / 2]));
      mount.push([-Math.min(c, l * 0.7) / 2, 0, 0], [Math.min(c, l * 0.7) / 2, 0, 0]);
    } else {
      solid = sub(cylinder(w / 2, t), cylinder(g / 2, t * 2, [0, 0, -t / 2]));
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
