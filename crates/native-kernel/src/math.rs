// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! The vector, box and polygon math the push/pull pipeline uses, written operation for operation like the TypeScript
//! it was ported from (`@pushform/core` and `@pushform/geom`), so results stay bit-identical to it.

pub type Vec3 = [f64; 3];

pub fn sub(a: Vec3, b: Vec3) -> Vec3 {
  [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
pub fn dot(a: Vec3, b: Vec3) -> f64 {
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
pub fn cross(a: Vec3, b: Vec3) -> Vec3 {
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
pub fn neg(a: Vec3) -> Vec3 {
  [-a[0], -a[1], -a[2]]
}
pub fn len(a: Vec3) -> f64 {
  hypot3(a[0], a[1], a[2])
}
pub fn dist(a: Vec3, b: Vec3) -> f64 {
  hypot3(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}
/// `v3angle` from `@pushform/core`.
pub fn angle(a: Vec3, b: Vec3) -> f64 {
  len(cross(a, b)).atan2(dot(a, b))
}
/// `v3parallel` from `@pushform/core`.
pub fn parallel(a: Vec3, b: Vec3, tol: f64) -> bool {
  let ang = angle(a, b);
  ang <= tol || std::f64::consts::PI - ang <= tol
}

fn hypot(values: &[f64]) -> f64 {
  let mut max = 0.0_f64;
  let mut any_nan = false;
  for &value in values {
    if value.is_nan() {
      any_nan = true;
    } else if value.abs() > max {
      max = value.abs();
    }
  }
  if max == f64::INFINITY {
    return f64::INFINITY;
  }
  if any_nan {
    return f64::NAN;
  }
  if max == 0.0 {
    return 0.0;
  }
  let (mut sum, mut compensation) = (0.0_f64, 0.0_f64);
  for &value in values {
    let scaled = value.abs() / max;
    let summand = scaled * scaled - compensation;
    let preliminary = sum + summand;
    compensation = (preliminary - sum) - summand;
    sum = preliminary;
  }
  sum.sqrt() * max
}

/// `Math.hypot(a, b)`: the Kahan summation both JavaScript engines the app runs on use (V8 and JavaScriptCore). A
/// plain square root of the sum of squares differs from it in the last digit, which would reorder equal-area
/// triangles and change which faces get which fresh ids.
pub fn hypot2(a: f64, b: f64) -> f64 {
  hypot(&[a, b])
}
/// `Math.hypot(a, b, c)`, see [`hypot2`].
pub fn hypot3(a: f64, b: f64, c: f64) -> f64 {
  hypot(&[a, b, c])
}

/// `box3FromPositions`: min and max over flat xyz positions.
pub fn bounds(positions: &[f64]) -> ([f64; 3], [f64; 3]) {
  let mut min = [f64::INFINITY; 3];
  let mut max = [f64::NEG_INFINITY; 3];
  for point in positions.chunks_exact(3) {
    for axis in 0..3 {
      if point[axis] < min[axis] {
        min[axis] = point[axis];
      }
      if point[axis] > max[axis] {
        max[axis] = point[axis];
      }
    }
  }
  (min, max)
}

pub type Pt = [f64; 2];

fn point_in_ring(p: Pt, ring: &[Pt]) -> bool {
  let (x, y) = (p[0], p[1]);
  let mut inside = false;
  let n = ring.len();
  let mut j = n.wrapping_sub(1);
  for i in 0..n {
    let (xi, yi) = (ring[i][0], ring[i][1]);
    let (xj, yj) = (ring[j][0], ring[j][1]);
    if (yi > y) != (yj > y) {
      let x_cross = ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if x < x_cross {
        inside = !inside;
      }
    }
    j = i;
  }
  inside
}

/// `pointInPolygon` from `@pushform/geom`: inside the outer ring and outside every hole.
pub fn point_in_polygon(p: Pt, poly: &[Vec<Pt>]) -> bool {
  let Some(outer) = poly.first() else { return false };
  if !point_in_ring(p, outer) {
    return false;
  }
  poly[1..].iter().all(|hole| !point_in_ring(p, hole))
}

/// `pointOnRing` from `@pushform/geom`.
pub fn point_on_ring(p: Pt, ring: &[Pt], tol: f64) -> bool {
  let n = ring.len();
  let t2 = tol * tol;
  let mut j = n.wrapping_sub(1);
  for i in 0..n {
    let (ax, ay) = (ring[j][0], ring[j][1]);
    let (bx, by) = (ring[i][0], ring[i][1]);
    let (dx, dy) = (bx - ax, by - ay);
    let l2 = dx * dx + dy * dy;
    let mut t = if l2 > 0.0 { ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2 } else { 0.0 };
    t = if t < 0.0 { 0.0 } else if t > 1.0 { 1.0 } else { t };
    let (qx, qy) = (ax + dx * t - p[0], ay + dy * t - p[1]);
    if qx * qx + qy * qy <= t2 {
      return true;
    }
    j = i;
  }
  false
}
