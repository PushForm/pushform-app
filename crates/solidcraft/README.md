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

Marked `PushForm:` in the source.

- Manifests: workspace tables spelled out, lints inlined, `rust-version` kept.
- **Threads behind a feature, not the target.** The kernel's parallel helpers (`kernel/src/par.rs`,
  `step_in/parallel.rs`, `measure.rs`) and the tessellator's rayon use (`vendor/truck-meshalgo`) were gated on
  `not(target_arch = "wasm32")`. They are now behind a `threads` feature (on by default; `truck-meshalgo/threads`),
  so the WebAssembly build for `wasm32-wasip1-threads` converts on threads too, and the plain wasm build turns it off.
- **`set_threads` / `threads`** (`par.rs`): the host tells the kernel how many threads it offers, since
  `available_parallelism` knows nothing in WebAssembly. Natively it also sizes rayon's global pool; in the browser the
  pool is left alone (its threads left the main instance waiting forever under Chromium and WebKit; the plain threads
  of `map_on_threads` run fine), so `map` runs serially there.
- **Reading a piece at a time, with the bodies on the way** (`step_in/mod.rs`): `StepReading::with_workers` is
  public; `tree()` and `planned()` expose the assembly as planned, by planned solid index, before anything is
  converted; `converted_bodies()` yields the bodies converted so far with those indices, so a caller can mesh or show
  parts while the rest convert. `ImportedBody` already shared its solid, so handing bodies out is cheap.
- **Conversion order** (`step_in/mod.rs`, `Reader::order`): the planned solids are converted by face count, the
  heaviest first when workers share the work (one large part runs beside the rest instead of after them), the
  lightest first on one thread (a caller showing parts as they come sees most of them early). `solid_faces` counts a
  solid's faces through its shells from the parsed file.
