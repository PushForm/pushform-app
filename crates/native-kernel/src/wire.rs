// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! The binary kernel protocol (little-endian). Requests are one byte buffer starting with an opcode; responses start
//! with the opcode. Typed sections in a response are padded so a Float64 run starts on an 8-byte boundary and a Uint32
//! run on a 4-byte boundary, so the webview can read them without copying through JSON.
use crate::finalize::Component;
use crate::math::Pt;
use crate::push_pull::{Basis, PushPullOutput, PushPullRequest};
use crate::KernelError;

pub const OP_ENSURE_BODY: u32 = 1;
pub const OP_PUSH_PULL: u32 = 2;
pub const OP_RELEASE: u32 = 3;

pub struct Mesh {
  pub verts: Vec<f64>,
  pub tris: Vec<u32>,
  pub face_id: Vec<u32>,
}

pub enum Request {
  EnsureBody { body_id: u64, version: u64, mesh: Option<Mesh> },
  PushPull(PushPullRequest),
  Release { body_id: u64, version: Option<u64> },
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
  fn id(&mut self) -> Result<u64, KernelError> {
    Ok(self.f64()? as u64)
  }
  fn f64s(&mut self, n: usize) -> Result<Vec<f64>, KernelError> {
    let raw = self.take(n * 8)?;
    Ok(raw.chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect())
  }
  fn u32s(&mut self, n: usize) -> Result<Vec<u32>, KernelError> {
    let raw = self.take(n * 4)?;
    Ok(raw.chunks_exact(4).map(|c| u32::from_le_bytes(c.try_into().unwrap())).collect())
  }
  fn vec3(&mut self) -> Result<[f64; 3], KernelError> {
    Ok([self.f64()?, self.f64()?, self.f64()?])
  }
}

pub fn decode_request(bytes: &[u8]) -> Result<Request, KernelError> {
  let mut r = Reader { bytes, at: 0 };
  match r.u32()? {
    OP_ENSURE_BODY => {
      let (body_id, version) = (r.id()?, r.id()?);
      let mesh = if r.u32()? != 0 {
        let (num_verts, num_tris) = (r.u32()? as usize, r.u32()? as usize);
        Some(Mesh { verts: r.f64s(num_verts * 3)?, tris: r.u32s(num_tris * 3)?, face_id: r.u32s(num_tris)? })
      } else {
        None
      };
      Ok(Request::EnsureBody { body_id, version, mesh })
    }
    OP_PUSH_PULL => {
      let (body_id, version) = (r.id()?, r.id()?);
      let face_id = r.u32()?;
      let region_is_whole_face = r.u32()? != 0;
      let basis = Basis { origin: r.vec3()?, u: r.vec3()?, v: r.vec3()?, n: r.vec3()? };
      let distance = r.f64()?;
      let new_body = r.u32()? != 0;
      let preview = r.u32()? != 0;
      let next_face_id = r.f64()? as i64;
      let num_contours = r.u32()? as usize;
      let counts = r.u32s(num_contours)?;
      let mut polygon: Vec<Vec<Pt>> = Vec::with_capacity(num_contours);
      for count in counts {
        let coords = r.f64s(count as usize * 2)?;
        polygon.push(coords.chunks_exact(2).map(|p| [p[0], p[1]]).collect());
      }
      Ok(Request::PushPull(PushPullRequest { body_id, version, face_id, basis, polygon, region_is_whole_face, distance, new_body, preview, next_face_id }))
    }
    OP_RELEASE => {
      let body_id = r.id()?;
      let has_version = r.u32()? != 0;
      let version = r.id()?;
      Ok(Request::Release { body_id, version: if has_version { Some(version) } else { None } })
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
        w.u32(*face);
        w.u32(*edge);
      }
      w.f64(*next_face_id as f64);
      for component in components {
        write_component(&mut w, component);
      }
    }
  }
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
    bytes.extend(3u32.to_le_bytes());
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
    assert_eq!((req.body_id, req.version, req.face_id), (7, 2, 3));
    assert!(req.region_is_whole_face && req.preview && !req.new_body);
    assert_eq!(req.next_face_id, 12);
    assert_eq!(req.polygon, vec![vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]]);
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
