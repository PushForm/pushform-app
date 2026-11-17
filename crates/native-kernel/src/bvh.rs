// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! A flat bounding-volume tree over triangles, a port of `@pushform/geom`'s `buildTriBVH` and `queryBVHBox`: the same
//! median split and the same traversal order, so a box query lists triangles in the same order.
use crate::math::{js_max, js_min, Vec3};

pub struct Bvh {
  /// Six per node: min xyz, max xyz.
  bounds: Vec<f64>,
  left: Vec<i32>,
  right: Vec<i32>,
  start: Vec<i32>,
  count: Vec<i32>,
  order: Vec<u32>,
  /// Six per triangle, in triangle order.
  pub prim_bounds: Vec<f64>,
}

const MAX_LEAF: usize = 4;

/// `buildTriBVH(mesh)` with the default leaf size.
pub fn build_tri_bvh(verts: &[f64], tris: &[u32]) -> Bvh {
  let n = tris.len() / 3;
  let (mut prim_bounds, mut centroids) = (vec![0.0; n * 6], vec![0.0; n * 3]);
  for i in 0..n {
    let (mut minx, mut miny, mut minz) = (f64::INFINITY, f64::INFINITY, f64::INFINITY);
    let (mut maxx, mut maxy, mut maxz) = (f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for k in 0..3 {
      let v = tris[i * 3 + k] as usize * 3;
      let (x, y, z) = (verts[v], verts[v + 1], verts[v + 2]);
      minx = js_min(minx, x);
      miny = js_min(miny, y);
      minz = js_min(minz, z);
      maxx = js_max(maxx, x);
      maxy = js_max(maxy, y);
      maxz = js_max(maxz, z);
    }
    prim_bounds[i * 6] = minx;
    prim_bounds[i * 6 + 1] = miny;
    prim_bounds[i * 6 + 2] = minz;
    prim_bounds[i * 6 + 3] = maxx;
    prim_bounds[i * 6 + 4] = maxy;
    prim_bounds[i * 6 + 5] = maxz;
    centroids[i * 3] = (minx + maxx) / 2.0;
    centroids[i * 3 + 1] = (miny + maxy) / 2.0;
    centroids[i * 3 + 2] = (minz + maxz) / 2.0;
  }
  build_bvh(prim_bounds, centroids)
}

struct Builder<'a> {
  prim_bounds: &'a [f64],
  centroids: &'a [f64],
  order: Vec<u32>,
  bounds: Vec<f64>,
  left: Vec<i32>,
  right: Vec<i32>,
  start: Vec<i32>,
  count: Vec<i32>,
  node_count: usize,
}

fn build_bvh(prim_bounds: Vec<f64>, centroids: Vec<f64>) -> Bvh {
  let n = prim_bounds.len() / 6;
  let order: Vec<u32> = (0..n as u32).collect();
  let cap = 2 * n.div_ceil(MAX_LEAF) * 2 + 1;
  let cap = cap.max(1);
  let mut b = Builder { prim_bounds: &prim_bounds, centroids: &centroids, order, bounds: vec![0.0; cap * 6], left: vec![-1; cap], right: vec![-1; cap], start: vec![0; cap], count: vec![0; cap], node_count: 0 };
  if n > 0 {
    b.build(0, n);
  } else {
    b.node_count = 1;
    b.bounds[..6].copy_from_slice(&[f64::INFINITY, f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY]);
  }
  let Builder { order, bounds, left, right, start, count, .. } = b;
  Bvh { bounds, left, right, start, count, order, prim_bounds }
}

