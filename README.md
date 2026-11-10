# PushForm

2D/3D push/pull modeling software for Carpenters, Architects, and Landcapers. Available for desktop and web, with Fusion 360-style cloud revision history and client publishing.

## Stack

TypeScript monorepo (pnpm). Geometry kernel: Rust on [Manifold](https://github.com/elalish/manifold), compiled to WebAssembly and run in a Web Worker. Renderer: three.js (WebGL2). UI: React. Desktop: Tauri 2. Cloud: Supabase.

## Develop

The kernel needs Rust, Emscripten and cmake. The tested versions are in `scripts/kernel-wasm-artifact.mjs`:

```sh
rustup target add wasm32-unknown-emscripten   # tested with Rust 1.98
brew install cmake emscripten                 # macOS; elsewhere, install cmake and use emsdk for Emscripten 6.0.13
```

```sh
corepack enable            # provides pnpm
pnpm install
pnpm build:kernel-wasm     # compile the WebAssembly kernel; do this first, and again when its sources change
pnpm dev                   # web app at http://localhost:5174 (uses apps/web/.env.local)
pnpm commons:dev           # community catalog frontend at http://localhost:5176
pnpm commons:build         # build the independent catalog frontend
pnpm desktop               # Tauri desktop app (needs Rust)
pnpm test                  # unit tests (vitest); stops with a message if the kernel module is missing or stale
pnpm typecheck
pnpm lint
pnpm license-check         # fails on licenses that are not GPLv3-compatible
```

The app requires sign-in and stores documents in Supabase. Point `apps/web/.env.local` at a Supabase project (see [apps/web/.env.example](apps/web/.env.example)).

## Layout

```
packages/   core geom kernel model inference commands render io ui mcp cloud testing
apps/       web desktop commons
docs/       documentation site published at docs.pushform.io
docs/help/  in-app help guides that AI Chat searches (not part of the site)
```

The standalone Commons frontend has its own build and catalog configuration; see [apps/commons](apps/commons/README.md).
The documentation site has its own build; see [docs](docs/README.md).

## License

GPL-3.0-or-later (see LICENSE). Dependencies must be GPLv3-compatible: permissive licenses, LGPL, GPL-3.0 and GPL-2.0-or-later are allowed; GPL-2.0-only and AGPL are not. First-party source files carry an SPDX tag; `pnpm spdx-check` fails when one is missing.

Icons come from the sets bundled by `react-icons` (MIT). The Game Icons set (`react-icons/gi`, used for the `saw-blade` icon) is by Lorc, Delapouite and contributors at [game-icons.net](https://game-icons.net/), licensed [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/); the About dialog carries this credit.

## Disclaimer

SketchUp and LayOut are trademarks and copyrighted works of Trimble Inc. PushForm is made by JobCraft, Inc. and is not affiliated with, endorsed by, or sponsored by Trimble. References to SketchUp and LayOut describe file-format compatibility only.

