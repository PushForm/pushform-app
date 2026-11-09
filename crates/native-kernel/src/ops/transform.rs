// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! A column-major 4x4 affine transform of a body, a port of `transform.ts`.
use crate::finalize::{finalize_manifold, FinalizeOptions};
use crate::math::m4_affine;
use crate::normalize::keep_ids_from_runs;
use crate::ops::ComponentsOutput;
use crate::{Kernel, KernelError};

pub fn transform(kernel: &Kernel, body: (f64, f64), matrix: &[f64], next_face_id: f64) -> Result<ComponentsOutput, KernelError> {
  if matrix.len() != 16 || matrix.iter().any(|x| !x.is_finite()) {
    return Err(KernelError::invalid("transform.matrix must hold 16 finite numbers"));
  }
  let entry = kernel.get_body(body.0, body.1)?;
  let m: [f64; 16] = matrix.try_into().expect("checked above");
  let moved = entry.manifold.transform(&m4_affine(&m));
  let run_ids = [entry.run_id];
  let fin = finalize_manifold(&moved, &FinalizeOptions { next_face_id, simplify_tolerance: None, connected_solid: false }, keep_ids_from_runs(&run_ids))?;
  Ok(ComponentsOutput { components: fin.components, next_face_id: fin.next_face_id })
}
