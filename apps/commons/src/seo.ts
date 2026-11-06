// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { commonsExactSearch, commonsFileUrl, type CatalogModel, type CommonsCollection } from '@pushform/cloud/catalog';

/** Search and social metadata, shared by the browser (which updates the head as the route changes) and the edge
 * worker (which writes the same tags into the HTML that crawlers and link-preview bots fetch without running scripts). */
export const SITE_NAME = 'PushForm Commons';
export const DEFAULT_SITE_URL = 'https://commons.pushform.io';
/** A real product capture on the main site, used when a page has no image of its own. */
export const DEFAULT_SHARE_IMAGE = 'https://pushform.io/assets/img/app-shaker-workbench.jpg';
export const HOME_TITLE = 'PushForm Commons — 3D models for woodworking, building and landscaping';
export const HOME_DESCRIPTION = 'Browse community-built 3D models for woodworking, carpentry, architecture and landscaping. Every model lists its license and creator credits, and opens in PushForm.';

export interface SeoContext { siteUrl: string; filesUrl?: string | undefined }
export interface SeoMeta {
  title: string; description: string; canonical: string;
  /** `index` for public content; utility and missing pages are kept out of results. */
  robots: string;
  image: { url: string; alt: string } | null;
  type: 'website' | 'profile';
  published?: string | undefined;
  jsonLd: object[];
}

export const modelPath = (id: string): string => `/models/${id}`;
export const profilePathFor = (handle: string): string => `/u/${handle}`;
export const collectionPath = (id: string): string => `/collections/${id}`;
/** The library filtered to an exact-name search, used to find every model credited to a creator without a Commons profile. */
export const browseSearchPath = (name: string): string => `/?${new URLSearchParams({ q: commonsExactSearch(name) })}#browse`;
const INDEX = 'index, follow, max-image-preview:large, max-snippet:-1';
export const NOINDEX = 'noindex, follow';

export function normalizeSiteUrl(value: string | undefined): string {
  try {
    const url = new URL(value?.trim() || DEFAULT_SITE_URL);
    if (url.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(url.hostname)) return url.origin;
  } catch { /* fall through to the default */ }
  return DEFAULT_SITE_URL;
}
const absolute = (ctx: SeoContext, path: string): string => `${ctx.siteUrl}${path}`;

/** Collapses whitespace and cuts at a word boundary so titles and descriptions fit search result snippets. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-–—]+$/, '')}…`;
}

/** The best public picture of a model, in the order the app itself prefers. */
export function modelImageUrl(model: CatalogModel, ctx: SeoContext): string | null {
  const geometry = model.files.find(file => /\.(pf|step|stp|stl|obj|glb|gltf|dae|3ds|skp)$/i.test(file.name));
  return (model.previewImage ? commonsFileUrl(ctx.filesUrl, 'images', model.previewImage.id) : null)
    ?? model.imageUrl ?? (geometry ? commonsFileUrl(ctx.filesUrl, 'thumbnails', geometry.id) : null);
}
const formatLabel = (model: CatalogModel): string => [...new Set(model.formats.map(format => format.replace(/^\./, '').toUpperCase()))].join(', ');
const firstLicenseUrl = (model: CatalogModel): string | undefined => model.licenses.find(license => license.url)?.url ?? undefined;

export function modelDescription(model: CatalogModel): string {
  const own = model.description.replace(/\s+/g, ' ').trim();
  const licenses = [...new Set(model.licenses.map(license => license.name))].join(', ');
  const tail = ` Licensed ${licenses}.`;
  if (own.length >= 80) return clip(own, 158);
  return clip(`${own ? own + ' ' : ''}${model.category} 3D model by ${model.creator}, available as ${formatLabel(model)}.${tail}`, 158);
}

