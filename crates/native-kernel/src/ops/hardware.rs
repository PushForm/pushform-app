// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! Parametric cabinet hardware (knobs and pulls), a port of `hardware.ts`. Every solid is built from Manifold primitives
//! and booleans in the same order as the TypeScript, so the run ids and results come out identical. The request arrives
//! with its options already resolved and validated by the client (`resolveHardwareOptions`).
use std::cell::RefCell;
use std::rc::Rc;

use manifold_csg::{CrossSection, FillRule, Manifold};

use crate::finalize::{finalize_manifold, Component, FinalizeOptions};
use crate::jsmath::{atan2, cos, sin};
use crate::math::{hypot2, hypot3, js_min, Vec3};
use crate::meshio::{manifold_from_soup, soup_center, TriangleSoup};
use crate::normalize::all_new_ids;
use crate::KernelError;

/// `LENGTH_TOL ** 3`, spelled out so it is exactly the double the old check computed: below this volume the dimensions
/// produced no solid worth keeping.
const VOLUME_FLOOR: f64 = 9.999999999999999e-19;

pub struct HardwareRequest {
  pub shape: String,
  pub length: f64,
  pub width: f64,
  pub projection: f64,
  pub spacing: f64,
  pub grip: f64,
  pub wall: f64,
  pub segments: f64,
  pub next_face_id: f64,
}

pub struct HardwareOutput {
  pub components: Vec<Component>,
  pub next_face_id: f64,
  pub mounting_centers: Vec<Vec3>,
}

type Point = [f64; 2];

/// Builds the solid. Every intermediate Manifold stays alive until the build ends, as the TypeScript scope kept it: Manifold
/// flattens a chain of unions only while nothing else holds a link in it, and flattening changes the result's order.
struct Builder {
  n: i32,
  held: RefCell<Vec<Rc<Manifold>>>,
}

impl Builder {
  fn keep(&self, m: Manifold) -> Rc<Manifold> {
    let rc = Rc::new(m);
    self.held.borrow_mut().push(Rc::clone(&rc));
    rc
  }
  fn moved(&self, s: &Manifold, x: f64, y: f64, z: f64) -> Rc<Manifold> {
    self.keep(s.translate(x, y, z))
  }
  fn box_at(&self, x: f64, y: f64, z: f64, at: [f64; 3]) -> Rc<Manifold> {
    let cube = self.keep(Manifold::cube(x, y, z, true));
    self.moved(&cube, at[0], at[1], at[2])
  }
  fn cylinder(&self, radius: f64, height: f64, at: [f64; 3], sides: i32) -> Rc<Manifold> {
    let c = self.keep(Manifold::cylinder(height, radius, radius, sides, false));
    self.moved(&c, at[0], at[1], at[2])
  }
  fn sphere(&self, x: f64, y: f64, z: f64, at: [f64; 3]) -> Rc<Manifold> {
    let unit = self.keep(Manifold::sphere(1.0, self.n));
    let scaled = self.keep(unit.scale(x, y, z));
    self.moved(&scaled, at[0], at[1], at[2])
  }
  fn add(&self, a: &Manifold, b: &Manifold) -> Rc<Manifold> {
    self.keep(a.union(b))
  }
  fn sub(&self, a: &Manifold, b: &Manifold) -> Rc<Manifold> {
    self.keep(a.difference(b))
  }
  fn cut(&self, a: &Manifold, b: &Manifold) -> Rc<Manifold> {
    self.keep(a.intersection(b))
  }
  fn lathe(&self, points: Vec<Point>) -> Rc<Manifold> {
    self.keep(Manifold::revolve(&section(points), self.n, 360.0))
  }
  fn rod(&self, a: [f64; 3], b: [f64; 3], radius: f64) -> Rc<Manifold> {
    let d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let len = hypot3(d[0], d[1], d[2]);
    let yaw = (atan2(d[1], d[0]) * 180.0) / std::f64::consts::PI;
    let pitch = (atan2(hypot2(d[0], d[1]), d[2]) * 180.0) / std::f64::consts::PI;
    let c = self.keep(Manifold::cylinder(len, radius, radius, self.n, false));
    let turned = self.keep(c.rotate(0.0, pitch, yaw));
    self.moved(&turned, a[0], a[1], a[2])
  }
  fn extruded(&self, s: &CrossSection, height: f64, scale: f64) -> Rc<Manifold> {
    self.keep(Manifold::extrude_with_options(s, height, 0, 0.0, scale, scale))
  }
}

fn section(points: Vec<Point>) -> CrossSection {
  CrossSection::from_polygons_with_fill_rule(&[points], FillRule::Positive)
}

