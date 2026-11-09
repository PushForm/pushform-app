// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! The normalize invariant: triangles group into faces by coplanarity and edge adjacency, then get face ids.
//! A port of `normalize.ts`; orderings are reproduced exactly because the first group to claim an id wins.
use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

use crate::math::{hypot3, to_uint32};
use crate::meshio::ReadMesh;
use crate::tolerance::{AREA_TOL, COPLANAR_TOL};

/// Fast hashing for integer edge keys, which are already well spread after multiplying.
#[derive(Default)]
pub struct IntHasher(u64);
impl Hasher for IntHasher {
  fn finish(&self) -> u64 {
    self.0
  }
  fn write(&mut self, bytes: &[u8]) {
    for b in bytes {
      self.write_u8(*b);
    }
  }
  fn write_u8(&mut self, b: u8) {
    self.0 = self.0.rotate_left(5) ^ b as u64;
    self.0 = self.0.wrapping_mul(0x517c_c1b7_2722_0a95);
  }
  fn write_u64(&mut self, n: u64) {
    self.0 = (n ^ self.0.rotate_left(5)).wrapping_mul(0x517c_c1b7_2722_0a95);
  }
}
pub type IntMap<K, V> = HashMap<K, V, BuildHasherDefault<IntHasher>>;

struct TriPlanes {
  normals: Vec<f64>,
  offsets: Vec<f64>,
  areas: Vec<f64>,
}

fn triangle_planes(verts: &[f64], tris: &[u32]) -> TriPlanes {
  let n = tris.len() / 3;
  let (mut normals, mut offsets, mut areas) = (vec![0.0; n * 3], vec![0.0; n], vec![0.0; n]);
  for t in 0..n {
    let (a, b, c) = (tris[t * 3] as usize * 3, tris[t * 3 + 1] as usize * 3, tris[t * 3 + 2] as usize * 3);
    let (ax, ay, az) = (verts[a], verts[a + 1], verts[a + 2]);
    let (e1x, e1y, e1z) = (verts[b] - ax, verts[b + 1] - ay, verts[b + 2] - az);
    let (e2x, e2y, e2z) = (verts[c] - ax, verts[c + 1] - ay, verts[c + 2] - az);
    let (nx, ny, nz) = (e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x);
    let l = hypot3(nx, ny, nz);
    areas[t] = l / 2.0;
    if l > 0.0 {
      normals[t * 3] = nx / l;
      normals[t * 3 + 1] = ny / l;
      normals[t * 3 + 2] = nz / l;
      offsets[t] = (nx * ax + ny * ay + nz * az) / l;
    }
  }
  TriPlanes { normals, offsets, areas }
}

/// A triangle's neighbours in the order its edges are met: up to three stored inline, any more in `overflow`.
struct Neighbors {
  inline: Vec<u32>,
  count: Vec<u8>,
  overflow: IntMap<u32, Vec<u32>>,
}

impl Neighbors {
  fn new(num_tris: usize) -> Self {
    Self { inline: vec![0; num_tris * 3], count: vec![0; num_tris], overflow: IntMap::default() }
  }

  fn push(&mut self, t: u32, neighbor: u32) {
    let c = self.count[t as usize];
    if c < 3 {
      self.inline[t as usize * 3 + c as usize] = neighbor;
      self.count[t as usize] = c + 1;
    } else {
      self.overflow.entry(t).or_default().push(neighbor);
    }
  }

  fn for_each(&self, t: u32, mut f: impl FnMut(u32)) {
    let c = self.count[t as usize] as usize;
    for k in 0..c {
      f(self.inline[t as usize * 3 + k]);
    }
    if c == 3 {
      if let Some(rest) = self.overflow.get(&t) {
        for &u in rest {
          f(u);
        }
      }
    }
  }
}

const NO_TRIANGLE: u32 = u32::MAX;

