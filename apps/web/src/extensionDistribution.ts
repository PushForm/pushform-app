// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { decodeDistributionBase64, parseVersion } from '@pushform/extension-protocol';
import type { RegistryOptions } from '@pushform/extensions';

const https = z.string().url().refine(value => {
  const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
});
const schema = z.strictObject({
  keys: z.array(z.strictObject({ id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/), publicKey: z.string().max(100),
    notBefore: z.iso.datetime({ offset: true }), notAfter: z.iso.datetime({ offset: true }) })).min(1).max(20),
  registryUrl: https, revocationsUrl: https, origins: z.array(https.refine(value => new URL(value).origin === value)).min(1).max(10),
});

/** This is public build configuration. No private signing key is accepted or read by the app. */
export function readExtensionDistribution(value: string | undefined, appVersion: string): Pick<RegistryOptions, 'keys' | 'registryUrl' | 'revocationsUrl' | 'origins' | 'appVersion'> | undefined {
  if (!value?.trim()) return undefined;
  try {
    if (value.length > 16_384 || !parseVersion(appVersion)) return undefined;
    const config = schema.parse(JSON.parse(value));
    const ids = new Set<string>();
    for (const key of config.keys) {
      const raw = decodeDistributionBase64(key.publicKey, 65);
      if (ids.has(key.id) || raw.length !== 65 || raw[0] !== 4 || Date.parse(key.notBefore) >= Date.parse(key.notAfter)) return undefined;
      ids.add(key.id);
    }
    if (![config.registryUrl, config.revocationsUrl].every(url => config.origins.includes(new URL(url).origin))) return undefined;
    return { ...config, appVersion };
  } catch { return undefined; }
}
