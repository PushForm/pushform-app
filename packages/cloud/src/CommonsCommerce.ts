// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './db.types';

const optionalText = (max = 1000) => z.string().trim().max(max).nullable().default(null);
const https = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const u = new URL(value);
      return (
        /^https:\/\/[A-Za-z0-9.-]+(?:[/?#]|$)/.test(value) &&
        u.protocol === 'https:' &&
        !u.username &&
        !u.password &&
        !u.port &&
        !/[\s\\]/.test(value)
      );
    } catch {
      return false;
    }
  }, 'Enter an HTTPS URL without credentials or a custom port.');
const optionalUrl = https.nullable().default(null);
const key = z.string().regex(/^[a-z][a-z0-9-]{1,47}$/);
const domains = z
  .array(
    z
      .string()
      .regex(/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/)
      .refine((value) => !value.includes('..')),
  )
  .max(20);
const name = z.string().trim().min(1).max(200);

export const commonsMarketplaceFieldsSchema = z
  .object({
    name,
    country: z.string().regex(/^[A-Z]{2}$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
    domains: domains.min(1),
    identifierLabel: name,
    programName: optionalText(),
    programUrl: optionalUrl,
    network: z.enum(['none', 'amazon-associates', 'impact', 'other']),
    enabled: z.boolean(),
    staffNotes: optionalText(2000),
  })
  .strict();
export type CommonsMarketplaceFields = z.infer<typeof commonsMarketplaceFieldsSchema>;
export const commonsAffiliateFieldsSchema = z
  .object({
    label: name,
    marketplaceId: key,
    accountId: optionalText(),
    trackingId: optionalText(),
    campaignId: optionalText(),
    status: z.enum(['not_configured', 'pending', 'active', 'paused']),
    linkMethod: z.enum(['direct', 'amazon_tag', 'provided_url']),
    trackingDomains: domains,
    websiteUrl: optionalUrl,
    disclosure: optionalText(),
    staffNotes: optionalText(2000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status !== 'active') return;
    if (value.linkMethod === 'direct' || !value.disclosure)
      ctx.addIssue({
        code: 'custom',
        message: 'An active affiliate account needs a tracking method and disclosure.',
      });
    if (value.linkMethod === 'amazon_tag' && !/^[A-Za-z0-9_-]{3,100}$/.test(value.trackingId ?? ''))
      ctx.addIssue({ code: 'custom', message: 'Enter the approved Amazon tracking tag.' });
    if (value.linkMethod === 'provided_url' && !value.trackingDomains.length)
      ctx.addIssue({ code: 'custom', message: 'Enter the approved tracking domains.' });
  });
export type CommonsAffiliateFields = z.infer<typeof commonsAffiliateFieldsSchema>;
export const commonsPurchaseFieldsSchema = z
  .object({
    productTitle: name,
    marketplaceId: key,
    marketplaceProductId: optionalText(),
    manufacturer: optionalText(),
    manufacturerPartNumber: optionalText(),
    brand: optionalText(),
    seller: optionalText(),
    sellerSku: optionalText(),
    gtin: z
      .string()
      .regex(/^(?:[0-9]{8}|[0-9]{12,14})$/)
      .nullable()
      .default(null),
    purchaseUrl: https,
    relationship: z.enum(['reference', 'similar']),
    variant: optionalText(),
    finish: optionalText(),
    material: optionalText(),
    packQuantity: z.number().int().min(1).max(99999).nullable().default(null),
    dimensions: optionalText(),
    evidenceUrl: optionalUrl,
    checkedAt: z.iso.datetime({ offset: true }).nullable().default(null),
    availability: z.enum(['unknown', 'in_stock', 'out_of_stock', 'discontinued']),
    affiliateAccountId: z.uuid().nullable().default(null),
    affiliateUrl: optionalUrl,
    enabled: z.boolean(),
    sortOrder: z.number().int().min(0).max(9999),
    staffNotes: optionalText(2000),
  })
  .strict();
export type CommonsPurchaseFields = z.infer<typeof commonsPurchaseFieldsSchema>;
export const commonsPublicPurchaseSchema = commonsPurchaseFieldsSchema
  .omit({
    marketplaceId: true,
    affiliateAccountId: true,
    affiliateUrl: true,
    enabled: true,
    sortOrder: true,
    staffNotes: true,
  })
  .extend({
    id: z.uuid(),
    version: z.number().int().positive(),
    destinationVersion: z.string().regex(/^[a-f0-9]{32}$/),
    marketplace: z
      .object({ id: key, name, country: z.string().regex(/^[A-Z]{2}$/), identifierLabel: name })
      .strict(),
    outboundUrl: https,
    affiliate: z.boolean(),
    disclosure: optionalText(),
  })
  .strict();
export type CommonsPublicPurchase = z.infer<typeof commonsPublicPurchaseSchema>;
const record = { id: z.string(), version: z.number().int().positive(), updatedAt: z.string() };
export const commonsMarketplaceSchema = z
  .object({ ...record, fields: commonsMarketplaceFieldsSchema })
  .strict();
export const commonsAffiliateSchema = z
  .object({ ...record, id: z.uuid(), fields: commonsAffiliateFieldsSchema })
  .strict();
export const commonsPurchaseSourceSchema = z
  .object({
    ...record,
    id: z.uuid(),
    modelId: z.string(),
    fields: commonsPurchaseFieldsSchema,
    preview: commonsPublicPurchaseSchema.nullable(),
  })
  .strict();
export type CommonsMarketplace = z.infer<typeof commonsMarketplaceSchema>;
export type CommonsAffiliate = z.infer<typeof commonsAffiliateSchema>;
export type CommonsPurchaseSource = z.infer<typeof commonsPurchaseSourceSchema>;
export const commonsCommerceSettingsSchema = z
  .object({
    marketplaces: z.array(commonsMarketplaceSchema),
    affiliates: z.array(commonsAffiliateSchema),
  })
  .strict();
export type CommonsCommerceSettings = z.infer<typeof commonsCommerceSettingsSchema>;
const count = z.number().int().nonnegative();
export const commonsPurchaseClicksSchema = z
  .object({
    days: z.number().int(),
    total: count,
    affiliate: count,
    perDay: z.array(z.object({ day: z.string(), total: count, affiliate: count }).strict()),
    marketplaces: z.array(
      z.object({ id: z.string(), name: z.string(), total: count, affiliate: count }).strict(),
    ),
    sources: z.array(
      z
        .object({
          id: z.uuid(),
          modelId: z.string(),
          modelTitle: z.string(),
          productTitle: z.string(),
          marketplaceId: z.string(),
          total: count,
          affiliate: count,
        })
        .strict(),
    ),
    accounts: z.array(
      z.object({ id: z.uuid().nullable(), label: z.string(), total: count }).strict(),
    ),
  })
  .strict();
export type CommonsPurchaseClicks = z.infer<typeof commonsPurchaseClicksSchema>;

/** Purchasing records are read separately from contributor-owned publication metadata. */
export class CommonsCommerce {
  constructor(private readonly client: Pick<SupabaseClient<Database>, 'rpc'>) {}
  async sources(modelId: string, signal?: AbortSignal): Promise<CommonsPublicPurchase[]> {
    if (!/^[a-z0-9][a-z0-9-]{0,95}$/.test(modelId)) throw new Error('Invalid model.');
    const invoke = this.client.rpc as unknown as (
      name: string,
      args: object,
    ) => ReturnType<SupabaseClient<Database>['rpc']>;
    const query = invoke.call(this.client, 'commons_purchase_sources', { p_model: modelId });
    const result = await (signal ? query.abortSignal(signal) : query);
    if (result.error?.code === 'PGRST202') return [];
    if (result.error) throw new Error('Purchase sources could not be loaded.');
    return commonsPublicPurchaseSchema.array().parse(result.data);
  }
}

/** Preview the same effective destination the server computes; this never writes or fetches a URL. */
export function commonsPurchaseDestination(
  source: CommonsPurchaseFields,
  account: CommonsAffiliateFields | null,
): { url: string; affiliate: boolean } {
  const direct = { url: source.purchaseUrl, affiliate: false };
  if (!account || account.status !== 'active' || account.marketplaceId !== source.marketplaceId)
    return direct;
  if (
    account.linkMethod === 'amazon_tag' &&
    /^[A-Za-z0-9_-]{3,100}$/.test(account.trackingId ?? '')
  ) {
    const base = source.purchaseUrl.split('#')[0]!;
    return {
      url: base + (base.includes('?') ? '&' : '?') + 'tag=' + account.trackingId!,
      affiliate: true,
    };
  }
  if (account.linkMethod === 'provided_url' && source.affiliateUrl) {
    const checked = https.safeParse(source.affiliateUrl);
    if (checked.success && account.trackingDomains.includes(new URL(checked.data).hostname))
      return { url: checked.data, affiliate: true };
  }
  return direct;
}
