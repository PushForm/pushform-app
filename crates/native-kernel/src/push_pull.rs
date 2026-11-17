// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! Push/pull of a region of a cached body's face, a port of `pushPull.ts`: extrude a labelled tool prism, then move the
//! face when that gives the same solid as cutting, otherwise cut (union when pulling, difference when pushing), and
//! normalize the result so faces keep their identities.
use manifold_csg::{CrossSection, FillRule, JoinType, Manifold, MeshGL, MeshGLOptions, reserve_ids};

use crate::cache::CacheEntry;
use crate::finalize::{finalize_manifold, Component, Finalized, FinalizeOptions};
use crate::math::{self, cross, dist, dot, hypot2, hypot3, js_max, js_min, neg, parallel, point_in_polygon, point_on_ring, sub, Basis, Pt, Vec3};
use crate::meshio::{manifold_from_soup, read_manifold, try_manifold_from_soup, uncaught_manifold_error, ReadMesh, TriangleSoup};
use crate::normalize::{normalize_triangles, IntMap, WeightedOrigin};
use crate::tolerance::{AREA_TOL, COPLANAR_TOL, MERGE_TOL};
use crate::KernelError;

const TOOL_NEAR_CAP: u32 = 0;
const TOOL_FAR_CAP: u32 = 1;
const TOOL_SIDE_BASE: u32 = 2;

/// Start-cap overlap that removes the coincident-face degeneracy where the tool's start cap cannot coincide with the face.
const OVERLAP: f64 = 4.0 * COPLANAR_TOL;

pub struct PushPullRequest {
  pub body_id: f64,
  pub version: f64,
  pub face_id: f64,
  pub basis: Basis,
  pub polygon: Vec<Vec<Pt>>,
  pub region_is_whole_face: bool,
  pub distance: f64,
  pub new_body: bool,
  pub preview: bool,
  pub next_face_id: f64,
}

pub struct ExtrudeSketchRequest {
  pub basis: Basis,
  pub polygon: Vec<Vec<Pt>>,
  pub distance: f64,
  pub next_face_id: f64,
}

/// Checked between pipeline stages; the op stops with `Aborted` once the kernel has been reset.
pub trait Checkpoint {
  fn check(&self) -> Result<(), KernelError>;
}

pub enum PushPullOutput {
  Full {
    components: Vec<Component>,
    /// Keyed by the face's id as a number, which can exceed what a mesh's `faceId` holds.
    side_face_for_boundary_edge: Vec<(f64, u32)>,
    next_face_id: f64,
    body_run_id: u32,
    tool_run_id: u32,
    moved: bool,
  },
  /// Triangles to draw for a drag preview, grouped into faces, and nothing else.
  Preview { verts: Vec<f64>, tris: Vec<u32>, face_id: Vec<u32> },
}

struct ToolFrame {
  /// World transform of the tool's local frame (z = push direction): u, v, n and origin columns.
  matrix: [f64; 12],
  origin: Vec3,
  u: Vec3,
  v: Vec3,
  /// Region contours in the local frame (oriented: outer CCW, holes CW).
  contours: Vec<Vec<Pt>>,
  /// Region boundary edges (input order, flattened over contours) in the local frame.
  edges: Vec<(Pt, Pt)>,
  /// Unit extrusion direction in world space.
  dir: Vec3,
}

fn signed_area(poly: &[Pt]) -> f64 {
  let mut a = 0.0;
  for i in 0..poly.len() {
    let (p, q) = (poly[i], poly[(i + 1) % poly.len()]);
    a += p[0] * q[1] - q[0] * p[1];
  }
  a / 2.0
}

