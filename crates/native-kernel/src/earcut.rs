// SPDX-License-Identifier: ISC
// Port of earcut 3.2.4 (https://github.com/mapbox/earcut), Copyright (c) 2016-2026 Mapbox.
// Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby
// granted, provided that the above copyright notice and this permission notice appear in all copies. THE SOFTWARE IS
// PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED
// WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT,
// OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION
// OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
// THIS SOFTWARE.
//! Polygon triangulation, a statement-for-statement port of the `earcut` JavaScript library: same node order, same
//! z-order hash, same hole bridging, so it returns the same triangles for the same input. Only the dimensionless
//! 2-coordinate form the kernel uses is kept.
use std::collections::HashSet;

use crate::math::{js_max, js_max3, js_min, js_min3, to_int32};

const NIL: u32 = u32::MAX;

#[derive(Clone, Copy)]
struct Node {
  i: u32,
  x: f64,
  y: f64,
  prev: u32,
  next: u32,
  z: i32,
  prev_z: u32,
  next_z: u32,
}

/// Edges per block of the hole-bridge index.
const K: usize = 16;

struct Earcut {
  nodes: Vec<Node>,
  steiners: HashSet<u32>,
  filtered_out: bool,
  index_active: bool,
  block_bbox: Vec<f64>,
  num_blocks: usize,
  block_head: Vec<u32>,
  block_stop: Vec<u32>,
  triangles: Vec<u32>,
  sort_arr: Vec<u32>,
}

/// Triangles as triplets of vertex indices into `data`, flat (x, y) pairs. `hole_indices` are vertex indices.
pub fn earcut(data: &[f64], hole_indices: &[usize]) -> Vec<u32> {
  let has_holes = !hole_indices.is_empty();
  let outer_len = if has_holes { hole_indices[0] * 2 } else { data.len() };
  let mut e = Earcut {
    nodes: Vec::with_capacity(data.len() / 2),
    steiners: HashSet::new(),
    filtered_out: false,
    index_active: false,
    block_bbox: Vec::new(),
    num_blocks: 0,
    block_head: Vec::new(),
    block_stop: Vec::new(),
    triangles: Vec::new(),
    sort_arr: Vec::new(),
  };
  let Some(mut outer_node) = e.linked_list(data, 0, outer_len, true) else { return e.triangles };
  if e.next(outer_node) == e.prev(outer_node) {
    return e.triangles;
  }
  let (mut min_x, mut min_y, mut inv_size) = (0.0, 0.0, 0.0);
  if has_holes {
    outer_node = e.eliminate_holes(data, hole_indices, outer_node);
  }
  if data.len() > 80 * 2 {
    min_x = data[0];
    min_y = data[1];
    let (mut max_x, mut max_y) = (min_x, min_y);
    let mut i = 2;
    while i < outer_len {
      let (x, y) = (data[i], data[i + 1]);
      if x < min_x {
        min_x = x;
      }
      if y < min_y {
        min_y = y;
      }
      if x > max_x {
        max_x = x;
      }
      if y > max_y {
        max_y = y;
      }
      i += 2;
    }
    inv_size = js_max(max_x - min_x, max_y - min_y);
    inv_size = if inv_size != 0.0 { 32767.0 / inv_size } else { 0.0 };
  }
  e.earcut_linked(outer_node, min_x, min_y, inv_size);
  e.triangles
}

fn inv_truthy(inv_size: f64) -> bool {
  inv_size != 0.0 && !inv_size.is_nan()
}

fn z_order(x: f64, y: f64, min_x: f64, min_y: f64, inv_size: f64) -> i32 {
  let mut x = to_int32((x - min_x) * inv_size);
  let mut y = to_int32((y - min_y) * inv_size);
  x = (x | (x << 8)) & 0x00FF00FF;
  x = (x | (x << 4)) & 0x0F0F0F0F;
  x = (x | (x << 2)) & 0x33333333;
  x = (x | (x << 1)) & 0x55555555;
  y = (y | (y << 8)) & 0x00FF00FF;
  y = (y | (y << 4)) & 0x0F0F0F0F;
  y = (y | (y << 2)) & 0x33333333;
  y = (y | (y << 1)) & 0x55555555;
  x | (y << 1)
}

