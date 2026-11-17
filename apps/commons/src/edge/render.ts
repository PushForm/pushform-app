// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { catalogModelSchema, commonsCollectionSchema, commonsProfileImageUrl, commonsPublicProfileSchema, parseCommonsCatalog, type CatalogModel, type CommonsCollection } from '@pushform/cloud/catalog';
import {
  browseSearchPath, collectionPath, collectionSeo, escapeHtml, headTags, homeSeo, modelImageUrl, modelPath, modelSeo, normalizeSiteUrl, profilePathFor, profileSeo, utilitySeo,
  type SeoContext, type SeoMeta,
} from '../seo';

/** Server-side rendering of Commons search and social tags. The Pages Functions in `functions/` call these; the app
 * itself stays a static single-page build and takes over in the browser. */
export interface EdgeEnv { ASSETS: { fetch(request: Request): Promise<Response> } }
export interface SeoConfig { siteUrl: string; supabaseUrl: string; publishableKey: string; catalogUrl: string; filesUrl: string }
export interface EdgeCache { match(key: string): Promise<Response | undefined>; put(key: string, response: Response): Promise<void> }
export interface EdgeDeps { fetcher?: typeof fetch; cache?: EdgeCache | null; now?: () => number }
export type PageRoute = { kind: 'home' } | { kind: 'model'; id: string } | { kind: 'profile'; handle: string } | { kind: 'collection'; id: string };

const CACHE_SECONDS = 300;
const MODEL_ID = /^[a-z0-9][a-z0-9-]{0,95}$/;
const HANDLE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
const COLLECTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const configSchema = z.object({ siteUrl: z.string().optional(), supabaseUrl: z.string().optional(), publishableKey: z.string().optional(),
  catalogUrl: z.string().optional(), filesUrl: z.string().optional() });

/** `seo-config.json` is written at build time from the same public settings as the app bundle. */
export async function loadSeoConfig(env: EdgeEnv, origin: string): Promise<SeoConfig> {
  let raw: z.infer<typeof configSchema> = {};
  try {
    const response = await env.ASSETS.fetch(new Request(new URL('/seo-config.json', origin)));
    if (response.ok) raw = configSchema.parse(await response.json());
  } catch { /* an absent or malformed file leaves the defaults */ }
  return { siteUrl: normalizeSiteUrl(raw.siteUrl), supabaseUrl: raw.supabaseUrl ?? '', publishableKey: raw.publishableKey ?? '',
    catalogUrl: raw.catalogUrl ?? '', filesUrl: raw.filesUrl ?? '' };
}
const contextOf = (config: SeoConfig): SeoContext => ({ siteUrl: config.siteUrl, filesUrl: config.filesUrl || undefined });
/** Only the production site is indexable; previews and staging copies tell crawlers to stay away. */
export const isIndexableHost = (request: Request, config: SeoConfig): boolean => new URL(request.url).hostname === new URL(config.siteUrl).hostname;

export type Loaded<T> = { kind: 'ok'; value: T } | { kind: 'unavailable' } | { kind: 'error' };

async function cached<T>(key: string, deps: EdgeDeps, produce: () => Promise<Loaded<T>>): Promise<Loaded<T>> {
  const cacheKey = `https://seo-cache.invalid/${encodeURIComponent(key)}`;
  const hit = await deps.cache?.match(cacheKey).catch(() => undefined);
  if (hit) { try { return { kind: 'ok', value: (await hit.json()) as T }; } catch { /* refetch */ } }
  const result = await produce();
  if (result.kind === 'ok' && deps.cache) {
    await deps.cache.put(cacheKey, new Response(JSON.stringify(result.value), { headers: { 'Cache-Control': `public, max-age=${CACHE_SECONDS}`, 'Content-Type': 'application/json' } })).catch(() => undefined);
  }
  return result;
}

