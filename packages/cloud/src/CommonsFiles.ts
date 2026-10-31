// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { catalogUrlSchema, commonsUploadSchema, type CommonsUpload } from './CommonsCatalog';

export const COMMONS_FILE_LIMIT = 128 * 1024 * 1024;
/** Original file plus bounded attribution and ZIP headers. */
export const COMMONS_PACKAGE_LIMIT = COMMONS_FILE_LIMIT + 256 * 1024;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Only configured service origins receive tokens; credentials never appear in a URL. */
export function commonsFileUrl(base: string | undefined, operation: 'uploads'|'downloads'|'review'|'thumbnails'|'previews'|'images', id?: string): string | null {
  const parsed = catalogUrlSchema.safeParse(base?.trim());
  if (!parsed.success || (id !== undefined && !uuid.test(id))) return null;
  const url = new URL(parsed.data);
  if (url.search || url.hash || url.pathname !== '/') return null;
  return `${url.origin}/${operation}${id ? '/' + id : ''}`;
}
export class CommonsTermsRequiredError extends Error {
  constructor() { super('Complete your account setup and accept the site Terms of Use before downloading.'); this.name = 'CommonsTermsRequiredError'; }
}
async function request(fetcher: typeof fetch, url: string, token: string, init: RequestInit): Promise<Response> {
  if (!token || /\s/.test(token)) throw new Error('Sign in to manage model files.');
  const headers = new Headers(init.headers); headers.set('Authorization', `Bearer ${token}`);
  const response = await fetcher(url, { ...init, headers, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
  if (!response.ok) {
    if (response.status === 403) {
      const detail = await response.clone().json().catch(() => null) as {code?:unknown}|null;
      if (detail?.code === 'commons_terms_required') throw new CommonsTermsRequiredError();
    }
    throw new Error(response.status === 409 ? 'This revision changed. Refresh before trying again.' :
    response.status === 401 || response.status === 403 ? 'Your account cannot manage these model files.' :
    response.status === 422 ? 'The file failed its size, type or checksum checks.' : 'The file service could not complete this request.');
  }
  return response;
}
export async function uploadCommonsFile(base: string, token: string, revision: string, file: Blob & { name: string }, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<CommonsUpload> {
  const url = commonsFileUrl(base, 'uploads');
  if (!url) throw new Error('Model file uploads are not configured.');
  if (!uuid.test(revision) || !file.name || file.name.length > 180 || /^[.]/.test(file.name) || /[/\\]/.test(file.name) || Array.from(file.name).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || !/\.(pf|step|stp|obj|stl|glb|gltf|dae|3ds|zip|fcstd|blend|skp|png|jpe?g)$/i.test(file.name))
    throw new Error('Choose a supported model file or ZIP archive with a valid filename.');
  if (file.size < 1 || file.size > COMMONS_FILE_LIMIT) throw new Error('Choose a model file between 1 byte and 128 MiB.');
  if (/\.(png|jpe?g)$/i.test(file.name) && file.size > 8 * 1024 * 1024) throw new Error('Choose a preview image no larger than 8 MiB.');
  signal.throwIfAborted();
  const bytes = await file.arrayBuffer(); signal.throwIfAborted();
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) => value.toString(16).padStart(2, '0')).join('');
  signal.throwIfAborted();
  const reservation = commonsUploadSchema.parse(await (await request(fetcher, url, token, { method: 'POST', signal,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision, filename: file.name, sizeBytes: file.size, sha256 }) })).json());
  if (reservation.revision_id !== revision || reservation.sha256 !== sha256 || reservation.size_bytes !== file.size || reservation.filename !== file.name || reservation.status === 'removed')
    throw new Error('The upload reservation does not match the selected file.');
  if (reservation.status === 'ready') return reservation;
  const result = await (await request(fetcher, commonsFileUrl(base, 'uploads', reservation.id)!, token,
    { method: 'PUT', signal, headers: { 'Content-Type': 'application/octet-stream' }, body: file })).json() as { id?: unknown; status?: unknown };
  if (result.id !== reservation.id || result.status !== 'ready') throw new Error('The file upload was not verified.');
  return { ...reservation, status: 'ready' };
}
export async function removeCommonsFile(base: string, token: string, id: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<void> {
  const url = commonsFileUrl(base, 'uploads', id); if (!url) throw new Error('Model file uploads are not configured.');
  await request(fetcher, url, token, { method: 'DELETE', signal });
}
export async function reviewCommonsFile(base: string, token: string, id: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<Blob> {
  const url = commonsFileUrl(base, 'review', id); if (!url) throw new Error('Model file downloads are not configured.');
  return (await request(fetcher, url, token, { signal })).blob();
}

/** Downloads use the current session only; access tokens never appear in links or referrers. */
export async function downloadCommonsFile(base: string, token: string, id: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<Blob> {
  const url = commonsFileUrl(base, 'downloads', id); if (!url) throw new Error('Model file downloads are not configured.');
  const response = await request(fetcher, url, token, { signal });
  if (response.headers.get('Content-Type')?.split(';')[0]?.trim() !== 'application/zip') { await response.body?.cancel().catch(() => {}); throw new Error('The file service did not return a model package.'); }
  const declared = response.headers.get('Content-Length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > COMMONS_PACKAGE_LIMIT)) { await response.body?.cancel().catch(() => {}); throw new Error('The model package exceeds the download limit.'); }
  if (!response.body) throw new Error('The model package is empty.');
  const reader = response.body.getReader(); const chunks: ArrayBuffer[] = []; let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > COMMONS_PACKAGE_LIMIT) { await reader.cancel(); throw new Error('The model package exceeds the download limit.'); }
      chunks.push(new Uint8Array(next.value).buffer);
    }
  } finally { reader.releaseLock(); }
  if (!size) throw new Error('The model package is empty.');
  return new Blob(chunks, { type: 'application/zip' });
}