fn point_in_triangle(ax: f64, ay: f64, bx: f64, by: f64, cx: f64, cy: f64, px: f64, py: f64) -> bool {
  (cx - px) * (ay - py) >= (ax - px) * (cy - py) && (ax - px) * (by - py) >= (bx - px) * (ay - py) && (bx - px) * (cy - py) >= (cx - px) * (by - py)
}

fn signed_area(data: &[f64], start: usize, end: usize) -> f64 {
  let mut sum = 0.0;
  let mut j = end.wrapping_sub(2);
  let mut i = start;
  while i < end {
    sum += (data[j] - data[i]) * (data[i + 1] + data[j + 1]);
    j = i;
    i += 2;
  }
  sum
}

impl Earcut {
  fn n(&self, id: u32) -> &Node {
    &self.nodes[id as usize]
  }
  fn x(&self, id: u32) -> f64 {
    self.n(id).x
  }
  fn y(&self, id: u32) -> f64 {
    self.n(id).y
  }
  fn i(&self, id: u32) -> u32 {
    self.n(id).i
  }
  fn prev(&self, id: u32) -> u32 {
    self.n(id).prev
  }
  fn next(&self, id: u32) -> u32 {
    self.n(id).next
  }

  fn create_node(&mut self, i: u32, x: f64, y: f64) -> u32 {
    let id = self.nodes.len() as u32;
    self.nodes.push(Node { i, x, y, prev: NIL, next: NIL, z: 0, prev_z: NIL, next_z: NIL });
    id
  }

  fn insert_node(&mut self, i: u32, x: f64, y: f64, last: Option<u32>) -> u32 {
    let p = self.create_node(i, x, y);
    match last {
      None => {
        self.nodes[p as usize].prev = p;
        self.nodes[p as usize].next = p;
      }
      Some(last) => {
        let last_next = self.next(last);
        self.nodes[p as usize].next = last_next;
        self.nodes[p as usize].prev = last;
        self.nodes[last_next as usize].prev = p;
        self.nodes[last as usize].next = p;
      }
    }
    p
  }

  fn remove_node(&mut self, p: u32) {
    let (prev, next, prev_z, next_z) = {
      let node = self.n(p);
      (node.prev, node.next, node.prev_z, node.next_z)
    };
    self.nodes[next as usize].prev = prev;
    self.nodes[prev as usize].next = next;
    if prev_z != NIL {
      self.nodes[prev_z as usize].next_z = next_z;
    }
    if next_z != NIL {
      self.nodes[next_z as usize].prev_z = prev_z;
    }
    if self.index_active {
      self.grow_block(prev, next);
    }
  }

  fn area(&self, p: u32, q: u32, r: u32) -> f64 {
    let (p, q, r) = (self.n(p), self.n(q), self.n(r));
    (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y)
  }

  fn equals(&self, a: u32, b: u32) -> bool {
    let (a, b) = (self.n(a), self.n(b));
    a.x == b.x && a.y == b.y
  }

  fn linked_list(&mut self, data: &[f64], start: usize, end: usize, clockwise: bool) -> Option<u32> {
    let mut last = None;
    if clockwise == (signed_area(data, start, end) > 0.0) {
      let mut i = start;
      while i < end {
        last = Some(self.insert_node((i / 2) as u32, data[i], data[i + 1], last));
        i += 2;
      }
    } else if end >= 2 {
      let mut i = end - 2;
      loop {
        if i < start {
          break;
        }
        last = Some(self.insert_node((i / 2) as u32, data[i], data[i + 1], last));
        if i < 2 {
          break;
        }
        i -= 2;
      }
    }
    if let Some(l) = last {
      if self.equals(l, self.next(l)) {
        self.remove_node(l);
        last = Some(self.next(l));
      }
    }
    last
  }

  fn filter_points(&mut self, start: u32, end: Option<u32>) -> u32 {
    let mut end = end.unwrap_or(start);
    let full = end == start;
    let mut p = start;
    loop {
      let mut again = false;
      let next = self.next(p);
      if p != next && (self.steiners.is_empty() || !self.steiners.contains(&p)) && (self.equals(p, next) || self.area(self.prev(p), p, next) == 0.0) {
        if full || p == end {
          end = self.prev(p);
        }
        self.filtered_out = true;
        self.remove_node(p);
        p = self.prev(p);
        again = true;
      } else if full || p != end {
        p = self.next(p);
        again = !full;
      }
      if !(again || p != end) {
        break;
      }
    }
    end
  }

