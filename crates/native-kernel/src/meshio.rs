// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! Conversion between the wire mesh and Manifold's Float32 `MeshGL`, matching the WebAssembly path exactly: positions go
//! through Float32 around a shared centre, so the kernels agree on every coincidence decision. `MeshGL64` would keep
//! more bits per vertex but disagree with the WebAssembly path, which is the contract here.
use manifold_csg::{CsgError, Manifold, MeshGL, MeshGLOptions};

use crate::KernelError;

pub struct ReadMesh {
  pub verts: Vec<f64>,
  pub tris: Vec<u32>,
  pub run_id: Vec<u32>,
  pub face_id: Vec<u32>,
}

pub struct TriangleSoup<'a> {
  pub verts: &'a [f64],
  pub tris: &'a [u32],
  pub face_id: &'a [u32],
}

/// The `MeshGL` for `soup`: positions relative to `center`, the given originalID, per-triangle face ids.
fn mesh_gl_from(soup: &TriangleSoup, run_id: u32, center: [f64; 3]) -> Result<MeshGL, KernelError> {
  let mut props = Vec::with_capacity(soup.verts.len());
  for point in soup.verts.chunks_exact(3) {
    props.push((point[0] - center[0]) as f32);
    props.push((point[1] - center[1]) as f32);
    props.push((point[2] - center[2]) as f32);
  }
  let run_index = [0, soup.tris.len() as u32];
  let run_original_id = [run_id];
  let options = MeshGLOptions::new().runs(&run_index, &run_original_id);
  let mut mesh = MeshGL::new_with_options(&props, 3, soup.tris, options).map_err(status_error)?;
  mesh.set_face_id(soup.face_id);
  Ok(mesh)
}

fn status_error(e: CsgError) -> KernelError {
  KernelError::manifold(format!("{e}"))
}

/// A Manifold in world coordinates from a soup uploaded around `center`, or the status Manifold rejected it with.
pub fn try_manifold_from_soup(soup: &TriangleSoup, run_id: u32, center: [f64; 3]) -> Result<Manifold, KernelError> {
  if soup.tris.is_empty() || soup.tris.len() % 3 != 0 || soup.face_id.len() != soup.tris.len() / 3 {
    return Err(KernelError::manifold("Mesh rejected by Manifold: FaceIDWrongLength".to_string()));
  }
  let mesh = mesh_gl_from(soup, run_id, center)?;
  let local = Manifold::from_meshgl(&mesh).map_err(status_error)?;
  Ok(local.translate(center[0], center[1], center[2]))
}

/// The bounds centre of `verts`, the upload centre used when solids do not have to share one.
pub fn soup_center(verts: &[f64]) -> [f64; 3] {
  let (min, max) = crate::math::bounds(verts);
  [(min[0] + max[0]) / 2.0, (min[1] + max[1]) / 2.0, (min[2] + max[2]) / 2.0]
}

/// Read a Manifold as welded Float64 triangles with per-triangle provenance (see `readManifold` in the TypeScript kernel).
pub fn read_manifold(m: &Manifold) -> ReadMesh {
  if m.is_empty() {
    return ReadMesh { verts: Vec::new(), tris: Vec::new(), run_id: Vec::new(), face_id: Vec::new() };
  }
  let bounds = m.bounding_box().expect("not empty");
  let (lo, hi) = (bounds.min(), bounds.max());
  let c = [(lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0, (lo[2] + hi[2]) / 2.0];
  let shifted = m.translate(-c[0], -c[1], -c[2]);
  let mg = shifted.to_meshgl();
  drop(shifted);

  let num_vert = mg.num_vert();
  let np = mg.num_prop();
  let mut remap: Vec<u32> = (0..num_vert as u32).collect();
  let (from, to) = (mg.merge_from_vert(), mg.merge_to_vert());
  for (f, t) in from.iter().zip(to.iter()) {
    remap[*f as usize] = *t;
  }
  let tri_verts = mg.tri_verts();
  let num_tri = tri_verts.len() / 3;
  let mut used = vec![-1i32; num_vert];
  let mut count = 0i32;
  let mut tris = vec![0u32; tri_verts.len()];
  for (i, v) in tri_verts.iter().enumerate() {
    let v = remap[*v as usize] as usize;
    if used[v] == -1 {
      used[v] = count;
      count += 1;
    }
    tris[i] = used[v] as u32;
  }
  let mut verts = vec![0.0f64; count as usize * 3];
  let props = mg.vert_properties();
  for v in 0..num_vert {
    let o = used[v];
    if o == -1 {
      continue;
    }
    let o = o as usize;
    verts[o * 3] = props[v * np] as f64 + c[0];
    verts[o * 3 + 1] = props[v * np + 1] as f64 + c[1];
    verts[o * 3 + 2] = props[v * np + 2] as f64 + c[2];
  }
  let mut run_id = vec![0u32; num_tri];
  let (run_index, run_original_id) = (mg.run_index(), mg.run_original_id());
  for (r, id) in run_original_id.iter().enumerate() {
    let start = (run_index[r] / 3) as usize;
    let end = if r + 1 < run_index.len() { (run_index[r + 1] / 3) as usize } else { num_tri };
    for slot in &mut run_id[start..end] {
      *slot = *id;
    }
  }
  let face_id = {
    let f = mg.face_id();
    if f.len() == num_tri { f } else { vec![0u32; num_tri] }
  };
  ReadMesh { verts, tris, run_id, face_id }
}
