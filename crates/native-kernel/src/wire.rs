// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! The binary kernel protocol (little-endian). Requests are one byte buffer starting with an opcode; responses start
//! with the opcode. Typed sections in a response are padded so a Float64 run starts on an 8-byte boundary and a Uint32
//! run on a 4-byte boundary, so the webview can read them without copying through JSON.
use crate::finalize::Component;
use crate::math::{Basis, Pt, Vec3};
use crate::ops::boolean::{BooleanOutput, BooleanRequest};
use crate::ops::edge_blend::{EdgeBlendOutput, EdgeBlendRequest};
use crate::ops::follow_me::FollowMeRequest;
use crate::ops::from_triangles::FromTrianglesOutput;
use crate::ops::hardware::{HardwareOutput, HardwareRequest};
use crate::ops::properties::PropertiesOutput;
use crate::ops::revolve::RevolveRequest;
use crate::ops::section_cut::SectionCutOutput;
use crate::ops::ComponentsOutput;
use crate::push_pull::{ExtrudeSketchRequest, PushPullOutput, PushPullRequest};
use crate::KernelError;

pub const OP_ENSURE_BODY: u32 = 1;
pub const OP_PUSH_PULL: u32 = 2;
pub const OP_RELEASE: u32 = 3;
pub const OP_INIT: u32 = 4;
pub const OP_EXTRUDE_SKETCH: u32 = 5;
pub const OP_BOOLEAN: u32 = 6;
pub const OP_TRANSFORM: u32 = 7;
pub const OP_AUTOFOLD: u32 = 8;
pub const OP_SECTION_CUT: u32 = 9;
pub const OP_PROPERTIES: u32 = 10;
pub const OP_FROM_TRIANGLES: u32 = 11;
pub const OP_DECOMPOSE: u32 = 12;
pub const OP_SIMPLIFY: u32 = 13;
pub const OP_HULL: u32 = 14;
pub const OP_FOLLOW_ME: u32 = 15;
pub const OP_REVOLVE: u32 = 16;
pub const OP_EDGE_BLEND: u32 = 17;
pub const OP_STATS: u32 = 18;
pub const OP_VALIDATE_SOLID: u32 = 19;
pub const OP_HARDWARE: u32 = 20;

/// A triangle mesh or tool soup as sent, with each array's own length so a malformed mesh reaches the kernel as it was sent.
pub struct Mesh {
  pub verts: Vec<f64>,
  pub tris: Vec<u32>,
  pub face_id: Vec<u32>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BooleanOp {
  Add,
  Subtract,
  Intersect,
  Split,
  Trim,
}

/// A body reference: id and version, both JavaScript numbers.
pub type BodyRef = (f64, f64);

pub enum Request {
  Init,
  EnsureBody { body_id: f64, version: f64, mesh: Option<Mesh> },
  PushPull(PushPullRequest),
  ExtrudeSketch(ExtrudeSketchRequest),
  Release { body_id: f64, version: Option<f64> },
  Boolean(BooleanRequest),
  Transform { body: BodyRef, matrix: Vec<f64>, next_face_id: f64 },
  Autofold { mesh: Mesh, next_face_id: f64 },
  SectionCut { body: BodyRef, n: Vec3, d: f64 },
  Properties { body: BodyRef },
  FromTriangles { mesh: Mesh, next_face_id: f64 },
  Decompose { body: BodyRef, next_face_id: f64 },
  Simplify { body: BodyRef, tolerance: Option<f64>, next_face_id: f64 },
  Hull { bodies: Vec<BodyRef>, next_face_id: f64 },
  FollowMe(FollowMeRequest),
  Revolve(RevolveRequest),
  EdgeBlend(EdgeBlendRequest),
  Stats,
  ValidateSolid { mesh: Mesh },
  Hardware(HardwareRequest),
}

struct Reader<'a> {
  bytes: &'a [u8],
  at: usize,
}

