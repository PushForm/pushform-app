// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! Booleans between two cached bodies, a port of `boolean.ts`.
use manifold_csg::Manifold;

use crate::cache::CacheEntry;
use crate::finalize::{finalize_manifold, Component, FinalizeOptions};
use crate::math::{bounds, bounds_center, union_bounds};
use crate::meshio::{manifold_from_soup, TriangleSoup};
use crate::normalize::keep_ids_from_runs;
use crate::tolerance::MERGE_TOL;
use crate::wire::BooleanOp;
use crate::{Kernel, KernelError};

pub struct BooleanRequest {
  pub op: BooleanOp,
  pub a_body: (f64, f64),
  pub b_body: (f64, f64),
  pub next_face_id: f64,
}

pub struct BooleanOutput {
  pub components: Vec<Component>,
  pub secondary: Vec<Component>,
  pub next_face_id: f64,
  pub a_run_id: u32,
  pub b_run_id: u32,
}

fn soup(entry: &CacheEntry) -> TriangleSoup<'_> {
  TriangleSoup { verts: &entry.mesh.verts, tris: &entry.mesh.tris, face_id: &entry.mesh.face_id }
}

fn touches(a: ([f64; 3], [f64; 3]), b: ([f64; 3], [f64; 3])) -> bool {
  (0..3).all(|i| a.0[i] <= b.1[i] + MERGE_TOL && b.0[i] <= a.1[i] + MERGE_TOL)
}

/// Two bodies that touch, uploaded again around one shared centre so a plane they share rounds the same way in both.
/// Bodies that are apart keep their cached Manifolds.
fn shared_frame(a: &CacheEntry, b: &CacheEntry) -> Result<Option<(Manifold, Manifold)>, KernelError> {
  let (ba, bb) = (bounds(&a.mesh.verts), bounds(&b.mesh.verts));
  if !touches(ba, bb) {
    return Ok(None);
  }
  let center = bounds_center(union_bounds(ba, bb));
  Ok(Some((manifold_from_soup(&soup(a), a.run_id, center)?, manifold_from_soup(&soup(b), b.run_id, center)?)))
}

pub fn boolean(kernel: &Kernel, req: &BooleanRequest) -> Result<BooleanOutput, KernelError> {
  let a = kernel.get_body(req.a_body.0, req.a_body.1)?;
  let b = kernel.get_body(req.b_body.0, req.b_body.1)?;
  let run_ids = [a.run_id];
  let choose_id = keep_ids_from_runs(&run_ids);
  let shared = if req.op == BooleanOp::Add { shared_frame(&a, &b)? } else { None };
  let (ma, mb) = match &shared {
    Some((x, y)) => (x, y),
    None => (&a.manifold, &b.manifold),
  };
  let (primary, secondary_manifold) = match req.op {
    BooleanOp::Add => (ma.union(mb), None),
    BooleanOp::Subtract | BooleanOp::Trim => (ma.difference(mb), None),
    BooleanOp::Intersect => (ma.intersection(mb), None),
    BooleanOp::Split => {
      let (inside, outside) = ma.split(mb);
      (inside, Some(outside))
    }
  };
  let fin = finalize_manifold(&primary, &FinalizeOptions { next_face_id: req.next_face_id, simplify_tolerance: None }, &choose_id)?;
  let mut secondary = Vec::new();
  let mut next_face_id = fin.next_face_id;
  if let Some(second) = &secondary_manifold {
    let fin2 = finalize_manifold(second, &FinalizeOptions { next_face_id, simplify_tolerance: None }, &choose_id)?;
    secondary = fin2.components;
    next_face_id = fin2.next_face_id;
  }
  Ok(BooleanOutput { components: fin.components, secondary, next_face_id, a_run_id: a.run_id, b_run_id: b.run_id })
}
