// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { catalogUrlSchema, commonsUploadSchema, type CommonsUpload } from './CommonsCatalog';
import { xhrSender, type CommonsProfileImageSender, type CommonsUploadProgress } from './CommonsProfileImages';

export const COMMONS_FILE_LIMIT = 128 * 1024 * 1024;
export const COMMONS_IMAGE_LIMIT = 8 * 1024 * 1024;
/** Model formats Commons accepts and converts for previews: the editor's import formats plus native PF and FreeCAD. */
export const COMMONS_MODEL_EXTENSIONS = ['skp', 'skb', 'dae', 'kmz', 'obj', '3ds', 'stl', 'dxf', 'gltf', 'glb', 'step', 'stp', 'pf', 'fcstd', 'zip'] as const;
/** Pictures are accepted only as the cover photo. */
export const COMMONS_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg'] as const;
export const commonsFileExtension = (name: string): string => /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
export function commonsFileKind(name: string): 'model' | 'image' | null {
  const extension = commonsFileExtension(name);
  return (COMMONS_MODEL_EXTENSIONS as readonly string[]).includes(extension) ? 'model' : (COMMONS_IMAGE_EXTENSIONS as readonly string[]).includes(extension) ? 'image' : null;
}
/** Original file plus bounded attribution and ZIP headers. */
export const COMMONS_PACKAGE_LIMIT = COMMONS_FILE_LIMIT + 256 * 1024;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Only configured service origins receive tokens; credentials never appear in a URL. */
export function commonsFileUrl(base: string | undefined, operation: 'uploads'|'downloads'|'review'|'thumbnails'|'previews'|'images'|'preview-status'|'renders', id?: string): string | null {
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
export interface CommonsFileUploadOptions { fetcher?: typeof fetch; send?: CommonsProfileImageSender; onProgress?: (progress: CommonsUploadProgress) => void }
/** Reserves, sends and verifies one file. `onProgress` reports hashing, the bytes sent, then the service's checks. */
export async function uploadCommonsFile(base: string, token: string, revision: string, file: Blob & { name: string }, signal: AbortSignal, options: typeof fetch | CommonsFileUploadOptions = {}): Promise<CommonsUpload> {
  const { fetcher = fetch, send, onProgress } = typeof options === 'function' ? { fetcher: options } as CommonsFileUploadOptions : options;
  const report = (stage: CommonsUploadProgress['stage'], loaded = 0) => onProgress?.({ stage, loaded, total: file.size });
  const url = commonsFileUrl(base, 'uploads');
  if (!url) throw new Error('Model file uploads are not configured.');
  if (!uuid.test(revision) || !file.name || file.name.length > 180 || /^[.]/.test(file.name) || /[/\\]/.test(file.name) || Array.from(file.name).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || !commonsFileKind(file.name))
    throw new Error('Choose a supported model file or ZIP archive with a valid filename.');
  if (file.size < 1 || file.size > COMMONS_FILE_LIMIT) throw new Error('Choose a model file between 1 byte and 128 MiB.');
  if (commonsFileKind(file.name) === 'image' && file.size > COMMONS_IMAGE_LIMIT) throw new Error('Choose a cover photo no larger than 8 MiB.');
  report('preparing'); signal.throwIfAborted();
  const bytes = await file.arrayBuffer(); signal.throwIfAborted();
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) => value.toString(16).padStart(2, '0')).join('');
  signal.throwIfAborted();
  const reservation = commonsUploadSchema.parse(await (await request(fetcher, url, token, { method: 'POST', signal,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision, filename: file.name, sizeBytes: file.size, sha256 }) })).json());
  if (reservation.revision_id !== revision || reservation.sha256 !== sha256 || reservation.size_bytes !== file.size || reservation.filename !== file.name || reservation.status === 'removed')
    throw new Error('The upload reservation does not match the selected file.');
  if (reservation.status === 'ready') { report('verifying', file.size); return reservation; }
  report('uploading');
  const target = commonsFileUrl(base, 'uploads', reservation.id)!;
  let result: { id?: unknown; status?: unknown };
  if (send || (typeof options !== 'function' && !options.fetcher && typeof XMLHttpRequest !== 'undefined')) {
    // Upload progress needs XMLHttpRequest; fetch reports no progress for request bodies.
    const sent = await (send ?? xhrSender)(target, token, new Blob([bytes], { type: 'application/octet-stream' }), signal, loaded => report(loaded >= file.size ? 'verifying' : 'uploading', loaded));
    if (sent.status < 200 || sent.status >= 300) throw new Error(sent.status === 409 ? 'This revision changed. Refresh before trying again.' : sent.status === 422 ? 'The file failed its size, type or checksum checks.' : 'The file service could not complete this request.');
    result = (sent.body ?? {}) as { id?: unknown; status?: unknown };
  } else {
    result = await (await request(fetcher, target, token, { method: 'PUT', signal, headers: { 'Content-Type': 'application/octet-stream' }, body: file })).json() as { id?: unknown; status?: unknown };
  }
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

