// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! Strict contour validation before Manifold can repair malformed extrusion input.
use crate::math::{hypot2, point_in_polygon, Pt};
use crate::tolerance::{AREA_TOL, MERGE_TOL};
use crate::KernelError;

struct Edge {
  a: Pt,
  b: Pt,
  ring: usize,
  index: usize,
  size: usize,
  min_x: f64,
  max_x: f64,
  min_y: f64,
  max_y: f64,
}

fn forbidden_intersection(a: &Edge, b: &Edge, adjacent: bool) -> bool {
  let (rx, ry) = (a.b[0] - a.a[0], a.b[1] - a.a[1]);
  let (qx, qy) = (b.b[0] - b.a[0], b.b[1] - b.a[1]);
  let (wx, wy) = (b.a[0] - a.a[0], b.a[1] - a.a[1]);
  let (rl, ql) = (hypot2(rx, ry), hypot2(qx, qy));
  let denom = rx * qy - ry * qx;
  if denom.abs() / (rl * ql) <= MERGE_TOL / rl.max(ql) {
    if (wx * ry - wy * rx).abs() / rl > MERGE_TOL { return false; }
    let t0 = (wx * rx + wy * ry) / (rl * rl);
    let t1 = ((b.b[0] - a.a[0]) * rx + (b.b[1] - a.a[1]) * ry) / (rl * rl);
    let lo = 0.0_f64.max(t0.min(t1));
    let hi = 1.0_f64.min(t0.max(t1));
    return hi + MERGE_TOL / rl >= lo && (!adjacent || hi > lo);
  }
  let t = (wx * qy - wy * qx) / denom;
  let s = (wx * ry - wy * rx) / denom;
  !adjacent && t >= -MERGE_TOL / rl && t <= 1.0 + MERGE_TOL / rl
    && s >= -MERGE_TOL / ql && s <= 1.0 + MERGE_TOL / ql
}

pub fn validate_profile(polygon: &[Vec<Pt>]) -> Result<(), KernelError> {
  if polygon.is_empty() || polygon.len() > 101 || polygon.iter().map(Vec::len).sum::<usize>() > 10_000 {
    return Err(KernelError::invalid("Profile exceeds its contour/point limit."));
  }
  let mut edges = Vec::new();
  for (ring_index, ring) in polygon.iter().enumerate() {
    let area = ring.iter().enumerate().map(|(i, a)| {
      let b = ring[(i + 1) % ring.len()]; a[0] * b[1] - a[1] * b[0]
    }).sum::<f64>() * 0.5;
    if ring.len() < 3 || ring.iter().flatten().any(|v| !v.is_finite()) || area.abs() <= AREA_TOL {
      return Err(KernelError::invalid("Each profile contour must have nonzero area and finite points."));
    }
    for (index, &a) in ring.iter().enumerate() {
      let b = ring[(index + 1) % ring.len()];
      if hypot2(b[0] - a[0], b[1] - a[1]) <= MERGE_TOL {
        return Err(KernelError::invalid("Profile contains a zero-length edge."));
      }
      edges.push(Edge { a, b, ring: ring_index, index, size: ring.len(),
        min_x: a[0].min(b[0]), max_x: a[0].max(b[0]), min_y: a[1].min(b[1]), max_y: a[1].max(b[1]) });
    }
  }
  // Stable x-bound sweep avoids an all-pairs scan for ordinary long polylines.
  edges.sort_by(|a, b| a.min_x.total_cmp(&b.min_x));
  for (i, a) in edges.iter().enumerate() {
    for b in &edges[i + 1..] {
      if b.min_x > a.max_x + MERGE_TOL { break; }
      if b.max_y < a.min_y - MERGE_TOL || b.min_y > a.max_y + MERGE_TOL { continue; }
      let delta = a.index.abs_diff(b.index);
      let adjacent = a.ring == b.ring && (delta == 1 || delta == a.size - 1);
      if forbidden_intersection(a, b, adjacent) {
        return Err(KernelError::invalid("Profile contours cross, overlap or touch."));
      }
    }
  }
  for i in 1..polygon.len() {
    if !point_in_polygon(polygon[i][0], &polygon[..1]) {
      return Err(KernelError::invalid("A profile hole lies outside the outer contour."));
    }
    for j in 1..polygon.len() {
      if i != j && point_in_polygon(polygon[i][0], std::slice::from_ref(&polygon[j])) {
        return Err(KernelError::invalid("Profile holes must not overlap or contain each other."));
      }
    }
  }
  Ok(())
}