export function modelSeo(model: CatalogModel, ctx: SeoContext): SeoMeta {
  const url = absolute(ctx, modelPath(model.id));
  const imageUrl = modelImageUrl(model, ctx);
  const description = modelDescription(model);
  const creatorUrl = model.creatorProfile ? absolute(ctx, profilePathFor(model.creatorProfile.handle)) : undefined;
  const keywords = [...new Set([model.category, ...model.tags, ...model.formats])];
  const jsonLd: object[] = [{
    '@context': 'https://schema.org', '@type': '3DModel', '@id': `${url}#model`, url, name: model.title, description,
    ...(imageUrl ? { image: imageUrl, thumbnailUrl: imageUrl } : {}),
    creator: { '@type': creatorUrl ? 'Person' : 'Organization', name: model.creator, ...(creatorUrl ? { url: creatorUrl } : {}) },
    datePublished: model.publishedAt, version: model.revision, genre: model.category, keywords: keywords.join(', '),
    encodingFormat: model.formats, isAccessibleForFree: true,
    ...(firstLicenseUrl(model) ? { license: firstLicenseUrl(model) } : {}),
    creditText: model.credits.map(credit => credit.name).join(', '),
    ...(model.source ? { isBasedOn: model.source.url } : {}),
    isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: ctx.siteUrl },
    mainEntityOfPage: url, inLanguage: 'en',
  }, breadcrumbs(ctx, [['Models', ctx.siteUrl + '/'], [model.title, url]])];
  return {
    title: `${clip(model.title, 46)} — ${model.category} 3D model | ${SITE_NAME}`,
    description, canonical: url, robots: INDEX, type: 'website', published: model.publishedAt,
    image: imageUrl ? { url: imageUrl, alt: `${model.title}, a ${model.category.toLowerCase()} 3D model by ${model.creator}` } : null, jsonLd,
  };
}

export interface SeoProfile { handle: string; displayName: string; bio: string; links: { label: string; url: string }[]; avatarUrl: string | null }
export function profileSeo(profile: SeoProfile, models: CatalogModel[], ctx: SeoContext, avatarImageUrl?: string | null): SeoMeta {
  const url = absolute(ctx, profilePathFor(profile.handle));
  const count = models.length;
  const description = clip(profile.bio.trim() || `${profile.displayName} shares ${count === 1 ? 'a model' : `${count} models`} on ${SITE_NAME}, with license and credits for each.`, 158);
  const image = avatarImageUrl ?? profile.avatarUrl;
  return {
    title: `${clip(profile.displayName, 50)} (@${profile.handle}) — 3D models | ${SITE_NAME}`, description, canonical: url, robots: INDEX, type: 'profile',
    image: image ? { url: image, alt: profile.displayName } : null,
    jsonLd: [{
      '@context': 'https://schema.org', '@type': 'ProfilePage', '@id': `${url}#profile`, url, name: `${profile.displayName} on ${SITE_NAME}`,
      mainEntity: { '@type': 'Person', name: profile.displayName, alternateName: profile.handle, url, ...(profile.bio ? { description: profile.bio } : {}),
        ...(image ? { image } : {}), ...(profile.links.length ? { sameAs: profile.links.map(link => link.url) } : {}) },
    }, ...(count ? [{ '@context': 'https://schema.org', '@type': 'ItemList', itemListElement: models.slice(0, 24).map((model, index) => ({ '@type': 'ListItem', position: index + 1, url: absolute(ctx, modelPath(model.id)), name: model.title })) }] : []),
    breadcrumbs(ctx, [['Models', ctx.siteUrl + '/'], [profile.displayName, url]])],
  };
}

/** A collection's tags. `members` are its published models in collection order; the first with a picture provides the
 * share image. Private collections are only ever seen by their curator and stay out of search results. */
export function collectionSeo(collection: CommonsCollection, members: CatalogModel[], ctx: SeoContext): SeoMeta {
  const url = absolute(ctx, collectionPath(collection.id));
  const curator = collection.curator?.displayName ?? 'a Commons member';
  const count = members.length;
  const titles = members.slice(0, 4).map(model => model.title).join(', ');
  const description = clip(collection.description.trim() || `${count === 1 ? 'One model' : `${count} models`} collected by ${curator}${titles ? `: ${titles}` : ''}.`, 158);
  const cover = members.map(model => ({ model, url: modelImageUrl(model, ctx) })).find(item => item.url);
  return {
    title: `${clip(collection.title, 50)} — collection by ${clip(curator, 30)} | ${SITE_NAME}`, description, canonical: url,
    robots: collection.visibility === 'public' ? INDEX : NOINDEX, type: 'website',
    image: cover?.url ? { url: cover.url, alt: `${cover.model.title}, from the ${collection.title} collection` } : null,
    jsonLd: [{
      '@context': 'https://schema.org', '@type': 'CollectionPage', '@id': `${url}#collection`, url, name: collection.title, description,
      ...(collection.curator ? { author: { '@type': 'Person', name: collection.curator.displayName, url: absolute(ctx, profilePathFor(collection.curator.handle)) } } : {}),
      dateModified: collection.updatedAt, isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: ctx.siteUrl }, inLanguage: 'en',
      ...(count ? { mainEntity: { '@type': 'ItemList', numberOfItems: count, itemListElement: members.map((model, index) => ({ '@type': 'ListItem', position: index + 1, url: absolute(ctx, modelPath(model.id)), name: model.title })) } } : {}),
    }, breadcrumbs(ctx, [['Collections', `${ctx.siteUrl}/#collections`], [collection.title, url]])],
  };
}