/// The tool's local frame. For a push the basis is mirrored (u and v swapped, normal negated) so the transform stays
/// right-handed, and the polygon's coordinates are swapped to match.
fn tool_frame(basis: &Basis, polygon: &[Vec<Pt>], distance: f64) -> ToolFrame {
  let pull = distance > 0.0;
  let (u, v) = if pull { (basis.u, basis.v) } else { (basis.v, basis.u) };
  let n = if pull { basis.n } else { neg(basis.n) };
  let local: Vec<Vec<Pt>> = polygon.iter().map(|c| c.iter().map(|p| if pull { *p } else { [p[1], p[0]] }).collect()).collect();
  let mut edges = Vec::new();
  for contour in &local {
    for i in 0..contour.len() {
      edges.push((contour[i], contour[(i + 1) % contour.len()]));
    }
  }
  let contours: Vec<Vec<Pt>> = local.iter().filter(|c| c.len() >= 3).enumerate().map(|(i, c)| {
    let want_ccw = i == 0;
    if (signed_area(c) > 0.0) == want_ccw { c.clone() } else { c.iter().rev().copied().collect() }
  }).collect();
  let o = basis.origin;
  let matrix = [u[0], u[1], u[2], v[0], v[1], v[2], n[0], n[1], n[2], o[0], o[1], o[2]];
  ToolFrame { matrix, origin: o, u, v, contours, edges, dir: n }
}

fn collinear_overlap(a: Pt, b: Pt, edge: (Pt, Pt), tol: f64) -> f64 {
  let (p, q) = edge;
  let (ex, ey) = (q[0] - p[0], q[1] - p[1]);
  let len = hypot2(ex, ey);
  if len == 0.0 {
    return 0.0;
  }
  let (ux, uy) = (ex / len, ey / len);
  let dist_to_line = |r: Pt| ((r[0] - p[0]) * uy - (r[1] - p[1]) * ux).abs();
  if dist_to_line(a) > tol || dist_to_line(b) > tol {
    return 0.0;
  }
  let ta = (a[0] - p[0]) * ux + (a[1] - p[1]) * uy;
  let tb = (b[0] - p[0]) * ux + (b[1] - p[1]) * uy;
  js_min(js_max(ta, tb), len) - js_max(js_min(ta, tb), 0.0)
}

fn contour_tol(extent: f64) -> f64 {
  js_max(1e-6 * extent, 1e-9)
}

/// Near-cap, far-cap or side label for each triangle of an extruded prism in its local frame.
fn label_tool_faces(props: &[f32], np: usize, tris: &[u32], edges: &[(Pt, Pt)]) -> Vec<u32> {
  let p = |i: usize| props[i] as f64;
  let mut extent = 0.0_f64;
  for (a, b) in edges {
    extent = js_max(js_max(js_max(js_max(extent, a[0].abs()), a[1].abs()), b[0].abs()), b[1].abs());
  }
  let tol = contour_tol(extent);
  let num_tri = tris.len() / 3;
  let mut face_id = vec![0u32; num_tri];
  for t in 0..num_tri {
    let v = [tris[t * 3] as usize * np, tris[t * 3 + 1] as usize * np, tris[t * 3 + 2] as usize * np];
    let z = [p(v[0] + 2), p(v[1] + 2), p(v[2] + 2)];
    let e1 = [p(v[1]) - p(v[0]), p(v[1] + 1) - p(v[0] + 1), z[1] - z[0]];
    let e2 = [p(v[2]) - p(v[0]), p(v[2] + 1) - p(v[0] + 1), z[2] - z[0]];
    let nz = e1[0] * e2[1] - e1[1] * e2[0];
    let (nx, ny) = (e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2]);
    if nz.abs() > hypot2(nx, ny) {
      face_id[t] = if nz > 0.0 { TOOL_FAR_CAP } else { TOOL_NEAR_CAP };
      continue;
    }
    // Side: the two corners at the same height span the base edge.
    let k: [usize; 2] = if (z[0] - z[1]).abs() <= (z[1] - z[2]).abs() && (z[0] - z[1]).abs() <= (z[0] - z[2]).abs() {
      [0, 1]
    } else if (z[1] - z[2]).abs() <= (z[0] - z[2]).abs() {
      [1, 2]
    } else {
      [0, 2]
    };
    let a = [p(v[k[0]]), p(v[k[0]] + 1)];
    let b = [p(v[k[1]]), p(v[k[1]] + 1)];
    let (mut best, mut best_overlap) = (-1i64, 0.0_f64);
    for (i, edge) in edges.iter().enumerate() {
      let o = collinear_overlap(a, b, *edge, tol);
      if o > best_overlap {
        best_overlap = o;
        best = i as i64;
      }
    }
    face_id[t] = TOOL_SIDE_BASE + (if best >= 0 { best as usize } else { edges.len() }) as u32;
  }
  face_id
}