  fn earcut_linked(&mut self, mut ear: u32, min_x: f64, min_y: f64, inv_size: f64) {
    if inv_truthy(inv_size) {
      self.index_curve(ear, min_x, min_y, inv_size);
    }
    let mut stop = ear;
    let mut cured = false;
    while self.prev(ear) != self.next(ear) {
      let prev = self.prev(ear);
      let next = self.next(ear);
      if self.area(prev, ear, next) < 0.0 && (if inv_truthy(inv_size) { self.is_ear_hashed(ear, min_x, min_y, inv_size) } else { self.is_ear(ear) }) {
        let (a, b, c) = (self.i(prev), self.i(ear), self.i(next));
        self.triangles.extend_from_slice(&[a, b, c]);
        self.remove_node(ear);
        ear = next;
        stop = next;
        continue;
      }
      ear = next;
      if ear == stop {
        self.filtered_out = false;
        ear = self.filter_points(ear, None);
        if self.filtered_out {
          stop = ear;
          continue;
        }
        if !cured {
          ear = self.cure_local_intersections(ear);
          stop = ear;
          cured = true;
          continue;
        }
        self.split_earcut(ear, min_x, min_y, inv_size);
        break;
      }
    }
  }

  fn is_ear(&self, ear: u32) -> bool {
    let (a, b, c) = (self.prev(ear), ear, self.next(ear));
    let (ax, bx, cx, ay, by, cy) = (self.x(a), self.x(b), self.x(c), self.y(a), self.y(b), self.y(c));
    let (x0, y0, x1, y1) = (js_min3(ax, bx, cx), js_min3(ay, by, cy), js_max3(ax, bx, cx), js_max3(ay, by, cy));
    let mut p = self.next(c);
    while p != a {
      let (px, py) = (self.x(p), self.y(p));
      if px >= x0 && px <= x1 && py >= y0 && py <= y1 && !(ax == px && ay == py) && point_in_triangle(ax, ay, bx, by, cx, cy, px, py) && self.area(self.prev(p), p, self.next(p)) >= 0.0 {
        return false;
      }
      p = self.next(p);
    }
    true
  }

  fn is_ear_hashed(&self, ear: u32, min_x: f64, min_y: f64, inv_size: f64) -> bool {
    let (a, b, c) = (self.prev(ear), ear, self.next(ear));
    let (ax, bx, cx, ay, by, cy) = (self.x(a), self.x(b), self.x(c), self.y(a), self.y(b), self.y(c));
    let (x0, y0, x1, y1) = (js_min3(ax, bx, cx), js_min3(ay, by, cy), js_max3(ax, bx, cx), js_max3(ay, by, cy));
    let min_z = z_order(x0, y0, min_x, min_y, inv_size);
    let max_z = z_order(x1, y1, min_x, min_y, inv_size);
    let mut p = self.n(ear).prev_z;
    while p != NIL && self.n(p).z >= min_z {
      let (px, py) = (self.x(p), self.y(p));
      if px >= x0 && px <= x1 && py >= y0 && py <= y1 && p != c && !(ax == px && ay == py) && point_in_triangle(ax, ay, bx, by, cx, cy, px, py) && self.area(self.prev(p), p, self.next(p)) >= 0.0 {
        return false;
      }
      p = self.n(p).prev_z;
    }
    let mut n = self.n(ear).next_z;
    while n != NIL && self.n(n).z <= max_z {
      let (nx, ny) = (self.x(n), self.y(n));
      if nx >= x0 && nx <= x1 && ny >= y0 && ny <= y1 && n != c && !(ax == nx && ay == ny) && point_in_triangle(ax, ay, bx, by, cx, cy, nx, ny) && self.area(self.prev(n), n, self.next(n)) >= 0.0 {
        return false;
      }
      n = self.n(n).next_z;
    }
    true
  }

  fn cure_local_intersections(&mut self, start: u32) -> u32 {
    let mut start = start;
    let mut p = start;
    let mut cured = false;
    loop {
      let a = self.prev(p);
      let b = self.next(self.next(p));
      if self.intersects(a, p, self.next(p), b, false) && self.locally_inside(a, b) && self.locally_inside(b, a) {
        let (ai, pi, bi) = (self.i(a), self.i(p), self.i(b));
        self.triangles.extend_from_slice(&[ai, pi, bi]);
        self.remove_node(p);
        let pn = self.next(p);
        self.remove_node(pn);
        p = b;
        start = b;
        cured = true;
      }
      p = self.next(p);
      if p == start {
        break;
      }
    }
    if cured { self.filter_points(p, None) } else { p }
  }