impl Reader<'_> {
  fn take(&mut self, n: usize) -> Result<&[u8], KernelError> {
    let end = self.at.checked_add(n).filter(|&e| e <= self.bytes.len());
    let Some(end) = end else { return Err(KernelError::invalid("truncated kernel request")) };
    let slice = &self.bytes[self.at..end];
    self.at = end;
    Ok(slice)
  }
  fn u32(&mut self) -> Result<u32, KernelError> {
    Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
  }
  fn f64(&mut self) -> Result<f64, KernelError> {
    Ok(f64::from_le_bytes(self.take(8)?.try_into().unwrap()))
  }
  fn f64s(&mut self, n: usize) -> Result<Vec<f64>, KernelError> {
    let bytes = n.checked_mul(8).ok_or_else(|| KernelError::invalid("truncated kernel request"))?;
    let raw = self.take(bytes)?;
    Ok(raw.chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect())
  }
  fn u32s(&mut self, n: usize) -> Result<Vec<u32>, KernelError> {
    let bytes = n.checked_mul(4).ok_or_else(|| KernelError::invalid("truncated kernel request"))?;
    let raw = self.take(bytes)?;
    Ok(raw.chunks_exact(4).map(|c| u32::from_le_bytes(c.try_into().unwrap())).collect())
  }
  fn vec3(&mut self) -> Result<Vec3, KernelError> {
    Ok([self.f64()?, self.f64()?, self.f64()?])
  }
  fn body(&mut self) -> Result<BodyRef, KernelError> {
    Ok((self.f64()?, self.f64()?))
  }
  fn basis(&mut self) -> Result<Basis, KernelError> {
    Ok(Basis { origin: self.vec3()?, u: self.vec3()?, v: self.vec3()?, n: self.vec3()? })
  }
  fn mesh(&mut self) -> Result<Mesh, KernelError> {
    let (verts, tris, faces) = (self.u32()? as usize, self.u32()? as usize, self.u32()? as usize);
    Ok(Mesh { verts: self.f64s(verts)?, tris: self.u32s(tris)?, face_id: self.u32s(faces)? })
  }
  fn meshes(&mut self) -> Result<Vec<Mesh>, KernelError> {
    let n = self.u32()? as usize;
    (0..n).map(|_| self.mesh()).collect()
  }
  fn string(&mut self) -> Result<String, KernelError> {
    let len = self.u32()? as usize;
    Ok(String::from_utf8_lossy(self.take(len)?).into_owned())
  }
  fn polygon(&mut self) -> Result<Vec<Vec<Pt>>, KernelError> {
    let num_contours = self.u32()? as usize;
    let counts = self.u32s(num_contours)?;
    let mut polygon: Vec<Vec<Pt>> = Vec::with_capacity(num_contours);
    for count in counts {
      let coords = self.f64s(count as usize * 2)?;
      polygon.push(coords.chunks_exact(2).map(|p| [p[0], p[1]]).collect());
    }
    Ok(polygon)
  }
}