/// The region's contours as a cross-section. A region with no usable contour (none given, or every one under three
/// points) has no area and is the caller's mistake, like any other region without area.
fn polygons_cross_section(frame: &ToolFrame) -> Result<CrossSection, KernelError> {
  if frame.contours.is_empty() {
    return Err(KernelError::invalid("pushPull region polygon has no area"));
  }
  Ok(CrossSection::from_polygons_with_fill_rule(&frame.contours, FillRule::Positive))
}

/// Cross-section of the frame's contours, or the region-has-no-area error of the former TypeScript kernel.
fn cross_section(frame: &ToolFrame) -> Result<CrossSection, KernelError> {
  let cs = polygons_cross_section(frame)?;
  if cs.is_empty() {
    return Err(KernelError::invalid("pushPull region polygon has no area"));
  }
  Ok(cs)
}

/// The extruded region as a labelled tool in world space, for a tool nothing has to coincide with exactly.
fn build_standalone_tool(frame: &ToolFrame, height: f64, run_id: u32) -> Result<Manifold, KernelError> {
  let cs = cross_section(frame)?;
  let prism = cs.extrude(height);
  let mg = prism.to_meshgl();
  let (props, tri_verts) = (mg.vert_properties(), mg.tri_verts());
  let labels = label_tool_faces(&props, mg.num_prop(), &tri_verts, &frame.edges);
  let run_index = [0, tri_verts.len() as u32];
  let run_original_id = [run_id];
  let (from, to) = (mg.merge_from_vert(), mg.merge_to_vert());
  let options = MeshGLOptions::new().runs(&run_index, &run_original_id).merge_vertices(&from, &to);
  let mut labelled = MeshGL::new_with_options(&props, mg.num_prop(), &tri_verts, options).map_err(|e| KernelError::internal(format!("{e}")))?;
  labelled.set_face_id(&labels);
  let local = Manifold::from_meshgl(&labelled).map_err(uncaught_manifold_error)?;
  Ok(local.transform(&frame.matrix))
}

fn on_face(frame: &ToolFrame, x: f64, y: f64) -> Vec3 {
  let (o, u, v) = (frame.origin, frame.u, frame.v);
  [o[0] + x * u[0] + y * v[0], o[1] + x * u[1] + y * v[1], o[2] + x * u[2] + y * v[2]]
}

struct CornerPoint {
  x: f64,
  y: f64,
  world: Vec3,
}

struct ToolCorners {
  points: Vec<CornerPoint>,
  all_on_vertices: bool,
}

fn snap_corners(frame: &ToolFrame, face_verts: &[Vec3]) -> ToolCorners {
  let mut all_on_vertices = !face_verts.is_empty();
  let mut points = Vec::new();
  for contour in &frame.contours {
    for &[x, y] in contour {
      let p = on_face(frame, x, y);
      let (mut best, mut best_d) = (None, MERGE_TOL);
      for q in face_verts {
        let d = dist(p, *q);
        if d <= best_d {
          best_d = d;
          best = Some(*q);
        }
      }
      if best.is_none() {
        all_on_vertices = false;
      }
      points.push(CornerPoint { x, y, world: best.unwrap_or(p) });
    }
  }
  ToolCorners { points, all_on_vertices }
}

