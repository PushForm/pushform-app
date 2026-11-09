// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! Fillet and chamfer: subtract the union of the cut prisms from a body and add the union of the add prisms, a port of
//! `edgeBlend.ts`. Tool prisms are uploaded around one shared centre so vertices two prisms share land identically.
use manifold_csg::{Manifold, reserve_ids};

use crate::finalize::{finalize_manifold, Component, FinalizeOptions};
use crate::math::{bounds, bounds_center, Vec3};
use crate::meshio::{manifold_from_props, relative_props};
use crate::normalize::keep_ids_from_runs;
use crate::wire::Mesh;
use crate::{Kernel, KernelError};

pub struct EdgeBlendRequest {
  pub body: (f64, f64),
  pub cut: Vec<Mesh>,
  pub add: Vec<Mesh>,
  pub next_face_id: f64,
}

pub struct EdgeBlendOutput {
  pub components: Vec<Component>,
  pub next_face_id: f64,
  pub body_run_id: u32,
  pub tool_run_id: u32,
}

fn prism_manifold(soup: &Mesh, run_id: u32, center: Vec3, index: usize) -> Result<Manifold, KernelError> {
  let props = relative_props(&soup.verts, center);
  if soup.tris.is_empty() || !soup.tris.len().is_multiple_of(3) || soup.face_id.len() != soup.tris.len() / 3 {
    return Err(KernelError::invalid(&format!("edgeBlend prism {index} has a malformed mesh")));
  }
  let local = manifold_from_props(&props, &soup.tris, &soup.face_id, run_id).map_err(|status| {
    KernelError::invalid_with(format!("edgeBlend prism {index} is not a valid solid ({status})"), format!("{{\"status\":\"{status}\",\"prism\":{index}}}"))
  })?;
  Ok(local.translate(center[0], center[1], center[2]))
}

fn union_of(soups: &[Mesh], run_id: u32, center: Vec3, index: &mut usize) -> Result<Option<Manifold>, KernelError> {
  if soups.is_empty() {
    return Ok(None);
  }
  let mut parts = Vec::with_capacity(soups.len());
  for soup in soups {
    parts.push(prism_manifold(soup, run_id, center, *index)?);
    *index += 1;
  }
  Ok(Some(if parts.len() == 1 { parts.remove(0) } else { Manifold::batch_union(&parts) }))
}

pub fn edge_blend(kernel: &Kernel, req: &EdgeBlendRequest) -> Result<EdgeBlendOutput, KernelError> {
  let body = kernel.get_body(req.body.0, req.body.1)?;
  if req.cut.is_empty() && req.add.is_empty() {
    return Err(KernelError::invalid("edgeBlend needs at least one tool prism"));
  }
  let positions: Vec<f64> = req.cut.iter().chain(req.add.iter()).flat_map(|s| s.verts.iter().copied()).collect();
  let center = bounds_center(bounds(&positions));
  let tool_run_id = reserve_ids(1);
  let mut index = 0;
  let cut = union_of(&req.cut, tool_run_id, center, &mut index)?;
  let mut solid = match cut {
    Some(cut) => body.manifold.difference(&cut),
    None => body.manifold.clone(),
  };
  let add = union_of(&req.add, tool_run_id, center, &mut index)?;
  if let Some(add) = add {
    solid = solid.union(&add);
  }
  let run_ids = [body.run_id];
  let fin = finalize_manifold(&solid, &FinalizeOptions { next_face_id: req.next_face_id, simplify_tolerance: None }, keep_ids_from_runs(&run_ids))?;
  Ok(EdgeBlendOutput { components: fin.components, next_face_id: fin.next_face_id, body_run_id: body.run_id, tool_run_id })
}
