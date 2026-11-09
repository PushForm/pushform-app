// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! Generates `tolerance.rs` from `packages/core/src/tolerance.ts`, so the kernel can never disagree with the rest of the
//! app about a tolerance.
use std::{env, fs, path::Path};

const NAMES: [&str; 3] = ["COPLANAR_TOL", "MERGE_TOL", "AREA_TOL"];

fn main() {
  let manifest = env::var("CARGO_MANIFEST_DIR").unwrap();
  let source = Path::new(&manifest).join("../../packages/core/src/tolerance.ts");
  println!("cargo:rerun-if-changed={}", source.display());
  println!("cargo:rerun-if-changed=build.rs");
  let text = fs::read_to_string(&source).unwrap_or_else(|e| panic!("cannot read {}: {e}", source.display()));
  let mut out = String::new();
  for name in NAMES {
    let needle = format!("export const {name} = ");
    let start = text.find(&needle).unwrap_or_else(|| panic!("{name} not found in {}", source.display())) + needle.len();
    let literal = text[start..].split(';').next().unwrap().trim();
    let value: f64 = literal.parse().unwrap_or_else(|_| panic!("{name} = {literal} is not a plain number"));
    out.push_str(&format!("pub const {name}: f64 = {value:?};\n"));
  }
  fs::write(Path::new(&env::var("OUT_DIR").unwrap()).join("tolerance.rs"), out).unwrap();
}