fn face_vertices(mesh: &ReadMesh, face_id: f64) -> Vec<Vec3> {
  let mut seen = vec![false; mesh.verts.len() / 3];
  let mut out = Vec::new();
  for t in 0..mesh.face_id.len() {
    if f64::from(mesh.face_id[t]) != face_id {
      continue;
    }
    for k in 0..3 {
      let i = mesh.tris[t * 3 + k] as usize;
      if seen[i] {
        continue;
      }
      seen[i] = true;
      out.push([mesh.verts[i * 3], mesh.verts[i * 3 + 1], mesh.verts[i * 3 + 2]]);
    }
  }
  out
}

struct ToolSoup {
  verts: Vec<f64>,
  tris: Vec<u32>,
  face_id: Vec<u32>,
}

/// The labelled tool prism as a triangle soup in world space spanning local z ∈ [-overlap_near, height + overlap_far],
/// each corner built from its exact position on the face so shared edges are the solid's own.
fn build_tool_soup(frame: &ToolFrame, corners: &ToolCorners, height: f64, overlap_near: f64, overlap_far: f64) -> Result<ToolSoup, KernelError> {
  let cs = cross_section(frame)?;
  let prism = cs.extrude(height + overlap_near + overlap_far).translate(0.0, 0.0, -overlap_near);
  let mg = prism.to_meshgl();
  let np = mg.num_prop();
  let (props, tri_verts) = (mg.vert_properties(), mg.tri_verts());
  let face_id = label_tool_faces(&props, np, &tri_verts, &frame.edges);
  let extent = corners.points.iter().fold(0.0_f64, |e, c| js_max(js_max(e, c.x.abs()), c.y.abs()));
  let tol = contour_tol(extent);
  let mid = (height + overlap_far - overlap_near) / 2.0;
  let near = if overlap_near > 0.0 { -overlap_near } else { 0.0 };
  let d = frame.dir;
  let num_vert = mg.num_vert();
  let mut verts = vec![0.0f64; num_vert * 3];
  for i in 0..num_vert {
    let (x, y) = (props[i * np] as f64, props[i * np + 1] as f64);
    let (mut base, mut best_d) = (None, tol);
    for c in &corners.points {
      let dd = hypot2(c.x - x, c.y - y);
      if dd <= best_d {
        best_d = dd;
        base = Some(c.world);
      }
    }
    let base = base.unwrap_or_else(|| on_face(frame, x, y));
    let z = if (props[i * np + 2] as f64) > mid { height + overlap_far } else { near };
    verts[i * 3] = base[0] + z * d[0];
    verts[i * 3 + 1] = base[1] + z * d[1];
    verts[i * 3 + 2] = base[2] + z * d[2];
  }
  // Weld: every edge shared by index, as Manifold requires of an input mesh.
  let mut remap: Vec<u32> = (0..num_vert as u32).collect();
  let (from, to) = (mg.merge_from_vert(), mg.merge_to_vert());
  for (f, t) in from.iter().zip(to.iter()) {
    remap[*f as usize] = *t;
  }
  let tris = tri_verts.iter().map(|v| remap[*v as usize]).collect();
  Ok(ToolSoup { verts, tris, face_id })
}

/// True when a face anti-parallel to F lies within MERGE_TOL of the far-end plane: the tool exits or enters through it.
fn reaches_opposing_face(body: &ReadMesh, n: Vec3, far_offset: f64) -> bool {
  let (verts, tris) = (&body.verts, &body.tris);
  let mut t = 0;
  while t < tris.len() {
    let (a, b, c) = (tris[t] as usize * 3, tris[t + 1] as usize * 3, tris[t + 2] as usize * 3);
    let e1 = [verts[b] - verts[a], verts[b + 1] - verts[a + 1], verts[b + 2] - verts[a + 2]];
    let e2 = [verts[c] - verts[a], verts[c + 1] - verts[a + 1], verts[c + 2] - verts[a + 2]];
    let fnormal = cross(e1, e2);
    t += 3;
    if dot(fnormal, n) >= 0.0 || !parallel(fnormal, n, 1e-6) {
      continue;
    }
    let offset = n[0] * verts[a] + n[1] * verts[a + 1] + n[2] * verts[a + 2];
    if (offset - far_offset).abs() <= MERGE_TOL {
      return true;
    }
  }
  false
}

