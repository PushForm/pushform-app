// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! The PushForm kernel as a library, built natively for the desktop app and to WebAssembly for the web app. It keeps its
//! own cache of solids and answers requests in the binary protocol of [`wire`]. Every operation returns exactly what the
//! golden corpus in `packages/kernel/goldens` records; the corpus was captured from the former TypeScript kernel.
pub mod bvh;
pub mod cache;
pub mod earcut;
#[cfg(feature = "fault-injection")]
pub mod faults;
pub mod finalize;
pub mod jsmath;
pub mod math;
pub mod meshio;
pub mod normalize;
pub mod ops;
pub mod polygon;
pub mod push_pull;
pub mod wire;

pub mod tolerance {
  //! Generated from `packages/core/src/tolerance.ts` by `build.rs`.
  include!(concat!(env!("OUT_DIR"), "/tolerance.rs"));
}

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use cache::{BodyCache, CacheEntry};
use math::js_number_string;
use ops::{autofold, bodies, boolean, decompose, edge_blend, follow_me, from_triangles, hardware, hull, properties, revolve, section_cut, simplify, transform};
use push_pull::Checkpoint;
use tolerance::COPLANAR_TOL;
use wire::Request;

/// Number of (body, version) solids kept alive, the same as the WebAssembly kernel's cache.
const CACHE_CAPACITY: usize = 64;

/// An error for the webview: the fields of the kernel protocol's error info, as JSON.
#[derive(Debug)]
pub struct KernelError {
  pub code: &'static str,
  pub message: String,
  pub details: Option<String>,
}

impl KernelError {
  pub fn invalid(message: &str) -> Self {
    Self { code: "InvalidInput", message: message.to_string(), details: None }
  }
  pub fn invalid_with(message: String, details: String) -> Self {
    Self { code: "InvalidInput", message, details: Some(details) }
  }
  pub fn manifold(message: String) -> Self {
    Self { code: "ManifoldError", message, details: None }
  }
  pub fn manifold_with(message: String, details: String) -> Self {
    Self { code: "ManifoldError", message, details: Some(details) }
  }
  fn aborted() -> Self {
    Self { code: "Aborted", message: "Native kernel request was aborted".to_string(), details: None }
  }
  pub fn internal(message: String) -> Self {
    Self { code: "Internal", message, details: None }
  }
  fn not_cached(body_id: f64, version: f64) -> Self {
    let (id, version_string) = (js_number_string(body_id), js_number_string(version));
    Self { code: "BodyNotCached", message: format!("Body {id} v{version_string} is not cached"), details: Some(format!("{{\"bodyId\":{id},\"version\":{version_string}}}")) }
  }

  /// `{code, message, details?}` as JSON, the form the webview's backend decodes.
  pub fn to_json(&self) -> String {
    let mut out = format!("{{\"code\":\"{}\",\"message\":{}", self.code, json_string(&self.message));
    if let Some(details) = &self.details {
      out.push_str(",\"details\":");
      out.push_str(details);
    }
    out.push('}');
    out
  }
}

fn json_string(s: &str) -> String {
  let mut out = String::with_capacity(s.len() + 2);
  out.push('"');
  for c in s.chars() {
    match c {
      '"' => out.push_str("\\\""),
      '\\' => out.push_str("\\\\"),
      '\n' => out.push_str("\\n"),
      '\r' => out.push_str("\\r"),
      '\t' => out.push_str("\\t"),
      c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
      c => out.push(c),
    }
  }
  out.push('"');
  out
}

/// The kernel: a cache of solids and a generation counter that stops in-flight work when the kernel is reset.
pub struct Kernel {
  cache: Mutex<BodyCache>,
  generation: AtomicU64,
}

impl Default for Kernel {
  fn default() -> Self {
    Self { cache: Mutex::new(BodyCache::new(CACHE_CAPACITY)), generation: AtomicU64::new(0) }
  }
}