pub fn decode_request(bytes: &[u8]) -> Result<Request, KernelError> {
  let mut r = Reader { bytes, at: 0 };
  match r.u32()? {
    OP_ENSURE_BODY => {
      let (body_id, version) = r.body()?;
      let mesh = if r.u32()? != 0 { Some(r.mesh()?) } else { None };
      Ok(Request::EnsureBody { body_id, version, mesh })
    }
    OP_PUSH_PULL => {
      let (body_id, version) = r.body()?;
      let face_id = r.f64()?;
      let region_is_whole_face = r.u32()? != 0;
      let basis = r.basis()?;
      let distance = r.f64()?;
      let new_body = r.u32()? != 0;
      let preview = r.u32()? != 0;
      let next_face_id = r.f64()?;
      let polygon = r.polygon()?;
      Ok(Request::PushPull(PushPullRequest { body_id, version, face_id, basis, polygon, region_is_whole_face, distance, new_body, preview, next_face_id }))
    }
    OP_RELEASE => {
      let body_id = r.f64()?;
      let has_version = r.u32()? != 0;
      let version = r.f64()?;
      Ok(Request::Release { body_id, version: if has_version { Some(version) } else { None } })
    }
    OP_INIT => Ok(Request::Init),
    OP_EXTRUDE_SKETCH => {
      let basis = r.basis()?;
      let distance = r.f64()?;
      let next_face_id = r.f64()?;
      let polygon = r.polygon()?;
      let validate_profile = r.at < r.bytes.len() && r.u32()? != 0;
      Ok(Request::ExtrudeSketch(ExtrudeSketchRequest { basis, polygon, distance, next_face_id, validate_profile }))
    }
    OP_BOOLEAN => {
      let op = match r.u32()? {
        0 => BooleanOp::Add,
        1 => BooleanOp::Subtract,
        2 => BooleanOp::Intersect,
        3 => BooleanOp::Split,
        4 => BooleanOp::Trim,
        other => return Err(KernelError::invalid(&format!("unknown boolean op {other}"))),
      };
      let a_body = r.body()?;
      let b_body = r.body()?;
      let next_face_id = r.f64()?;
      Ok(Request::Boolean(BooleanRequest { op, a_body, b_body, next_face_id }))
    }
    OP_TRANSFORM => {
      let body = r.body()?;
      let len = r.u32()? as usize;
      let matrix = r.f64s(len)?;
      Ok(Request::Transform { body, matrix, next_face_id: r.f64()? })
    }
    OP_AUTOFOLD => {
      let mesh = r.mesh()?;
      Ok(Request::Autofold { mesh, next_face_id: r.f64()? })
    }
    OP_SECTION_CUT => {
      let body = r.body()?;
      let n = r.vec3()?;
      Ok(Request::SectionCut { body, n, d: r.f64()? })
    }
    OP_PROPERTIES => Ok(Request::Properties { body: r.body()? }),
    OP_FROM_TRIANGLES => {
      let mesh = r.mesh()?;
      Ok(Request::FromTriangles { mesh, next_face_id: r.f64()? })
    }
    OP_DECOMPOSE => {
      let body = r.body()?;
      Ok(Request::Decompose { body, next_face_id: r.f64()? })
    }
    OP_SIMPLIFY => {
      let body = r.body()?;
      let has_tolerance = r.u32()? != 0;
      let tolerance = r.f64()?;
      Ok(Request::Simplify { body, tolerance: if has_tolerance { Some(tolerance) } else { None }, next_face_id: r.f64()? })
    }
    OP_HULL => {
      let n = r.u32()? as usize;
      let bodies = (0..n).map(|_| r.body()).collect::<Result<Vec<_>, _>>()?;
      Ok(Request::Hull { bodies, next_face_id: r.f64()? })
    }
    OP_FOLLOW_ME => {
      let profile = r.polygon()?;
      let basis = r.basis()?;
      let n = r.u32()? as usize;
      let path = (0..n).map(|_| r.vec3()).collect::<Result<Vec<_>, _>>()?;
      let closed = r.u32()? != 0;
      let next_face_id = r.f64()?;
      Ok(Request::FollowMe(FollowMeRequest { profile, basis, path, closed, next_face_id }))
    }
    OP_REVOLVE => {
      let profile = r.polygon()?;
      let basis = r.basis()?;
      let axis_origin = r.vec3()?;
      let axis_dir = r.vec3()?;
      let angle_deg = r.f64()?;
      let segments = r.f64()?;
      let next_face_id = r.f64()?;
      Ok(Request::Revolve(RevolveRequest { profile, basis, axis_origin, axis_dir, angle_deg, segments, next_face_id }))
    }
    OP_EDGE_BLEND => {
      let body = r.body()?;
      let cut = r.meshes()?;
      let add = r.meshes()?;
      let next_face_id = r.f64()?;
      Ok(Request::EdgeBlend(EdgeBlendRequest { body, cut, add, next_face_id }))
    }
    OP_STATS => Ok(Request::Stats),
    OP_VALIDATE_SOLID => Ok(Request::ValidateSolid { mesh: r.mesh()? }),
    OP_HARDWARE => {
      let shape = r.string()?;
      let (length, width, projection, spacing, grip, wall, segments) = (r.f64()?, r.f64()?, r.f64()?, r.f64()?, r.f64()?, r.f64()?, r.f64()?);
      let next_face_id = r.f64()?;
      // Only the domed knob sends its profile divisions, after everything the other shapes send.
      let profile_segments = if shape == "knob-domed" { r.f64()? } else { 0.0 };
      Ok(Request::Hardware(HardwareRequest { shape, length, width, projection, spacing, grip, wall, segments, profile_segments, next_face_id }))
    }
    op => Err(KernelError::invalid(&format!("unknown kernel request {op}"))),
  }
}

#[derive(Default)]
pub struct Writer {
  bytes: Vec<u8>,
}

impl Writer {
  fn u32(&mut self, v: u32) {
    self.bytes.extend_from_slice(&v.to_le_bytes());
  }
  fn f64(&mut self, v: f64) {
    self.align(8);
    self.bytes.extend_from_slice(&v.to_le_bytes());
  }
  fn align(&mut self, n: usize) {
    while !self.bytes.len().is_multiple_of(n) {
      self.bytes.push(0);
    }
  }
  fn f64s(&mut self, values: &[f64]) {
    self.align(8);
    self.bytes.reserve(values.len() * 8);
    for v in values {
      self.bytes.extend_from_slice(&v.to_le_bytes());
    }
  }
  fn u32s(&mut self, values: &[u32]) {
    self.align(4);
    self.bytes.reserve(values.len() * 4);
    for v in values {
      self.bytes.extend_from_slice(&v.to_le_bytes());
    }
  }
  fn finish(self) -> Vec<u8> {
    self.bytes
  }
}

