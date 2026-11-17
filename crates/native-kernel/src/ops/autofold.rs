// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! Autofold: validate a re-triangulated mesh and normalize it, a port of `autofold.ts`. Rejections carry the same
//! messages and details as the former TypeScript kernel.
use manifold_csg::reserve_ids;

use crate::bvh::{build_tri_bvh, query_box};
use crate::finalize::{finalize_manifold, FinalizeOptions};
use crate::math::{cross, dot, hypot3, js_max, js_max3, js_min, js_min3, sub, Vec3};
use crate::meshio::{soup_center, try_manifold_from_soup, TriangleSoup};
use crate::normalize::keep_ids_from_runs;
use crate::ops::ComponentsOutput;
use crate::tolerance::COPLANAR_TOL;
use crate::wire::Mesh;
use crate::KernelError;

pub fn autofold(mesh: &Mesh, next_face_id: f64) -> Result<ComponentsOutput, KernelError> {
  if mesh.tris.is_empty() || !mesh.tris.len().is_multiple_of(3) || mesh.face_id.len() != mesh.tris.len() / 3 {
    return Err(KernelError::invalid("autofold.mesh must hold at least one triangle and one faceId per triangle"));
  }
  let run_id = reserve_ids(1);
  let soup = TriangleSoup { verts: &mesh.verts, tris: &mesh.tris, face_id: &mesh.face_id };
  let manifold = try_manifold_from_soup(&soup, run_id, soup_center(&mesh.verts)).map_err(|status| {
    KernelError::manifold_with(format!("Would create an invalid solid ({status})"), format!("{{\"reason\":\"NotManifold\",\"status\":\"{status}\"}}"))
  })?;
  if let Some((i, j)) = mesh_self_intersection(&mesh.verts, &mesh.tris) {
    return Err(KernelError::manifold_with("Would create a self-intersecting solid".to_string(), format!("{{\"reason\":\"SelfIntersecting\",\"status\":\"NoError\",\"triangles\":[{i},{j}]}}")));
  }
  let run_ids = [run_id];
  let fin = finalize_manifold(&manifold, &FinalizeOptions { next_face_id, simplify_tolerance: None, connected_solid: false }, keep_ids_from_runs(&run_ids))?;
  Ok(ComponentsOutput { components: fin.components, next_face_id: fin.next_face_id })
}

/// Parameter interval of a triangle's crossing with the other triangle's plane along axis `ax`.
fn crossing_interval(p: &[Vec3; 3], d: &[f64; 3], ax: usize, tol: f64) -> (f64, f64) {
  let pos = d.iter().filter(|&&x| x > tol).count();
  let neg = d.iter().filter(|&&x| x < -tol).count();
  let first_pos = d.iter().position(|&x| x > tol).unwrap_or(0);
  let first_neg = d.iter().position(|&x| x < -tol).unwrap_or(0);
  let isolated = if pos == 1 {
    first_pos
  } else if neg == 1 {
    first_neg
  } else {
    first_pos
  };
  let (a, b, c) = (isolated, (isolated + 1) % 3, (isolated + 2) % 3);
  let (pa, da) = (p[a][ax], d[a]);
  let at = |k: usize| -> f64 {
    let (dk, pk) = (d[k], p[k][ax]);
    let denom = da - dk;
    if denom.abs() < 1e-300 { pk } else { pa + ((pk - pa) * da) / denom }
  };
  let (t1, t2) = (at(b), at(c));
  if t1 < t2 { (t1, t2) } else { (t2, t1) }
}

/// Moller's triangle/triangle test with a tolerance: touching within `tol` does not count; coplanar pairs are ignored.
fn triangles_intersect(p: &[Vec3; 3], q: &[Vec3; 3], tol: f64) -> bool {
  let n1 = cross(sub(p[1], p[0]), sub(p[2], p[0]));
  let l1 = hypot3(n1[0], n1[1], n1[2]);
  if l1 == 0.0 {
    return false;
  }
  let u1 = [n1[0] / l1, n1[1] / l1, n1[2] / l1];
  let dq = [dot(u1, sub(q[0], p[0])), dot(u1, sub(q[1], p[0])), dot(u1, sub(q[2], p[0]))];
  if js_max3(dq[0], dq[1], dq[2]) <= tol || js_min3(dq[0], dq[1], dq[2]) >= -tol {
    return false;
  }
  let n2 = cross(sub(q[1], q[0]), sub(q[2], q[0]));
  let l2 = hypot3(n2[0], n2[1], n2[2]);
  if l2 == 0.0 {
    return false;
  }
  let u2 = [n2[0] / l2, n2[1] / l2, n2[2] / l2];
  let dp = [dot(u2, sub(p[0], q[0])), dot(u2, sub(p[1], q[0])), dot(u2, sub(p[2], q[0]))];
  if js_max3(dp[0], dp[1], dp[2]) <= tol || js_min3(dp[0], dp[1], dp[2]) >= -tol {
    return false;
  }
  let dir = cross(u1, u2);
  let ax = if dir[0].abs() >= dir[1].abs() && dir[0].abs() >= dir[2].abs() {
    0
  } else if dir[1].abs() >= dir[2].abs() {
    1
  } else {
    2
  };
  let (ip0, ip1) = crossing_interval(p, &dp, ax, tol);
  let (iq0, iq1) = crossing_interval(q, &dq, ax, tol);
  let overlap = js_min(ip1, iq1) - js_max(ip0, iq0);
  let scale = dir[ax].abs() / js_max(hypot3(dir[0], dir[1], dir[2]), 1e-300);
  overlap / js_max(scale, 1e-300) > tol
}

