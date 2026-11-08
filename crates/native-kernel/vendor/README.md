# Vendored crates

`manifold-csg` 0.4.1 and `manifold-csg-sys` 3.5.105 (Apache-2.0 OR MIT, https://github.com/zmerlynn/manifold-csg), carried
here because the native kernel needs one thing their published versions do not offer: giving a mesh its per-triangle
face ids when building a `MeshGL`. Everything else builds Manifold exactly as the crates do.

Changes from the published crates:

- `manifold-csg-sys/patches/0001-meshgl-set-face-id.patch`: adds `manifold_meshgl_set_face_id` to Manifold's C API (the
  crate's build applies patches in that directory after cloning Manifold).
- `manifold-csg-sys/src/lib.rs` declares that function; `manifold-csg/src/mesh.rs` adds `MeshGL::set_face_id`.
- `manifold-csg-sys/build/build.rs` builds Manifold with `-ffp-contract=off`, so double-precision results match the
  WebAssembly build, which never fuses multiply-adds.
- Unused pieces of the crates (examples, tests, the wasm32-unknown-unknown build support) are left out.

Dropping these would be possible if upstream's C API gains a way to set face ids.