impl Builder<'_> {
  /// Make the node for `order[s..e)`: a leaf (`None`) or an inner node split at the returned index.
  fn enter(&mut self, s: usize, e: usize) -> Option<usize> {
    let node = self.node_count;
    self.node_count += 1;
    let (mut minx, mut miny, mut minz) = (f64::INFINITY, f64::INFINITY, f64::INFINITY);
    let (mut maxx, mut maxy, mut maxz) = (f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    let (mut cminx, mut cminy, mut cminz) = (f64::INFINITY, f64::INFINITY, f64::INFINITY);
    let (mut cmaxx, mut cmaxy, mut cmaxz) = (f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for i in s..e {
      let (p, c) = (self.order[i] as usize * 6, self.order[i] as usize * 3);
      minx = js_min(minx, self.prim_bounds[p]);
      miny = js_min(miny, self.prim_bounds[p + 1]);
      minz = js_min(minz, self.prim_bounds[p + 2]);
      maxx = js_max(maxx, self.prim_bounds[p + 3]);
      maxy = js_max(maxy, self.prim_bounds[p + 4]);
      maxz = js_max(maxz, self.prim_bounds[p + 5]);
      cminx = js_min(cminx, self.centroids[c]);
      cminy = js_min(cminy, self.centroids[c + 1]);
      cminz = js_min(cminz, self.centroids[c + 2]);
      cmaxx = js_max(cmaxx, self.centroids[c]);
      cmaxy = js_max(cmaxy, self.centroids[c + 1]);
      cmaxz = js_max(cmaxz, self.centroids[c + 2]);
    }
    let b = node * 6;
    self.bounds[b] = minx;
    self.bounds[b + 1] = miny;
    self.bounds[b + 2] = minz;
    self.bounds[b + 3] = maxx;
    self.bounds[b + 4] = maxy;
    self.bounds[b + 5] = maxz;
    let len = e - s;
    let (ex, ey, ez) = (cmaxx - cminx, cmaxy - cminy, cmaxz - cminz);
    if len <= MAX_LEAF || (ex == 0.0 && ey == 0.0 && ez == 0.0) {
      self.start[node] = s as i32;
      self.count[node] = len as i32;
      return None;
    }
    let axis = if ex >= ey && ex >= ez {
      0
    } else if ey >= ez {
      1
    } else {
      2
    };
    let mid = s + (len >> 1);
    select_nth(&mut self.order, s, e, mid, self.centroids, axis);
    self.count[node] = 0;
    Some(mid)
  }

  fn build(&mut self, s: usize, e: usize) -> usize {
    let node = self.node_count;
    let mid = self.enter(s, e);
    if let Some(mid) = mid {
      self.left[node] = self.build(s, mid) as i32;
      self.right[node] = self.build(mid, e) as i32;
    }
    node
  }
}

/// Reorder `order[s..e)` so `order[k]` holds the primitive whose centroid would sort there along `axis` (quickselect
/// with Hoare partitioning).
fn select_nth(order: &mut [u32], s: usize, e: usize, k: usize, centroids: &[f64], axis: usize) {
  let key = |order: &[u32], i: usize| centroids[order[i] as usize * 3 + axis];
  let (mut lo, mut hi) = (s as isize, e as isize - 1);
  let k = k as isize;
  while hi > lo {
    let (a, m, z) = (key(order, lo as usize), key(order, ((lo + hi) >> 1) as usize), key(order, hi as usize));
    let pivot = if a < m {
      if m < z {
        m
      } else if a < z {
        z
      } else {
        a
      }
    } else if a < z {
      a
    } else if m < z {
      z
    } else {
      m
    };
    let (mut i, mut j) = (lo, hi);
    while i <= j {
      while key(order, i as usize) < pivot {
        i += 1;
      }
      while key(order, j as usize) > pivot {
        j -= 1;
      }
      if i <= j {
        order.swap(i as usize, j as usize);
        i += 1;
        j -= 1;
      }
    }
    if k <= j {
      hi = j;
    } else if k >= i {
      lo = i;
    } else {
      return;
    }
  }
}

/// `queryBVHBox`: triangle ids whose bounds overlap the box, in the tree's traversal order.
pub fn query_box(bvh: &Bvh, min: Vec3, max: Vec3) -> Vec<u32> {
  let mut out = Vec::new();
  let mut stack = vec![0usize];
  while let Some(node) = stack.pop() {
    let b = node * 6;
    if bvh.bounds[b] > max[0] || bvh.bounds[b + 3] < min[0] || bvh.bounds[b + 1] > max[1] || bvh.bounds[b + 4] < min[1] || bvh.bounds[b + 2] > max[2] || bvh.bounds[b + 5] < min[2] {
      continue;
    }
    if bvh.count[node] > 0 {
      let s = bvh.start[node] as usize;
      let e = s + bvh.count[node] as usize;
      for i in s..e {
        let id = bvh.order[i];
        let p = id as usize * 6;
        let pb = &bvh.prim_bounds;
        if pb[p] > max[0] || pb[p + 3] < min[0] || pb[p + 1] > max[1] || pb[p + 4] < min[1] || pb[p + 2] > max[2] || pb[p + 5] < min[2] {
          continue;
        }
        out.push(id);
      }
    } else {
      stack.push(bvh.left[node] as usize);
      stack.push(bvh.right[node] as usize);
    }
  }
  out
}