  fn split_earcut(&mut self, start: u32, min_x: f64, min_y: f64, inv_size: f64) {
    let mut a = start;
    loop {
      let mut b = self.next(self.next(a));
      while b != self.prev(a) {
        if self.i(a) != self.i(b) && self.is_valid_diagonal(a, b) {
          let mut c = self.split_polygon(a, b);
          let a_next = self.next(a);
          a = self.filter_points(a, Some(a_next));
          let c_next = self.next(c);
          c = self.filter_points(c, Some(c_next));
          self.earcut_linked(a, min_x, min_y, inv_size);
          self.earcut_linked(c, min_x, min_y, inv_size);
          return;
        }
        b = self.next(b);
      }
      a = self.next(a);
      if a == start {
        break;
      }
    }
  }

  fn eliminate_holes(&mut self, data: &[f64], hole_indices: &[usize], outer_node: u32) -> u32 {
    let mut queue: Vec<u32> = Vec::with_capacity(hole_indices.len());
    for (i, &hole) in hole_indices.iter().enumerate() {
      let start = hole * 2;
      let end = if i + 1 < hole_indices.len() { hole_indices[i + 1] * 2 } else { data.len() };
      let list = self.linked_list(data, start, end, false).expect("a hole ring has vertices");
      if list == self.next(list) {
        self.steiners.insert(list);
      }
      queue.push(self.get_leftmost(list));
    }
    // Stable, like Array.prototype.sort; a comparator result of NaN counts as equal.
    queue.sort_by(|&a, &b| {
      let d = self.compare_x_y_slope(a, b);
      if d > 0.0 {
        std::cmp::Ordering::Greater
      } else if d < 0.0 {
        std::cmp::Ordering::Less
      } else {
        std::cmp::Ordering::Equal
      }
    });
    self.build_block_index(data.len() / 2, hole_indices.len());
    self.index_segment(outer_node, outer_node);
    self.index_active = true;
    let mut outer_node = outer_node;
    for &hole in &queue {
      outer_node = self.eliminate_hole(hole, outer_node);
    }
    self.index_active = false;
    self.filter_points(outer_node, None)
  }

  fn compare_x_y_slope(&self, a: u32, b: u32) -> f64 {
    let (na, nb) = (self.n(a), self.n(b));
    let dx = na.x - nb.x;
    if dx != 0.0 && !dx.is_nan() {
      return dx;
    }
    let dy = na.y - nb.y;
    if dy != 0.0 && !dy.is_nan() {
      return dy;
    }
    let (ana, anb) = (self.n(na.next), self.n(nb.next));
    (ana.y - na.y) / (ana.x - na.x) - (anb.y - nb.y) / (anb.x - nb.x)
  }

  fn eliminate_hole(&mut self, hole: u32, outer_node: u32) -> u32 {
    let Some(bridge) = self.find_hole_bridge(hole, outer_node) else { return outer_node };
    let bridge_reverse = self.split_polygon(bridge, hole);
    let bridge2 = self.next(bridge_reverse);
    let stop = self.next(bridge2);
    self.index_segment(bridge, stop);
    let br_next = self.next(bridge_reverse);
    self.filter_points(bridge_reverse, Some(br_next));
    let b_next = self.next(bridge);
    self.filter_points(bridge, Some(b_next))
  }

  fn build_block_index(&mut self, max_nodes: usize, num_holes: usize) {
    let max_blocks = ((max_nodes as f64 + 2.0 * num_holes as f64) / K as f64).ceil() as usize + num_holes + 2;
    if self.block_bbox.len() < max_blocks * 4 {
      self.block_bbox.resize(max_blocks * 4, 0.0);
    }
    self.num_blocks = 0;
  }

  fn set_block_head(&mut self, b: usize, p: u32) {
    if b == self.block_head.len() {
      self.block_head.push(p);
      self.block_stop.push(p);
    } else {
      self.block_head[b] = p;
    }
  }

