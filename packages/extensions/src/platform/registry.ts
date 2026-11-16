// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { DistributionError, DISTRIBUTION_LIMITS, SIGNATURE_FILE, assertDistributionProgress, compareVersions, packageSignatureVerifier,
  parseVersion, readDistributionSignature, readPackageArchive, sha256Hex, validatePackage, verifyDistributionFeed,
  type DistributionKey, type ExtensionPermission, type RegistryIndex, type RegistryRelease, type RevocationFeed,
  type ValidatedPackage, type VerifiedDistribution } from '@pushform/extension-protocol';

export type DistributionFeedKind = 'registry' | 'revocations';
/** The transport must enforce `limit` while streaming and never send credentials or follow redirects. */
export type DistributionTransport = (url: string, limit: number, signal?: AbortSignal) => Promise<Uint8Array>;
export interface DistributionCache {
  read(kind: DistributionFeedKind): Promise<Uint8Array | null>;
  /** Compare-and-swap protects the high-water mark when several app tabs share this cache. */
  write(kind: DistributionFeedKind, bytes: Uint8Array, expected: Uint8Array | null): Promise<boolean>;
}
export interface RegistryOptions {
  readonly keys: readonly DistributionKey[];
  readonly registryUrl: string;
  readonly revocationsUrl: string;
  /** All feed and archive origins are explicitly configured by the host. */
  readonly origins: readonly string[];
  readonly appVersion: string;
  readonly transport: DistributionTransport;
  readonly cache: DistributionCache;
  readonly now?: () => Date;
}
export interface RegistryPackage { readonly validated: ValidatedPackage; readonly files: ReadonlyMap<string, Uint8Array> }
export interface RegistryStatus { readonly available: boolean; readonly fresh: boolean; readonly error: string | null; readonly checkedAt: string | null }

/** A registry never runs package code. Invalid downloads leave the last authenticated snapshot intact. */
export class ExtensionRegistry {
  private index: VerifiedDistribution<RegistryIndex> | null = null;
  private feed: VerifiedDistribution<RevocationFeed> | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly now: () => Date;
  private refreshing: Promise<void> | null = null;
  private initializing: Promise<void> | null = null;
  private error: string | null = null;
  private checkedAt: string | null = null;
  private changes = 0;
  private checks: { controller: AbortController; timer: ReturnType<typeof setInterval> } | null = null;
  readonly verifyPackageSignature: ReturnType<typeof packageSignatureVerifier>;

