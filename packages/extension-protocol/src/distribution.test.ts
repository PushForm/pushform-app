// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { beforeAll, describe, expect, it } from 'vitest';
import type { webcrypto } from 'node:crypto';
import { assertDistributionProgress, verifyDistributionFeed, type RevocationFeed } from './distribution.ts';
import { decodeDistributionBase64, distributionSigningInput, encodeDistributionBase64, packageSignatureVerifier,
  verifyDistributionSignature, type DistributionKey, type DistributionSignature, type SignaturePurpose } from './signatures.ts';
import { buildManifest, validatePackage } from './package.ts';

const now = new Date('2026-11-09T00:00:00Z');
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
let pair: webcrypto.CryptoKeyPair, anchor: DistributionKey;
beforeAll(async () => {
  pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  anchor = { id: 'release-2026', publicKey: encodeDistributionBase64(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))),
    notBefore: '2026-01-01T00:00:00Z', notAfter: '2027-01-01T00:00:00Z' };
});
async function sign(purpose: SignaturePurpose, payload: Uint8Array): Promise<DistributionSignature> {
  return { version: 1, algorithm: 'ES256', keyId: anchor.id,
    value: encodeDistributionBase64(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, distributionSigningInput(purpose, payload)))) };
}
async function wrap(data: object, purpose: SignaturePurpose = 'revocations') {
  const payload = bytes(data); return bytes({ payload: encodeDistributionBase64(payload), signature: await sign(purpose, payload) });
}
const feed = (patch: Partial<RevocationFeed> = {}): RevocationFeed => ({ version: 1, kind: 'revocations', sequence: 1,
  issuedAt: '2026-11-08T00:00:00Z', expiresAt: '2026-11-15T00:00:00Z', keys: [], releases: [], permissions: [], ...patch });
const options = () => ({ keys: [anchor], now });

describe('distribution signatures', () => {
  it('verifies real P-256 signatures over exact bytes and separates all three purposes', async () => {
    const payload = bytes({ exact: 'maple, birch and \u00e9' }), signature = await sign('package', payload);
    expect(await verifyDistributionSignature('package', payload, signature, [anchor], now)).toBe(true);
    expect(await verifyDistributionSignature('registry', payload, signature, [anchor], now)).toBe(false);
    expect(await verifyDistributionSignature('revocations', payload, signature, [anchor], now)).toBe(false);
    expect(await verifyDistributionSignature('package', new Uint8Array([...payload, 32]), signature, [anchor], now)).toBe(false);
  });
  it('refuses unknown, revoked, duplicate, invalid and out-of-period pinned keys', async () => {
    const payload = bytes('x'), signature = await sign('package', payload);
    for (const keys of [[], [anchor, anchor], [{ ...anchor, publicKey: 'AAAA' }], [{ ...anchor, notBefore: '2027-01-01T00:00:00Z' }],
      [{ ...anchor, notAfter: now.toISOString() }], [{ ...anchor, notAfter: 'bad' }]])
      expect(await verifyDistributionSignature('package', payload, signature, keys, now)).toBe(false);
    expect(await verifyDistributionSignature('package', payload, signature, [anchor], now, new Set([anchor.id]))).toBe(false);
    expect(await verifyDistributionSignature('package', payload, { ...signature, algorithm: 'none' } as never, [anchor], now)).toBe(false);
  });
  it('checks the real package validator and never downgrades a signed package to unsigned', async () => {
    const files = new Map<string, Uint8Array>([['main.js', new TextEncoder().encode('export function activate() {}')]]);
    files.set('manifest.json', await buildManifest({ id: 'io.pushform.example', name: 'Example', publisher: 'PushForm', version: '1.0.0',
      apiVersion: '^0.1.0', main: 'main.js', editors: ['modeling'], contributions: [{ id: 'io.pushform.example.open', target: 'model.command', name: 'Open' }],
      permissions: [], license: 'MIT', defaultLocale: 'en' }, files));
    files.set('signature.json', bytes(await sign('package', files.get('manifest.json')!)));
    expect((await validatePackage(files, { verifySignature: packageSignatureVerifier([anchor], () => now) })).integrity).toBe('official');
    await expect(validatePackage(files)).rejects.toMatchObject({ details: { problem: 'signature.invalid' } });
    files.set('main.js', new TextEncoder().encode('export function activate() { throw 0; }'));
    await expect(validatePackage(files, { verifySignature: packageSignatureVerifier([anchor], () => now) })).rejects.toMatchObject({ details: { problem: 'file.hash' } });
  });
  it('requires canonical base64 and checks limits before decoding large inputs', () => {
    expect(decodeDistributionBase64('YQ==', 1)).toEqual(new Uint8Array([97]));
    for (const input of ['YQ', 'YR==', 'YQ==\n', 'YQ====', '=YQ=', 'YQ--']) expect(() => decodeDistributionBase64(input, 10)).toThrow();
    expect(() => decodeDistributionBase64('AAAA', 1)).toThrow();
    const large = new Uint8Array(2 * 1024 * 1024).fill(145);
    const restored = decodeDistributionBase64(encodeDistributionBase64(large), large.length);
    expect(restored.length).toBe(large.length); expect(restored.every(value => value === 145)).toBe(true);
  });
});

