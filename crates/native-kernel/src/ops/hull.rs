// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! Convex hull of cached bodies, a port of `hull.ts`. Manifold's JavaScript binding hulls the concatenated vertices of
//! each body's `MeshGL64`, in that order, so that is what is built here.
use manifold_csg::Manifold;

use crate::finalize::{finalize_manifold, FinalizeOptions};
use crate::normalize::all_new_ids;
use crate::ops::ComponentsOutput;
use crate::{Kernel, KernelError};

fn hull_of(manifolds: &[&Manifold]) -> Manifold {
  let mut points = Vec::new();
  for m in manifolds {
    let mesh = m.to_meshgl64();
    let np = mesh.num_prop();
    let props = mesh.vert_properties();
    for v in 0..mesh.num_vert() {
      points.push([props[v * np], props[v * np + 1], props[v * np + 2]]);
    }
  }
  Manifold::hull_pts(&points)
}

pub fn hull(kernel: &Kernel, bodies: &[(f64, f64)], next_face_id: f64) -> Result<ComponentsOutput, KernelError> {
  if bodies.is_empty() {
    return Err(KernelError::invalid("hull needs at least one body"));
  }
  let entries = bodies.iter().map(|&(id, version)| kernel.get_body(id, version)).collect::<Result<Vec<_>, _>>()?;
  let manifolds: Vec<&Manifold> = entries.iter().map(|e| &e.manifold).collect();
  let h = hull_of(&manifolds);
  let fin = finalize_manifold(&h, &FinalizeOptions { next_face_id, simplify_tolerance: None }, all_new_ids)?;
  Ok(ComponentsOutput { components: fin.components, next_face_id: fin.next_face_id })
}