struct Stretch {
  square: bool,
  /// Vertex positions of the solid with F moved, or `None` when moving F would not give the boolean's result.
  verts: Option<Vec<f64>>,
}

const NOT_SQUARE: Stretch = Stretch { square: false, verts: None };

/// Move a whole face along its normal instead of cutting, when every face around it is square to it and nothing else of
/// the solid is in the way. See `stretchFace` in the former TypeScript kernel.
fn stretch_face(body: &CacheEntry, mesh: &ReadMesh, req: &PushPullRequest, frame: &ToolFrame, height: f64) -> Result<Stretch, KernelError> {
  if req.new_body || !req.region_is_whole_face {
    return Ok(NOT_SQUARE);
  }
  let f = req.face_id;
  let n = req.basis.n;
  let d = req.distance;
  let (verts, tris, face_id) = (&mesh.verts, &mesh.tris, &mesh.face_id);
  let num_tri = face_id.len();
  let mut moves = vec![false; verts.len() / 3];
  let mut any = false;
  for t in 0..num_tri {
    if f64::from(face_id[t]) != f {
      continue;
    }
    for k in 0..3 {
      moves[tris[t * 3 + k] as usize] = true;
    }
    any = true;
  }
  if !any {
    return Ok(NOT_SQUARE);
  }
  let at = |i: usize, moved: bool| -> Vec3 {
    let s = if moved && moves[i] { d } else { 0.0 };
    [verts[i * 3] + s * n[0], verts[i * 3 + 1] + s * n[1], verts[i * 3 + 2] + s * n[2]]
  };
  let normal = |a: usize, b: usize, c: usize, moved: bool| -> Vec3 {
    let p = at(a, moved);
    cross(sub(at(b, moved), p), sub(at(c, moved), p))
  };
  let mut around: IntMap<u32, Vec3> = IntMap::default();
  let mut folds = false;
  for t in 0..num_tri {
    let id = face_id[t];
    if f64::from(id) == f {
      continue;
    }
    let (a, b, c) = (tris[t * 3] as usize, tris[t * 3 + 1] as usize, tris[t * 3 + 2] as usize);
    if !moves[a] && !moves[b] && !moves[c] {
      continue;
    }
    let (before, after) = (normal(a, b, c, false), normal(a, b, c, true));
    if dot(before, after) <= 0.0 || hypot3(after[0], after[1], after[2]) <= 2.0 * AREA_TOL {
      folds = true;
    }
    let sum = around.entry(id).or_insert([0.0; 3]);
    *sum = [sum[0] + before[0], sum[1] + before[1], sum[2] + before[2]];
  }
  // Square: moving F keeps each face around it flat within the coplanarity tolerance.
  for sum in around.values() {
    let len = hypot3(sum[0], sum[1], sum[2]);
    if len == 0.0 || d.abs() * dot(*sum, n).abs() / len > COPLANAR_TOL / 2.0 {
      return Ok(NOT_SQUARE);
    }
  }
  if folds {
    return Ok(Stretch { square: true, verts: None });
  }
  // No other vertex of the solid where F passes.
  let (o, u, v, dir) = (frame.origin, frame.u, frame.v, frame.dir);
  for i in 0..moves.len() {
    if moves[i] {
      continue;
    }
    let w = [verts[i * 3] - o[0], verts[i * 3 + 1] - o[1], verts[i * 3 + 2] - o[2]];
    let z = dot(w, dir);
    if z < -MERGE_TOL || z > height + MERGE_TOL {
      continue;
    }
    let xy = [dot(w, u), dot(w, v)];
    if point_in_polygon(xy, &frame.contours) || frame.contours.iter().any(|ring| point_on_ring(xy, ring, MERGE_TOL)) {
      return Ok(Stretch { square: true, verts: None });
    }
  }
  // No other face of the solid across where F passes: a slightly smaller prism there holds none of the solid (pulling
  // out) or only solid (pushing in).
  if height > 2.0 * OVERLAP {
    let shrunk = polygons_cross_section(frame)?.offset(-OVERLAP, JoinType::Miter, 2.0, 0);
    if !shrunk.is_empty() {
      let probe = shrunk.extrude(height - 2.0 * OVERLAP).translate(0.0, 0.0, OVERLAP).transform(&frame.matrix);
      let clash = if d > 0.0 { body.manifold.intersection(&probe) } else { probe.difference(&body.manifold) };
      if clash.volume() > COPLANAR_TOL * probe.surface_area() {
        return Ok(Stretch { square: true, verts: None });
      }
    }
  }
  let mut moved = verts.clone();
  for i in 0..moves.len() {
    if !moves[i] {
      continue;
    }
    for k in 0..3 {
      moved[i * 3 + k] = verts[i * 3 + k] + d * n[k];
    }
  }
  Ok(Stretch { square: true, verts: Some(moved) })
}