async function rpc(config: SeoConfig, name: string, args: object, deps: EdgeDeps): Promise<{ status: number; body: unknown }> {
  const response = await (deps.fetcher ?? fetch)(`${config.supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc/${name}`, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000),
    headers: { apikey: config.publishableKey, Authorization: `Bearer ${config.publishableKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await response.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* leave null */ }
  return { status: response.status, body };
}
const isUnavailable = (body: unknown): boolean => typeof body === 'object' && body !== null && JSON.stringify(body).includes('commons_unavailable');

export function loadCatalog(config: SeoConfig, deps: EdgeDeps = {}): Promise<Loaded<CatalogModel[]>> {
  return cached('catalog', deps, async () => {
    try {
      if (config.catalogUrl) {
        const response = await (deps.fetcher ?? fetch)(config.catalogUrl, { redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' } });
        if (!response.ok) { console.error(`Commons catalog snapshot request failed with status ${response.status}`); return { kind: 'error' }; }
        return { kind: 'ok', value: parseCommonsCatalog(await response.json()) };
      }
      if (!config.supabaseUrl || !config.publishableKey) return { kind: 'unavailable' };
      const { status, body } = await rpc(config, 'commons_catalog', {}, deps);
      if (isUnavailable(body)) return { kind: 'unavailable' };
      if (status !== 200) { console.error(`Commons catalog request failed with status ${status}`); return { kind: 'error' }; }
      return { kind: 'ok', value: parseCommonsCatalog(body) };
    } catch (error) { console.error('Commons catalog could not be loaded', error instanceof Error ? error.message : error); return { kind: 'error' }; }
  });
}

const profilePageSchema = z.object({ profile: commonsPublicProfileSchema, models: z.array(catalogModelSchema).max(1000) }).strict();
export type ProfilePage = z.infer<typeof profilePageSchema>;
/** `value: null` is a profile that does not exist or is hidden. */
export function loadProfile(config: SeoConfig, handle: string, deps: EdgeDeps = {}): Promise<Loaded<ProfilePage | null>> {
  return cached(`profile:${handle}`, deps, async () => {
    try {
      if (!config.supabaseUrl || !config.publishableKey) return { kind: 'unavailable' };
      const { status, body } = await rpc(config, 'commons_profile_by_handle', { p_handle: handle }, deps);
      if (isUnavailable(body)) return { kind: 'unavailable' };
      if (status !== 200) return { kind: 'error' };
      return { kind: 'ok', value: body === null ? null : profilePageSchema.parse(body) };
    } catch { return { kind: 'error' }; }
  });
}

export interface CollectionPage { collection: CommonsCollection; members: CatalogModel[] }
/** A public collection and its published models in collection order. `value: null` is a private, removed or missing
 * collection: anonymous reads see only public ones. */
export function loadCollection(config: SeoConfig, id: string, deps: EdgeDeps = {}): Promise<Loaded<CollectionPage | null>> {
  return cached(`collection:${id}`, deps, async () => {
    try {
      if (!config.supabaseUrl || !config.publishableKey) return { kind: 'unavailable' };
      const found = await rpc(config, 'commons_collection', { p_id: id }, deps);
      if (isUnavailable(found.body)) return { kind: 'unavailable' };
      if (found.status !== 200) return { kind: 'error' };
      if (found.body === null) return { kind: 'ok', value: null };
      const collection = commonsCollectionSchema.parse(found.body);
      if (collection.visibility !== 'public') return { kind: 'ok', value: null };
      if (!collection.modelIds.length) return { kind: 'ok', value: { collection, members: [] } };
      const models = await rpc(config, 'commons_catalog_models', { p_ids: collection.modelIds }, deps);
      if (models.status !== 200) return { kind: 'error' };
      const byId = new Map(z.array(catalogModelSchema).max(100).parse(models.body).map(model => [model.id, model]));
      return { kind: 'ok', value: { collection, members: collection.modelIds.flatMap(member => byId.get(member) ?? []) } };
    } catch { return { kind: 'error' }; }
  });
}

/** Public collections, for the sitemap. An unreadable list leaves them out rather than failing the sitemap. */
async function loadPublicCollections(config: SeoConfig, deps: EdgeDeps): Promise<CommonsCollection[]> {
  const result = await cached<CommonsCollection[]>('collections', deps, async () => {
    try {
      if (!config.supabaseUrl || !config.publishableKey) return { kind: 'unavailable' };
      const { status, body } = await rpc(config, 'commons_discovery', {}, deps);
      if (status !== 200) return { kind: 'error' };
      const collections = z.object({ collections: z.array(commonsCollectionSchema).max(1000) }).parse(body).collections;
      return { kind: 'ok', value: collections.filter(collection => collection.visibility === 'public' && collection.modelIds.length > 0) };
    } catch { return { kind: 'error' }; }
  });
  return result.kind === 'ok' ? result.value : [];
}

const paragraphs = (text: string): string => text.split(/\n{2,}/).map(part => part.trim()).filter(Boolean).map(part => `<p>${escapeHtml(part).replace(/\n/g, '<br />')}</p>`).join('');
const safeHref = (url: string | null | undefined): string | null => { try { const parsed = new URL(url ?? ''); return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null; } catch { return null; } };
const link = (url: string | null | undefined, label: string): string => { const href = safeHref(url); return href ? `<a href="${escapeHtml(href)}" rel="noopener">${escapeHtml(label)}</a>` : escapeHtml(label); };
const modelLink = (model: CatalogModel): string => `<li><a href="${modelPath(model.id)}">${escapeHtml(model.title)}</a> — ${escapeHtml(model.category)} by ${escapeHtml(model.creator)}</li>`;

/** Readable page content for crawlers and no-script visitors. The app replaces it as soon as it starts. */
export function modelBody(model: CatalogModel, ctx: SeoContext): string {
  const image = modelImageUrl(model, ctx);
  return `<main><nav aria-label="Breadcrumb"><a href="/">All models</a></nav><article>
<h1>${escapeHtml(model.title)}</h1>
<p>By ${model.creatorProfile ? `<a href="${profilePathFor(model.creatorProfile.handle)}">${escapeHtml(model.creator)}</a>` : model.creator.trim() ? `<a href="${escapeHtml(browseSearchPath(model.creator))}" rel="nofollow">${escapeHtml(model.creator)}</a>` : escapeHtml(model.creator)}</p>
${image ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(model.title)}" width="640" />` : ''}
${paragraphs(model.description)}
<ul><li>Category: ${escapeHtml(model.category)}</li><li>Formats: ${escapeHtml(model.formats.join(', '))}</li>${model.tags.length ? `<li>Tags: ${escapeHtml(model.tags.join(', '))}</li>` : ''}<li>Published: ${escapeHtml(model.publishedAt.slice(0, 10))}</li></ul>
<h2>Licenses and attribution</h2>
${model.source ? `<p>Source: ${link(model.source.url, model.source.name)}</p>` : ''}
${model.licenses.map(license => `<h3>${link(license.url, license.name)}</h3>${license.conditions.length ? `<ul>${license.conditions.map(condition => `<li>${escapeHtml(condition)}</li>`).join('')}</ul>` : ''}`).join('')}
${model.credits.map(credit => `<p>${link(credit.url, credit.name)}${credit.text ? ` — ${escapeHtml(credit.text)}` : ''}</p>`).join('')}
</article></main><noscript><p>PushForm Commons needs JavaScript to preview, download and open models.</p></noscript>`;
}
export function profileBody(page: ProfilePage): string {
  return `<main><nav aria-label="Breadcrumb"><a href="/">All models</a></nav><article><h1>${escapeHtml(page.profile.displayName)}</h1><p>@${escapeHtml(page.profile.handle)}</p>${paragraphs(page.profile.bio)}
${page.profile.links.length ? `<ul>${page.profile.links.map(item => `<li>${link(item.url, item.label)}</li>`).join('')}</ul>` : ''}
<h2>Published models</h2>${page.models.length ? `<ul>${page.models.map(modelLink).join('')}</ul>` : '<p>No published models to show.</p>'}</article></main>`;
}
export function collectionBody(page: CollectionPage): string {
  const { collection, members } = page;
  const curator = collection.curator ? `<a href="${profilePathFor(collection.curator.handle)}">${escapeHtml(collection.curator.displayName)}</a>` : 'a Commons member';
  return `<main><nav aria-label="Breadcrumb"><a href="/">All models</a></nav><article><h1>${escapeHtml(collection.title)}</h1><p>Curated by ${curator}</p>${paragraphs(collection.description)}
<h2>Models in this collection</h2>${members.length ? `<ul>${members.map(modelLink).join('')}</ul>` : '<p>No published models are available in this collection.</p>'}</article></main>`;
}
export function homeBody(models: CatalogModel[]): string {
  const recent = [...models].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, 100);
  return `<main><h1>PushForm Commons</h1><p>Community-built 3D models for woodworking, carpentry, architecture and landscaping. Each model lists its license and creator credits.</p>
${recent.length ? `<h2>Browse models</h2><ul>${recent.map(modelLink).join('')}</ul>` : ''}</main>`;
}

const HEAD_MARKERS = /<!--seo:head-->[\s\S]*?<!--\/seo:head-->/;
const BODY_MARKER = '<!--seo:body-->';
/** Writes the page's tags and content into the built `index.html`. A shell without the markers is returned unchanged. */
export function renderShell(shell: string, meta: SeoMeta, body: string): string {
  if (!HEAD_MARKERS.test(shell)) return shell;
  return shell.replace(HEAD_MARKERS, () => `<!--seo:head-->\n    ${headTags(meta)}\n    <!--/seo:head-->`).replace(BODY_MARKER, () => body);
}

function respond(html: string, status: number, indexable: boolean, extra: Record<string, string> = {}): Response {
  const headers = new Headers({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...extra });
  if (!indexable) headers.set('X-Robots-Tag', 'noindex, nofollow');
  return new Response(html, { status, headers });
}

export async function renderPage(request: Request, env: EdgeEnv, route: PageRoute, deps: EdgeDeps = {}): Promise<Response> {
  const origin = new URL(request.url).origin;
  const [config, shellResponse] = await Promise.all([loadSeoConfig(env, origin), env.ASSETS.fetch(new Request(new URL('/', origin)))]);
  const indexable = isIndexableHost(request, config);
  if (!shellResponse.ok) return shellResponse;
  const shell = await shellResponse.text();
  const ctx = contextOf(config);
  const page = async (): Promise<Response> => {
    if (route.kind === 'home') {
      const catalog = await loadCatalog(config, deps);
      if (catalog.kind === 'error') return respond(shell, 200, indexable);
      const models = catalog.kind === 'ok' ? catalog.value : [];
      return respond(renderShell(shell, catalog.kind === 'ok' ? homeSeo(models, ctx) : utilitySeo('Models', ctx), homeBody(models)), 200, indexable);
    }
    if (route.kind === 'model') {
      if (!MODEL_ID.test(route.id)) return respond(renderShell(shell, utilitySeo('Model not found', ctx), ''), 404, indexable);
      const catalog = await loadCatalog(config, deps);
      if (catalog.kind === 'error') return respond(shell, 503, indexable, { 'Retry-After': '120' });
      const model = catalog.kind === 'ok' ? catalog.value.find(item => item.id === route.id) : undefined;
      if (!model) return respond(renderShell(shell, utilitySeo('Model not found', ctx), ''), catalog.kind === 'ok' ? 404 : 200, indexable);
      return respond(renderShell(shell, modelSeo(model, ctx), modelBody(model, ctx)), 200, indexable);
    }
    if (route.kind === 'collection') {
      if (!COLLECTION_ID.test(route.id)) return respond(renderShell(shell, utilitySeo('Collection not found', ctx), ''), 404, indexable);
      const loaded = await loadCollection(config, route.id, deps);
      if (loaded.kind === 'error') return respond(shell, 503, indexable, { 'Retry-After': '120' });
      if (loaded.kind === 'unavailable') return respond(renderShell(shell, utilitySeo('Collection', ctx), ''), 200, indexable);
      // A private collection is still served to its signed-in curator by the app, so it is not a 404, but crawlers see nothing.
      if (!loaded.value) return respond(renderShell(shell, utilitySeo('Collection', ctx), ''), 200, indexable);
      return respond(renderShell(shell, collectionSeo(loaded.value.collection, loaded.value.members, ctx), collectionBody(loaded.value)), 200, indexable);
    }
    if (!HANDLE.test(route.handle)) return respond(renderShell(shell, utilitySeo('Profile not found', ctx), ''), 404, indexable);
    const profile = await loadProfile(config, route.handle, deps);
    if (profile.kind === 'error') return respond(shell, 503, indexable, { 'Retry-After': '120' });
    if (profile.kind === 'unavailable') return respond(renderShell(shell, utilitySeo('Profile', ctx), ''), 200, indexable);
    if (!profile.value) return respond(renderShell(shell, utilitySeo('Profile not found', ctx), ''), 404, indexable);
    const { profile: owner, models } = profile.value;
    const avatar = owner.avatarImage ? commonsProfileImageUrl(config.filesUrl || undefined, owner.avatarImage.id) : null;
    return respond(renderShell(shell, profileSeo(owner, models, ctx, avatar), profileBody(profile.value)), 200, indexable);
  };
  return page();
}

export async function renderRobots(request: Request, env: EdgeEnv): Promise<Response> {
  const config = await loadSeoConfig(env, new URL(request.url).origin);
  const body = isIndexableHost(request, config)
    ? `User-agent: *\nAllow: /\n\nSitemap: ${config.siteUrl}/sitemap.xml\n`
    : 'User-agent: *\nDisallow: /\n';
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
}

const xml = escapeHtml;
/** Every public model, creator profile and nonempty public collection. `lastmod` is the publication date; the catalog does not expose later edit times. */
export async function renderSitemap(request: Request, env: EdgeEnv, deps: EdgeDeps = {}): Promise<Response> {
  const config = await loadSeoConfig(env, new URL(request.url).origin);
  if (!isIndexableHost(request, config)) return new Response('Not found', { status: 404, headers: { 'X-Robots-Tag': 'noindex, nofollow' } });
  const [catalog, collections] = await Promise.all([loadCatalog(config, deps), loadPublicCollections(config, deps)]);
  if (catalog.kind === 'error') return new Response('Catalog temporarily unavailable', { status: 503, headers: { 'Retry-After': '300' } });
  const ctx = contextOf(config);
  const models = catalog.kind === 'ok' ? catalog.value : [];
  const newest = models.map(model => model.publishedAt).sort().at(-1);
  const profiles = new Map<string, string>();
  for (const model of models) {
    const handle = model.creatorProfile?.handle;
    if (handle && (profiles.get(handle) ?? '') < model.publishedAt) profiles.set(handle, model.publishedAt);
  }
  const entry = (path: string, lastmod: string | undefined, extra = '') => `  <url><loc>${xml(config.siteUrl + path)}</loc>${lastmod ? `<lastmod>${xml(lastmod)}</lastmod>` : ''}${extra}</url>`;
  const image = (model: CatalogModel) => { const url = modelImageUrl(model, ctx); return url ? `<image:image><image:loc>${xml(url)}</image:loc><image:title>${xml(model.title)}</image:title></image:image>` : ''; };
  const lines = [entry('/', newest), ...[...models].sort((a, b) => a.id.localeCompare(b.id)).map(model => entry(modelPath(model.id), model.publishedAt, image(model))),
    ...[...profiles].sort(([a], [b]) => a.localeCompare(b)).map(([handle, modified]) => entry(profilePathFor(handle), modified)),
    ...[...collections].sort((a, b) => a.id.localeCompare(b.id)).map(collection => entry(collectionPath(collection.id), collection.updatedAt))];
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${lines.join('\n')}\n</urlset>\n`,
    { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
}
