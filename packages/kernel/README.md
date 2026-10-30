# @pushform/kernel

Manifold (`manifold-3d`) wrapper: the worker protocol (`src/protocol.ts`), the ops that run inside the
worker (`src/worker/ops/*`), the backends (`InlineBackend` for Node/CLI, `WorkerBackend` for the
browser) and the typed `KernelClient` with request coalescing and upload tracking.

Tests: `pnpm vitest run --project node packages/kernel` (Node, `InlineBackend`).

## Bundling the worker with Vite

`WorkerBackend` creates `new Worker(new URL('../worker/kernel.worker.ts', import.meta.url), { type: 'module' })`,
which Vite turns into a separate chunk. `manifold-3d` finds `manifold.wasm` through
`new URL('manifold.wasm', import.meta.url)`, which Vite rewrites to an emitted asset *only when the
package is bundled by Rollup*, so the app config needs:

```ts
optimizeDeps: { exclude: ['manifold-3d'] }, // keep esbuild's pre-bundler away from import.meta.url
worker: { format: 'es' },
```

If the wasm still cannot be located in some host, load it explicitly:
`import wasmUrl from 'manifold-3d/manifold.wasm?url'` and pass `{ locateFile: () => wasmUrl }` to the
module factory in `src/worker/ManifoldModule.ts`.