  fn index_segment(&mut self, head: u32, stop: u32) {
    let mut p = head;
    loop {
      let b = self.num_blocks;
      self.num_blocks += 1;
      self.set_block_head(b, p);
      let (mut min_x, mut min_y, mut max_x, mut max_y) = (self.x(p), self.y(p), self.x(p), self.y(p));
      let mut k = 0;
      loop {
        let c = self.next(p);
        self.nodes[p as usize].z = b as i32;
        let (cx, cy) = (self.x(c), self.y(c));
        if cx < min_x {
          min_x = cx;
        }
        if cx > max_x {
          max_x = cx;
        }
        if cy < min_y {
          min_y = cy;
        }
        if cy > max_y {
          max_y = cy;
        }
        p = c;
        k += 1;
        if !(k < K && p != stop) {
          break;
        }
      }
      self.block_stop[b] = p;
      let g = b * 4;
      self.block_bbox[g] = min_x;
      self.block_bbox[g + 1] = min_y;
      self.block_bbox[g + 2] = max_x;
      self.block_bbox[g + 3] = max_y;
      if p == stop {
        break;
      }
    }
  }

  fn grow_block(&mut self, head: u32, tail: u32) {
    let g = (self.n(head).z as usize) * 4;
    let (tx, ty) = (self.x(tail), self.y(tail));
    if tx < self.block_bbox[g] {
      self.block_bbox[g] = tx;
    }
    if ty < self.block_bbox[g + 1] {
      self.block_bbox[g + 1] = ty;
    }
    if tx > self.block_bbox[g + 2] {
      self.block_bbox[g + 2] = tx;
    }
    if ty > self.block_bbox[g + 3] {
      self.block_bbox[g + 3] = ty;
    }
  }

  fn live_block_stop(&mut self, b: usize) -> u32 {
    let mut stop = self.block_stop[b];
    while self.next(self.prev(stop)) != stop {
      stop = self.next(stop);
    }
    self.block_stop[b] = stop;
    stop
  }

  fn live_block_head(&mut self, b: usize) -> u32 {
    let mut head = self.block_head[b];
    while self.next(self.prev(head)) != head {
      head = self.next(head);
    }
    self.block_head[b] = head;
    head
  }

  fn find_hole_bridge(&mut self, hole: u32, outer_node: u32) -> Option<u32> {
    let mut p = outer_node;
    let (hx, hy) = (self.x(hole), self.y(hole));
    let mut qx = f64::NEG_INFINITY;
    let mut m: Option<u32> = None;
    if self.equals(hole, p) {
      return Some(p);
    }
    for b in 0..self.num_blocks {
      let g = b * 4;
      if hy < self.block_bbox[g + 1] || hy > self.block_bbox[g + 3] || self.block_bbox[g] > hx || self.block_bbox[g + 2] <= qx {
        continue;
      }
      let stop = self.live_block_stop(b);
      p = self.live_block_head(b);
      loop {
        if self.next(self.prev(p)) == p {
          let next = self.next(p);
          if self.equals(hole, next) {
            return Some(next);
          } else if hy <= self.y(p) && hy >= self.y(next) && self.y(next) != self.y(p) {
            let x = self.x(p) + (hy - self.y(p)) * (self.x(next) - self.x(p)) / (self.y(next) - self.y(p));
            if x <= hx && x > qx {
              qx = x;
              let chosen = if self.x(p) < self.x(next) { p } else { next };
              m = Some(chosen);
              if x == hx {
                return Some(chosen);
              }
            }
          }
        }
        p = self.next(p);
        if p == stop {
          break;
        }
      }
    }
    let mut m = m?;
    let (mx, my) = (self.x(m), self.y(m));
    let tmin_y = js_min(hy, my);
    let tmax_y = js_max(hy, my);
    let mut tan_min = f64::INFINITY;
    for b in 0..self.num_blocks {
      let g = b * 4;
      if self.block_bbox[g + 2] < mx || self.block_bbox[g] > hx || self.block_bbox[g + 3] < tmin_y || self.block_bbox[g + 1] > tmax_y {
        continue;
      }
      let stop = self.live_block_stop(b);
      p = self.live_block_head(b);
      loop {
        let (px, py) = (self.x(p), self.y(p));
        if self.next(self.prev(p)) == p && hx >= px && px >= mx && hx != px && point_in_triangle(if hy < my { hx } else { qx }, hy, mx, my, if hy < my { qx } else { hx }, hy, px, py) {
          let tan = (hy - py).abs() / (hx - px);
          let next = self.next(p);
          if (self.locally_inside(p, hole) || (py == hy && self.y(next) == hy && self.x(next) > hx)) && (tan < tan_min || (tan == tan_min && (px > self.x(m) || (px == self.x(m) && self.sector_contains_sector(m, p))))) {
            m = p;
            tan_min = tan;
          }
        }
        p = self.next(p);
        if p == stop {
          break;
        }
      }
    }
    Some(m)
  }

