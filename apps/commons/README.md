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

The initial application supports search, category/license facets, a commercial-permission filter, model detail links and original license/source credits. Published model files can be downloaded as attribution ZIP packages when `VITE_COMMONS_ASSETS_URL` is configured with a file-service origin. Each ZIP contains the unchanged model file and its source, license, conditions and credits. Model pages offer Open in PushForm for supported standalone files. `VITE_PUSHFORM_EDITOR_URL` optionally overrides the default web editor origin; the editor uses its own `VITE_COMMONS_ASSETS_URL`. The handoff carries only model/revision/asset identifiers, survives normal sign-in/onboarding, verifies the current package and creates a separate unsaved model. Unitless STL/OBJ/3DS files ask for units and up axis. Original archives, FCStd and BLEND require download/conversion. 3D previews and in-project insertion are not connected yet. This application has its own build output; the editor's build and deployment are separate. Production publishing runs in the main CI batch. Only the production site is indexable (see Search and sharing).

## Catalog contract

`@pushform/cloud` exports the shared schema (`packages/cloud/src/CommonsCatalog.ts`) used by `src/catalog.ts` to validate the version 1 metadata response. The response is `{ "version": 1, "models": [...] }`, with at most 1,000 models and 2 MiB of JSON text. This is an initial bounded catalog snapshot, not a pagination protocol. Each model has:

- A stable lowercase `id`, published `revision`, title/description, creator, category, tags, formats and ISO publication timestamp.
- An HTTPS `imageUrl` or `null`, and an original `source` with name/URL or `null`.
- One or more `licenses`, each containing its original `name`, `url`, explicit `commercialUse` (`allowed`, `restricted` or `unknown`) and a list of required `conditions`.
- One or more `credits`, with name, URL or `null`, and attribution/notice text.

Published file descriptors contain a stable UUID, filename, format, byte count and SHA-256; older metadata-only snapshots may omit `files` and decode as an empty list. All other fields are required. HTTP URLs are accepted only on localhost for development. Duplicate identifiers, missing licensing/credits, unsafe links and invalid payloads fail the load; no license is inferred or substituted. The commercial filter includes an item only when every included license explicitly permits commercial use. This conservative flag does not replace reading the license or any additional conditions.

The endpoint must expose only approved public metadata, with previews and metadata cleared for distribution. Acquisition manifests and raw source files are not public catalog responses. The producer is responsible for verifying rights, provenance and publication eligibility before emitting records; client validation is not a rights review. Model pages live at `/models/<id>` and creator profiles at `/u/<handle>`; the account, collection and publishing screens stay hash routes. Older `#models/<id>` links still open and move to the model path.

## Search and sharing

Commons is a client-rendered app, so crawlers and link-preview bots would otherwise see an empty shell. Cloudflare Pages Functions in `functions/` (thin wrappers over `src/edge/render.ts`) fill the built `index.html` on each request:

- `/`, `/models/<id>`, `/u/<handle>` and `/collections/<id>` get their own title, description, canonical URL, robots directive, Open Graph and Twitter tags, schema.org JSON-LD (`3DModel`, `ProfilePage`, `CollectionPage`, `WebSite`, breadcrumbs, item lists) and a readable, escaped HTML version of the page inside `#root`, which the app replaces when it starts. The browser keeps the same tags current while people navigate (`src/seo.ts`, shared by both).
- A model that is not published answers 404 with `noindex`. If the catalog cannot be read, the page answers 503 with `Retry-After` (the app still loads), so crawlers retry instead of dropping the page.
- A private, removed or missing collection gets only the generic `noindex` tags, so its address reveals nothing; the app still opens a private collection for its signed-in curator.
- `/sitemap.xml` lists the home page, every model (with its image), each creator and each nonempty public collection; `/robots.txt` points to it.
- Only the host in `VITE_COMMONS_SITE_URL` (default `https://commons.pushform.io`) is indexable. Every other host, such as a preview deployment, gets `X-Robots-Tag: noindex`, `Disallow: /` and no sitemap. Canonical URLs always name the production site.
- The functions read the catalog with the same public settings as the app. The build writes them to `seo-config.json` (public values only), and the catalog is cached at the edge for five minutes, so a newly published model is indexable within minutes without a redeploy.
- Utility screens (account, upload, drafts, new collection) are marked `noindex` in the browser.
- A collection's share image is a 1200 × 630 cover the file service draws from its first four published members' generated thumbnails (`/collection-covers/<id>` on the file host). A collection whose members have no previewable model shares its first member's own picture instead.
- Models without a picture use a product capture from the main site as their share image; a model's own cover image or thumbnail is used when present.

