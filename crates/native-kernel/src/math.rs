// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! The vector, matrix, box and polygon math the kernel uses, written operation for operation like the TypeScript it
//! was ported from (`@pushform/core` and `@pushform/geom`), so results stay bit-identical to it.

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
pub fn add(a: Vec3, b: Vec3) -> Vec3 {
  [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
pub fn scale(a: Vec3, s: f64) -> Vec3 {
  [a[0] * s, a[1] * s, a[2] * s]
}
pub fn add_scaled(a: Vec3, b: Vec3, s: f64) -> Vec3 {
  [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s]
}
/// `v3normalize`: a zero (or NaN-length) vector normalizes to zero.
pub fn normalize(a: Vec3) -> Vec3 {
  let l = len(a);
  if l > 0.0 { [a[0] / l, a[1] / l, a[2] / l] } else { [0.0, 0.0, 0.0] }
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

/// `Math.min(a, b)`: NaN wins and -0 is smaller than +0, unlike Rust's `f64::min`.
pub fn js_min(a: f64, b: f64) -> f64 {
  if a.is_nan() || b.is_nan() {
    f64::NAN
  } else if a == 0.0 && b == 0.0 {
    if a.is_sign_negative() || b.is_sign_negative() { -0.0 } else { 0.0 }
  } else if a < b {
    a
  } else {
    b
  }
}
/// `Math.max(a, b)`: NaN wins and +0 is larger than -0, unlike Rust's `f64::max`.
pub fn js_max(a: f64, b: f64) -> f64 {
  if a.is_nan() || b.is_nan() {
    f64::NAN
  } else if a == 0.0 && b == 0.0 {
    if a.is_sign_positive() || b.is_sign_positive() { 0.0 } else { -0.0 }
  } else if a > b {
    a
  } else {
    b
  }
}
pub fn js_min3(a: f64, b: f64, c: f64) -> f64 {
  js_min(js_min(a, b), c)
}
pub fn js_max3(a: f64, b: f64, c: f64) -> f64 {
  js_max(js_max(a, b), c)
}

/// JavaScript's ToUint32: the numeric truncation of `x` modulo 2^32, what storing a number in a `Uint32Array` does.
pub fn to_uint32(x: f64) -> u32 {
  if !x.is_finite() {
    return 0;
  }
  x.trunc().rem_euclid(4294967296.0) as u32
}
/// JavaScript's ToInt32.
pub fn to_int32(x: f64) -> i32 {
  to_uint32(x) as i32
}
/// `Number.isInteger`.
pub fn is_integer(x: f64) -> bool {
  x.is_finite() && x.trunc() == x
}

/// `String(x)` for a number: the shortest digits that round-trip, in JavaScript's plain or exponent notation.
pub fn js_number_string(x: f64) -> String {
  if x.is_nan() {
    return "NaN".to_string();
  }
  if x.is_infinite() {
    return if x > 0.0 { "Infinity".to_string() } else { "-Infinity".to_string() };
  }
  if x == 0.0 {
    return "0".to_string();
  }
  let sign = if x < 0.0 { "-" } else { "" };
  // Rust's `{:e}` prints the shortest round-trip digits, like `1.5e0`, the same digits JavaScript uses.
  let exp_form = format!("{:e}", x.abs());
  let (mantissa, exponent) = exp_form.split_once('e').expect("`{:e}` writes an exponent");
  let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
  let k = digits.len() as i32;
  let n = exponent.parse::<i32>().expect("`{:e}` writes an integer exponent") + 1;
  let body = if k <= n && n <= 21 {
    format!("{digits}{}", "0".repeat((n - k) as usize))
  } else if 0 < n && n <= 21 {
    format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
  } else if -6 < n && n <= 0 {
    format!("0.{}{digits}", "0".repeat((-n) as usize))
  } else {
    let e = n - 1;
    let exponent = if e < 0 { format!("{e}") } else { format!("+{e}") };
    if k == 1 { format!("{digits}e{exponent}") } else { format!("{}.{}e{exponent}", &digits[..1], &digits[1..]) }
  };
  format!("{sign}{body}")
}

/// `Math.hypot(a, b)` as V8 computes it, with Kahan summation. A plain square root of the sum of squares differs from
/// it in the last digit, which would reorder equal-area triangles and change which faces get which fresh ids.
/// JavaScriptCore's `Math.hypot` also differs from this in the last digits, so the TypeScript kernel's results there
/// are not bit-identical to V8's or to this kernel's.
pub fn hypot2(a: f64, b: f64) -> f64 {
  hypot(&[a, b])
}
/// `Math.hypot(a, b, c)`, see [`hypot2`].
pub fn hypot3(a: f64, b: f64, c: f64) -> f64 {
  hypot(&[a, b, c])
}

/// `box3Union` of two (min, max) boxes.
pub fn union_bounds(a: ([f64; 3], [f64; 3]), b: ([f64; 3], [f64; 3])) -> ([f64; 3], [f64; 3]) {
  (
    [js_min(a.0[0], b.0[0]), js_min(a.0[1], b.0[1]), js_min(a.0[2], b.0[2])],
    [js_max(a.1[0], b.1[0]), js_max(a.1[1], b.1[1]), js_max(a.1[2], b.1[2])],
  )
}
/// `box3Center`.
pub fn bounds_center(b: ([f64; 3], [f64; 3])) -> [f64; 3] {
  [(b.0[0] + b.1[0]) / 2.0, (b.0[1] + b.1[1]) / 2.0, (b.0[2] + b.1[2]) / 2.0]
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

/// A plane's origin and in-plane axes, as in `PlaneBasis` from `@pushform/core`.
#[derive(Clone, Copy)]
pub struct Basis {
  pub origin: Vec3,
  pub u: Vec3,
  pub v: Vec3,
  pub n: Vec3,
}

/// `planeBasis`: u = Z x n unless n is (anti)parallel to Z, then u = X; v = n x u.
pub fn plane_basis(origin: Vec3, n: Vec3) -> Basis {
  let un = normalize(n);
  let u = if parallel(un, [0.0, 0.0, 1.0], 1e-9) { [1.0, 0.0, 0.0] } else { normalize(cross([0.0, 0.0, 1.0], un)) };
  let v = normalize(cross(un, u));
  Basis { origin, u, v, n: un }
}

/// `basisToWorld(b, x, y)`.
pub fn basis_to_world(b: &Basis, x: f64, y: f64) -> Vec3 {
  [b.origin[0] + b.u[0] * x + b.v[0] * y + b.n[0] * 0.0, b.origin[1] + b.u[1] * x + b.v[1] * y + b.n[1] * 0.0, b.origin[2] + b.u[2] * x + b.v[2] * y + b.n[2] * 0.0]
}

/// Column-major 4x4 matrix.
pub type Mat4 = [f64; 16];

/// `m4fromBasis`.
pub fn m4_from_basis(o: Vec3, u: Vec3, v: Vec3, n: Vec3) -> Mat4 {
  [u[0], u[1], u[2], 0.0, v[0], v[1], v[2], 0.0, n[0], n[1], n[2], 0.0, o[0], o[1], o[2], 1.0]
}

/// The column-major 4x3 part of a column-major 4x4 matrix: what Manifold reads from one, dropping the bottom row.
pub fn m4_affine(m: &Mat4) -> [f64; 12] {
  [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10], m[12], m[13], m[14]]
}

/// `m4invert`.
#[allow(clippy::many_single_char_names)]
pub fn m4_invert(m: &Mat4) -> Option<Mat4> {
  let [n11, n21, n31, n41, n12, n22, n32, n42, n13, n23, n33, n43, n14, n24, n34, n44] = *m;
  let t11 = n23 * n34 * n42 - n24 * n33 * n42 + n24 * n32 * n43 - n22 * n34 * n43 - n23 * n32 * n44 + n22 * n33 * n44;
  let t12 = n14 * n33 * n42 - n13 * n34 * n42 - n14 * n32 * n43 + n12 * n34 * n43 + n13 * n32 * n44 - n12 * n33 * n44;
  let t13 = n13 * n24 * n42 - n14 * n23 * n42 + n14 * n22 * n43 - n12 * n24 * n43 - n13 * n22 * n44 + n12 * n23 * n44;
  let t14 = n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 + n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34;
  let det = n11 * t11 + n21 * t12 + n31 * t13 + n41 * t14;
  if det == 0.0 {
    return None;
  }
  let d = 1.0 / det;
  Some([
    t11 * d,
    (n24 * n33 * n41 - n23 * n34 * n41 - n24 * n31 * n43 + n21 * n34 * n43 + n23 * n31 * n44 - n21 * n33 * n44) * d,
    (n22 * n34 * n41 - n24 * n32 * n41 + n24 * n31 * n42 - n21 * n34 * n42 - n22 * n31 * n44 + n21 * n32 * n44) * d,
    (n23 * n32 * n41 - n22 * n33 * n41 - n23 * n31 * n42 + n21 * n33 * n42 + n22 * n31 * n43 - n21 * n32 * n43) * d,
    t12 * d,
    (n13 * n34 * n41 - n14 * n33 * n41 + n14 * n31 * n43 - n11 * n34 * n43 - n13 * n31 * n44 + n11 * n33 * n44) * d,
    (n14 * n32 * n41 - n12 * n34 * n41 - n14 * n31 * n42 + n11 * n34 * n42 + n12 * n31 * n44 - n11 * n32 * n44) * d,
    (n12 * n33 * n41 - n13 * n32 * n41 + n13 * n31 * n42 - n11 * n33 * n42 - n12 * n31 * n43 + n11 * n32 * n43) * d,
    t13 * d,
    (n14 * n23 * n41 - n13 * n24 * n41 - n14 * n21 * n43 + n11 * n24 * n43 + n13 * n21 * n44 - n11 * n23 * n44) * d,
    (n12 * n24 * n41 - n14 * n22 * n41 + n14 * n21 * n42 - n11 * n24 * n42 - n12 * n21 * n44 + n11 * n22 * n44) * d,
    (n13 * n22 * n41 - n12 * n23 * n41 - n13 * n21 * n42 + n11 * n23 * n42 + n12 * n21 * n43 - n11 * n22 * n43) * d,
    t14 * d,
    (n13 * n24 * n31 - n14 * n23 * n31 + n14 * n21 * n33 - n11 * n24 * n33 - n13 * n21 * n34 + n11 * n23 * n34) * d,
    (n14 * n22 * n31 - n12 * n24 * n31 - n14 * n21 * n32 + n11 * n24 * n32 + n12 * n21 * n34 - n11 * n22 * n34) * d,
    (n12 * n23 * n31 - n13 * n22 * n31 + n13 * n21 * n32 - n11 * n23 * n32 - n12 * n21 * n33 + n11 * n22 * n33) * d,
  ])
}

/// `meshSignedVolume`.
pub fn mesh_signed_volume(verts: &[f64], tris: &[u32]) -> f64 {
  let mut v = 0.0;
  for t in tris.chunks_exact(3) {
    let (a, b, c) = (t[0] as usize * 3, t[1] as usize * 3, t[2] as usize * 3);
    let (ax, ay, az) = (verts[a], verts[a + 1], verts[a + 2]);
    let (bx, by, bz) = (verts[b], verts[b + 1], verts[b + 2]);
    let (cx, cy, cz) = (verts[c], verts[c + 1], verts[c + 2]);
    v += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  v / 6.0
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn min_and_max_follow_javascript_for_zero_signs_and_nan() {
    assert!(js_min(-0.0, 0.0).is_sign_negative());
    assert!(js_min(0.0, -0.0).is_sign_negative());
    assert!(js_max(-0.0, 0.0).is_sign_positive());
    assert!(js_max(0.0, -0.0).is_sign_positive());
    assert!(js_min(f64::NAN, 1.0).is_nan());
    assert!(js_max(1.0, f64::NAN).is_nan());
    assert_eq!(js_max3(1.0, 3.0, 2.0), 3.0);
    assert_eq!(js_min3(1.0, -3.0, 2.0), -3.0);
  }

  #[test]
  fn integer_conversions_follow_javascript() {
    assert_eq!(to_uint32(4294967296.5), 0);
    assert_eq!(to_uint32(-1.0), 4294967295);
    assert_eq!(to_uint32(f64::NAN), 0);
    assert_eq!(to_uint32(f64::INFINITY), 0);
    assert_eq!(to_int32(2147483648.0), -2147483648);
    assert_eq!(to_int32(4294967295.0), -1);
    assert!(is_integer(3.0) && !is_integer(2.5) && !is_integer(f64::INFINITY));
  }

  #[test]
  fn numbers_print_like_javascript() {
    assert_eq!(js_number_string(7.0), "7");
    assert_eq!(js_number_string(1.5), "1.5");
    assert_eq!(js_number_string(-0.0), "0");
    assert_eq!(js_number_string(1e21), "1e+21");
    assert_eq!(js_number_string(123456789012345680000.0), "123456789012345680000");
    assert_eq!(js_number_string(0.000001), "0.000001");
    assert_eq!(js_number_string(1e-7), "1e-7");
    assert_eq!(js_number_string(1.5e-7), "1.5e-7");
    assert_eq!(js_number_string(4294967296.0), "4294967296");
    assert_eq!(js_number_string(f64::NAN), "NaN");
  }

  #[test]
  fn plane_basis_and_inverse_match_the_typescript_formulas() {
    let b = plane_basis([1.0, 2.0, 3.0], [0.0, 0.0, 2.0]);
    assert_eq!((b.u, b.v, b.n), ([1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]));
    let m = m4_from_basis(b.origin, b.u, b.v, b.n);
    let inv = m4_invert(&m).expect("invertible");
    assert_eq!((inv[12], inv[13], inv[14]), (-1.0, -2.0, -3.0));
    let zero = m4_from_basis([0.0; 3], [1.0, 0.0, 0.0], [0.0; 3], [0.0; 3]);
    assert!(m4_invert(&zero).is_none());
  }
}
