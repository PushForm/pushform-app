// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/** Content licenses remain independent of the application's software license. */
export interface ModelAttribution {
  modelId: string;
  revision: string;
  assetId: string;
  title: string;
  creator: string;
  source: { name: string; url: string } | null;
  licenses: { name: string; url: string; commercialUse: 'allowed' | 'restricted' | 'unknown'; conditions: string[] }[];
  credits: { name: string; url: string | null; text: string }[];
  file: { name: string; sizeBytes: number; sha256: string };
}
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 1000): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const url = (v: unknown): v is string => {
  if (!text(v, 2048)) return false;
  try { const u = new URL(v); return !u.username && !u.password && (u.protocol === 'https:' || u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)); }
  catch { return false; }
};
/** Validate stored notices before trusting a native document or writing an export package. */
export function parseModelAttributions(value: unknown): ModelAttribution[] {
  if (!Array.isArray(value) || value.length > 100 || new TextEncoder().encode(JSON.stringify(value)).length > 512 * 1024) throw new Error('Invalid model attribution.');
  for (const a of value) {
    if (!record(a) || !text(a.modelId, 96) || !text(a.revision) || !text(a.assetId) || !text(a.title) || !text(a.creator)
      || !(a.source === null || record(a.source) && text(a.source.name) && url(a.source.url))
      || !Array.isArray(a.licenses) || a.licenses.length < 1 || a.licenses.length > 50
      || a.licenses.some(l => !record(l) || !text(l.name) || !url(l.url) || !['allowed', 'restricted', 'unknown'].includes(l.commercialUse as string) || !Array.isArray(l.conditions) || l.conditions.length > 50 || l.conditions.some(c => !text(c)))
      || !Array.isArray(a.credits) || a.credits.length < 1 || a.credits.length > 100
      || a.credits.some(c => !record(c) || !text(c.name) || !(c.url === null || url(c.url)) || typeof c.text !== 'string' || c.text.length > 4000)
      || !record(a.file) || !text(a.file.name, 180) || typeof a.file.sizeBytes !== 'number' || !Number.isSafeInteger(a.file.sizeBytes) || a.file.sizeBytes < 1 || a.file.sizeBytes > 134217728
      || typeof a.file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(a.file.sha256)) throw new Error('Invalid model attribution.');
  }
  return value.map((a: ModelAttribution) => ({ modelId: a.modelId, revision: a.revision, assetId: a.assetId, title: a.title, creator: a.creator,
    source: a.source ? { name: a.source.name, url: a.source.url } : null,
    licenses: a.licenses.map(l => ({ name: l.name, url: l.url, commercialUse: l.commercialUse, conditions: [...l.conditions] })),
    credits: a.credits.map(c => ({ name: c.name, url: c.url, text: c.text })), file: { name: a.file.name, sizeBytes: a.file.sizeBytes, sha256: a.file.sha256 } }));
}
