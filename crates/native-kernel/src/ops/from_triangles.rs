// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! Validate a triangle soup with Manifold and normalize it, a port of `fromTriangles.ts`.
use manifold_csg::reserve_ids;

use crate::finalize::{finalize_manifold, Component, FinalizeOptions};
use crate::meshio::{soup_center, try_manifold_from_soup, TriangleSoup};
use crate::normalize::keep_ids_from_runs;
use crate::wire::Mesh;
use crate::KernelError;

pub struct FromTrianglesOutput {
  /// `ManifoldStatus` name: `NoError` or why the mesh was rejected.
  pub status: &'static str,
  pub components: Vec<Component>,
  pub next_face_id: f64,
}

pub fn from_triangles(mesh: &Mesh, next_face_id: f64) -> Result<FromTrianglesOutput, KernelError> {
  let run_id = reserve_ids(1);
  let soup = TriangleSoup { verts: &mesh.verts, tris: &mesh.tris, face_id: &mesh.face_id };
  let manifold = match try_manifold_from_soup(&soup, run_id, soup_center(&mesh.verts)) {
    Ok(m) => m,
    Err(status) => return Ok(FromTrianglesOutput { status, components: Vec::new(), next_face_id }),
  };
  let run_ids = [run_id];
  let fin = finalize_manifold(&manifold, &FinalizeOptions { next_face_id, simplify_tolerance: None }, keep_ids_from_runs(&run_ids))?;
  Ok(FromTrianglesOutput { status: "NoError", components: fin.components, next_face_id: fin.next_face_id })
}