/// The corners of a rounded rectangle, quadrant by quadrant.
fn rounded(x: f64, y: f64, radius: f64) -> Vec<Point> {
  let mut points = Vec::new();
  for k in 0..4 {
    let cx = (if k == 0 || k == 3 { 1.0 } else { -1.0 }) * (x / 2.0 - radius);
    let cy = (if k < 2 { 1.0 } else { -1.0 }) * (y / 2.0 - radius);
    for i in 0..=6 {
      let angle = ((f64::from(k) + f64::from(i) / 6.0) * std::f64::consts::PI) / 2.0;
      points.push([cx + radius * cos(angle), cy + radius * sin(angle)]);
    }
  }
  points
}

/// A wire or arch grip as one lofted tube along `points`.
fn tube(points: &[[f64; 3]], n: i32, g: f64, w: f64, arch: bool) -> Result<Manifold, KernelError> {
  let n = n as usize;
  let (mut verts, mut tris) = (Vec::new(), Vec::new());
  for k in 0..points.len() {
    let a = points[k.saturating_sub(1)];
    let b = points[(k + 1).min(points.len() - 1)];
    let dx = b[0] - a[0];
    let dz = b[2] - a[2];
    let len = hypot2(dx, dz);
    for j in 0..n {
      let angle = ((j as f64) * 2.0 * std::f64::consts::PI) / n as f64;
      let across = (sin(angle) * g) / 2.0;
      verts.push(points[k][0] - (dz / len) * across);
      let taper = if arch { 0.6 + 0.4 * ((2.0 * k as f64) / (points.len() as f64 - 1.0) - 1.0).abs() } else { 1.0 };
      verts.push(((cos(angle) * w) / 2.0) * taper);
      verts.push(points[k][2] + (dx / len) * across);
    }
  }
  for k in 0..points.len() - 1 {
    for j in 0..n {
      let a = (k * n + j) as u32;
      let b = (k * n + (j + 1) % n) as u32;
      tris.extend_from_slice(&[a, b, b + n as u32, a, b + n as u32, a + n as u32]);
    }
  }
  for j in 1..n.saturating_sub(1) {
    let (j32, top) = (j as u32, ((points.len() - 1) * n) as u32);
    tris.extend_from_slice(&[0, j32 + 1, j32]);
    tris.extend_from_slice(&[top, top + j32, top + j32 + 1]);
  }
  let face_id = vec![0u32; tris.len() / 3];
  let soup = TriangleSoup { verts: &verts, tris: &tris, face_id: &face_id };
  manifold_from_soup(&soup, 0, soup_center(&verts))
}