/// First pair of triangles with no shared vertex index that intersect, in the order the former TypeScript kernel finds them.
fn mesh_self_intersection(verts: &[f64], tris: &[u32]) -> Option<(usize, usize)> {
  let tol = COPLANAR_TOL;
  let bvh = build_tri_bvh(verts, tris);
  let num_tri = tris.len() / 3;
  let point = |v: u32| -> Vec3 { [verts[v as usize * 3], verts[v as usize * 3 + 1], verts[v as usize * 3 + 2]] };
  for i in 0..num_tri {
    let (ia, ib, ic) = (tris[i * 3], tris[i * 3 + 1], tris[i * 3 + 2]);
    let pb = &bvh.prim_bounds;
    let min = [pb[i * 6] - tol, pb[i * 6 + 1] - tol, pb[i * 6 + 2] - tol];
    let max = [pb[i * 6 + 3] + tol, pb[i * 6 + 4] + tol, pb[i * 6 + 5] + tol];
    let p = [point(ia), point(ib), point(ic)];
    for j in query_box(&bvh, min, max) {
      let j = j as usize;
      if j <= i {
        continue;
      }
      let (ja, jb, jc) = (tris[j * 3], tris[j * 3 + 1], tris[j * 3 + 2]);
      if ja == ia || ja == ib || ja == ic || jb == ia || jb == ib || jb == ic || jc == ia || jc == ib || jc == ic {
        continue;
      }
      if triangles_intersect(&p, &[point(ja), point(jb), point(jc)], tol) {
        return Some((i, j));
      }
    }
  }
  None
}

#[cfg(test)]
mod tests {
  use super::mesh_self_intersection;

  /// The triangles of a box with faces on each side, like `meshBox` in `@pushform/core`.
  fn box_mesh(min: [f64; 3], max: [f64; 3], first_vert: u32) -> (Vec<f64>, Vec<u32>) {
    let mut verts = Vec::new();
    for &z in &[min[2], max[2]] {
      for &(x, y) in &[(min[0], min[1]), (max[0], min[1]), (max[0], max[1]), (min[0], max[1])] {
        verts.extend_from_slice(&[x, y, z]);
      }
    }
    #[rustfmt::skip]
    let tris: Vec<u32> = [0u32, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7].iter().map(|i| i + first_vert).collect();
    (verts, tris)
  }

  #[test]
  fn self_intersection_ignores_adjacent_and_merely_touching_triangles() {
    let (verts, tris) = box_mesh([0.0, 0.0, 0.0], [1.0, 1.0, 1.0], 0);
    assert_eq!(mesh_self_intersection(&verts, &tris), None);
    // Two boxes sharing a face but not vertices: touching, not intersecting.
    let (mut together, mut tris_together) = box_mesh([0.0, 0.0, 0.0], [1.0, 1.0, 1.0], 0);
    let (top, top_tris) = box_mesh([0.25, 0.25, 1.0], [0.75, 0.75, 2.0], 8);
    together.extend_from_slice(&top);
    tris_together.extend_from_slice(&top_tris);
    assert_eq!(mesh_self_intersection(&together, &tris_together), None);
    // The second box now reaches into the first.
    let (mut crossing, mut tris_crossing) = box_mesh([0.0, 0.0, 0.0], [1.0, 1.0, 1.0], 0);
    let (inside, inside_tris) = box_mesh([0.25, 0.25, 0.5], [0.75, 0.75, 2.0], 8);
    crossing.extend_from_slice(&inside);
    tris_crossing.extend_from_slice(&inside_tris);
    assert!(mesh_self_intersection(&crossing, &tris_crossing).is_some());
  }
}