/// B ∪ tool (pulling) or B − tool (pushing), with both uploaded around one shared centre so faces they share coincide.
#[allow(clippy::too_many_arguments)]
fn cut(body: &CacheEntry, mesh: &ReadMesh, req: &PushPullRequest, frame: &ToolFrame, corners: &ToolCorners, height: f64, square: bool, tool_run_id: u32) -> Result<Manifold, KernelError> {
  let n = req.basis.n;
  let far_offset = dot(n, req.basis.origin) + req.distance;
  let overlap_far = if reaches_opposing_face(mesh, n, far_offset) { OVERLAP } else { 0.0 };
  let overlap_near = if req.distance > 0.0 && req.region_is_whole_face && square && corners.all_on_vertices { 0.0 } else { OVERLAP };
  let soup = build_tool_soup(frame, corners, height, overlap_near, overlap_far)?;
  let center = math::bounds_center(math::union_bounds(math::bounds(&mesh.verts), math::bounds(&soup.verts)));
  let solid = manifold_from_soup(&TriangleSoup { verts: &mesh.verts, tris: &mesh.tris, face_id: &mesh.face_id }, body.run_id, center)?;
  let tool = manifold_from_soup(&TriangleSoup { verts: &soup.verts, tris: &soup.tris, face_id: &soup.face_id }, tool_run_id, center)?;
  Ok(if req.distance > 0.0 { solid.union(&tool) } else { solid.difference(&tool) })
}

fn side_face_map(fin: &Finalized, tool_run_id: u32) -> Vec<(f64, u32)> {
  let mut out = Vec::new();
  for face in &fin.faces {
    if let Some(side) = face.origins.iter().find(|o| o.run_id == tool_run_id && o.face_id >= TOOL_SIDE_BASE) {
      out.push((face.id, side.face_id - TOOL_SIDE_BASE));
    }
  }
  out
}

fn preview_mesh(m: &Manifold) -> PushPullOutput {
  let norm = normalize_triangles(&read_manifold(m), 0.0, |_| None);
  PushPullOutput::Preview { verts: norm.mesh.verts, tris: norm.mesh.tris, face_id: norm.mesh.face_id }
}

