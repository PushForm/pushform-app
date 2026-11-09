// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { extensionManifestSchema, parseVersion } from './manifest.ts';
import { PACKAGE_LIMITS, sha256Hex } from './package.ts';
import { DISTRIBUTION_LIMITS, DistributionError, decodeDistributionBase64, distributionJson, distributionSignatureSchema,
  verifyDistributionSignature, type DistributionKey, type DistributionSignature } from './signatures.ts';

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const id = z.string().max(200).regex(/^[a-z][a-z0-9-]{0,62}(\.[a-z][a-z0-9-]{0,62})+$/);
const keyId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/);
const version = z.string().max(100).refine(value => parseVersion(value) !== null);
const timestamp = z.iso.datetime({ offset: true });
const base = { version: z.literal(1), sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), issuedAt: timestamp, expiresAt: timestamp };
const reason = z.string().trim().min(1).max(2000);
const https = z.string().max(2048).refine(value => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search; } catch { return false; }
});

export const registryReleaseSchema = z.strictObject({
  /** The full signed-manifest shape is carried for discovery; the package's exact manifest bytes are checked again. */
  manifest: extensionManifestSchema, contentHash: digest, archiveHash: digest,
  archiveBytes: z.number().int().min(1).max(PACKAGE_LIMITS.archiveBytes), url: https,
  /** Explicit rollout target; history can remain listed when a release is paused or rolled back. */
  recommended: z.boolean(),
  minimumAppVersion: version, releaseNotes: z.string().max(20_000),
});
export const registryIndexSchema = z.strictObject({ ...base, kind: z.literal('registry'), releases: z.array(registryReleaseSchema).max(2000) })
  .superRefine((value, ctx) => {
    const identities = new Set<string>(), recommended = new Set<string>();
    for (const [i, release] of value.releases.entries()) {
      const identity = `${release.manifest.id}@${release.manifest.version}`;
      if (identities.has(identity)) ctx.addIssue({ code: 'custom', path: ['releases', i], message: 'duplicate release' });
      identities.add(identity);
      if (release.recommended) {
        if (recommended.has(release.manifest.id)) ctx.addIssue({ code: 'custom', path: ['releases', i], message: 'multiple recommended releases for one plugin' });
        recommended.add(release.manifest.id);
      }
    }
  });
export const revocationFeedSchema = z.strictObject({ ...base, kind: z.literal('revocations'),
  keys: z.array(z.strictObject({ keyId, reason })).max(1000),
  releases: z.array(z.strictObject({ id, contentHash: digest, reason })).max(10_000),
  permissions: z.array(z.strictObject({ id: id.optional(), contentHash: digest.optional(), permission: extensionManifestSchema.shape.permissions.element, reason })
    .refine(value => value.contentHash === undefined || value.id !== undefined, { message: 'a release-specific revocation requires a plugin id' })).max(10_000),
}).superRefine((value, ctx) => {
  for (const field of ['keys', 'releases', 'permissions'] as const) {
    const entries = value[field].map(entry => 'keyId' in entry ? entry.keyId : `${entry.id ?? '*'}:${entry.contentHash ?? '*'}${'permission' in entry ? `:${entry.permission}` : ''}`);
    if (new Set(entries).size !== entries.length) ctx.addIssue({ code: 'custom', path: [field], message: 'duplicate revocation' });
  }
});
export type RegistryIndex = z.infer<typeof registryIndexSchema>;
export type RegistryRelease = z.infer<typeof registryReleaseSchema>;
export type RevocationFeed = z.infer<typeof revocationFeedSchema>;
const envelope = z.strictObject({ payload: z.string().max(4 * Math.ceil(DISTRIBUTION_LIMITS.payloadBytes / 3)), signature: distributionSignatureSchema });
export interface VerifiedDistribution<T> { readonly data: T; readonly payloadHash: string; readonly signature: DistributionSignature; readonly bytes: Uint8Array }

export async function verifyDistributionFeed<K extends 'registry' | 'revocations'>(kind: K, bytes: Uint8Array, options: {
  readonly keys: readonly DistributionKey[]; readonly now: Date; readonly cached?: boolean; readonly revokedKeys?: ReadonlySet<string>;
}): Promise<VerifiedDistribution<K extends 'registry' ? RegistryIndex : RevocationFeed>> {
  const wrapped = envelope.safeParse(distributionJson(bytes, DISTRIBUTION_LIMITS.feedBytes));
  if (!wrapped.success) throw new DistributionError('feed.invalid', 'The distribution feed has an unsupported format.');
  const payload = decodeDistributionBase64(wrapped.data.payload, DISTRIBUTION_LIMITS.payloadBytes);
  const raw = distributionJson(payload, DISTRIBUTION_LIMITS.payloadBytes);
  const parsed = (kind === 'registry' ? registryIndexSchema : revocationFeedSchema).safeParse(raw);
  if (!parsed.success) throw new DistributionError('feed.invalid', 'The distribution feed has invalid fields.');
  const data = parsed.data;
  const issued = Date.parse(data.issuedAt), expires = Date.parse(data.expiresAt), now = options.now.getTime();
  if (!Number.isFinite(now) || expires <= issued || expires - issued > DISTRIBUTION_LIMITS.lifetimeMs || issued > now + DISTRIBUTION_LIMITS.clockSkewMs)
    throw new DistributionError('feed.time', 'The distribution feed has an invalid validity period.');
  if (!options.cached && expires <= now) throw new DistributionError('feed.expired', 'The distribution feed has expired.');
  if (!await verifyDistributionSignature(kind, payload, wrapped.data.signature, options.keys, new Date(issued), options.revokedKeys))
    throw new DistributionError('signature.invalid', 'The distribution feed signature could not be verified.');
  return { data, payloadHash: await sha256Hex(payload), signature: wrapped.data.signature, bytes: bytes.slice() } as VerifiedDistribution<K extends 'registry' ? RegistryIndex : RevocationFeed>;
}

export function assertDistributionProgress<T extends RegistryIndex | RevocationFeed>(previous: VerifiedDistribution<T> | null, next: VerifiedDistribution<T>): void {
  if (!previous) return;
  if (next.data.sequence < previous.data.sequence || (next.data.sequence === previous.data.sequence && next.payloadHash !== previous.payloadHash))
    throw new DistributionError('feed.rollback', 'An older or conflicting distribution feed cannot replace the verified cache.');
  if (Date.parse(next.data.issuedAt) < Date.parse(previous.data.issuedAt)) throw new DistributionError('feed.rollback', 'The distribution feed issue time moved backwards.');
  if (previous.data.kind === 'revocations' && next.data.kind === 'revocations') {
    for (const field of ['keys', 'releases', 'permissions'] as const) {
      const identity = (entry: RevocationFeed[typeof field][number]): string => 'keyId' in entry ? entry.keyId
        : `${entry.id ?? '*'}:${entry.contentHash ?? '*'}${'permission' in entry ? `:${entry.permission}` : ''}`;
      const retained = new Set(next.data[field].map(identity));
      if (previous.data[field].some(entry => !retained.has(identity(entry)))) throw new DistributionError('feed.rollback', 'A published revocation cannot be removed.');
    }
  }
}
