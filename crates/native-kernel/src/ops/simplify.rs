// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! Manifold `simplify`: collapses edges shorter than the tolerance, a port of `simplify.ts`.
use crate::finalize::{finalize_manifold, FinalizeOptions};
use crate::normalize::keep_ids_from_runs;
use crate::ops::ComponentsOutput;
use crate::tolerance::COPLANAR_TOL;
use crate::{Kernel, KernelError};

pub fn simplify(kernel: &Kernel, body: (f64, f64), tolerance: Option<f64>, next_face_id: f64) -> Result<ComponentsOutput, KernelError> {
  let entry = kernel.get_body(body.0, body.1)?;
  let tolerance = tolerance.unwrap_or(COPLANAR_TOL);
  let simplified = entry.manifold.simplify(tolerance);
  let run_ids = [entry.run_id];
  let fin = finalize_manifold(&simplified, &FinalizeOptions { next_face_id, simplify_tolerance: Some(tolerance) }, keep_ids_from_runs(&run_ids))?;
  Ok(ComponentsOutput { components: fin.components, next_face_id: fin.next_face_id })
}
