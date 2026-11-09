// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! Link flags for the Emscripten module: the ones Manifold's C++ build requires (exceptions, memory growth, stack size),
//! forwarded from `manifold-csg-sys`, and the shape of the module itself: an ES module with no filesystem and no `main`.
fn main() {
  println!("cargo:rerun-if-changed=build.rs");
  println!("cargo:rerun-if-env-changed=DEP_MANIFOLD_LINK_ARGS");
  for arg in std::env::var("DEP_MANIFOLD_LINK_ARGS").unwrap_or_default().split_whitespace() {
    println!("cargo:rustc-link-arg-bins={arg}");
  }
  let exports = ["pf_kernel_alloc", "pf_kernel_free", "pf_kernel_call", "pf_kernel_abort"].map(|name| format!("_{name}")).join(",");
  for arg in [
    // rustc links with emcc, which only adds the C++ runtime for Manifold when asked to.
    "-sDEFAULT_TO_CXX=1".to_string(),
    "-sMODULARIZE=1".to_string(),
    "-sEXPORT_ES6=1".to_string(),
    "-sENVIRONMENT=web,worker,node".to_string(),
    "-sFILESYSTEM=0".to_string(),
    "-sINVOKE_RUN=0".to_string(),
    "-sEXIT_RUNTIME=0".to_string(),
    format!("-sEXPORTED_FUNCTIONS={exports}"),
    "-sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32".to_string(),
  ] {
    println!("cargo:rustc-link-arg-bins={arg}");
  }
}
