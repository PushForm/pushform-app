// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! One component per connected solid, largest volume first, a port of `decompose.ts`.
use crate::finalize::{finalize_manifold, FinalizeOptions};
use crate::normalize::keep_ids_from_runs;
use crate::ops::ComponentsOutput;
use crate::{Kernel, KernelError};

pub fn decompose(kernel: &Kernel, body: (f64, f64), next_face_id: f64) -> Result<ComponentsOutput, KernelError> {
  let entry = kernel.get_body(body.0, body.1)?;
  let run_ids = [entry.run_id];
  let fin = finalize_manifold(&entry.manifold, &FinalizeOptions { next_face_id, simplify_tolerance: None }, keep_ids_from_runs(&run_ids))?;
  Ok(ComponentsOutput { components: fin.components, next_face_id: fin.next_face_id })
}
