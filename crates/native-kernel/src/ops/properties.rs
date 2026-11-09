// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! Volume, area, genus and bounds of a cached body, a port of `properties.ts`.
use crate::{Kernel, KernelError};

pub struct PropertiesOutput {
  pub volume: f64,
  pub area: f64,
  pub genus: f64,
  pub min: [f64; 3],
  pub max: [f64; 3],
}

pub fn properties(kernel: &Kernel, body: (f64, f64)) -> Result<PropertiesOutput, KernelError> {
  let entry = kernel.get_body(body.0, body.1)?;
  let m = &entry.manifold;
  // An empty Manifold's box is the one Manifold reports: inverted and infinite.
  let (min, max) = match m.bounding_box() {
    Some(b) => (b.min(), b.max()),
    None => ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]),
  };
  Ok(PropertiesOutput { volume: m.volume(), area: m.surface_area(), genus: f64::from(m.genus()), min, max })
}
