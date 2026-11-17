// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! Sweep a planar profile along a polyline path as a union of per-segment prisms, a port of `followMe.ts`.
use manifold_csg::{Manifold, reserve_ids};

use crate::finalize::{finalize_manifold, FinalizeOptions};
use crate::math::{add, add_scaled, basis_to_world, bounds, bounds_center, dist, dot, len, mesh_signed_volume, normalize, scale, sub, Basis, Pt, Vec3};
use crate::meshio::{manifold_from_props, relative_props};
use crate::normalize::all_new_ids;
use crate::ops::ComponentsOutput;
use crate::polygon::{normalize_polygon, signed_area, triangulate_polygon};
use crate::tolerance::{AREA_TOL, MERGE_TOL};
use crate::KernelError;

const CAP_START: u32 = 0;
const CAP_END: u32 = 1;
const SIDE_BASE: u32 = 2;

pub struct FollowMeRequest {
  pub profile: Vec<Vec<Pt>>,
  pub basis: Basis,
  pub path: Vec<Vec3>,
  pub closed: bool,
  pub next_face_id: f64,
}

struct Profile {
  points: Vec<Vec3>,
  ring_starts: Vec<usize>,
  cap_tris: Vec<u32>,
}

fn build_profile(req: &FollowMeRequest) -> Result<Profile, KernelError> {
  let norm: Vec<_> = normalize_polygon(&req.profile).into_iter().filter(|ring| ring.len() >= 3).collect();
  if norm.is_empty() || signed_area(&norm[0]).abs() <= AREA_TOL {
    return Err(KernelError::invalid("followMe.profile has no area"));
  }
  let tri = triangulate_polygon(&norm);
  let mut points = Vec::with_capacity(tri.coords.len() / 2);
  let mut k = 0;
  while k < tri.coords.len() {
    points.push(basis_to_world(&req.basis, tri.coords[k], tri.coords[k + 1]));
    k += 2;
  }
  Ok(Profile { points, ring_starts: tri.ring_starts, cap_tris: tri.indices })
}

fn clean_path(path: &[Vec3], closed: bool) -> Result<Vec<Vec3>, KernelError> {
  let mut pts: Vec<Vec3> = Vec::new();
  for p in path {
    if p.iter().any(|x| !x.is_finite()) {
      return Err(KernelError::invalid("followMe.path has a non-finite vertex"));
    }
    if pts.last().is_none_or(|last| dist(*last, *p) > MERGE_TOL) {
      pts.push(*p);
    }
  }
  if closed && pts.len() > 1 && dist(pts[0], pts[pts.len() - 1]) <= MERGE_TOL {
    pts.pop();
  }
  Ok(pts)
}

fn orient_path(pts: Vec<Vec3>, closed: bool, anchor: Vec3) -> Vec<Vec3> {
  if !closed {
    return if dist(anchor, pts[pts.len() - 1]) < dist(anchor, pts[0]) { pts.iter().rev().copied().collect() } else { pts };
  }
  let (mut best, mut best_d) = (0, f64::INFINITY);
  for (i, p) in pts.iter().enumerate() {
    let d = dist(anchor, *p);
    if d < best_d {
      best_d = d;
      best = i;
    }
  }
  let mut out = pts[best..].to_vec();
  out.extend_from_slice(&pts[..best]);
  out
}

fn project_along(points: &[Vec3], dir: Vec3, plane_point: Vec3, plane_normal: Vec3) -> Result<Vec<Vec3>, KernelError> {
  let denom = dot(dir, plane_normal);
  if denom.abs() < 1e-9 {
    return Err(KernelError::invalid("followMe.path doubles back on itself"));
  }
  Ok(points.iter().map(|q| add_scaled(*q, dir, dot(sub(plane_point, *q), plane_normal) / denom)).collect())
}

fn bisector(a: Vec3, b: Vec3) -> Result<Vec3, KernelError> {
  let s = add(a, b);
  if len(s) < 1e-9 {
    return Err(KernelError::invalid("followMe.path doubles back on itself"));
  }
  Ok(normalize(s))
}

fn sweep_sections(profile: &Profile, path: &[Vec3], closed: bool) -> Result<Vec<Vec<Vec3>>, KernelError> {
  let n = path.len();
  let num_seg = if closed { n } else { n - 1 };
  let dirs: Vec<Vec3> = (0..num_seg).map(|i| normalize(sub(path[(i + 1) % n], path[i]))).collect();
  let d0 = dirs[0];
  let mut start = project_along(&profile.points, d0, path[0], d0)?;
  if closed {
    start = project_along(&start, d0, path[0], bisector(dirs[num_seg - 1], d0)?)?;
  }
  let mut sections = vec![start];
  for i in 0..num_seg {
    let end = path[(i + 1) % n];
    let has_next = closed || i + 1 < num_seg;
    let plane_normal = if has_next { bisector(dirs[i], dirs[(i + 1) % num_seg])? } else { dirs[i] };
    let projected = project_along(&sections[i], dirs[i], end, plane_normal)?;
    sections.push(projected);
  }
  Ok(sections)
}