/// Response to `ensureBody`: cached (status 0) or the mesh is needed (status 1).
pub fn encode_ensure_body(cached: bool, run_id: u32) -> Vec<u8> {
  let mut w = Writer::default();
  w.u32(OP_ENSURE_BODY);
  w.u32(if cached { 0 } else { 1 });
  w.u32(run_id);
  w.finish()
}

pub fn encode_release(released: usize) -> Vec<u8> {
  let mut w = Writer::default();
  w.u32(OP_RELEASE);
  w.u32(released as u32);
  w.finish()
}

pub fn encode_init() -> Vec<u8> {
  let mut w = Writer::default();
  w.u32(OP_INIT);
  w.finish()
}

pub fn encode_validate_solid() -> Vec<u8> {
  let mut w = Writer::default();
  w.u32(OP_VALIDATE_SOLID);
  w.finish()
}

pub fn encode_stats(cached: usize, heap_bytes: f64) -> Vec<u8> {
  let mut w = Writer::default();
  w.u32(OP_STATS);
  w.u32(cached as u32);
  w.f64(heap_bytes);
  w.finish()
}

fn write_component(w: &mut Writer, c: &Component) {
  w.f64(c.volume);
  w.f64(c.area);
  w.u32(c.run_id);
  w.u32((c.verts.len() / 3) as u32);
  w.u32((c.tris.len() / 3) as u32);
  w.u32(c.face_origin.len() as u32);
  for (face, origins) in &c.face_origin {
    w.u32(*face);
    w.u32(origins.len() as u32);
    for (run, id) in origins {
      w.u32(*run);
      w.u32(*id);
    }
  }
  w.f64s(&c.verts);
  w.u32s(&c.tris);
  w.u32s(&c.face_id);
}

fn write_components(w: &mut Writer, components: &[Component]) {
  for component in components {
    write_component(w, component);
  }
}

pub fn encode_push_pull(output: &PushPullOutput) -> Vec<u8> {
  let mut w = Writer::default();
  w.u32(OP_PUSH_PULL);
  match output {
    PushPullOutput::Preview { verts, tris, face_id } => {
      w.u32(1);
      w.u32((verts.len() / 3) as u32);
      w.u32((tris.len() / 3) as u32);
      w.f64s(verts);
      w.u32s(tris);
      w.u32s(face_id);
    }
    PushPullOutput::Full { components, side_face_for_boundary_edge, next_face_id, body_run_id, tool_run_id, moved } => {
      w.u32(0);
      w.u32(u32::from(*moved));
      w.u32(*body_run_id);
      w.u32(*tool_run_id);
      w.u32(side_face_for_boundary_edge.len() as u32);
      w.u32(components.len() as u32);
      for (face, edge) in side_face_for_boundary_edge {
        w.f64(*face);
        w.u32(*edge);
      }
      w.f64(*next_face_id);
      write_components(&mut w, components);
    }
  }
  w.finish()
}

/// Components results share one layout under the op code they answer.
pub fn encode_components(op: u32, output: &ComponentsOutput) -> Vec<u8> {
  let mut w = Writer::default();
  w.u32(op);
  w.u32(output.components.len() as u32);
  w.f64(output.next_face_id);
  write_components(&mut w, &output.components);
  w.finish()
}

pub fn encode_boolean(output: &BooleanOutput) -> Vec<u8> {
  let mut w = Writer::default();
  w.u32(OP_BOOLEAN);
  w.u32(output.a_run_id);
  w.u32(output.b_run_id);
  w.u32(output.components.len() as u32);
  w.u32(output.secondary.len() as u32);
  w.f64(output.next_face_id);
  write_components(&mut w, &output.components);
  write_components(&mut w, &output.secondary);
  w.finish()
}

pub fn encode_edge_blend(output: &EdgeBlendOutput) -> Vec<u8> {
  let mut w = Writer::default();
  w.u32(OP_EDGE_BLEND);
  w.u32(output.body_run_id);
  w.u32(output.tool_run_id);
  w.u32(output.components.len() as u32);
  w.f64(output.next_face_id);
  write_components(&mut w, &output.components);
  w.finish()
}

