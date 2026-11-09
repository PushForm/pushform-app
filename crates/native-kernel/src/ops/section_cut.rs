// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! Plane through a body as closed loops, a port of `sectionCut.ts`.
use crate::math::{basis_to_world, m4_affine, m4_from_basis, m4_invert, plane_basis, scale, Vec3};
use crate::tolerance::COPLANAR_TOL;
use crate::{Kernel, KernelError};

pub struct SectionCutOutput {
  /// Closed loops as flat xyz polylines (first point not repeated).
  pub loops: Vec<Vec<f64>>,
}

pub fn section_cut(kernel: &Kernel, body: (f64, f64), n: Vec3, d: f64) -> Result<SectionCutOutput, KernelError> {
  let entry = kernel.get_body(body.0, body.1)?;
  let basis = plane_basis(scale(n, -d), n);
  let Some(to_local) = m4_invert(&m4_from_basis(basis.origin, basis.u, basis.v, basis.n)) else {
    return Err(KernelError::invalid("sectionCut.plane normal must be non-zero"));
  };
  let local = entry.manifold.transform(&m4_affine(&to_local));
  let cross = local.slice_to_cross_section(0.0).simplify(COPLANAR_TOL);
  let loops = cross
    .to_polygons()
    .into_iter()
    .map(|poly| {
      let mut out = vec![0.0; poly.len() * 3];
      for (i, point) in poly.iter().enumerate() {
        let w = basis_to_world(&basis, point[0], point[1]);
        out[i * 3..i * 3 + 3].copy_from_slice(&w);
      }
      out
    })
    .collect();
  Ok(SectionCutOutput { loops })
}
