# PushForm geometry kernel

The one implementation of PushForm's solid modeling operations, in Rust on [Manifold](https://github.com/elalish/manifold) 3.5.4. Everything that changes a solid goes through it: push/pull, booleans, follow-me, revolve, edge blends, section cuts, cabinet hardware and the rest. The TypeScript side (`packages/kernel`) holds the request protocol, the client and the backends that carry requests here.

## Layout

| Path | What it is |
|---|---|
| `src/lib.rs` | Dispatches each request and turns panics and errors into kernel errors |
| `src/wire.rs` | The binary request and response format; the other half is `packages/kernel/src/backends/nativeWire.ts` |
| `src/ops/`, `src/push_pull.rs` | One operation per file |
| `src/finalize.rs`, `src/normalize.rs`, `src/meshio.rs` | The shared tail of every body-producing operation, face grouping and identity, and conversion to and from Manifold |
| `src/cache.rs` | Least-recently-used cache of solids, keyed by body id and version |
| `src/jsmath.rs`, `src/math.rs` | Number handling that has to match exactly (see below) |
| `vendor/` | The Manifold Rust binding, with small changes listed in `vendor/README.md` |
| `build.rs` | Generates the tolerances from `packages/core/src/tolerance.ts`, so the two can't disagree |
| `src/bin/harness.rs` | A test process that lets TypeScript tests drive the native build |

`crates/kernel-wasm` wraps this crate in a C interface for the WebAssembly build.

## Builds

| | WebAssembly | Native |
|---|---|---|
| Used by | The web app, the desktop app, Node tests, the CLI and headless MCP | Desktop builds made with the switch below |
| Default | Yes | No |
| Threads | Single-threaded | Threaded (oneTBB) |
| Built by | `pnpm build:kernel-wasm` (Emscripten) | Cargo, with cmake compiling Manifold |

The native build is off by default. It needs two settings together: the Cargo feature `native-kernel` on the desktop app and `PF_NATIVE_KERNEL=1` when building the web bundle. `pnpm desktop:native` sets both. It has only been tested on Apple Silicon. When it can't finish a request, that request reruns in the WebAssembly worker.

Most contributors don't need either toolchain. See "The compiled module" in `packages/kernel/README.md`.

## Results must be exact

Every build has to produce the same bytes for the same request. A solid's face ids and provenance are stored in documents, and a difference in the last bit of a coordinate can change which triangles merge into a face, which renumbers faces. These rules exist for that reason, so please keep them:

- **Positions cross into Manifold as Float32, around a shared centre** (`src/meshio.rs`), so solids that share a face round it the same way.
- **Math follows V8, not the platform.** `hypot`, `sin`, `cos`, `atan2` and `x ** 3` come from `src/jsmath.rs` and `src/math.rs`. Platform math libraries and other JavaScript engines differ in the last digit on many inputs, and this difference used to make results vary between browsers.
- **Manifold is built with `-ffp-contract=off`,** so a compiler can't fuse multiply-adds differently on different targets.
- **Duplicate edges are removed in one order.** Manifold's threaded `DedupeEdges` reports duplicates in a different order from its sequential path, so the vendored build always uses the sequential one. See `vendor/manifold-csg-sys/patches/0002-sequential-dedupe-edges.patch`.
- **Order must be explicit.** Results are built in insertion order and sorted stably. Don't let the iteration order of a hash map reach a result.
- **Keep intermediate solids alive until a build finishes** where an operation chains unions, as cabinet hardware does. Manifold evaluates lazily, and flattening a chain changes the result.
- **Anything growing with face count must stay near-linear.** `IntHasher` in `src/normalize.rs` mixes its output because float bit patterns have zero low bits, and without that, lookups on large bodies become quadratic. Correctness tests can't catch this kind of slowdown, so it's worth timing a large body when you change this code.

## Changing the kernel

1. Change the Rust. If a request or response changes shape, update `src/wire.rs` and `packages/kernel/src/backends/nativeWire.ts` together, along with `packages/kernel/src/protocol.ts`.
2. Build it with `pnpm build:kernel-wasm`, and add `--faults` to run the failure tests too. You need the Rust and Emscripten versions pinned in `scripts/kernel-wasm-artifact.mjs`, plus cmake.
3. Run the tests. To include the native build, build its test process first, in this directory:

   ```sh
   cargo build --release --features harness --bin pushform-native-kernel-harness
   ```

   Without it, the native comparison tests skip. CI does not build it yet.
4. If `packages/kernel/goldens/kernel-corpus.bin.br` no longer matches, work out why before changing it. To accept an intended change:

   ```sh
   PF_UPDATE_GOLDENS=1 pnpm exec vitest run packages/kernel/src/backends/goldenCorpus.test.ts
   ```

   Put that in its own commit. The test lists the records it rewrote, and the commit message should explain them. Run ids come from one counter across the corpus, so an operation that reserves more of them changes the run ids in every later record. Those differences are expected only if they are run ids and nothing else. Anything else changing is a bug until shown otherwise.
5. After the change is on `main` and CI has published the new module, run `pnpm kernel-wasm:pin` on that commit and commit `packages/kernel/kernel-wasm.lock.json`. Until then, other contributors have to build the module themselves.