pub fn encode_hardware(output: &HardwareOutput) -> Vec<u8> {
  let mut w = Writer::default();
  w.u32(OP_HARDWARE);
  w.u32(output.components.len() as u32);
  w.u32(output.mounting_centers.len() as u32);
  w.f64(output.next_face_id);
  for center in &output.mounting_centers {
    w.f64(center[0]);
    w.f64(center[1]);
    w.f64(center[2]);
  }
  write_components(&mut w, &output.components);
  w.finish()
}

/// Status names in the order `decodeFromTriangles` reads them.
const STATUS_NAMES: [&str; 17] = ["NoError", "NonFiniteVertex", "NotManifold", "VertexOutOfBounds", "PropertiesWrongLength", "MissingPositionProperties", "MergeVectorsDifferentLengths", "MergeIndexOutOfBounds", "TransformWrongLength", "RunIndexWrongLength", "FaceIDWrongLength", "InvalidConstruction", "ResultTooLarge", "InvalidTangents", "Cancelled", "Unknown", "UnknownError"];

pub fn encode_from_triangles(output: &FromTrianglesOutput) -> Vec<u8> {
  let mut w = Writer::default();
  w.u32(OP_FROM_TRIANGLES);
  w.u32(STATUS_NAMES.iter().position(|n| *n == output.status).unwrap_or(15) as u32);
  w.u32(output.components.len() as u32);
  w.f64(output.next_face_id);
  write_components(&mut w, &output.components);
  w.finish()
}

pub fn encode_section_cut(output: &SectionCutOutput) -> Vec<u8> {
  let mut w = Writer::default();
  w.u32(OP_SECTION_CUT);
  w.u32(output.loops.len() as u32);
  for l in &output.loops {
    w.u32(l.len() as u32);
  }
  for l in &output.loops {
    w.f64s(l);
  }
  w.finish()
}

pub fn encode_properties(output: &PropertiesOutput) -> Vec<u8> {
  let mut w = Writer::default();
  w.u32(OP_PROPERTIES);
  w.f64s(&[output.volume, output.area, output.genus, output.min[0], output.min[1], output.min[2], output.max[0], output.max[1], output.max[2]]);
  w.finish()
}

#[cfg(test)]
mod tests {
  use super::*;

  fn f64_bytes(values: &[f64]) -> Vec<u8> {
    values.iter().flat_map(|v| v.to_le_bytes()).collect()
  }

  #[test]
  fn decodes_a_push_pull_request() {
    let mut bytes = OP_PUSH_PULL.to_le_bytes().to_vec();
    bytes.extend(f64_bytes(&[7.0, 2.0]));
    bytes.extend(f64_bytes(&[3.0]));
    bytes.extend(1u32.to_le_bytes());
    bytes.extend(f64_bytes(&[0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]));
    bytes.extend(f64_bytes(&[-0.25]));
    bytes.extend(0u32.to_le_bytes());
    bytes.extend(1u32.to_le_bytes());
    bytes.extend(f64_bytes(&[12.0]));
    bytes.extend(1u32.to_le_bytes());
    bytes.extend(4u32.to_le_bytes());
    bytes.extend(f64_bytes(&[0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0]));
    let Request::PushPull(req) = decode_request(&bytes).unwrap() else { panic!("wrong request") };
    assert_eq!((req.body_id, req.version, req.face_id), (7.0, 2.0, 3.0));
    assert!(req.region_is_whole_face && req.preview && !req.new_body);
    assert_eq!(req.next_face_id, 12.0);
    assert_eq!(req.polygon, vec![vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]]);
  }

  #[test]
  fn decodes_a_boolean_request() {
    let mut bytes = OP_BOOLEAN.to_le_bytes().to_vec();
    bytes.extend(3u32.to_le_bytes());
    bytes.extend(f64_bytes(&[1.0, 2.0, 3.0, 4.0, 40.0]));
    let Request::Boolean(req) = decode_request(&bytes).unwrap() else { panic!("wrong request") };
    assert_eq!(req.op, BooleanOp::Split);
    assert_eq!((req.a_body, req.b_body, req.next_face_id), ((1.0, 2.0), (3.0, 4.0), 40.0));
  }

  #[test]
  fn rejects_a_truncated_request() {
    assert!(decode_request(&OP_ENSURE_BODY.to_le_bytes()).is_err());
  }

  #[test]
  fn float64_runs_start_on_eight_byte_boundaries() {
    let output = PushPullOutput::Preview { verts: vec![1.0, 2.0, 3.0], tris: vec![0, 0, 0], face_id: vec![5] };
    let bytes = encode_push_pull(&output);
    // Header is four u32s, so the verts begin at 16.
    assert_eq!(&bytes[16..24], &1.0f64.to_le_bytes());
  }
}
