// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! Revolve (lathe) a planar profile about an axis, a port of `revolve.ts`.
use manifold_csg::{CrossSection, FillRule, Manifold};

use crate::finalize::{finalize_manifold, FinalizeOptions};
use crate::math::{add_scaled, basis_to_world, cross, dot, is_integer, js_max, js_max3, len, m4_affine, m4_from_basis, neg, normalize, sub, to_int32, Basis, Pt, Vec3};
use crate::normalize::all_new_ids;
use crate::ops::ComponentsOutput;
use crate::polygon::{normalize_polygon, signed_area, Ring};
use crate::tolerance::AREA_TOL;
use crate::KernelError;

pub struct RevolveRequest {
  pub profile: Vec<Vec<Pt>>,
  pub basis: Basis,
  pub axis_origin: Vec3,
  pub axis_dir: Vec3,
  pub angle_deg: f64,
  pub segments: f64,
  pub next_face_id: f64,
}

struct LatheFrame {
  matrix: [f64; 16],
  rings: Vec<Ring>,
  extent: f64,
}

fn lathe_frame(req: &RevolveRequest) -> Result<LatheFrame, KernelError> {
  let n = req.basis.n;
  let axis_len = len(req.axis_dir);
  if !axis_len.is_finite() || axis_len == 0.0 {
    return Err(KernelError::invalid("revolve.axisDir must be non-zero"));
  }
  let z = add_scaled(req.axis_dir, n, -dot(req.axis_dir, n));
  if len(z) < 1e-9 {
    return Err(KernelError::invalid("revolve.axisDir is perpendicular to the profile plane"));
  }
  let axis_z = normalize(z);
  let o = add_scaled(req.axis_origin, n, -dot(sub(req.axis_origin, req.basis.origin), n));
  let x0 = normalize(cross(n, axis_z));

  let world: Vec<Vec<Vec3>> = req.profile.iter().map(|ring| ring.iter().map(|p| basis_to_world(&req.basis, p[0], p[1])).collect()).collect();
  let Some(outer) = world.first().filter(|outer| outer.len() >= 3) else {
    return Err(KernelError::invalid("revolve.profile needs an outer ring"));
  };
  let cx: f64 = outer.iter().fold(0.0, |sum, p| sum + dot(sub(*p, o), x0));
  let x_axis = if cx >= 0.0 { x0 } else { neg(x0) };
  let y_axis = cross(axis_z, x_axis);

  let mut extent = 0.0_f64;
  let mut rings: Vec<Ring> = Vec::with_capacity(world.len());
  for ring in &world {
    let mut local = Vec::with_capacity(ring.len());
    for p in ring {
      let r = sub(*p, o);
      let (x, y) = (dot(r, x_axis), dot(r, axis_z));
      extent = js_max3(extent, x.abs(), y.abs());
      local.push([x, y]);
    }
    rings.push(local);
  }
  let norm: Vec<Ring> = normalize_polygon(&rings).into_iter().filter(|ring| ring.len() >= 3).collect();
  if norm.is_empty() || signed_area(&norm[0]).abs() <= AREA_TOL {
    return Err(KernelError::invalid("revolve.profile has no area"));
  }
  Ok(LatheFrame { matrix: m4_from_basis(o, x_axis, y_axis, axis_z), rings: norm, extent })
}

pub fn revolve(req: &RevolveRequest) -> Result<ComponentsOutput, KernelError> {
  if !req.angle_deg.is_finite() || req.angle_deg <= 0.0 || req.angle_deg > 360.0 {
    return Err(KernelError::invalid("revolve.angleDeg must be in (0, 360]"));
  }
  if !is_integer(req.segments) || req.segments < 3.0 {
    return Err(KernelError::invalid("revolve.segments must be an integer >= 3"));
  }
  let frame = lathe_frame(req)?;
  let cs = CrossSection::from_polygons_with_fill_rule(&frame.rings, FillRule::Positive);
  let w = frame.extent * 2.0 + 1.0;
  let half = CrossSection::from_polygons_with_fill_rule(&[vec![[0.0, -w], [w, -w], [w, w], [0.0, w]]], FillRule::Positive);
  let clipped = cs.intersection(&half);
  if clipped.is_empty() {
    return Err(KernelError::invalid("revolve.profile lies entirely on the far side of the axis"));
  }
  let divisions = js_max(3.0, ((req.segments * req.angle_deg) / 360.0).ceil());
  // A connected planar region rotates into one connected solid. Split regions before revolving so an enclosed hole
  // stays a cavity of its solid rather than a separate shell.
  let mut components = Vec::new();
  let mut next_face_id = req.next_face_id;
  for region in clipped.decompose() {
    let local = Manifold::revolve(&region, to_int32(divisions), req.angle_deg);
    let solid = local.transform(&m4_affine(&frame.matrix));
    let fin = finalize_manifold(&solid, &FinalizeOptions { next_face_id, simplify_tolerance: None, connected_solid: true }, all_new_ids)?;
    components.extend(fin.components);
    next_face_id = fin.next_face_id;
  }
  Ok(ComponentsOutput { components, next_face_id })
}
