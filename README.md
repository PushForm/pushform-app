# PushForm

2D/3D push/pull modeling software for Carpenters, Architects, and Landcapers. Available for desktop and web, with Fusion 360-style cloud revision history and client publishing.

## Stack

TypeScript monorepo (pnpm). Geometry kernel: Rust on [Manifold](https://github.com/elalish/manifold), compiled to WebAssembly and run in a Web Worker. Renderer: three.js (WebGL2). UI: React. Desktop: Tauri 2. Cloud: Supabase.

## Develop

The kernel needs Rust, Emscripten and cmake. The tested versions are in `scripts/kernel-wasm-artifact.mjs`:

```sh
rustup target add wasm32-unknown-emscripten wasm32-wasip1 wasm32-wasip1-threads   # tested with Rust 1.98
brew install cmake emscripten                 # macOS; elsewhere, install cmake and use emsdk for Emscripten 6.0.13
```

```sh
corepack enable            # provides pnpm
pnpm install
pnpm build:kernel-wasm     # compile the WebAssembly kernel; do this first, and again when its sources change
pnpm build:dwg-reader      # compile the DWG reader; pnpm build and pnpm dev need it
pnpm build:step-reader     # compile the STEP reader; pnpm build and pnpm dev need it
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
The hosted schema is not published. For a fresh project, [supabase/minimal/documents.sql](supabase/minimal/documents.sql) sets up sign-in profiles and cloud documents (run it once in the SQL editor); Commons, billing, AI Chat and exports stay unavailable.

## Live agent bridge (MCP)

An AI agent on your computer, such as Claude Code or Claude Desktop, can edit the 3D model that is open in PushForm, and you watch each change land in the viewport. `pushform-mcp --live` is an MCP server that the agent starts. It listens on `ws://127.0.0.1:47615`, which only this computer can reach. The app pairs with it using a code you choose. The agent gets the same model tools and editing rules as AI Chat, but nothing goes through a backend, so AI Chat doesn't need to be set up. See [packages/mcp](packages/mcp/README.md) for details.

1. **Build and run the app.** Follow the steps in Develop above (`pnpm install`, the three `build:*` commands, `apps/web/.env.local`), then run `pnpm dev` and open http://localhost:5174 in Chrome. The desktop app hasn't been tested with the bridge yet.
2. **Pick a pairing code**, for example `MY-CODE-1234`. It needs at least 6 letters or digits, and case and dashes don't matter. When the code is fixed, the app reconnects on its own every time the agent restarts the server. Without `--code`, the server makes up a new code each time it starts.
3. **Add the server to your agent.** Use the absolute path of your checkout.

   Claude Code:

   ```sh
   claude mcp add --scope user pushform -- node /path/to/pushform-app/packages/mcp/bin/pushform-mcp.mjs --live --code MY-CODE-1234
   claude mcp list            # pushform should show as connected
   ```

   Claude Desktop: open Settings › Developer › Edit Config and add the entry below to `claude_desktop_config.json`, then quit Claude and reopen it. Claude Desktop doesn't use your shell's PATH, so `command` has to be the full path to Node (`which node` prints it).

   ```json
   {
     "mcpServers": {
       "pushform": {
         "command": "/full/path/to/node",
         "args": ["/path/to/pushform-app/packages/mcp/bin/pushform-mcp.mjs", "--live", "--code", "MY-CODE-1234"]
       }
     }
   }
   ```

   Only one `--live` server can use a port. If you set up both agents, add `--port 47616` to one of them.
4. **Connect the app.** Open a 3D model, click **Connect agent** in the status bar, enter port `47615` and your code, and click Connect. The dot turns green and the label reads **Agent connected**. While it reads "Waiting for agent…", the app retries every few seconds until the server is running.
5. **Try it.** Ask the agent something like: *"Use the pushform tools. Check the status, read the open model, build a bookshelf 80 cm wide, 30 cm deep and 180 cm tall with 4 shelves, check for overlaps and render it."* Each batch of changes is one Undo step, named "External agent: …".

| Problem | Fix |
| --- | --- |
| "The pairing code does not match" | Enter the same code as `--code`. |
| Stuck on "Waiting for agent…" | The server isn't running. Check `claude mcp list`, or Settings › Developer in Claude Desktop. |
| `cannot listen on 127.0.0.1:47615` | Another `--live` server already uses the port (`lsof -i :47615`). Stop it or use `--port`. |
| "No PushForm window is connected" | Connect from the status bar, with a 3D model tab active (not Home or a Layout). |
| "Another PushForm window connected" | Only one window or tab can be paired at a time, and the newest one wins. |

`pushform-mcp --headless [model.pf]` is the other mode. It edits a model in memory with no window. It offers the same model tools except `model_view` and `model_render`, which need a viewport, plus the registry commands.

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

## Disclaimer

SketchUp and LayOut are trademarks and copyrighted works of Trimble Inc. PushForm is made by JobCraft, Inc. and is not affiliated with, endorsed by, or sponsored by Trimble. References to SketchUp and LayOut describe file-format compatibility only.

