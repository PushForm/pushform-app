// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! 2D polygon helpers from `@pushform/geom`, written operation for operation like the TypeScript so results stay
//! bit-identical to it.
use crate::earcut;
use crate::math::Pt;

pub type Ring = Vec<Pt>;

/// `signedArea`: shoelace, positive for counter-clockwise rings.
pub fn signed_area(ring: &[Pt]) -> f64 {
  let n = ring.len();
  let mut a = 0.0;
  if n == 0 {
    return -0.0 / 2.0;
  }
  let mut j = n - 1;
  for i in 0..n {
    let (p, q) = (ring[i], ring[j]);
    a += (q[0] + p[0]) * (q[1] - p[1]);
    j = i;
  }
  -a / 2.0
}

/// `normalizePolygon`: a copy with the outer ring counter-clockwise and every hole clockwise; zero-area rings stay as
/// they are.
pub fn normalize_polygon(poly: &[Ring]) -> Vec<Ring> {
  poly
    .iter()
    .enumerate()
    .map(|(i, ring)| {
      let a = signed_area(ring);
      let want_ccw = i == 0;
      if a == 0.0 || (a > 0.0) == want_ccw { ring.clone() } else { ring.iter().rev().copied().collect() }
    })
    .collect()
}

pub struct Triangulation {
  /// Flat (x, y) coordinates of all rings in order (outer first).
  pub coords: Vec<f64>,
  /// Triangle vertex indices into `coords`.
  pub indices: Vec<u32>,
  /// Start vertex index of each ring.
  pub ring_starts: Vec<usize>,
}

/// `triangulatePolygon`: earcut over a polygon with holes, normalized first.
pub fn triangulate_polygon(poly: &[Ring]) -> Triangulation {
  let norm = normalize_polygon(poly);
  let n: usize = norm.iter().map(Vec::len).sum();
  let mut coords = vec![0.0; n * 2];
  let mut ring_starts = Vec::with_capacity(norm.len());
  let mut hole_indices = Vec::new();
  let mut k = 0;
  for (i, ring) in norm.iter().enumerate() {
    ring_starts.push(k);
    if i > 0 {
      hole_indices.push(k);
    }
    for p in ring {
      coords[k * 2] = p[0];
      coords[k * 2 + 1] = p[1];
      k += 1;
    }
  }
  let indices = earcut::earcut(&coords, &hole_indices);
  Triangulation { coords, indices, ring_starts }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn signed_area_and_normalize_match_the_typescript_formula() {
    let cw: Ring = vec![[0.0, 0.0], [0.0, 1.0], [1.0, 1.0], [1.0, 0.0]];
    assert_eq!(signed_area(&cw), -1.0);
    let norm = normalize_polygon(&[cw.clone()]);
    assert_eq!(signed_area(&norm[0]), 1.0);
    assert_eq!(norm[0][0], cw[3]);
  }

  #[test]
  fn triangulates_a_square_with_a_hole() {
    let outer: Ring = vec![[0.0, 0.0], [4.0, 0.0], [4.0, 4.0], [0.0, 4.0]];
    let hole: Ring = vec![[1.0, 1.0], [1.0, 3.0], [3.0, 3.0], [3.0, 1.0]];
    let t = triangulate_polygon(&[outer, hole]);
    assert_eq!(t.ring_starts, vec![0, 4]);
    assert_eq!(t.indices.len() % 3, 0);
    assert_eq!(t.indices.len(), 3 * 8);
  }
}