describe('signed registry and revocation feeds', () => {
  it('verifies real signed feeds, including Unicode reasons, without accepting a key from the payload', async () => {
    const data = feed({ keys: [{ keyId: 'older', reason: 'Retir\u00e9' }] });
    const checked = await verifyDistributionFeed('revocations', await wrap(data), options());
    expect(checked.data).toEqual(data); expect(checked.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    await expect(verifyDistributionFeed('revocations', await wrap({ ...data, publicKey: anchor.publicKey }), options())).rejects.toMatchObject({ problem: 'feed.invalid' });
    await expect(verifyDistributionFeed('revocations', await wrap(data), { keys: [], now })).rejects.toMatchObject({ problem: 'signature.invalid' });
  });
  it('refuses modified bytes, cross-purpose signatures, unknown fields and invalid text/algorithm encodings', async () => {
    const signed = JSON.parse(new TextDecoder().decode(await wrap(feed())));
    signed.payload = encodeDistributionBase64(bytes(feed({ sequence: 2 })));
    await expect(verifyDistributionFeed('revocations', bytes(signed), options())).rejects.toMatchObject({ problem: 'signature.invalid' });
    await expect(verifyDistributionFeed('revocations', await wrap(feed(), 'registry'), options())).rejects.toMatchObject({ problem: 'signature.invalid' });
    await expect(verifyDistributionFeed('registry', await wrap(feed(), 'registry'), options())).rejects.toMatchObject({ problem: 'feed.invalid' });
    await expect(verifyDistributionFeed('revocations', bytes({ ...signed, key: anchor }), options())).rejects.toMatchObject({ problem: 'feed.invalid' });
    await expect(verifyDistributionFeed('revocations', new Uint8Array([255]), options())).rejects.toMatchObject({ problem: 'data.invalid' });
  });
  it('enforces fresh downloads, bounded validity and clock skew, but revalidates expired offline caches', async () => {
    const expired = await wrap(feed({ expiresAt: '2026-11-08T23:59:59Z' }));
    await expect(verifyDistributionFeed('revocations', expired, options())).rejects.toMatchObject({ problem: 'feed.expired' });
    expect((await verifyDistributionFeed('revocations', expired, { ...options(), cached: true })).data.sequence).toBe(1);
    for (const patch of [{ issuedAt: '2026-11-09T00:05:01Z' }, { expiresAt: '2026-12-31T00:00:00Z' }, { expiresAt: '2026-11-07T00:00:00Z' }])
      await expect(verifyDistributionFeed('revocations', await wrap(feed(patch)), options())).rejects.toMatchObject({ problem: 'feed.time' });
  });
  it('rejects rollback and equivocation while allowing the same signed payload to be signed again', async () => {
    const previous = await verifyDistributionFeed('revocations', await wrap(feed({ sequence: 2 })), options());
    const check = async (data: RevocationFeed) => assertDistributionProgress(previous, await verifyDistributionFeed('revocations', await wrap(data), options()));
    await expect(check(feed())).rejects.toMatchObject({ problem: 'feed.rollback' });
    await expect(check(feed({ sequence: 2, expiresAt: '2026-11-16T00:00:00Z' }))).rejects.toMatchObject({ problem: 'feed.rollback' });
    await expect(check(feed({ sequence: 3, issuedAt: '2026-11-07T00:00:00Z' }))).rejects.toMatchObject({ problem: 'feed.rollback' });
    await expect(check(feed({ sequence: 2 }))).resolves.toBeUndefined();
  });
  it('retains all prior key, release and permission revocations across a newer feed', async () => {
    const contentHash = 'a'.repeat(64), id = 'io.pushform.example';
    const original = feed({ keys: [{ keyId: 'old', reason: 'Compromised' }], releases: [{ id, contentHash, reason: 'Unsafe' }],
      permissions: [{ id, contentHash, permission: 'model.write', reason: 'Unsafe write' }] });
    const previous = await verifyDistributionFeed('revocations', await wrap(original), options());
    for (const field of ['keys', 'releases', 'permissions']) {
      const next = await verifyDistributionFeed('revocations', await wrap({ ...original, sequence: 2, [field]: [] }), options());
      expect(() => assertDistributionProgress(previous, next)).toThrow('cannot be removed');
    }
    const next = await verifyDistributionFeed('revocations', await wrap({ ...original, sequence: 2 }), options());
    expect(() => assertDistributionProgress(previous, next)).not.toThrow();
    await expect(verifyDistributionFeed('revocations', await wrap({ ...original, keys: [...original.keys, ...original.keys] }), options())).rejects.toMatchObject({ problem: 'feed.invalid' });
  });
});
