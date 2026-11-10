// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';

/** Public distribution signatures. A package or feed cannot supply its own trust anchor. */
export const DISTRIBUTION_LIMITS = { signatureBytes: 2048, feedBytes: 8 * 1024 * 1024, payloadBytes: 6 * 1024 * 1024,
  clockSkewMs: 5 * 60_000, lifetimeMs: 30 * 24 * 60 * 60_000 } as const;
export type SignaturePurpose = 'package' | 'registry' | 'revocations';
const keyId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/);
export const distributionSignatureSchema = z.strictObject({ version: z.literal(1), algorithm: z.literal('ES256'), keyId,
  value: z.string().length(88) });
export type DistributionSignature = z.infer<typeof distributionSignatureSchema>;

export interface DistributionKey {
  readonly id: string;
  /** Base64-encoded uncompressed SEC1 point (65 bytes). No private key is accepted. */
  readonly publicKey: string;
  readonly notBefore: string;
  readonly notAfter: string;
}

export class DistributionError extends Error {
  constructor(readonly problem: string, message: string) { super(message); this.name = 'DistributionError'; }
}

export function distributionJson(bytes: Uint8Array, maxBytes: number): unknown {
  if (bytes.byteLength > maxBytes) throw new DistributionError('limit.exceeded', 'The signed distribution data is too large.');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new DistributionError('data.invalid', 'The signed distribution data is not UTF-8 JSON.'); }
}

/** Strict padded RFC 4648 base64, including canonical pad bits. */
export function decodeDistributionBase64(value: string, maxBytes: number): Uint8Array {
  if (value.length > 4 * Math.ceil(maxBytes / 3) || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)
    || !/^[^=]*={0,2}$/.test(value))
    throw new DistributionError('encoding.invalid', 'The signed distribution data has invalid base64.');
  const binary = atob(value);
  if (binary.length > maxBytes || btoa(binary) !== value)
    throw new DistributionError('encoding.invalid', 'The signed distribution data has invalid base64.');
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

export function encodeDistributionBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  return btoa(chunks.join(''));
}

/** Domain separation is part of the wire format, including the terminating zero byte. */
export function distributionSigningInput(purpose: SignaturePurpose, bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const prefix = new TextEncoder().encode(`PushForm extension ${purpose} v1\0`);
  const input = new Uint8Array(prefix.length + bytes.length); input.set(prefix); input.set(bytes, prefix.length); return input;
}

export function readDistributionSignature(bytes: Uint8Array): DistributionSignature {
  const parsed = distributionSignatureSchema.safeParse(distributionJson(bytes, DISTRIBUTION_LIMITS.signatureBytes));
  if (!parsed.success) throw new DistributionError('signature.invalid', 'The distribution signature has an unsupported format.');
  return parsed.data;
}

/** Verifies exact bytes with a pinned key valid at `at`. Cached feeds use their original issue time. */
export async function verifyDistributionSignature(purpose: SignaturePurpose, bytes: Uint8Array, signature: DistributionSignature,
  keys: readonly DistributionKey[], at: Date, revokedKeys: ReadonlySet<string> = new Set()): Promise<boolean> {
  try {
    const parsed = distributionSignatureSchema.parse(signature);
    const matches = keys.filter(key => key.id === parsed.keyId);
    if (matches.length !== 1 || revokedKeys.has(parsed.keyId)) return false;
    const key = matches[0]!;
    const before = Date.parse(key.notBefore), after = Date.parse(key.notAfter), time = at.getTime();
    if (!Number.isFinite(time) || !Number.isFinite(before) || !Number.isFinite(after) || before >= after || time < before || time >= after) return false;
    const raw = decodeDistributionBase64(key.publicKey, 65), sig = decodeDistributionBase64(parsed.value, 64);
    if (raw.length !== 65 || raw[0] !== 4 || sig.length !== 64) return false;
    const imported = await crypto.subtle.importKey('raw', raw as Uint8Array<ArrayBuffer>, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, imported, sig as Uint8Array<ArrayBuffer>, distributionSigningInput(purpose, bytes));
  } catch { return false; }
}

export function packageSignatureVerifier(keys: readonly DistributionKey[], now: () => Date = () => new Date(), revokedKeys: () => ReadonlySet<string> = () => new Set()) {
  return async (manifest: Uint8Array, bytes: Uint8Array): Promise<boolean> => {
    try { return await verifyDistributionSignature('package', manifest, readDistributionSignature(bytes), keys, now(), revokedKeys()); }
    catch { return false; }
  };
}
