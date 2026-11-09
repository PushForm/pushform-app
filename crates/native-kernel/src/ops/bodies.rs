// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! Cache-facing operations: ensureBody, release, stats. A port of `bodies.ts`.
use std::sync::Arc;

use manifold_csg::reserve_ids;

use crate::cache::CacheEntry;
use crate::meshio::{manifold_from_soup, soup_center, ReadMesh, TriangleSoup};
use crate::push_pull::Checkpoint;
use crate::wire::Mesh;
use crate::{Kernel, KernelError};

/// `Some(run_id)` once `(body_id, version)` is cached; `None` when it is not and no mesh was sent.
pub fn ensure_body(kernel: &Kernel, body_id: f64, version: f64, mesh: Option<Mesh>, checkpoint: &dyn Checkpoint) -> Result<Option<u32>, KernelError> {
  if let Some(existing) = kernel.cached(body_id, version) {
    return Ok(Some(existing.run_id));
  }
  let Some(mesh) = mesh else { return Ok(None) };
  let run_id = reserve_ids(1);
  let soup = TriangleSoup { verts: &mesh.verts, tris: &mesh.tris, face_id: &mesh.face_id };
  let manifold = manifold_from_soup(&soup, run_id, soup_center(&mesh.verts))?;
  checkpoint.check()?;
  let num_tri = mesh.face_id.len();
  let entry = CacheEntry { manifold, run_id, mesh: ReadMesh { verts: mesh.verts, tris: mesh.tris, run_id: vec![run_id; num_tri], face_id: mesh.face_id } };
  kernel.insert(body_id, version, Arc::new(entry));
  Ok(Some(run_id))
}

/// Size of the heap the kernel runs in, or 0 when there is no single such heap (a native build).
pub fn heap_bytes() -> f64 {
  #[cfg(target_arch = "wasm32")]
  {
    (core::arch::wasm32::memory_size::<0>() * 65536) as f64
  }
  #[cfg(not(target_arch = "wasm32"))]
  {
    0.0
  }
}