/** One line of the file service's streamed conversion response. */
export type CommonsRenderEvent =
  | { state: 'waiting' | 'starting' | 'converting' | 'storing' | 'pending' }
  | { state: 'ready'; triangles: number | null; durationMs: number | null }
  | { state: 'failed'; error: string; code: string | null; retry: boolean };
const renderEvent = (value: unknown): CommonsRenderEvent | null => {
  if (!value || typeof value !== 'object') return null;
  const event = value as Record<string, unknown>;
  if (['waiting', 'starting', 'converting', 'storing', 'pending'].includes(event.state as string)) return { state: event.state as 'waiting' };
  const number = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  if (event.state === 'ready') return { state: 'ready', triangles: number(event.triangles), durationMs: number(event.durationMs) };
  if (event.state === 'failed') return { state: 'failed', error: typeof event.error === 'string' ? event.error.slice(0, 300) : 'The preview could not be created.', code: typeof event.code === 'string' ? event.code : null, retry: event.retry === true };
  return null;
};

/** Asks the file service to convert the signed-in owner's file now and reports each state as it streams in. Resolves
 * with the last state; a stream that ends early resolves with `pending`, and the service finishes the job later. */
export async function streamCommonsRender(base: string, token: string, asset: string, signal: AbortSignal, onEvent: (event: CommonsRenderEvent) => void,
  options: { retry?: boolean; fetcher?: typeof fetch } = {}): Promise<CommonsRenderEvent> {
  const url = commonsFileUrl(base, 'renders', asset); if (!url) throw new Error('Model previews are not configured.');
  const response = await request(options.fetcher ?? fetch, url, token, { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ retry: options.retry === true }) });
  if (!response.body) throw new Error('The file service returned no conversion progress.');
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '', last: CommonsRenderEvent = { state: 'pending' };
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      buffer += next.value;
      if (buffer.length > 65536) throw new Error('The conversion progress was malformed.');
      let line: number;
      while ((line = buffer.indexOf('\n')) >= 0) {
        const event = renderEvent(JSON.parse(buffer.slice(0, line) || 'null'));
        buffer = buffer.slice(line + 1);
        if (event) { last = event; onEvent(event); }
      }
    }
  } finally { reader.releaseLock(); }
  return last;
}

/** The signed-in owner's preview thumbnail (drafts included): an SVG image, or the job's state while there is none. */
export async function fetchCommonsThumbnail(base: string, token: string, asset: string, signal: AbortSignal, fetcher: typeof fetch = fetch):
  Promise<{ kind: 'image'; blob: Blob } | { kind: 'status'; status: string; error: string | null }> {
  const url = commonsFileUrl(base, 'thumbnails', asset); if (!url) throw new Error('Model previews are not configured.');
  if (!token || /\s/.test(token)) throw new Error('Sign in to see your model previews.');
  const response = await fetcher(url, { headers: { Authorization: `Bearer ${token}` }, signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
  if (response.status === 200 && response.headers.get('Content-Type')?.startsWith('image/svg+xml')) return { kind: 'image', blob: new Blob([await response.arrayBuffer()], { type: 'image/svg+xml' }) };
  const body = await response.json().catch(() => null) as { status?: unknown; error?: unknown } | null;
  return { kind: 'status', status: typeof body?.status === 'string' ? body.status : response.status === 404 ? 'missing' : 'failed', error: typeof body?.error === 'string' ? body.error : null };
}

/** The signed-in owner's cover photo, drafts included. */
export async function fetchCommonsImage(base: string, token: string, asset: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<Blob> {
  const url = commonsFileUrl(base, 'images', asset); if (!url) throw new Error('Model previews are not configured.');
  return (await request(fetcher, url, token, { signal })).blob();
}

/** Deletes a never-published draft, or discards the draft of a published model (the published revision stays). */
export async function deleteCommonsDraft(base: string, token: string, model: string, revision: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<void> {
  const parsed = catalogUrlSchema.safeParse(base?.trim());
  if (!parsed.success || !/^[a-z0-9][a-z0-9-]{0,95}$/.test(model) || !uuid.test(revision)) throw new Error('Drafts cannot be deleted in this build.');
  const origin = new URL(parsed.data);
  if (origin.search || origin.hash || origin.pathname !== '/') throw new Error('Drafts cannot be deleted in this build.');
  await request(fetcher, `${origin.origin}/drafts/${model}/${revision}`, token, { method: 'DELETE', signal });
}