  constructor(private readonly options: RegistryOptions) {
    this.now = options.now ?? (() => new Date());
    if (!parseVersion(options.appVersion)) throw new DistributionError('app.version', 'The app version is invalid.');
    this.assertUrl(options.registryUrl); this.assertUrl(options.revocationsUrl);
    this.verifyPackageSignature = packageSignatureVerifier(options.keys, this.now, () => this.revokedKeys());
  }
  get revision(): number { return this.changes; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  startChecks(): void {
    if (this.checks) return;
    const controller = new AbortController();
    const check = () => { void this.refresh(controller.signal); };
    this.checks = { controller, timer: setInterval(check, 15 * 60_000) }; check();
  }
  stopChecks(): void {
    if (!this.checks) return;
    clearInterval(this.checks.timer); this.checks.controller.abort(); this.checks = null;
  }
  private notify(): void { this.changes++; for (const listener of this.listeners) listener(); }
  status(): RegistryStatus {
    return { available: !!this.index && !!this.feed, fresh: this.fresh(), error: this.error, checkedAt: this.checkedAt };
  }
  private fresh(): boolean {
    const time = this.now().getTime();
    return !!this.index && !!this.feed && Date.parse(this.index.data.expiresAt) > time && Date.parse(this.feed.data.expiresAt) > time
      && !this.revokedKeys().has(this.index.signature.keyId);
  }
  revokedKeys(): ReadonlySet<string> { return new Set(this.feed?.data.keys.map(key => key.keyId) ?? []); }
  /** Caches are untrusted bytes and are reverified; an expired valid cache still retains all revocations. */
  initialize(): Promise<void> {
    return this.initializing ??= this.loadCache();
  }
  private async loadCache(): Promise<void> {
    for (const kind of ['revocations', 'registry'] as const) {
      try {
        const bytes = await this.options.cache.read(kind);
        if (!bytes) continue;
        if (kind === 'revocations') this.feed = await verifyDistributionFeed(kind, bytes, { keys: this.options.keys, now: this.now(), cached: true });
        else this.index = await verifyDistributionFeed(kind, bytes, { keys: this.options.keys, now: this.now(), cached: true, revokedKeys: this.revokedKeys() });
      } catch { this.error = 'The saved extension directory could not be verified.'; }
    }
    this.notify();
  }
  /** Serializes refreshes so a slower response cannot undo a newer verified snapshot. */
  refresh(signal?: AbortSignal): Promise<void> {
    return this.refreshing ??= this.fetchFeeds(signal).finally(() => { this.refreshing = null; });
  }
  private async fetchFeeds(signal?: AbortSignal): Promise<void> {
    await this.initialize();
    const errors: string[] = [];
    // Revocations are applied even if the registry download fails. No failed response can erase them.
    for (const kind of ['revocations', 'registry'] as const) {
      try {
        signal?.throwIfAborted();
        const bytes = await this.options.transport(kind === 'registry' ? this.options.registryUrl : this.options.revocationsUrl, DISTRIBUTION_LIMITS.feedBytes, signal);
        signal?.throwIfAborted();
        if (kind === 'revocations') {
          const next = await verifyDistributionFeed(kind, bytes, { keys: this.options.keys, now: this.now(), revokedKeys: this.revokedKeys() });
          assertDistributionProgress(this.feed, next);
          try { await this.persistSnapshot(next); }
          catch (error) {
            // Storage failure must not keep a known unsafe release running. A detected rollback is still refused.
            if (!(error instanceof DistributionError && error.problem === 'feed.rollback')) { assertDistributionProgress(this.feed, next); this.feed = next; this.notify(); }
            throw error;
          }
          this.feed = next;
        } else {
          const next = await verifyDistributionFeed(kind, bytes, { keys: this.options.keys, now: this.now(), revokedKeys: this.revokedKeys() });
          assertDistributionProgress(this.index, next); await this.persistSnapshot(next); this.index = next;
        }
        this.notify();
      } catch (error) { errors.push(error instanceof Error ? error.message : 'The extension directory is unavailable.'); }
    }
    this.error = errors.length ? errors.join(' ') : null; this.checkedAt = this.now().toISOString(); this.notify();
  }
  private async persistSnapshot(next: VerifiedDistribution<RegistryIndex | RevocationFeed>): Promise<void> {
    const kind = next.data.kind;
    for (let attempt = 0; attempt < 3; attempt++) {
      const previousBytes = await this.options.cache.read(kind);
      if (previousBytes) {
        if (kind === 'revocations') {
          let cached: VerifiedDistribution<RevocationFeed> | null = null;
          try { cached = await verifyDistributionFeed(kind, previousBytes, { keys: this.options.keys, now: this.now(), cached: true }); } catch { /* Replace an unauthenticated cache only by CAS. */ }
          if (cached) {
            if (!this.feed || cached.data.sequence >= this.feed.data.sequence) { assertDistributionProgress(this.feed, cached); this.feed = cached; this.notify(); }
            assertDistributionProgress(cached, next);
          }
        } else {
          let cached: VerifiedDistribution<RegistryIndex> | null = null;
          try { cached = await verifyDistributionFeed(kind, previousBytes, { keys: this.options.keys, now: this.now(), cached: true, revokedKeys: this.revokedKeys() }); } catch { /* An invalid cache is not a trust anchor. */ }
          if (cached) {
            if (!this.index || cached.data.sequence >= this.index.data.sequence) { assertDistributionProgress(this.index, cached); this.index = cached; this.notify(); }
            assertDistributionProgress(cached, next);
          }
        }
      }
      if (await this.options.cache.write(kind, next.bytes.slice(), previousBytes)) return;
    }
    throw new DistributionError('cache.conflict', 'The extension directory changed in another app tab. Check for updates again.');
  }
  /** The signed index already contains the rollout-selected releases; clients do not select an audience. */
  releases(): readonly RegistryRelease[] {
    if (!this.index || this.revokedKeys().has(this.index.signature.keyId)) return [];
    return structuredClone(this.index.data.releases.filter(release => !this.releaseReason(release.manifest.id, release.contentHash)));
  }
  releaseReason(id: string, contentHash: string): string | null {
    return this.feed?.data.releases.find(release => release.id === id && release.contentHash === contentHash)?.reason ?? null;
  }
  revokedPermissions(id: string, contentHash: string): readonly { readonly permission: ExtensionPermission; readonly reason: string }[] {
    return this.feed?.data.permissions.filter(entry => (entry.id === undefined || entry.id === id) && (entry.contentHash === undefined || entry.contentHash === contentHash))
      .map(({ permission, reason }) => ({ permission, reason })) ?? [];
  }
  packageRevocation(id: string, contentHash: string, files: Readonly<Record<string, Uint8Array>>): string | null {
    const release = this.releaseReason(id, contentHash); if (release) return release;
    const bytes = files[SIGNATURE_FILE];
    if (bytes) {
      try { const signature = readDistributionSignature(bytes); return this.feed?.data.keys.find(key => key.keyId === signature.keyId)?.reason ?? null; }
      catch { return 'Its installed signature is invalid.'; }
    }
    return null;
  }
  /** The caller names only the release identity. All download details are read again from authenticated data. */
  async package(id: string, contentHash: string, signal?: AbortSignal): Promise<RegistryPackage> {
    await this.initialize();
    if (!this.fresh()) throw new DistributionError('registry.unavailable', 'Refresh the extension directory before installing or updating.');
    const release = this.index!.data.releases.find(entry => entry.manifest.id === id && entry.contentHash === contentHash);
    if (!release || this.releaseReason(id, contentHash)) throw new DistributionError('release.unavailable', 'This extension release is no longer available.');
    if (compareVersions(parseVersion(this.options.appVersion)!, parseVersion(release.minimumAppVersion)!) < 0)
      throw new DistributionError('app.unsupported', `This extension requires PushForm ${release.minimumAppVersion} or later.`);
    this.assertUrl(release.url);
    const archive = await this.options.transport(release.url, release.archiveBytes, signal);
    signal?.throwIfAborted();
    if (archive.length !== release.archiveBytes || await sha256Hex(archive) !== release.archiveHash)
      throw new DistributionError('archive.hash', 'The downloaded extension does not match the published archive.');
    const files = readPackageArchive(archive);
    const validated = await validatePackage(files, { verifySignature: this.verifyPackageSignature });
    if (validated.integrity !== 'official' || validated.contentHash !== contentHash || JSON.stringify(validated.manifest) !== JSON.stringify(release.manifest))
      throw new DistributionError('release.mismatch', 'The signed package does not match its directory entry.');
    // A revocation or expiry may have arrived while the package was downloading or hashing.
    this.assertInstallable(id, contentHash, Object.fromEntries(files));
    return { files, validated };
  }
  assertInstallable(id: string, contentHash: string, files: Readonly<Record<string, Uint8Array>>): void {
    if (!this.fresh()) throw new DistributionError('registry.unavailable', 'Refresh the extension directory before installing or updating.');
    if (!this.index?.data.releases.some(entry => entry.manifest.id === id && entry.contentHash === contentHash))
      throw new DistributionError('release.unavailable', 'This extension release is no longer available.');
    const reason = this.packageRevocation(id, contentHash, files);
    if (reason) throw new DistributionError('release.revoked', reason);
  }
  private assertUrl(value: string): void {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !this.options.origins.includes(url.origin))
      throw new DistributionError('url.refused', 'The extension download is outside the configured registry origins.');
  }
}

export function memoryDistributionCache(): DistributionCache {
  const values = new Map<DistributionFeedKind, Uint8Array>();
  return { read: async kind => values.get(kind)?.slice() ?? null, write: async (kind, bytes, expected) => {
    if (!distributionBytesEqual(values.get(kind) ?? null, expected)) return false;
    values.set(kind, bytes.slice()); return true;
  } };
}

export function distributionBytesEqual(a: Uint8Array | null, b: Uint8Array | null): boolean {
  return a === null || b === null ? a === b : a.length === b.length && a.every((value, i) => value === b[i]);
}

/** Fetch belongs to the host, never the extension. Bounds apply before accumulating the entire response. */
export const fetchDistribution: DistributionTransport = async (url, limit, signal) => {
  const timeout = AbortSignal.timeout(30_000);
  const response = await fetch(url, { credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok || !response.body) throw new DistributionError('download.failed', 'The extension directory download failed.');
  const declared = response.headers.get('Content-Length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    await response.body.cancel(); throw new DistributionError('limit.exceeded', 'The extension download is too large.');
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > limit) throw new DistributionError('limit.exceeded', 'The extension download is too large.');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
};
