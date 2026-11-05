// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { beforeEach, describe, expect, it } from 'vitest';
import { exampleModel } from './catalog.fixture';
import { applySeo, clip, headTags, homeSeo, jsonLdText, modelDescription, modelSeo, normalizeSiteUrl, profileSeo, utilitySeo, DEFAULT_SHARE_IMAGE } from './seo';

const ctx = { siteUrl: 'https://commons.pushform.io', filesUrl: 'https://files.example' };
const fileId = '11111111-1111-4111-8111-111111111111';
const file = { id: fileId, name: 'hinge.step', format: 'STEP', sizeBytes: 1024, sha256: 'a'.repeat(64) };

describe('model search metadata', () => {
  it('describes a model with a canonical path, a bounded title and description, and indexing allowed', () => {
    const meta = modelSeo(exampleModel({ description: 'x '.repeat(400) }), ctx);
    expect(meta.canonical).toBe('https://commons.pushform.io/models/workshop-hinge');
    expect(meta.title).toBe('Workshop hinge — Hardware 3D model | PushForm Commons');
    expect(meta.description.length).toBeLessThanOrEqual(158);
    expect(meta.robots).toContain('index');
    expect(meta.robots).not.toContain('noindex');
  });
  it('keeps long titles within a search result and cuts at a word', () => {
    expect(modelSeo(exampleModel({ title: 'An extraordinarily detailed hand-cut dovetail drawer assembly for kitchens' }), ctx).title.length).toBeLessThanOrEqual(90);
    expect(clip('one two three four five', 14)).toBe('one two three…');
  });
  it('writes a useful description when the publisher gave a short one', () => {
    const text = modelDescription(exampleModel());
    expect(text).toContain('Hardware 3D model by Example Maker');
    expect(text).toContain('Attribution 3.0');
  });
  it('prefers the cover image, then the supplied image, then a generated thumbnail', () => {
    expect(modelSeo(exampleModel({ previewImage: file, imageUrl: 'https://img.example/a.png' }), ctx).image?.url).toBe(`https://files.example/images/${fileId}`);
    expect(modelSeo(exampleModel({ imageUrl: 'https://img.example/a.png', files: [file] }), ctx).image?.url).toBe('https://img.example/a.png');
    expect(modelSeo(exampleModel({ files: [file] }), ctx).image?.url).toBe(`https://files.example/thumbnails/${fileId}`);
    expect(modelSeo(exampleModel(), ctx).image).toBeNull();
  });
  it('adds structured data for the model, its creator, license and breadcrumb trail', () => {
    const meta = modelSeo(exampleModel({ creatorProfile: { id: fileId, handle: 'example-maker', displayName: 'Example Maker' } }), ctx);
    const model = meta.jsonLd[0] as Record<string, unknown>;
    expect(model).toMatchObject({ '@type': '3DModel', name: 'Workshop hinge', license: 'https://example.com/license', datePublished: '2026-10-31T12:00:00Z',
      creator: { '@type': 'Person', url: 'https://commons.pushform.io/u/example-maker' }, isBasedOn: 'https://example.com/model' });
    expect(meta.jsonLd[1]).toMatchObject({ '@type': 'BreadcrumbList', itemListElement: [{ position: 1 }, { position: 2, item: 'https://commons.pushform.io/models/workshop-hinge' }] });
  });
});

describe('other pages', () => {
  it('describes a profile with its models and links', () => {
    const meta = profileSeo({ handle: 'example-maker', displayName: 'Example Maker', bio: 'Builds cabinets.', links: [{ label: 'Site', url: 'https://example.com' }], avatarUrl: null }, [exampleModel()], ctx);
    expect(meta.canonical).toBe('https://commons.pushform.io/u/example-maker');
    expect(meta.type).toBe('profile');
    expect(JSON.stringify(meta.jsonLd)).toContain('"sameAs":["https://example.com"]');
  });
  it('describes the home page with a list of models and a share image', () => {
    const meta = homeSeo([exampleModel()], ctx);
    expect(meta.canonical).toBe('https://commons.pushform.io/');
    expect(meta.image?.url).toBe(DEFAULT_SHARE_IMAGE);
    expect(JSON.stringify(meta.jsonLd)).toContain('/models/workshop-hinge');
  });
  it('keeps utility pages out of search results and points them at the home page', () => {
    expect(utilitySeo('Model not found', ctx)).toMatchObject({ robots: 'noindex, follow', canonical: 'https://commons.pushform.io/' });
  });
  it('accepts only an HTTPS site address (or localhost) and otherwise uses the production site', () => {
    expect(normalizeSiteUrl('https://staging.example/path')).toBe('https://staging.example');
    expect(normalizeSiteUrl('http://evil.example')).toBe('https://commons.pushform.io');
    expect(normalizeSiteUrl(undefined)).toBe('https://commons.pushform.io');
  });
});

describe('markup', () => {
  it('escapes publisher text in attributes and structured data', () => {
    const meta = modelSeo(exampleModel({ title: '"><script>alert(1)</script>', description: 'd'.repeat(100) + '</script><img onerror=x>' }), ctx);
    const html = headTags(meta);
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('</script><img');
    expect(jsonLdText({ a: '</script>' })).toBe('{"a":"' + String.fromCharCode(92) + 'u003c/script>"}');
  });
  describe('in the browser', () => {
    beforeEach(() => { document.head.innerHTML = '<meta name="robots" content="old" /><link rel="canonical" href="https://old.example/" /><script type="application/ld+json">{}</script>'; });
    it('replaces earlier tags instead of adding duplicates', () => {
      applySeo(modelSeo(exampleModel(), ctx));
      applySeo(modelSeo(exampleModel({ id: 'other', title: 'Other' }), ctx));
      expect(document.title).toContain('Other');
      expect(document.head.querySelectorAll('link[rel="canonical"]')).toHaveLength(1);
      expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe('https://commons.pushform.io/models/other');
      expect(document.head.querySelectorAll('meta[name="robots"]')).toHaveLength(1);
      expect(document.head.querySelectorAll('script[type="application/ld+json"]')).toHaveLength(2);
      expect(document.head.querySelector('meta[property="og:title"]')?.getAttribute('content')).toContain('Other');
    });
  });
});