/// Stops an op once the kernel has been reset since the request started.
struct Generation<'a> {
  kernel: &'a Kernel,
  start: u64,
}

impl Checkpoint for Generation<'_> {
  fn check(&self) -> Result<(), KernelError> {
    if self.kernel.generation.load(Ordering::SeqCst) == self.start { Ok(()) } else { Err(KernelError::aborted()) }
  }
}

impl Kernel {
  /// Answer one request. A panic inside the kernel is caught here and returned as an error.
  pub fn handle(&self, bytes: &[u8]) -> Result<Vec<u8>, KernelError> {
    catch_unwind(AssertUnwindSafe(|| self.dispatch(bytes))).unwrap_or_else(|panic| {
      let message = panic.downcast_ref::<&str>().map(|s| (*s).to_string()).or_else(|| panic.downcast_ref::<String>().cloned()).unwrap_or_else(|| "panic in the native kernel".to_string());
      Err(KernelError::internal(message))
    })
  }

  /// Drop every cached solid and stop in-flight requests at their next checkpoint. A native boolean already running
  /// finishes on its own thread and its result is dropped.
  pub fn abort_all(&self) {
    self.generation.fetch_add(1, Ordering::SeqCst);
    self.lock_cache().clear();
  }

  fn lock_cache(&self) -> std::sync::MutexGuard<'_, BodyCache> {
    self.cache.lock().unwrap_or_else(|e| e.into_inner())
  }

  pub(crate) fn cached(&self, body_id: f64, version: f64) -> Option<Arc<CacheEntry>> {
    self.lock_cache().get(body_id, version)
  }

  pub(crate) fn insert(&self, body_id: f64, version: f64, entry: Arc<CacheEntry>) {
    self.lock_cache().set(body_id, version, entry);
  }

  /// The cached body, or `BodyNotCached` (the backend re-uploads and retries on this code).
  pub(crate) fn get_body(&self, body_id: f64, version: f64) -> Result<Arc<CacheEntry>, KernelError> {
    self.cached(body_id, version).ok_or_else(|| KernelError::not_cached(body_id, version))
  }

  fn dispatch(&self, bytes: &[u8]) -> Result<Vec<u8>, KernelError> {
    let start = self.generation.load(Ordering::SeqCst);
    let checkpoint = Generation { kernel: self, start };
    #[cfg(test)]
    if bytes.first() == Some(&0xff) {
      panic!("test panic");
    }
    #[cfg(feature = "fault-injection")]
    if let Some(result) = faults::run(bytes) {
      return result;
    }
    let response = match wire::decode_request(bytes)? {
      Request::Init => wire::encode_init(),
      Request::EnsureBody { body_id, version, mesh } => {
        let run_id = bodies::ensure_body(self, body_id, version, mesh, &checkpoint)?;
        wire::encode_ensure_body(run_id.is_some(), run_id.unwrap_or(0))
      }
      Request::PushPull(req) => {
        if !req.distance.is_finite() || req.distance.abs() <= COPLANAR_TOL {
          return Err(KernelError::invalid("pushPull.distance must be a non-zero finite number"));
        }
        let body = self.get_body(req.body_id, req.version)?;
        wire::encode_push_pull(&push_pull::push_pull(&body, &req, &checkpoint)?)
      }
      Request::ExtrudeSketch(req) => wire::encode_push_pull(&push_pull::extrude_sketch(&req, &checkpoint)?),
      Request::Release { body_id, version } => wire::encode_release(self.lock_cache().release(body_id, version)),
      Request::Boolean(req) => wire::encode_boolean(&boolean::boolean(self, &req)?),
      Request::Transform { body, matrix, next_face_id } => wire::encode_components(wire::OP_TRANSFORM, &transform::transform(self, body, &matrix, next_face_id)?),
      Request::Autofold { mesh, next_face_id } => wire::encode_components(wire::OP_AUTOFOLD, &autofold::autofold(&mesh, next_face_id)?),
      Request::SectionCut { body, n, d } => wire::encode_section_cut(&section_cut::section_cut(self, body, n, d)?),
      Request::Properties { body } => wire::encode_properties(&properties::properties(self, body)?),
      Request::FromTriangles { mesh, next_face_id } => wire::encode_from_triangles(&from_triangles::from_triangles(&mesh, next_face_id)?),
      Request::Decompose { body, next_face_id } => wire::encode_components(wire::OP_DECOMPOSE, &decompose::decompose(self, body, next_face_id)?),
      Request::Simplify { body, tolerance, next_face_id } => wire::encode_components(wire::OP_SIMPLIFY, &simplify::simplify(self, body, tolerance, next_face_id)?),
      Request::Hull { bodies: refs, next_face_id } => wire::encode_components(wire::OP_HULL, &hull::hull(self, &refs, next_face_id)?),
      Request::FollowMe(req) => wire::encode_components(wire::OP_FOLLOW_ME, &follow_me::follow_me(&req)?),
      Request::Revolve(req) => wire::encode_components(wire::OP_REVOLVE, &revolve::revolve(&req)?),
      Request::EdgeBlend(req) => wire::encode_edge_blend(&edge_blend::edge_blend(self, &req)?),
      Request::Hardware(req) => wire::encode_hardware(&hardware::hardware(&req)?),
      Request::Stats => wire::encode_stats(self.lock_cache().len(), bodies::heap_bytes()),
      Request::ValidateSolid { mesh } => {
        bodies::validate_solid(&mesh)?;
        wire::encode_validate_solid()
      }
    };
    checkpoint.check()?;
    Ok(response)
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::math::Pt;
  use crate::push_pull::PushPullOutput;
  use crate::wire::{OP_ENSURE_BODY, OP_PUSH_PULL};

  fn box_mesh(min: [f64; 3], max: [f64; 3]) -> (Vec<f64>, Vec<u32>, Vec<u32>) {
    let mut verts = Vec::new();
    for &z in &[min[2], max[2]] {
      for &(x, y) in &[(min[0], min[1]), (max[0], min[1]), (max[0], max[1]), (min[0], max[1])] {
        verts.extend_from_slice(&[x, y, z]);
      }
    }
    #[rustfmt::skip]
    let tris: Vec<u32> = vec![
      4, 5, 6, 4, 6, 7, // top (+z), face 1
      0, 2, 1, 0, 3, 2, // bottom (-z), face 0
      0, 1, 5, 0, 5, 4, // -y, face 2
      1, 2, 6, 1, 6, 5, // +x, face 3
      2, 3, 7, 2, 7, 6, // +y, face 4
      3, 0, 4, 3, 4, 7, // -x, face 5
    ];
    let face_id = vec![1, 1, 0, 0, 2, 2, 3, 3, 4, 4, 5, 5];
    (verts, tris, face_id)
  }

  fn ensure_request(body_id: u64, version: u64, mesh: &(Vec<f64>, Vec<u32>, Vec<u32>)) -> Vec<u8> {
    let mut b = OP_ENSURE_BODY.to_le_bytes().to_vec();
    b.extend((body_id as f64).to_le_bytes());
    b.extend((version as f64).to_le_bytes());
    b.extend(1u32.to_le_bytes());
    b.extend((mesh.0.len() as u32).to_le_bytes());
    b.extend((mesh.1.len() as u32).to_le_bytes());
    b.extend((mesh.2.len() as u32).to_le_bytes());
    for v in &mesh.0 {
      b.extend(v.to_le_bytes());
    }
    for v in &mesh.1 {
      b.extend(v.to_le_bytes());
    }
    for v in &mesh.2 {
      b.extend(v.to_le_bytes());
    }
    b
  }

  struct PullParams {
    body: u64,
    version: u64,
    polygon: Vec<Pt>,
    origin: [f64; 3],
    whole: bool,
    distance: f64,
    preview: bool,
  }

  fn pull_request(p: &PullParams) -> Vec<u8> {
    let mut b = OP_PUSH_PULL.to_le_bytes().to_vec();
    b.extend((p.body as f64).to_le_bytes());
    b.extend((p.version as f64).to_le_bytes());
    b.extend(1.0f64.to_le_bytes()); // face id: top
    b.extend(u32::from(p.whole).to_le_bytes());
    for v in [p.origin, [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]] {
      for c in v {
        b.extend(c.to_le_bytes());
      }
    }
    b.extend(p.distance.to_le_bytes());
    b.extend(0u32.to_le_bytes()); // merge
    b.extend(u32::from(p.preview).to_le_bytes());
    b.extend(6.0f64.to_le_bytes());
    b.extend(1u32.to_le_bytes());
    b.extend((p.polygon.len() as u32).to_le_bytes());
    for point in &p.polygon {
      b.extend(point[0].to_le_bytes());
      b.extend(point[1].to_le_bytes());
    }
    b
  }

  fn square(size: f64) -> Vec<Pt> {
    let h = size / 2.0;
    vec![[-h, -h], [h, -h], [h, h], [-h, h]]
  }

  fn run(kernel: &Kernel, body: u64, p: &PullParams) -> PushPullOutput {
    let mesh = box_mesh([0.0, 0.0, 0.0], [1.0, 1.0, 1.0]);
    kernel.handle(&ensure_request(body, 1, &mesh)).expect("upload");
    let wire::Request::PushPull(req) = wire::decode_request(&pull_request(p)).unwrap() else { panic!("not a pull") };
    let entry = kernel.cache.lock().unwrap().get(body as f64, 1.0).expect("cached");
    push_pull::push_pull(&entry, &req, &Generation { kernel, start: kernel.generation.load(Ordering::SeqCst) }).expect("push/pull")
  }

  fn expect_closed(tris: &[u32]) {
    let mut edges = std::collections::HashMap::new();
    for t in tris.chunks_exact(3) {
      for k in 0..3 {
        let (a, b) = (t[k].min(t[(k + 1) % 3]), t[k].max(t[(k + 1) % 3]));
        *edges.entry((a, b)).or_insert(0) += 1;
      }
    }
    assert!(edges.values().all(|&n| n == 2), "every edge has exactly two triangles");
  }

  #[test]
  fn pulls_a_region_into_a_closed_eleven_face_solid() {
    let kernel = Kernel::default();
    let params = PullParams { body: 1, version: 1, polygon: square(0.2), origin: [0.5, 0.5, 1.0], whole: false, distance: 0.5, preview: false };
    let PushPullOutput::Full { components, side_face_for_boundary_edge, next_face_id, moved, .. } = run(&kernel, 1, &params) else { panic!("expected a full result") };
    assert!(!moved);
    assert_eq!(components.len(), 1);
    let c = &components[0];
    assert!((c.volume - 1.02).abs() < 1e-6, "volume {}", c.volume);
    let faces: std::collections::HashSet<_> = c.face_id.iter().collect();
    assert_eq!(faces.len(), 11);
    assert_eq!(next_face_id, 11.0);
    assert_eq!(side_face_for_boundary_edge.len(), 4);
    expect_closed(&c.tris);
  }

  #[test]
  fn moves_a_whole_face_when_its_neighbours_are_square() {
    let kernel = Kernel::default();
    let params = PullParams { body: 2, version: 1, polygon: square(1.0), origin: [0.5, 0.5, 1.0], whole: true, distance: 1.0, preview: false };
    let PushPullOutput::Full { components, moved, .. } = run(&kernel, 2, &params) else { panic!("expected a full result") };
    assert!(moved);
    assert!((components[0].volume - 2.0).abs() < 1e-6);
    let mut ids: Vec<_> = components[0].face_id.clone();
    ids.sort();
    ids.dedup();
    assert_eq!(ids, vec![0, 1, 2, 3, 4, 5]);
  }

  #[test]
  fn a_preview_of_a_moved_face_is_the_solids_own_triangles() {
    let kernel = Kernel::default();
    let params = PullParams { body: 3, version: 1, polygon: square(1.0), origin: [0.5, 0.5, 1.0], whole: true, distance: 1.0, preview: true };
    let PushPullOutput::Preview { verts, tris, face_id } = run(&kernel, 3, &params) else { panic!("expected a preview") };
    assert_eq!(tris.len(), 36);
    assert_eq!(face_id.len(), 12);
    assert!(verts.iter().skip(2).step_by(3).any(|&z| (z - 2.0).abs() < 1e-9));
    expect_closed(&tris);
  }

  #[test]
  fn a_preview_of_a_cut_is_normalized_faces_without_a_rebuild() {
    let kernel = Kernel::default();
    let params = PullParams { body: 4, version: 1, polygon: square(0.2), origin: [0.5, 0.5, 1.0], whole: false, distance: 0.5, preview: true };
    let PushPullOutput::Preview { tris, face_id, .. } = run(&kernel, 4, &params) else { panic!("expected a preview") };
    let faces: std::collections::HashSet<_> = face_id.iter().collect();
    assert_eq!(faces.len(), 11);
    expect_closed(&tris);
  }

  #[test]
  fn an_unknown_body_asks_for_an_upload_through_its_error() {
    let kernel = Kernel::default();
    let bytes = pull_request(&PullParams { body: 99, version: 7, polygon: square(1.0), origin: [0.0, 0.0, 0.0], whole: false, distance: 1.0, preview: false });
    let error = kernel.handle(&bytes).unwrap_err();
    assert_eq!(error.code, "BodyNotCached");
    assert_eq!(error.details.as_deref(), Some("{\"bodyId\":99,\"version\":7}"));
    assert!(error.to_json().contains("\"message\":\"Body 99 v7 is not cached\""));
  }

  #[test]
  fn a_panic_in_the_kernel_becomes_an_error() {
    let kernel = Kernel::default();
    let error = kernel.handle(&[0xff]).unwrap_err();
    assert_eq!(error.code, "Internal");
    assert!(error.message.contains("test panic"));
    // The kernel stays usable afterwards.
    kernel.handle(&ensure_request(5, 1, &box_mesh([0.0, 0.0, 0.0], [1.0, 1.0, 1.0]))).unwrap();
  }

  #[test]
  fn abort_clears_the_cache_and_later_requests_work() {
    let kernel = Kernel::default();
    let mesh = box_mesh([0.0, 0.0, 0.0], [1.0, 1.0, 1.0]);
    kernel.handle(&ensure_request(6, 1, &mesh)).unwrap();
    kernel.abort_all();
    let bytes = pull_request(&PullParams { body: 6, version: 1, polygon: square(0.2), origin: [0.5, 0.5, 1.0], whole: false, distance: 0.5, preview: false });
    assert_eq!(kernel.handle(&bytes).unwrap_err().code, "BodyNotCached");
    kernel.handle(&ensure_request(6, 1, &mesh)).unwrap();
    kernel.handle(&bytes).unwrap();
  }

  #[test]
  fn tolerance_constants_match_the_typescript_kernel() {
    assert_eq!(tolerance::COPLANAR_TOL, 1e-5);
    assert_eq!(tolerance::MERGE_TOL, 2.54e-5);
    assert_eq!(tolerance::AREA_TOL, 1e-10);
  }

  #[test]
  fn hypot_matches_javascript_on_sample_values() {
    // Math.hypot values captured from Node on these exact inputs.
    assert_eq!(math::hypot3(0.1, 0.2, 0.3), 0.37416573867739417);
    assert_eq!(math::hypot2(1e-7, 3.3333333333333335e-8), 1.0540925533894598e-7);
    assert_eq!(math::hypot3(1.0, 1.0, 1.0), 1.7320508075688772);
  }
}
