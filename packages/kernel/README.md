# @pushform/kernel

The geometry kernel's TypeScript side: the protocol (`src/protocol.ts`), the typed `KernelClient` with request coalescing
and upload tracking, and the backends that carry requests to the kernel. The kernel itself is one Rust implementation
(`crates/native-kernel`) built to WebAssembly (`crates/kernel-wasm`) and, behind a build switch, natively for the desktop
app.

- `InlineBackend` runs the WebAssembly module on the calling thread: Node tests, the CLI and headless MCP.
- `createRustWasmBackend` (in `src/rustWasm.ts`, the `@pushform/kernel/rust-wasm` entry) runs it in a Web Worker, which is
  what the web and desktop apps use.
- `NativeKernelBackend` talks to the native build over Tauri's binary IPC and falls back to the WebAssembly worker.

Requests are encoded for the kernel by `src/backends/nativeWire.ts`, the other half of `crates/native-kernel/src/wire.rs`.

Tests: `pnpm vitest run --project node packages/kernel`.

## The compiled module

The kernel module is built from Rust and C++ that most contributors cannot compile. `pnpm install` downloads the prebuilt
module matching the current sources; `pnpm fetch:kernel-wasm` does the same on demand, and `pnpm build:kernel-wasm` builds it
locally (needs the pinned Rust and Emscripten, see `scripts/kernel-wasm-artifact.mjs`) and overrides any downloaded one.
`pnpm test` and production web builds stop with a message if the module is missing or stale.

Modules are addressed by a hash over the kernel crates, the vendored binding, the build script and the pinned toolchain.
CI publishes each one to a GitHub Release tagged `kernel-wasm-<hash>`, and `packages/kernel/kernel-wasm.lock.json` records
its checksums, so a download that does not match is refused. After a change to the kernel lands on main and CI has
published its module, run `pnpm kernel-wasm:pin` and commit the lock file so everyone else gets the new module.

## Golden corpus

`goldens/kernel-corpus.bin.br` is the record of what every kernel operation answers: requests and their exact results,
compared bit for bit by `src/backends/goldenCorpus.test.ts`. It was captured from the former TypeScript kernel on V8 and
is only ever changed on purpose, one verified record at a time (`src/backends/goldenCorpus.ts`).

## Bundling the worker with Vite

The kernel's worker is `new Worker(new URL('./worker/rustKernel.worker.ts', import.meta.url), { type: 'module' })` in
`src/rustWasm.ts`, which Vite turns into a separate chunk. The Emscripten glue finds its `.wasm` through
`new URL('pushform_kernel.wasm', import.meta.url)`, so the app config only needs `worker: { format: 'es' }`.