pub fn hardware(req: &HardwareRequest) -> Result<HardwareOutput, KernelError> {
  let shape = req.shape.as_str();
  let (l, w, h, c, g, t) = (req.length, req.width, req.projection, req.spacing, req.grip, req.wall);
  let n = req.segments as i32;
  let b = Builder { n, held: RefCell::new(Vec::new()) };
  let mut mount: Vec<Vec3> = Vec::new();

  let two_posts = |grip: Rc<Manifold>, square: bool, mount: &mut Vec<Vec3>| -> Rc<Manifold> {
    mount.push([-c / 2.0, 0.0, 0.0]);
    mount.push([c / 2.0, 0.0, 0.0]);
    let mut made = grip;
    for x in [-c / 2.0, c / 2.0] {
      let post = if square { b.box_at(g, w, h - g / 3.0, [x, 0.0, (h - g / 3.0) / 2.0]) } else { b.cylinder(g * 0.42, h - g / 3.0, [x, 0.0, 0.0], n) };
      made = b.add(&made, &post);
    }
    made
  };

  let solid: Rc<Manifold> = if matches!(shape, "bar-round" | "bar-square" | "bridge") {
    let grip = if shape == "bar-square" { b.box_at(l, w, g, [0.0, 0.0, h - g / 2.0]) } else { b.rod([-l / 2.0, 0.0, h - g / 2.0], [l / 2.0, 0.0, h - g / 2.0], g / 2.0) };
    let mut solid = two_posts(grip, shape == "bar-square", &mut mount);
    if shape == "bridge" {
      for x in [-c / 2.0, c / 2.0] {
        solid = b.add(&solid, &b.cylinder(js_min(g * 0.8, w / 2.0), g * 0.2, [x, 0.0, 0.0], n));
        solid = b.add(&solid, &b.cylinder(js_min(g * 0.6, w / 2.0), g * 0.25, [x, 0.0, h - g * 1.25], n));
      }
    }
    solid
  } else if matches!(shape, "wire" | "arch") {
    mount.push([-c / 2.0, 0.0, 0.0]);
    mount.push([c / 2.0, 0.0, 0.0]);
    let mut points: Vec<[f64; 3]> = Vec::new();
    let arch = shape == "arch";
    if arch {
      for i in 0..=16 {
        let u = f64::from(i) / 16.0;
        points.push([-(l - g) / 2.0 + (l - g) * u, 0.0, g / 2.0 + (h - g) * sin(std::f64::consts::PI * u)]);
      }
    } else {
      let r = js_min(h / 2.0, c / 4.0);
      points.push([-c / 2.0, 0.0, g / 2.0]);
      points.push([-c / 2.0, 0.0, h - g / 2.0 - r]);
      for i in 1..=8 {
        let a = std::f64::consts::PI - (f64::from(i) * std::f64::consts::PI) / 16.0;
        points.push([-c / 2.0 + r + r * cos(a), 0.0, h - g / 2.0 - r + r * sin(a)]);
      }
      for i in 0..=8 {
        let a = std::f64::consts::PI / 2.0 - (f64::from(i) * std::f64::consts::PI) / 16.0;
        points.push([c / 2.0 - r + r * cos(a), 0.0, h - g / 2.0 - r + r * sin(a)]);
      }
      points.push([c / 2.0, 0.0, g / 2.0]);
    }
    let mut solid = b.keep(tube(&points, n, g, w, arch)?);
    if arch {
      let bounds = solid.bounding_box().expect("the lofted tube is not empty");
      let (min, max) = (bounds.min(), bounds.max());
      solid = b.keep(solid.scale(l / (max[0] - min[0]), 1.0, 1.0));
      for x in [-c / 2.0, c / 2.0] {
        let u = (x + (l - g) / 2.0) / (l - g);
        let z = g / 2.0 + (h - g) * sin(std::f64::consts::PI * u);
        solid = b.add(&solid, &b.cylinder(js_min(g, w) / 2.0, z + g / 3.0, [x, 0.0, 0.0], n));
      }
    } else {
      for x in [-c / 2.0, c / 2.0] {
        solid = b.add(&solid, &b.cylinder(g / 2.0, g, [x, 0.0, 0.0], n));
      }
    }
    solid
  } else if shape.starts_with("knob-") {
    mount.push([0.0, 0.0, 0.0]);
    let stem_h = h * 0.65;
    let head_h = h - stem_h;
    let stem = b.cylinder(js_min(g / 2.0, w / 4.0), stem_h + head_h / 2.0, [0.0, 0.0, 0.0], n);
    let head = match shape {
      "knob-ball" => b.sphere(w / 2.0, w / 2.0, w / 2.0, [0.0, 0.0, h - w / 2.0]),
      "knob-oval" => b.sphere(l / 2.0, w / 2.0, head_h, [0.0, 0.0, h - head_h]),
      "knob-t" => b.rod([-l / 2.0, 0.0, h - g / 2.0], [l / 2.0, 0.0, h - g / 2.0], g / 2.0),
      "knob-t-square" => b.box_at(l, w, g, [0.0, 0.0, h - g / 2.0]),
      "knob-square" | "knob-pyramid" => {
        let outline = vec![[-l / 2.0, -w / 2.0], [l / 2.0, -w / 2.0], [l / 2.0, w / 2.0], [-l / 2.0, w / 2.0]];
        let scale = if shape == "knob-pyramid" { 0.4 } else { 1.0 };
        let extruded = b.extruded(&section(outline), head_h, scale);
        b.moved(&extruded, 0.0, 0.0, stem_h)
      }
      "knob-hex" | "knob-octagon" => {
        let sides: i32 = if shape == "knob-hex" { 6 } else { 8 };
        b.cylinder(w / (2.0 * cos(std::f64::consts::PI / f64::from(sides))), head_h, [0.0, 0.0, stem_h], sides)
      }
      "knob-cylinder" => b.cylinder(w / 2.0, h, [0.0, 0.0, 0.0], n),
      "knob-disk" => b.cylinder(w / 2.0, head_h, [0.0, 0.0, stem_h], n),
      _ => b.lathe(vec![
        [0.0, stem_h],
        [w * 0.3, stem_h],
        [w * 0.49, h - head_h * 0.45],
        [w / 2.0, h - head_h * 0.3],
        [w * 0.4, h - head_h * 0.08],
        [0.0, h],
      ]),
    };
    b.add(&stem, &head)
  } else if matches!(shape, "cup" | "cup-square") {
    let solid = if shape == "cup" {
      let outer = b.sphere(l / 2.0, w, h, [0.0, 0.0, 0.0]);
      let inner = b.sphere(l / 2.0 - t, w - t, h - t, [0.0, 0.0, 0.0]);
      let hollow = b.sub(&outer, &inner);
      let keep = b.box_at(l * 2.0, w, h, [0.0, w / 2.0, h / 2.0]);
      let half = b.cut(&hollow, &keep);
      b.moved(&half, 0.0, -w / 2.0, 0.0)
    } else {
      let radius = js_min(w / 5.0, t * 2.0);
      let outer = b.extruded(&section(rounded(l, w, radius)), h, 1.0);
      let pocket = b.box_at(l - 2.0 * t, w, h - 2.0 * t, [0.0, -t, (h - 2.0 * t) / 2.0]);
      let recess_section = section(rounded(l - 4.0 * t, w - 4.0 * t, js_min(radius / 2.0, (w - 4.0 * t) / 4.0)));
      let recess_solid = b.extruded(&recess_section, t, 1.0);
      let recess = b.moved(&recess_solid, 0.0, 0.0, h - t / 2.0);
      let pocketed = b.sub(&outer, &pocket);
      b.sub(&pocketed, &recess)
    };
    mount.push([-js_min(c, l - 2.0 * t) / 2.0, w * 0.2, 0.0]);
    mount.push([js_min(c, l - 2.0 * t) / 2.0, w * 0.2, 0.0]);
    solid
  } else if matches!(shape, "recessed" | "recessed-round") {
    let round = shape == "recessed-round";
    let flange = if round { b.cylinder(w / 2.0, t, [0.0, 0.0, 0.0], n) } else { b.box_at(l, w, t, [0.0, 0.0, t / 2.0]) };
    let body = if round { b.cylinder(w / 2.0 - t, h, [0.0, 0.0, -h], n) } else { b.box_at(l - 2.0 * t, w - 2.0 * t, h, [0.0, 0.0, -h / 2.0]) };
    let pocket = if round { b.cylinder(w / 2.0 - 2.0 * t, h + t, [0.0, 0.0, -h + t], n) } else { b.box_at(l - 4.0 * t, w - 4.0 * t, h + t, [0.0, 0.0, -h / 2.0 + 1.5 * t]) };
    let sum = b.add(&flange, &body);
    b.sub(&sum, &pocket)
  } else if matches!(shape, "edge" | "edge-curved") {
    let bottom = b.box_at(l, w, t, [0.0, w / 2.0, t / 2.0]);
    let wall = b.box_at(l, t, h, [0.0, t / 2.0, h / 2.0]);
    let mut solid = b.add(&bottom, &wall);
    if shape == "edge-curved" {
      solid = b.add(&solid, &b.rod([-l / 2.0, t, h - t], [l / 2.0, t, h - t], t));
    }
    mount.push([-js_min(c, l * 0.8) / 2.0, w * 0.65, 0.0]);
    mount.push([js_min(c, l * 0.8) / 2.0, w * 0.65, 0.0]);
    solid
  } else if shape == "ring" {
    let points: Vec<Point> = (0..12)
      .map(|i| {
        let a = (f64::from(i) * std::f64::consts::PI) / 6.0;
        [w / 2.0 - g / 2.0 + (cos(a) * g) / 2.0, (sin(a) * g) / 2.0]
      })
      .collect();
    let torus = b.keep(Manifold::revolve(&section(points), n, 360.0));
    let ring = b.moved(&torus, 0.0, -w / 2.0 + g / 2.0, h - g / 2.0);
    mount.push([0.0, 0.0, 0.0]);
    let post = b.cylinder(g * 0.65, h - g / 3.0, [0.0, 0.0, 0.0], n);
    b.add(&ring, &post)
  } else if shape == "half-moon" {
    let disc = b.keep(b.cylinder(l / 2.0, t, [0.0, 0.0, h - t], n).scale(1.0, (2.0 * w) / l, 1.0));
    let half = b.cut(&disc, &b.box_at(l * 2.0, l, h * 2.0, [0.0, l / 2.0, h]));
    let solid = b.add(&half, &b.box_at(l * 0.8, t, h, [0.0, t / 2.0, h / 2.0]));
    mount.push([-js_min(c, l * 0.7) / 2.0, 0.0, 0.0]);
    mount.push([js_min(c, l * 0.7) / 2.0, 0.0, 0.0]);
    solid
  } else {
    let plate = b.cylinder(w / 2.0, t, [0.0, 0.0, 0.0], n);
    let hole = b.cylinder(g / 2.0, t * 2.0, [0.0, 0.0, -t / 2.0], n);
    mount.push([0.0, 0.0, 0.0]);
    b.sub(&plate, &hole)
  };

  if solid.is_empty() || solid.volume() <= VOLUME_FLOOR {
    return Err(KernelError::invalid("These dimensions produce no hardware solid."));
  }
  let fin = finalize_manifold(&solid, &FinalizeOptions { next_face_id: req.next_face_id, simplify_tolerance: None, connected_solid: false }, all_new_ids)?;
  Ok(HardwareOutput { components: fin.components, next_face_id: fin.next_face_id, mounting_centers: mount })
}
