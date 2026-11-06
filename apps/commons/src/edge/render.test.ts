// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it, vi } from 'vitest';
import { exampleModel } from '../catalog.fixture';
import shell from '../../index.html?raw';
import { renderPage, renderRobots, renderSitemap, type EdgeCache, type EdgeEnv } from './render';

const config = { siteUrl: 'https://commons.pushform.io', supabaseUrl: 'https://project.example', publishableKey: 'sb_publishable_test', filesUrl: 'https://files.example' };
const env = (): EdgeEnv => ({ ASSETS: { fetch: async (request: Request) => new URL(request.url).pathname === '/seo-config.json'
  ? new Response(JSON.stringify(config)) : new Response(shell, { headers: { 'Content-Type': 'text/html' } }) } });
const catalog = (models = [exampleModel()]) => ({ version: 1, models });
const rpcFetcher = (handlers: Record<string, () => Response>) => vi.fn(async (url: string | URL | Request) => {
  const name = String(url).split('/rpc/')[1]!;
  return handlers[name]?.() ?? new Response('{}', { status: 404 });
}) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
const ok = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 });
const at = (url: string) => new Request(url);
const memoryCache = (): EdgeCache => {
  const store = new Map<string, string>();
  return { match: async key => store.has(key) ? new Response(store.get(key)) : undefined, put: async (key, response) => { store.set(key, await response.text()); } };
};

describe('the Commons shell', () => {
  it('has the markers the edge worker fills in', () => {
    expect(shell).toContain('<!--seo:head-->');
    expect(shell).toContain('<!--/seo:head-->');
    expect(shell).toContain('<!--seo:body-->');
  });
});

