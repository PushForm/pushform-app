// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import {
  commonsAffiliateFieldsSchema,
  commonsPurchaseDestination,
  commonsPurchaseFieldsSchema,
  commonsMarketplaceFieldsSchema,
} from './CommonsCommerce';
import { commonsSubmissionSchema } from './CommonsPublishing';
it('validates independent product identity and does not allow unsafe purchase destinations', () => {
  const source = {
    productTitle: 'Generic round pull',
    marketplaceId: 'amazon-us',
    manufacturer: 'Independent Manufacturer',
    manufacturerPartNumber: 'P-42',
    purchaseUrl: 'https://www.amazon.com/dp/B073TWK9RC',
    relationship: 'similar',
    availability: 'unknown',
    enabled: true,
    sortOrder: 0,
  };
  expect(commonsPurchaseFieldsSchema.parse(source).manufacturer).toBe('Independent Manufacturer');
  for (const url of [
    'javascript:alert(1)',
    'https://user:pass@amazon.com/',
    'http://amazon.com/',
    'https://amazon.com:9000/',
  ])
    expect(commonsPurchaseFieldsSchema.safeParse({ ...source, purchaseUrl: url }).success).toBe(
      false,
    );
  expect(
    commonsMarketplaceFieldsSchema.safeParse({
      name: 'Shop',
      country: 'US',
      currency: 'USD',
      domains: ['*.example.com'],
      identifierLabel: 'SKU',
      network: 'none',
      enabled: true,
    }).success,
  ).toBe(false);
  expect(commonsSubmissionSchema.safeParse({ purchaseSources: [source] }).success).toBe(false);
});
it('previews active tracking methods and falls back to canonical purchase URLs for paused or foreign accounts', () => {
  const source = commonsPurchaseFieldsSchema.parse({
    productTitle: 'Pull',
    marketplaceId: 'amazon-us',
    purchaseUrl: 'https://www.amazon.com/dp/B073TWK9RC',
    relationship: 'reference',
    availability: 'unknown',
    enabled: true,
    sortOrder: 0,
  });
  const account = commonsAffiliateFieldsSchema.parse({
    label: 'PushForm Amazon',
    marketplaceId: 'amazon-us',
    trackingId: 'example-20',
    status: 'active',
    linkMethod: 'amazon_tag',
    trackingDomains: [],
    disclosure: 'Affiliate disclosure',
  });
  expect(commonsPurchaseDestination(source, account)).toEqual({
    url: source.purchaseUrl + '?tag=example-20',
    affiliate: true,
  });
  expect(commonsPurchaseDestination(source, { ...account, status: 'paused' })).toEqual({
    url: source.purchaseUrl,
    affiliate: false,
  });
  expect(
    commonsPurchaseDestination(source, { ...account, marketplaceId: 'another-us' }).affiliate,
  ).toBe(false);
  expect(commonsAffiliateFieldsSchema.safeParse({ ...account, trackingId: null }).success).toBe(
    false,
  );
});