export function homeSeo(models: CatalogModel[], ctx: SeoContext): SeoMeta {
  return {
    title: HOME_TITLE, description: HOME_DESCRIPTION, canonical: `${ctx.siteUrl}/`, robots: INDEX, type: 'website',
    image: { url: DEFAULT_SHARE_IMAGE, alt: 'A woodworking project modeled in PushForm' },
    jsonLd: [
      { '@context': 'https://schema.org', '@type': 'WebSite', '@id': `${ctx.siteUrl}/#site`, url: `${ctx.siteUrl}/`, name: SITE_NAME, description: HOME_DESCRIPTION, inLanguage: 'en',
        publisher: { '@type': 'Organization', name: 'JobCraft, Inc.', url: 'https://pushform.io', logo: `${ctx.siteUrl}/pf-logo-mark.svg` } },
      ...(models.length ? [{ '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'Browse models', url: `${ctx.siteUrl}/`,
        mainEntity: { '@type': 'ItemList', numberOfItems: models.length, itemListElement: models.slice(0, 24).map((model, index) => ({ '@type': 'ListItem', position: index + 1, url: absolute(ctx, modelPath(model.id)), name: model.title })) } }] : []),
    ],
  };
}

/** Pages with no public content of their own (account, upload, drafts, missing items) stay out of search results. */
export function utilitySeo(title: string, ctx: SeoContext): SeoMeta {
  return { title: `${title} — ${SITE_NAME}`, description: HOME_DESCRIPTION, canonical: `${ctx.siteUrl}/`, robots: NOINDEX, type: 'website', image: null, jsonLd: [] };
}

function breadcrumbs(ctx: SeoContext, trail: [string, string][]): object {
  void ctx;
  return { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: trail.map(([name, item], index) => ({ '@type': 'ListItem', position: index + 1, name, item })) };
}

export const escapeHtml = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
/** JSON for a `<script type="application/ld+json">`: `<` is escaped so page data can never close the tag. */
export const jsonLdText = (value: object): string => JSON.stringify(value).replace(/</g, '\\' + 'u003c');

/** The head tags for a page as HTML, between the markers index.html leaves for them. */
export function headTags(meta: SeoMeta): string {
  const tag = (name: string, content: string, attr: 'name' | 'property' = 'property') => `<meta ${attr}="${name}" content="${escapeHtml(content)}" />`;
  return [
    `<title>${escapeHtml(meta.title)}</title>`,
    tag('description', meta.description, 'name'),
    tag('robots', meta.robots, 'name'),
    `<link rel="canonical" href="${escapeHtml(meta.canonical)}" />`,
    tag('og:site_name', SITE_NAME), tag('og:type', meta.type), tag('og:title', meta.title), tag('og:description', meta.description),
    tag('og:url', meta.canonical), tag('og:locale', 'en_US'),
    ...(meta.image ? [tag('og:image', meta.image.url), tag('og:image:alt', meta.image.alt)] : []),
    ...(meta.published ? [tag('article:published_time', meta.published)] : []),
    tag('twitter:card', meta.image ? 'summary_large_image' : 'summary', 'name'), tag('twitter:title', meta.title, 'name'),
    tag('twitter:description', meta.description, 'name'), ...(meta.image ? [tag('twitter:image', meta.image.url, 'name'), tag('twitter:image:alt', meta.image.alt, 'name')] : []),
    ...meta.jsonLd.map(item => `<script type="application/ld+json">${jsonLdText(item)}</script>`),
  ].join('\n    ');
}

const SEO_ATTRIBUTE = 'data-seo';
/** Replaces the page's search and social tags in the live document; tags written by the edge worker are adopted, not duplicated. */
export function applySeo(meta: SeoMeta, doc: Document = document): void {
  doc.title = meta.title;
  const head = doc.head;
  head.querySelectorAll(`[${SEO_ATTRIBUTE}], meta[name="description"], meta[name="robots"], meta[property^="og:"], meta[property^="article:"], meta[name^="twitter:"], link[rel="canonical"], script[type="application/ld+json"]`).forEach(node => node.remove());
  const template = doc.createElement('template');
  template.innerHTML = headTags(meta).replace(/<title>[\s\S]*?<\/title>/, '');
  template.content.querySelectorAll('*').forEach(node => node.setAttribute(SEO_ATTRIBUTE, ''));
  head.append(template.content);
}
