// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! The shared tail of a body-producing op: read the Manifold, normalize faces, rebuild with explicit face ids, simplify
//! away redundant vertices, decompose into connected solids, measure. A port of `finalize.ts`.
use manifold_csg::{Manifold, reserve_ids};

use crate::meshio::{read_manifold, soup_center, try_manifold_from_soup, TriangleSoup};
use crate::normalize::{normalize_triangles, IntMap, NormalizedFace, WeightedOrigin};
use crate::tolerance::COPLANAR_TOL;
use crate::KernelError;

/// One connected solid. `face_origin` keeps its entries in the order they first appear in `face_id`.
pub struct Component {
  pub verts: Vec<f64>,
  pub tris: Vec<u32>,
  pub face_id: Vec<u32>,
  pub run_id: u32,
  pub face_origin: Vec<(u32, Vec<(u32, u32)>)>,
  pub volume: f64,
  pub area: f64,
}

pub struct Finalized {
  pub components: Vec<Component>,
  pub faces: Vec<NormalizedFace>,
  pub next_face_id: i64,
}

/// Normalize, rebuild, simplify, decompose and measure `m`, which is left alone.
pub fn finalize_manifold(m: &Manifold, next_face_id: i64, choose_id: impl Fn(&[WeightedOrigin]) -> Option<u32>) -> Result<Finalized, KernelError> {
  let read = read_manifold(m);
  let norm = normalize_triangles(&read, next_face_id, choose_id);
  let run_id = reserve_ids(1);
  if norm.mesh.tris.is_empty() {
    return Ok(Finalized { components: Vec::new(), faces: Vec::new(), next_face_id: norm.next_face_id });
  }
  let center = soup_center(&norm.mesh.verts);
  let soup = TriangleSoup { verts: &norm.mesh.verts, tris: &norm.mesh.tris, face_id: &norm.mesh.face_id };
  let rebuilt = try_manifold_from_soup(&soup, run_id, center)?;
  let simplified = rebuilt.simplify(COPLANAR_TOL);
  let mut measured: Vec<(Manifold, f64, f64)> = simplified.decompose().into_iter().map(|part| {
    let (volume, area) = (part.volume(), part.surface_area());
    (part, volume, area)
  }).collect();
  // Stable, like Array.prototype.sort with `b.volume - a.volume`.
  measured.sort_by(|a, b| {
    let d = b.1 - a.1;
    if d > 0.0 { std::cmp::Ordering::Greater } else if d < 0.0 { std::cmp::Ordering::Less } else { std::cmp::Ordering::Equal }
  });
  let origin_of: IntMap<u32, usize> = norm.faces.iter().enumerate().map(|(i, f)| (f.id, i)).collect();
  let components = measured.into_iter().map(|(part, volume, area)| {
    let r = read_manifold(&part);
    let mut seen: IntMap<u32, ()> = IntMap::default();
    let mut face_origin = Vec::new();
    for &id in &r.face_id {
      if seen.insert(id, ()).is_some() {
        continue;
      }
      if let Some(&i) = origin_of.get(&id) {
        face_origin.push((id, norm.faces[i].origins.iter().map(|o| (o.run_id, o.face_id)).collect()));
      }
    }
    Component { verts: r.verts, tris: r.tris, face_id: r.face_id, run_id, face_origin, volume, area }
  }).collect();
  Ok(Finalized { components, faces: norm.faces, next_face_id: norm.next_face_id })
}