  fn sector_contains_sector(&self, m: u32, p: u32) -> bool {
    self.area(self.prev(m), m, self.prev(p)) < 0.0 && self.area(self.next(p), m, self.next(m)) < 0.0
  }

  fn index_curve(&mut self, start: u32, min_x: f64, min_y: f64, inv_size: f64) {
    self.sort_arr.clear();
    let mut p = start;
    loop {
      let (px, py) = (self.x(p), self.y(p));
      self.nodes[p as usize].z = z_order(px, py, min_x, min_y, inv_size);
      self.sort_arr.push(p);
      p = self.next(p);
      if p == start {
        break;
      }
    }
    let n = self.sort_arr.len();
    self.sort_nodes(n);
    let mut prev = NIL;
    for i in 0..n {
      let node = self.sort_arr[i];
      self.nodes[node as usize].prev_z = prev;
      if prev != NIL {
        self.nodes[prev as usize].next_z = node;
      }
      prev = node;
    }
    self.nodes[prev as usize].next_z = NIL;
  }

  fn sort_nodes(&mut self, n: usize) {
    if n <= 32 {
      for i in 1..n {
        let node = self.sort_arr[i];
        let z = self.n(node).z;
        let mut j = i as isize - 1;
        while j >= 0 && self.n(self.sort_arr[j as usize]).z > z {
          self.sort_arr[(j + 1) as usize] = self.sort_arr[j as usize];
          j -= 1;
        }
        self.sort_arr[(j + 1) as usize] = node;
      }
      return;
    }
    let mut z_arr: Vec<u32> = self.sort_arr.iter().map(|&node| self.n(node).z as u32).collect();
    let mut z_buf = vec![0u32; n];
    let mut sort_buf = vec![0u32; n];
    let mut counts = [0u32; 256];
    radix_pass(n, &self.sort_arr, &z_arr, &mut sort_buf, &mut z_buf, 0, &mut counts);
    radix_pass(n, &sort_buf, &z_buf, &mut self.sort_arr, &mut z_arr, 8, &mut counts);
    radix_pass(n, &self.sort_arr, &z_arr, &mut sort_buf, &mut z_buf, 16, &mut counts);
    radix_pass(n, &sort_buf, &z_buf, &mut self.sort_arr, &mut z_arr, 24, &mut counts);
  }

  fn get_leftmost(&self, start: u32) -> u32 {
    let mut p = start;
    let mut leftmost = start;
    loop {
      let (px, py) = (self.x(p), self.y(p));
      let (lx, ly) = (self.x(leftmost), self.y(leftmost));
      if px < lx || (px == lx && py < ly) {
        leftmost = p;
      }
      p = self.next(p);
      if p == start {
        break;
      }
    }
    leftmost
  }

  fn is_valid_diagonal(&self, a: u32, b: u32) -> bool {
    let zero_length = self.equals(a, b) && self.area(self.prev(a), a, self.next(a)) > 0.0 && self.area(self.prev(b), b, self.next(b)) > 0.0;
    self.i(self.next(a)) != self.i(b)
      && (zero_length || self.locally_inside(a, b) && self.locally_inside(b, a) && (self.area(self.prev(a), a, self.prev(b)) != 0.0 || self.area(a, self.prev(b), b) != 0.0))
      && !self.intersects_polygon(a, b)
      && (zero_length || self.middle_inside(a, b))
  }

  fn intersects(&self, p1: u32, q1: u32, p2: u32, q2: u32, include_boundary: bool) -> bool {
    let o1 = self.area(p1, q1, p2);
    let o2 = self.area(p1, q1, q2);
    let o3 = self.area(p2, q2, p1);
    let o4 = self.area(p2, q2, q1);
    if ((o1 > 0.0 && o2 < 0.0) || (o1 < 0.0 && o2 > 0.0)) && ((o3 > 0.0 && o4 < 0.0) || (o3 < 0.0 && o4 > 0.0)) {
      return true;
    }
    if !include_boundary {
      return false;
    }
    (o1 == 0.0 && self.on_segment(p1, p2, q1)) || (o2 == 0.0 && self.on_segment(p1, q2, q1)) || (o3 == 0.0 && self.on_segment(p2, p1, q2)) || (o4 == 0.0 && self.on_segment(p2, q1, q2))
  }