struct Prism {
  verts: Vec<f64>,
  tris: Vec<u32>,
  face_id: Vec<u32>,
}

/// Closed prism between two sections with the same vertex order; winding fixed by signed volume.
fn prism_soup(profile: &Profile, a: &[Vec3], b: &[Vec3]) -> Result<Prism, KernelError> {
  let n = a.len();
  let mut verts = vec![0.0; n * 6];
  for i in 0..n {
    verts[i * 3..i * 3 + 3].copy_from_slice(&a[i]);
    verts[(n + i) * 3..(n + i) * 3 + 3].copy_from_slice(&b[i]);
  }
  let (mut tris, mut face_id) = (Vec::new(), Vec::new());
  let cap = &profile.cap_tris;
  let mut t = 0;
  while t + 2 < cap.len() {
    tris.extend_from_slice(&[cap[t], cap[t + 2], cap[t + 1]]);
    face_id.push(CAP_START);
    let base = n as u32;
    tris.extend_from_slice(&[base + cap[t], base + cap[t + 1], base + cap[t + 2]]);
    face_id.push(CAP_END);
    t += 3;
  }
  let mut edge = 0u32;
  for r in 0..profile.ring_starts.len() {
    let s = profile.ring_starts[r];
    let e = if r + 1 < profile.ring_starts.len() { profile.ring_starts[r + 1] } else { n };
    for i in s..e {
      let j = if i + 1 < e { i + 1 } else { s };
      let (iu, ju, nu) = (i as u32, j as u32, n as u32);
      tris.extend_from_slice(&[iu, ju, nu + ju, iu, nu + ju, nu + iu]);
      face_id.push(SIDE_BASE + edge);
      face_id.push(SIDE_BASE + edge);
      edge += 1;
    }
  }
  let volume = mesh_signed_volume(&verts, &tris);
  if volume.abs() <= AREA_TOL {
    return Err(KernelError::invalid("followMe produced a degenerate segment"));
  }
  if volume < 0.0 {
    for t in tris.chunks_exact_mut(3) {
      t.swap(1, 2);
    }
  }
  Ok(Prism { verts, tris, face_id })
}

fn segment_manifold(soup: &Prism, run_id: u32, center: Vec3, index: usize) -> Result<Manifold, KernelError> {
  let props = relative_props(&soup.verts, center);
  let local = manifold_from_props(&props, &soup.tris, &soup.face_id, run_id).map_err(|status| {
    KernelError::manifold_with(format!("followMe segment {index} is not a valid solid ({status})"), format!("{{\"status\":\"{status}\",\"segment\":{index}}}"))
  })?;
  Ok(local.translate(center[0], center[1], center[2]))
}

pub fn follow_me(req: &FollowMeRequest) -> Result<ComponentsOutput, KernelError> {
  let profile = build_profile(req)?;
  let cleaned = clean_path(&req.path, req.closed)?;
  if cleaned.len() < if req.closed { 3 } else { 2 } {
    return Err(KernelError::invalid("followMe.path needs at least two distinct vertices (three when closed)"));
  }
  let outer_end = profile.ring_starts.get(1).copied().unwrap_or(profile.points.len());
  let sum = profile.points[..outer_end].iter().fold([0.0; 3], |acc, p| add(acc, *p));
  let anchor = scale(sum, 1.0 / outer_end as f64);
  let path = orient_path(cleaned, req.closed, anchor);
  let d0 = normalize(sub(path[1], path[0]));
  if dot(req.basis.n, d0).abs() < 1e-6 {
    return Err(KernelError::invalid("followMe.profile plane is parallel to the first path segment"));
  }
  let sections = sweep_sections(&profile, &path, req.closed)?;
  let run_id = reserve_ids(1);
  let flat: Vec<f64> = sections.iter().flat_map(|s| s.iter().flat_map(|p| p.iter().copied())).collect();
  let center = bounds_center(bounds(&flat));
  let mut segments = Vec::with_capacity(sections.len() - 1);
  for i in 0..sections.len() - 1 {
    let prism = prism_soup(&profile, &sections[i], &sections[i + 1])?;
    segments.push(segment_manifold(&prism, run_id, center, i)?);
  }
  let joined;
  let solid: &Manifold = if segments.len() == 1 {
    &segments[0]
  } else {
    joined = Manifold::batch_union(&segments);
    &joined
  };
  let fin = finalize_manifold(solid, &FinalizeOptions { next_face_id: req.next_face_id, simplify_tolerance: None, connected_solid: false }, all_new_ids)?;
  Ok(ComponentsOutput { components: fin.components, next_face_id: fin.next_face_id })
}
