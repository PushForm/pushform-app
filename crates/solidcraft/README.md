# SolidCraft kernel, carried in PushForm

This directory holds a copy of the B-rep kernel of **SolidCraft** (https://github.com/tangency-labs/solidcraft),
taken from commit `55bea620c79c22feeab1cda5c3931cdf2d7f3939` (version 0.28.0, 2026-10) and adapted here
from that point on. PushForm uses it for reading STEP files (`crates/step-reader`) and does not track
SolidCraft's later development: changes are made in this copy and marked `PushForm:` in the source and in
each crate's manifest, as SolidCraft marks its own changes to the truck crates with `SolidCraft:`.

| Directory | Origin | License |
| --- | --- | --- |
| `kernel/` | SolidCraft `crates/kernel` (solids, tessellation, measures, STEP reading) | MIT OR Apache-2.0, © SolidCraft contributors |
| `geom/` | SolidCraft `crates/geom` (vectors, planes, meshes) | MIT OR Apache-2.0, © SolidCraft contributors |
| `vendor/truck-*`, `vendor/matext4cgmath` | SolidCraft's patched copies of the truck CAD crates (https://github.com/ricosjp/truck), see `vendor/README.md` | Apache-2.0, © RICOS Co. Ltd. |

The license texts are `LICENSE-MIT` and `LICENSE-APACHE` here and `LICENSE` in each vendored crate;
`NOTICE-solidcraft.txt` is SolidCraft's notice file. The rest of PushForm is GPL-3.0-or-later; these
licenses are compatible with it, and the compiled STEP reader (wasm and desktop) contains code under all of them.

Build roots that depend on `kernel/` must repeat the `[patch.crates-io]` table that points the truck crates
at `vendor/` (Cargo applies patches from the root manifest only): see `crates/step-reader/Cargo.toml` and
`apps/desktop/src-tauri/Cargo.toml`. Nothing here is built on its own; `cargo test` in `crates/step-reader`
builds it natively, `pnpm build:step-reader` for WebAssembly.

## PushForm changes

None yet beyond the manifests (workspace tables spelled out, lints inlined).
