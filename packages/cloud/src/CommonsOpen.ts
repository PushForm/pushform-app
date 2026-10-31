// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { catalogModelSchema, type CatalogModel } from './CommonsCatalog';
import { commonsFileUrl } from './CommonsFiles';
import { readStoredAttributionPackage } from '@pushform/io/attribution';
import { parseModelAttributions, type ModelAttribution } from '@pushform/model';

export interface CommonsOpenIntent { modelId: string; revision: string; assetId: string }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const key = 'pushform:commons-open:v1';
const valid = (v: unknown): v is CommonsOpenIntent => !!v && typeof v === 'object'
  && typeof (v as CommonsOpenIntent).modelId === 'string' && /^[a-z0-9][a-z0-9-]{0,95}$/.test((v as CommonsOpenIntent).modelId)
  && uuid.test((v as CommonsOpenIntent).revision) && uuid.test((v as CommonsOpenIntent).assetId);
export function isCommonsOpenable(name: string): boolean { return /\.(pf|skp|step|stp|obj|stl|glb|gltf|dae|3ds)$/i.test(name); }
export function commonsOpenUrl(editor: string, model: Pick<CatalogModel, 'id'|'revision'>, assetId: string): string | null {
  const intent = { modelId: model.id, revision: model.revision, assetId };
  if (!valid(intent)) return null;
  let url: URL; try { url = new URL(editor); } catch { return null; }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) return null;
  url.searchParams.set('commonsModel', intent.modelId); url.searchParams.set('commonsRevision', intent.revision); url.searchParams.set('commonsAsset', intent.assetId);
  return url.href;
}
export function commonsIntentFromUrl(url: URL): CommonsOpenIntent | null {
  const value = { modelId: url.searchParams.get('commonsModel'), revision: url.searchParams.get('commonsRevision'), assetId: url.searchParams.get('commonsAsset') };
  return valid(value) ? value : null;
}
/** Capture before authentication consumes its callback URL; no tokens or arbitrary redirect URLs are retained. */
export function rememberCommonsOpen(url: URL, storage: Pick<Storage, 'getItem'|'setItem'|'removeItem'> | null): CommonsOpenIntent | null {
  const has = ['commonsModel', 'commonsRevision', 'commonsAsset'].some(name => url.searchParams.has(name));
  const fromUrl = { modelId: url.searchParams.get('commonsModel'), revision: url.searchParams.get('commonsRevision'), assetId: url.searchParams.get('commonsAsset') };
  try {
    if (has) { if (!valid(fromUrl)) { storage?.removeItem(key); return null; } storage?.setItem(key, JSON.stringify(fromUrl)); return fromUrl; }
    const saved: unknown = JSON.parse(storage?.getItem(key) ?? 'null');
    return valid(saved) ? saved : null;
  } catch { return valid(fromUrl) ? fromUrl : null; }
}
export function forgetCommonsOpen(storage: Pick<Storage, 'removeItem'> | null): void { try { storage?.removeItem(key); } catch { /* The active intent is still cleared in memory. */ } }
export interface OpenedCommonsModel { bytes: Uint8Array; name: string; attribution: ModelAttribution }

/** Only the configured service receives a bearer. Its current publication gate is checked before every package. */
export async function loadCommonsModel(base: string, token: string, intent: CommonsOpenIntent, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<OpenedCommonsModel> {
  if (!valid(intent)) throw new Error('Invalid Commons model link.');
  const url = commonsFileUrl(base, 'downloads', intent.assetId);
  if (!url) throw new Error('Opening Commons models is not configured for this editor.');
  if (!token || /\s/.test(token)) throw new Error('Sign in to open this Commons model.');
  const response = await fetcher(url, { headers: { Authorization: `Bearer ${token}` }, signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Sign in and accept the site Terms of Use before opening this model.' : 'This Commons model is no longer available.');
  const reader = response.body?.getReader(); if (!reader) throw new Error('The model package is empty.');
  const chunks: Uint8Array[] = []; let length = 0;
  for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length;
    if (length > 134217728 + 262144) { await reader.cancel(); throw new Error('The Commons package exceeds the size limit.'); } chunks.push(part.value); }
  signal.throwIfAborted();
  const archive = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { archive.set(chunk, offset); offset += chunk.length; }
  const files = readStoredAttributionPackage(archive);
  const record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(files['ATTRIBUTION.json'])) as Record<string, unknown>;
  if (record.modelId !== intent.modelId || record.revision !== intent.revision) throw new Error('The Commons model revision changed. Return to its page and try again.');
  const metadata = catalogModelSchema.parse({ ...(record.metadata as object), id: intent.modelId, revision: intent.revision, files: [], publishedAt: '1970-01-01T00:00:00.000Z' });
  const [attribution] = parseModelAttributions([{ modelId: intent.modelId, revision: intent.revision, assetId: intent.assetId, title: metadata.title, creator: metadata.creator,
    source: metadata.source, licenses: metadata.licenses, credits: metadata.credits, file: record.file }]);
  const file = attribution!.file;
  if (!isCommonsOpenable(file.name) || file.name.startsWith('.') || /[/\\]/.test(file.name)) throw new Error('This file needs conversion before it can open in PushForm. Download its original package instead.');
  const bytes = files[`files/${file.name}`]; if (!bytes || bytes.length !== file.sizeBytes || Object.keys(files).length !== 3) throw new Error('The downloaded model does not match its package.');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))), b => b.toString(16).padStart(2, '0')).join('');
  if (hash !== file.sha256) throw new Error('The downloaded model failed its integrity check.');
  signal.throwIfAborted(); return { bytes, name: file.name, attribution: attribution! };
}
