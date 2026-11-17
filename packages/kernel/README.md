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

The kernel module is compiled from Rust and C++ and is not committed. `pnpm build:kernel-wasm` builds it, using the Rust and
Emscripten versions pinned in `scripts/kernel-wasm-artifact.mjs`, plus cmake. See "Develop" in the root README for setup.
Each build is stamped with a hash over the kernel crates, the vendored binding, the build script and the pinned toolchain.
`pnpm test` and production web builds stop with a message if the module is missing or no longer matches its sources, so
run `pnpm build:kernel-wasm` again after pulling a kernel change. CI builds it too, caching by that hash.

## Golden corpus

`goldens/kernel-corpus.bin.br` is the record of what every kernel operation answers: requests and their exact results,
compared bit for bit by `src/backends/goldenCorpus.test.ts`. Its answers were checked against the former TypeScript kernel
on V8 before that kernel was removed, and it only changes on purpose (`src/backends/goldenCorpus.ts`).

To change the kernel, see `crates/native-kernel/README.md`: it covers how the operations are laid out, the rules that keep
every build's results identical, and what to do when a golden record changes.

## Bundling the worker with Vite

The kernel's worker is `new Worker(new URL('./worker/rustKernel.worker.ts', import.meta.url), { type: 'module' })` in
`src/rustWasm.ts`, which Vite turns into a separate chunk. The Emscripten glue finds its `.wasm` through
`new URL('pushform_kernel.wasm', import.meta.url)`, so the app config only needs `worker: { format: 'es' }`.