  fn on_segment(&self, p: u32, q: u32, r: u32) -> bool {
    let (px, py, qx, qy, rx, ry) = (self.x(p), self.y(p), self.x(q), self.y(q), self.x(r), self.y(r));
    qx <= js_max(px, rx) && qx >= js_min(px, rx) && qy <= js_max(py, ry) && qy >= js_min(py, ry)
  }

  fn intersects_polygon(&self, a: u32, b: u32) -> bool {
    let (min_x, max_x, min_y, max_y) = (js_min(self.x(a), self.x(b)), js_max(self.x(a), self.x(b)), js_min(self.y(a), self.y(b)), js_max(self.y(a), self.y(b)));
    let mut p = a;
    loop {
      let n = self.next(p);
      let (px, py, nx, ny) = (self.x(p), self.y(p), self.x(n), self.y(n));
      let outside = (px > max_x && nx > max_x) || (px < min_x && nx < min_x) || (py > max_y && ny > max_y) || (py < min_y && ny < min_y);
      if !outside && self.i(p) != self.i(a) && self.i(n) != self.i(a) && self.i(p) != self.i(b) && self.i(n) != self.i(b) && self.intersects(p, n, a, b, true) {
        return true;
      }
      p = n;
      if p == a {
        break;
      }
    }
    false
  }

  fn locally_inside(&self, a: u32, b: u32) -> bool {
    let (prev, next) = (self.prev(a), self.next(a));
    if self.area(prev, a, next) < 0.0 { self.area(a, b, next) >= 0.0 && self.area(a, prev, b) >= 0.0 } else { self.area(a, b, prev) < 0.0 || self.area(a, next, b) < 0.0 }
  }

  fn middle_inside(&self, a: u32, b: u32) -> bool {
    let mut p = a;
    let mut inside = false;
    let (px, py) = ((self.x(a) + self.x(b)) / 2.0, (self.y(a) + self.y(b)) / 2.0);
    loop {
      let n = self.next(p);
      let (x, y, nx, ny) = (self.x(p), self.y(p), self.x(n), self.y(n));
      if ((y > py) != (ny > py)) && (px < (nx - x) * (py - y) / (ny - y) + x) {
        inside = !inside;
      }
      p = n;
      if p == a {
        break;
      }
    }
    inside
  }

  fn split_polygon(&mut self, a: u32, b: u32) -> u32 {
    let a2 = self.create_node(self.i(a), self.x(a), self.y(a));
    let b2 = self.create_node(self.i(b), self.x(b), self.y(b));
    let an = self.next(a);
    let bp = self.prev(b);
    self.nodes[a as usize].next = b;
    self.nodes[b as usize].prev = a;
    self.nodes[a2 as usize].next = an;
    self.nodes[an as usize].prev = a2;
    self.nodes[b2 as usize].next = a2;
    self.nodes[a2 as usize].prev = b2;
    self.nodes[bp as usize].next = b2;
    self.nodes[b2 as usize].prev = bp;
    b2
  }
}

fn radix_pass(n: usize, src: &[u32], src_z: &[u32], dst: &mut [u32], dst_z: &mut [u32], shift: u32, counts: &mut [u32; 256]) {
  counts.fill(0);
  for i in 0..n {
    counts[((src_z[i] >> shift) & 0xff) as usize] += 1;
  }
  let mut sum = 0;
  for count in counts.iter_mut() {
    let c = *count;
    *count = sum;
    sum += c;
  }
  for i in 0..n {
    let z = src_z[i];
    let bucket = ((z >> shift) & 0xff) as usize;
    let pos = counts[bucket] as usize;
    counts[bucket] += 1;
    dst[pos] = src[i];
    dst_z[pos] = z;
  }
}

#[cfg(test)]
mod tests {
  use super::earcut;

  #[test]
  fn triangulates_the_documented_example() {
    assert_eq!(earcut(&[10.0, 0.0, 0.0, 50.0, 60.0, 60.0, 70.0, 10.0], &[]), vec![1, 0, 3, 1, 3, 2]);
  }

  #[test]
  fn a_square_with_a_hole_gives_eight_triangles() {
    let data = [0.0, 0.0, 4.0, 0.0, 4.0, 4.0, 0.0, 4.0, 1.0, 1.0, 1.0, 3.0, 3.0, 3.0, 3.0, 1.0];
    assert_eq!(earcut(&data, &[4]).len(), 24);
  }
}