/// For each triangle, the triangles sharing an edge with it, in the order the edges are met.
fn triangle_neighbors(tris: &[u32], num_verts: u64) -> Neighbors {
  let n = tris.len() / 3;
  // Every edge of a manifold mesh joins two triangles; `extra_on_edge` keeps any further ones in order.
  let mut by_edge: IntMap<u64, (u32, u32)> = IntMap::with_capacity_and_hasher(n * 2, Default::default());
  let mut extra_on_edge: IntMap<u64, Vec<u32>> = IntMap::default();
  let mut neighbors = Neighbors::new(n);
  for t in 0..n {
    let t32 = t as u32;
    for k in 0..3 {
      let (a, b) = (tris[t * 3 + k] as u64, tris[t * 3 + (k + 1) % 3] as u64);
      let key = a.min(b) * num_verts + a.max(b);
      let entry = by_edge.entry(key).or_insert((NO_TRIANGLE, NO_TRIANGLE));
      let (first, second) = *entry;
      if first == NO_TRIANGLE {
        entry.0 = t32;
        continue;
      }
      neighbors.push(t32, first);
      neighbors.push(first, t32);
      if second == NO_TRIANGLE {
        entry.1 = t32;
      } else {
        neighbors.push(t32, second);
        neighbors.push(second, t32);
        let rest = extra_on_edge.entry(key).or_default();
        for &u in rest.iter() {
          neighbors.push(t32, u);
          neighbors.push(u, t32);
        }
        rest.push(t32);
      }
    }
  }
  neighbors
}

/// Grows faces from seeds taken in decreasing area, so each group's plane comes from its most reliable triangle.
pub fn group_coplanar(verts: &[f64], tris: &[u32]) -> (Vec<Vec<u32>>, Vec<f64>) {
  let tol = COPLANAR_TOL;
  let n = tris.len() / 3;
  let TriPlanes { normals, offsets, areas } = triangle_planes(verts, tris);
  let neighbors = triangle_neighbors(tris, (verts.len() / 3) as u64);
  let mut order: Vec<u32> = (0..n as u32).collect();
  // Stable, like Array.prototype.sort with `areas[b] - areas[a]`.
  order.sort_by(|&a, &b| {
    let d = areas[b as usize] - areas[a as usize];
    if d > 0.0 { std::cmp::Ordering::Greater } else if d < 0.0 { std::cmp::Ordering::Less } else { std::cmp::Ordering::Equal }
  });
  let mut group_of = vec![-1i32; n];
  let mut groups: Vec<Vec<u32>> = Vec::new();
  for &seed in &order {
    if group_of[seed as usize] != -1 {
      continue;
    }
    let g = groups.len() as i32;
    let s = seed as usize;
    let (nx, ny, nz, d) = (normals[s * 3], normals[s * 3 + 1], normals[s * 3 + 2], offsets[s]);
    let fits = |t: usize| -> bool {
      for k in 0..3 {
        let v = tris[t * 3 + k] as usize * 3;
        if (nx * verts[v] + ny * verts[v + 1] + nz * verts[v + 2] - d).abs() > tol {
          return false;
        }
      }
      areas[t] <= AREA_TOL || nx * normals[t * 3] + ny * normals[t * 3 + 1] + nz * normals[t * 3 + 2] > 0.0
    };
    let mut members = Vec::new();
    let mut stack = vec![seed];
    group_of[s] = g;
    while let Some(t) = stack.pop() {
      members.push(t);
      neighbors.for_each(t, |u| {
        if group_of[u as usize] != -1 || !fits(u as usize) {
          return;
        }
        group_of[u as usize] = g;
        stack.push(u);
      });
    }
    groups.push(members);
  }
  (groups, areas)
}

#[derive(Clone, Copy)]
pub struct WeightedOrigin {
  pub run_id: u32,
  pub face_id: u32,
  pub area: f64,
}

pub struct NormalizedFace {
  /// A JavaScript number: fresh ids grow without wrapping; only a mesh's `faceId` array holds them as `Uint32`.
  pub id: f64,
  pub origins: Vec<WeightedOrigin>,
}

pub struct NormalizedMesh {
  pub verts: Vec<f64>,
  pub tris: Vec<u32>,
  pub face_id: Vec<u32>,
}

