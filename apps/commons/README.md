# PushForm Commons

Independent React/Vite frontend for the community model catalog. The catalog shell does not import the modeling editor, geometry kernel or renderer.

From the repository root:

```sh
pnpm install
pnpm commons:dev       # http://localhost:5176
pnpm commons:build     # apps/commons/dist
pnpm --filter @pushform/app-commons preview
pnpm exec vitest run apps/commons
```

Without configuration the app explains that the catalog is not available yet. It does not display sample models as published content. To connect a public read-only catalog, copy `.env.example` to `.env.local` and set `VITE_COMMONS_CATALOG_URL`. The value is public build-time configuration; never put credentials or private-file URLs in it. Cross-origin endpoints must explicitly allow the frontend origin through CORS. Requests omit cookies and credentials and do not follow redirects.

Alternatively configure `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` (or a legacy anon key) to load the reviewed catalog RPC. These are public client settings. An explicit snapshot endpoint takes precedence. This read-only client does not persist a user session or consume the editor's authentication callback. A disabled catalog shows unavailable; partial/invalid configuration shows a load failure.

The initial application supports search, category/license facets, a commercial-permission filter, model detail links and original license/source credits. Published model files can be downloaded as attribution ZIP packages when `VITE_COMMONS_ASSETS_URL` is configured with a file-service origin. Each ZIP contains the unchanged model file and its source, license, conditions and credits. 3D previews, editor insertion, accounts and social actions are not connected yet. This application has its own build output; the editor's build and deployment are separate. Production hosting is not configured here. Preview builds disallow indexing.

## Catalog contract

`@pushform/cloud` exports the shared schema (`packages/cloud/src/CommonsCatalog.ts`) used by `src/catalog.ts` to validate the version 1 metadata response. The response is `{ "version": 1, "models": [...] }`, with at most 1,000 models and 2 MiB of JSON text. This is an initial bounded catalog snapshot, not a pagination protocol. Each model has:

- A stable lowercase `id`, published `revision`, title/description, creator, category, tags, formats and ISO publication timestamp.
- An HTTPS `imageUrl` or `null`, and an original `source` with name/URL or `null`.
- One or more `licenses`, each containing its original `name`, `url`, explicit `commercialUse` (`allowed`, `restricted` or `unknown`) and a list of required `conditions`.
- One or more `credits`, with name, URL or `null`, and attribution/notice text.

Published file descriptors contain a stable UUID, filename, format, byte count and SHA-256; older metadata-only snapshots may omit `files` and decode as an empty list. All other fields are required. HTTP URLs are accepted only on localhost for development. Duplicate identifiers, missing licensing/credits, unsafe links and invalid payloads fail the load; no license is inferred or substituted. The commercial filter includes an item only when every included license explicitly permits commercial use. This conservative flag does not replace reading the license or any additional conditions.

The endpoint must expose only approved public metadata, with previews and metadata cleared for distribution. Acquisition manifests and raw source files are not public catalog responses. The producer is responsible for verifying rights, provenance and publication eligibility before emitting records; client validation is not a rights review. Model links currently use `#models/<id>` so direct links work on a static host without rewrites.