Deploy Pages from this directory (`wrangler pages deploy dist`) so `functions/` and `dist/_routes.json` are included. `pnpm --filter @pushform/app-commons preview` serves the static build only; use `wrangler pages dev dist` to try the functions.

## Collections and featured discovery

With account configuration present, public discovery loads collections and the ordered mixed featured list. Collections are listed at `#collections`, each collection has its own page at `/collections/<uuid>` (older `#collections/<uuid>` links move there), and `#collections/new` creates one. On `/u/<handle>`, owners see My Collections above My Models, including their private collections and drafts, with a New Collection action beside the collections heading. Visitors see public content only. Model detail pages expose Edit model and confirmed Delete model actions to their authenticated owner. Legacy `#my-models` and `#my-collections` links redirect to the owner's profile. Collection ownership, public visibility and admin featuring are enforced by authenticated database operations. New collections default to public, support up to 100 ordered model references, and preserve each member's existing rights. The initial limits are 100 collections per account, 1,000 public collections and 24 featured items. A collection follows the model's current publication; withdrawn models are omitted from its public view.

Commons restores its account session at startup so authorized accounts can see Feature actions directly on details. Only existing Admin/Owner roles can feature; public-profile settings and an account's email spelling do not grant this permission.

## Production deployment

The main CI batch deploys Commons to its own Pages project after the application checks pass. It builds with the Production environment's public Supabase and file-service settings, checks the resulting bundle configuration, uploads `apps/commons/dist`, then verifies that the live Commons HTML and hashed JavaScript/CSS match this build. A successful Commons build in the test job alone does not publish the site. Staging deployments do not publish to the production Commons project.

## Contributor accounts

The independent catalog client remains anonymous and stateless. Account actions use the shared PushForm session separately: initial name/details/Terms onboarding is the same form as the editor, and optional mailing signup starts unchecked. Existing completed accounts skip that form. A public profile is an explicit opt-in with a stable public ID/handle; it never publishes private account details. The Publish model flow saves private drafts and verified files before a deliberate publication action, without staff approval.

Set `VITE_PUSHFORM_EDITOR_URL` only when overriding the default web editor origin for Open in PushForm (HTTPS except localhost). Links carry stable model/revision/asset IDs, never bearer tokens or arbitrary file URLs. The editor and file service must be configured for the same catalog, and the file service must permit the editor/frontend origins. A model opens in a new document after normal sign-in, with source/license notices retained in native files and attribution packages for geometry/image exports.

Featured discovery also supports creators identified by their public profile UUID. Its `creators` array contains public profiles for the visible featured creator entries; older responses without that array decode as empty. Active public profiles are eligible even without published models. Admin/Owner accounts can feature them from profile details or the admin picker.

The featured list also accepts `credited_creator` targets. `creditedCreators` contains source-scoped credit groups (`id`, `displayName`, `sourceName`, `modelIds`); these describe imported models, not user accounts. `#creators/<id>` opens the current public group through the collection client. Missing groups are unavailable, and old discovery responses default to an empty group list.

Configured database browsing uses 24-model pages, server-side filters and two prefetched next pages, including their thumbnail images. A bounded in-memory image cache lets displayed cards reuse prefetched bytes even when HTTP caching is disabled. Scrolling appends results; the visible Load more control is also keyboard accessible. Featured cards request just their visible model references independently of the browse query. Explicit snapshot endpoints retain their full-snapshot contract.