/// Run push/pull. `body` is the cached solid; `checkpoint` stops the work once the kernel has been reset.
pub fn push_pull(body: &CacheEntry, req: &PushPullRequest, checkpoint: &dyn Checkpoint) -> Result<PushPullOutput, KernelError> {
  let mesh = &body.mesh;
  let frame = tool_frame(&req.basis, &req.polygon, req.distance);
  let corners = snap_corners(&frame, &face_vertices(mesh, req.face_id));
  let height = req.distance.abs();
  let tool_run_id = reserve_ids(1);
  let body_run_id = body.run_id;
  let far_cap_id = if req.region_is_whole_face { Some(req.face_id) } else { None };
  let choose_id = choose_id_for(body_run_id, tool_run_id, far_cap_id);
  let mut moved = false;
  let out = if req.new_body {
    build_standalone_tool(&frame, height, tool_run_id)?
  } else {
    let stretch = stretch_face(body, mesh, req, &frame, height)?;
    checkpoint.check()?;
    if req.preview {
      if let Some(verts) = stretch.verts {
        return Ok(PushPullOutput::Preview { verts, tris: mesh.tris.clone(), face_id: mesh.face_id.clone() });
      }
    }
    match stretch.verts {
      Some(verts) => match try_manifold_from_soup(&TriangleSoup { verts: &verts, tris: &mesh.tris, face_id: &mesh.face_id }, body_run_id, crate::meshio::soup_center(&verts)) {
        Ok(manifold) => {
          moved = true;
          manifold
        }
        Err(_) => cut(body, mesh, req, &frame, &corners, height, stretch.square, tool_run_id)?,
      },
      None => cut(body, mesh, req, &frame, &corners, height, stretch.square, tool_run_id)?,
    }
  };
  checkpoint.check()?;
  if req.preview {
    return Ok(preview_mesh(&out));
  }
  let fin = finalize_manifold(&out, &FinalizeOptions { next_face_id: req.next_face_id, simplify_tolerance: None, connected_solid: false }, choose_id)?;
  Ok(PushPullOutput::Full {
    side_face_for_boundary_edge: side_face_map(&fin, tool_run_id),
    next_face_id: fin.next_face_id,
    body_run_id,
    tool_run_id,
    moved,
    components: fin.components,
  })
}

/// `chooseIdFor`: the body face giving a face most of its area keeps its id; the far cap may take F's id.
fn choose_id_for(body_run_id: u32, tool_run_id: u32, far_cap_id: Option<f64>) -> impl Fn(&[WeightedOrigin]) -> Option<f64> {
  move |origins: &[WeightedOrigin]| {
    if let Some(o) = origins.iter().find(|o| o.run_id == body_run_id) {
      return Some(f64::from(o.face_id));
    }
    if let Some(cap) = far_cap_id {
      if origins.iter().any(|o| o.run_id == tool_run_id && o.face_id == TOOL_FAR_CAP) {
        return Some(cap);
      }
    }
    None
  }
}

/// Extrude a sketch polygon into a new solid: the new-body path of push/pull without a source body.
pub fn extrude_sketch(req: &ExtrudeSketchRequest, checkpoint: &dyn Checkpoint) -> Result<PushPullOutput, KernelError> {
  if !req.distance.is_finite() || req.distance.abs() <= COPLANAR_TOL {
    return Err(KernelError::invalid("extrudeSketch.distance must be a non-zero finite number"));
  }
  let frame = tool_frame(&req.basis, &req.polygon, req.distance);
  let tool_run_id = reserve_ids(1);
  let height = req.distance.abs();
  let tool = build_standalone_tool(&frame, height, tool_run_id)?;
  checkpoint.check()?;
  let choose_id = choose_id_for(0, tool_run_id, None);
  let fin = finalize_manifold(&tool, &FinalizeOptions { next_face_id: req.next_face_id, simplify_tolerance: None, connected_solid: false }, choose_id)?;
  Ok(PushPullOutput::Full {
    side_face_for_boundary_edge: side_face_map(&fin, tool_run_id),
    next_face_id: fin.next_face_id,
    body_run_id: 0,
    tool_run_id,
    moved: false,
    components: fin.components,
  })
}