pub struct Normalized {
  pub mesh: NormalizedMesh,
  pub faces: Vec<NormalizedFace>,
  pub next_face_id: f64,
}

fn origins_of(read: &ReadMesh, members: &[u32], areas: &[f64]) -> Vec<WeightedOrigin> {
  let mut index: IntMap<u64, usize> = IntMap::default();
  let mut acc: Vec<WeightedOrigin> = Vec::new();
  for &t in members {
    let (run_id, face_id) = (read.run_id[t as usize], read.face_id[t as usize]);
    let key = ((run_id as u64) << 32) | face_id as u64;
    match index.get(&key) {
      Some(&i) => acc[i].area += areas[t as usize],
      None => {
        index.insert(key, acc.len());
        acc.push(WeightedOrigin { run_id, face_id, area: areas[t as usize] });
      }
    }
  }
  acc.sort_by(|a, b| {
    let d = b.area - a.area;
    if d > 0.0 { std::cmp::Ordering::Greater } else if d < 0.0 { std::cmp::Ordering::Less } else { std::cmp::Ordering::Equal }
  });
  acc
}

/// `Map` and `Set` key equality for a JavaScript number (SameValueZero): -0 is +0 and every NaN is the same key.
pub fn number_key(x: f64) -> u64 {
  if x == 0.0 {
    0
  } else if x.is_nan() {
    u64::MAX
  } else {
    x.to_bits()
  }
}

/// `keepIdsFromRuns`: the smallest face id among the origins coming from one of `run_ids`.
pub fn keep_ids_from_runs(run_ids: &[u32]) -> impl Fn(&[WeightedOrigin]) -> Option<f64> + '_ {
  move |origins| origins.iter().filter(|o| run_ids.contains(&o.run_id)).map(|o| o.face_id).min().map(f64::from)
}

/// `allNewIds`.
pub fn all_new_ids(_: &[WeightedOrigin]) -> Option<f64> {
  None
}

/// Group `read` into faces and assign ids. `choose_id` proposes a kept id for a group from its origins (largest first);
/// the first group claiming an id wins, later claimants and groups with none get fresh ids.
pub fn normalize_triangles(read: &ReadMesh, next_face_id: f64, choose_id: impl Fn(&[WeightedOrigin]) -> Option<f64>) -> Normalized {
  let (groups, areas) = group_coplanar(&read.verts, &read.tris);
  let origins_per_group: Vec<Vec<WeightedOrigin>> = groups.iter().map(|m| origins_of(read, m, &areas)).collect();
  let mut claimed: std::collections::HashSet<u64, BuildHasherDefault<IntHasher>> = Default::default();
  let mut ids: Vec<Option<f64>> = vec![None; groups.len()];
  let mut max_claimed = next_face_id - 1.0;
  for (g, origins) in origins_per_group.iter().enumerate() {
    let Some(id) = choose_id(origins) else { continue };
    if !claimed.insert(number_key(id)) {
      continue;
    }
    ids[g] = Some(id);
    if id > max_claimed {
      max_claimed = id;
    }
  }
  let mut next = max_claimed + 1.0;
  let mut faces = Vec::with_capacity(groups.len());
  for (g, origins) in origins_per_group.into_iter().enumerate() {
    let id = ids[g].unwrap_or_else(|| {
      let fresh = next;
      next += 1.0;
      fresh
    });
    faces.push(NormalizedFace { id, origins });
  }
  let num_tri = read.tris.len() / 3;
  let mut tris = vec![0u32; num_tri * 3];
  let mut face_id = vec![0u32; num_tri];
  let mut out = 0usize;
  for (g, members) in groups.iter().enumerate() {
    for &t in members {
      let t = t as usize;
      tris[out * 3] = read.tris[t * 3];
      tris[out * 3 + 1] = read.tris[t * 3 + 1];
      tris[out * 3 + 2] = read.tris[t * 3 + 2];
      face_id[out] = to_uint32(faces[g].id);
      out += 1;
    }
  }
  Normalized { mesh: NormalizedMesh { verts: read.verts.clone(), tris, face_id }, faces, next_face_id: next }
}
