// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! The kernel's operations other than push/pull, each a port of the matching file in the TypeScript kernel's `ops/`.
pub mod autofold;
pub mod bodies;
pub mod boolean;
pub mod decompose;
pub mod edge_blend;
pub mod follow_me;
pub mod from_triangles;
pub mod hull;
pub mod properties;
pub mod revolve;
pub mod section_cut;
pub mod simplify;
pub mod transform;

use crate::finalize::Component;

/// Components and the advanced face id counter, the result of most operations.
pub struct ComponentsOutput {
  pub components: Vec<Component>,
  pub next_face_id: f64,
}
