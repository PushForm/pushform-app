# PushForm

2D/3D push/pull modeling software for Carpenters, Architects, and Landcapers. Available for desktop and web, with Fusion 360-style cloud revision history and client publishing.

## Stack

TypeScript monorepo (pnpm). Geometry kernel: [Manifold](https://github.com/elalish/manifold) (wasm, in a Web Worker). Renderer: three.js (WebGL2). UI: React. Desktop: Tauri 2. Cloud: Supabase.

## Develop

```sh
corepack enable            # provides pnpm
pnpm install
pnpm dev                   # web app at http://localhost:5174 (uses apps/web/.env.local)
pnpm commons:dev           # community catalog frontend at http://localhost:5176
pnpm commons:build         # build the independent catalog frontend
pnpm desktop               # Tauri desktop app (needs Rust)
pnpm test                  # unit tests (vitest)
pnpm typecheck
pnpm lint
pnpm license-check         # fails on licenses that are not GPLv3-compatible
```

The app requires sign-in and stores documents in Supabase. Point `apps/web/.env.local` at a Supabase project (see [apps/web/.env.example](apps/web/.env.example)).

## Layout

```
packages/   core geom kernel model inference commands render io ui mcp cloud testing
apps/       web desktop commons
docs/help/  user-facing help guides
```

The standalone Commons frontend has its own build and catalog configuration; see [apps/commons](apps/commons/README.md).

## License

GPL-3.0-or-later (see LICENSE). Dependencies must be GPLv3-compatible: permissive licenses, LGPL, GPL-3.0 and GPL-2.0-or-later are allowed; GPL-2.0-only and AGPL are not. First-party source files carry an SPDX tag; `pnpm spdx-check` fails when one is missing.

## Disclaimer

SketchUp and LayOut are trademarks and copyrighted works of Trimble Inc. PushForm is made by JobCraft, Inc. and is not affiliated with, endorsed by, or sponsored by Trimble. References to SketchUp and LayOut describe file-format compatibility only.