describe('model pages', () => {
  it('serve the model’s own tags, structured data and readable content to crawlers', async () => {
    const response = await renderPage(at('https://commons.pushform.io/models/workshop-hinge'), env(), { kind: 'model', id: 'workshop-hinge' }, { fetcher: rpcFetcher({ commons_catalog: ok(catalog()) }) });
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Robots-Tag')).toBeNull();
    expect(html).toContain('<title>Workshop hinge — Hardware 3D model | PushForm Commons</title>');
    expect(html.match(/rel="canonical"/g)).toHaveLength(1);
    expect(html).toContain('<link rel="canonical" href="https://commons.pushform.io/models/workshop-hinge" />');
    expect(html).toContain('"@type":"3DModel"');
    expect(html).toContain('<h1>Workshop hinge</h1>');
    expect(html).toContain('Credit Example Maker.');
    expect(html).not.toContain('<!--seo:body-->');
    expect(html.match(/name="robots"/g)).toHaveLength(1);
  });
  it('escape publisher text', async () => {
    const response = await renderPage(at('https://commons.pushform.io/models/workshop-hinge'), env(), { kind: 'model', id: 'workshop-hinge' },
      { fetcher: rpcFetcher({ commons_catalog: ok(catalog([exampleModel({ title: 'A <b>bold</b> "move"', description: '<script>alert(1)</script>' })])) }) });
    const html = await response.text();
    expect(html).not.toContain('<script>alert(1)');
    expect(html).not.toContain('<b>bold</b>');
  });
  it('answer 404 and stay out of results for a model that is not published', async () => {
    const response = await renderPage(at('https://commons.pushform.io/models/nothing'), env(), { kind: 'model', id: 'nothing' }, { fetcher: rpcFetcher({ commons_catalog: ok(catalog()) }) });
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('noindex, follow');
  });
  it('ask crawlers to retry later when the catalog cannot be read, while still serving the app', async () => {
    const response = await renderPage(at('https://commons.pushform.io/models/workshop-hinge'), env(), { kind: 'model', id: 'workshop-hinge' }, { fetcher: rpcFetcher({ commons_catalog: () => new Response('{}', { status: 500 }) }) });
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('120');
    expect(await response.text()).toContain('id="root"');
  });
  it('are not indexable on preview hosts', async () => {
    const response = await renderPage(at('https://abc123.pushform-commons.pages.dev/models/workshop-hinge'), env(), { kind: 'model', id: 'workshop-hinge' }, { fetcher: rpcFetcher({ commons_catalog: ok(catalog()) }) });
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
  });
  it('never ask the fetch for redirect "error", which the Workers runtime rejects', async () => {
    const fetcher = rpcFetcher({ commons_catalog: ok(catalog()) });
    await renderPage(at('https://commons.pushform.io/models/workshop-hinge'), env(), { kind: 'model', id: 'workshop-hinge' }, { fetcher });
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
  });
  it('read the catalog once while it is cached', async () => {
    const fetcher = rpcFetcher({ commons_catalog: ok(catalog()) });
    const deps = { fetcher, cache: memoryCache() };
    await renderPage(at('https://commons.pushform.io/models/workshop-hinge'), env(), { kind: 'model', id: 'workshop-hinge' }, deps);
    await renderPage(at('https://commons.pushform.io/'), env(), { kind: 'home' }, deps);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('home and profile pages', () => {
  it('list models with crawlable links on the home page', async () => {
    const html = await (await renderPage(at('https://commons.pushform.io/'), env(), { kind: 'home' }, { fetcher: rpcFetcher({ commons_catalog: ok(catalog()) }) })).text();
    expect(html).toContain('<a href="/models/workshop-hinge">Workshop hinge</a>');
    expect(html).toContain('"@type":"WebSite"');
  });
  it('describe a creator and list their models', async () => {
    const page = { profile: { id: '11111111-1111-4111-8111-111111111111', handle: 'example-maker', displayName: 'Example Maker', bio: 'Builds cabinets.', avatarUrl: null, links: [] }, models: [exampleModel()] };
    const response = await renderPage(at('https://commons.pushform.io/u/example-maker'), env(), { kind: 'profile', handle: 'example-maker' }, { fetcher: rpcFetcher({ commons_profile_by_handle: ok(page) }) });
    const html = await response.text();
    expect(html).toContain('<title>Example Maker (@example-maker) — 3D models | PushForm Commons</title>');
    expect(html).toContain('<a href="/models/workshop-hinge">Workshop hinge</a>');
  });
  it('return 404 for a hidden or missing profile', async () => {
    const response = await renderPage(at('https://commons.pushform.io/u/nobody'), env(), { kind: 'profile', handle: 'nobody' }, { fetcher: rpcFetcher({ commons_profile_by_handle: ok(null) }) });
    expect(response.status).toBe(404);
  });
});

describe('sitemap and robots', () => {
  it('list the home page, every model with its image, and each creator', async () => {
    const withProfile = exampleModel({ creatorProfile: { id: '11111111-1111-4111-8111-111111111111', handle: 'example-maker', displayName: 'Example Maker' }, imageUrl: 'https://img.example/a.png' });
    const response = await renderSitemap(at('https://commons.pushform.io/sitemap.xml'), env(), { fetcher: rpcFetcher({ commons_catalog: ok(catalog([withProfile, exampleModel({ id: 'a-bench', title: 'Bench & stool', imageUrl: 'https://img.example/b.png' })])) }) });
    const xml = await response.text();
    expect(response.headers.get('Content-Type')).toContain('application/xml');
    for (const loc of ['https://commons.pushform.io/', 'https://commons.pushform.io/models/workshop-hinge', 'https://commons.pushform.io/models/a-bench', 'https://commons.pushform.io/u/example-maker']) expect(xml).toContain(`<loc>${loc}</loc>`);
    expect(xml).toContain('<image:loc>https://img.example/a.png</image:loc>');
    expect(xml).toContain('Bench &amp; stool');
    expect(xml).toContain('<lastmod>2026-10-31T12:00:00Z</lastmod>');
  });
  it('are not published for preview hosts', async () => {
    expect((await renderSitemap(at('https://abc.pages.dev/sitemap.xml'), env(), { fetcher: rpcFetcher({}) })).status).toBe(404);
    expect(await (await renderRobots(at('https://abc.pages.dev/robots.txt'), env())).text()).toContain('Disallow: /');
  });
  it('points crawlers at the sitemap on the production site', async () => {
    const text = await (await renderRobots(at('https://commons.pushform.io/robots.txt'), env())).text();
    expect(text).toContain('Allow: /');
    expect(text).toContain('Sitemap: https://commons.pushform.io/sitemap.xml');
  });
});
