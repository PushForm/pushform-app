// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { catalogUrlSchema } from './CommonsCatalog';

export type CommonsProfileImageKind = 'avatar' | 'banner';
/** Profile images are cropped in the browser to exactly these sizes; the file service rejects any other size. */
export const COMMONS_PROFILE_IMAGE_SIZES = { avatar: { width: 512, height: 512 }, banner: { width: 1500, height: 500 } } as const;
export const COMMONS_PROFILE_IMAGE_LIMIT = 2 * 1024 * 1024;
export const commonsProfileImageSchema = z.object({
  id: z.uuid(), width: z.number().int().positive(), height: z.number().int().positive(),
  sizeBytes: z.number().int().min(1).max(COMMONS_PROFILE_IMAGE_LIMIT), sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type CommonsProfileImage = z.infer<typeof commonsProfileImageSchema>;

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/** Only a configured service origin is used; a profile image address never carries credentials. */
export function commonsProfileImageUrl(base: string | undefined, target?: string): string | null {
  let parsed: ReturnType<typeof catalogUrlSchema.safeParse>;
  try { parsed = catalogUrlSchema.safeParse(base?.trim()); } catch { return null; }
  if (!parsed.success || (target !== undefined && !uuid.test(target) && target !== 'avatar' && target !== 'banner')) return null;
  const url = new URL(parsed.data);
  if (url.search || url.hash || url.pathname !== '/') return null;
  return `${url.origin}/profile-images${target ? '/' + target : ''}`;
}

export type CommonsUploadStage = 'preparing' | 'uploading' | 'verifying';
export interface CommonsUploadProgress { stage: CommonsUploadStage; loaded: number; total: number }
/** Sends the image bytes; the default reports upload progress where the browser supports it. */
export type CommonsProfileImageSender = (url: string, token: string, body: Blob, signal: AbortSignal, onProgress: (loaded: number) => void) => Promise<{ status: number; body: unknown }>;

function failure(status: number): Error {
  return new Error(status === 401 ? 'Sign in to change your profile images.' :
    status === 403 ? 'Save your public profile before adding images.' :
    status === 409 ? 'This image changed in another tab. Try again.' :
    status === 413 || status === 422 ? 'The image failed its size, type or checksum checks.' : 'The file service could not save this image. Try again.');
}
const authHeaders = (token: string) => {
  if (!token || /\s/.test(token)) throw new Error('Sign in to change your profile images.');
  return { Authorization: `Bearer ${token}` };
};
async function call(fetcher: typeof fetch, url: string, token: string, init: RequestInit): Promise<unknown> {
  const response = await fetcher(url, { ...init, headers: { ...init.headers as Record<string, string>, ...authHeaders(token) }, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
  if (!response.ok) throw failure(response.status);
  return response.json();
}

export const xhrSender: CommonsProfileImageSender = (url, token, body, signal, onProgress) => new Promise((resolve, reject) => {
  const headers = authHeaders(token);
  if (typeof XMLHttpRequest === 'undefined') {
    void fetch(url, { method: 'PUT', body, signal, headers: { ...headers, 'Content-Type': 'application/octet-stream' }, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' })
      .then(async response => resolve({ status: response.status, body: await response.json().catch(() => null) }), reject);
    return;
  }
  const request = new XMLHttpRequest();
  request.open('PUT', url); request.withCredentials = false; request.responseType = 'json';
  request.setRequestHeader('Authorization', headers.Authorization); request.setRequestHeader('Content-Type', 'application/octet-stream');
  request.upload.onprogress = event => { if (event.lengthComputable) onProgress(event.loaded); };
  request.onload = () => resolve({ status: request.status, body: request.response as unknown });
  request.onerror = () => reject(new Error('The image could not be uploaded. Check your connection and try again.'));
  request.onabort = () => reject(signal.reason instanceof Error ? signal.reason : new DOMException('Upload cancelled.', 'AbortError'));
  signal.addEventListener('abort', () => request.abort(), { once: true });
  request.send(body);
});

const reservationSchema = z.object({ id: z.uuid(), kind: z.enum(['avatar', 'banner']), format: z.enum(['png', 'jpeg']), status: z.enum(['pending', 'ready', 'removed']), size_bytes: z.number(), sha256: z.string(), width: z.number(), height: z.number() });

/** Reserves, uploads and verifies one cropped image. It becomes the current image only after the service checks it. */
export async function uploadCommonsProfileImage(base: string, token: string, kind: CommonsProfileImageKind, image: Blob, signal: AbortSignal,
  options: { onProgress?: (progress: CommonsUploadProgress) => void; send?: CommonsProfileImageSender; fetcher?: typeof fetch } = {}): Promise<{ id: string }> {
  const url = commonsProfileImageUrl(base); if (!url) throw new Error('Profile image uploads are not configured.');
  const format = image.type === 'image/png' ? 'png' : image.type === 'image/jpeg' ? 'jpeg' : null;
  if (!format) throw new Error('Profile images must be PNG or JPEG.');
  if (image.size < 1 || image.size > COMMONS_PROFILE_IMAGE_LIMIT) throw new Error('The cropped image is larger than 2 MiB. Try a simpler image.');
  const report = (stage: CommonsUploadStage, loaded = 0) => options.onProgress?.({ stage, loaded, total: image.size });
  report('preparing'); signal.throwIfAborted();
  const bytes = await image.arrayBuffer(); signal.throwIfAborted();
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
  const size = COMMONS_PROFILE_IMAGE_SIZES[kind];
  const reservation = reservationSchema.parse(await call(options.fetcher ?? fetch, url, token, { method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, format, sizeBytes: image.size, sha256, width: size.width, height: size.height }) }));
  if (reservation.kind !== kind || reservation.format !== format || reservation.sha256 !== sha256 || reservation.size_bytes !== image.size || reservation.status === 'removed')
    throw new Error('The upload reservation does not match the cropped image.');
  if (reservation.status === 'ready') { report('verifying', image.size); return { id: reservation.id }; }
  report('uploading');
  const result = await (options.send ?? xhrSender)(commonsProfileImageUrl(base, reservation.id)!, token, new Blob([bytes], { type: 'application/octet-stream' }), signal, loaded => report(loaded >= image.size ? 'verifying' : 'uploading', loaded));
  if (result.status < 200 || result.status >= 300) throw failure(result.status);
  const body = result.body as { id?: unknown; status?: unknown } | null;
  if (body?.id !== reservation.id || body.status !== 'ready') throw new Error('The image upload was not verified.');
  return { id: reservation.id };
}

export async function removeCommonsProfileImage(base: string, token: string, kind: CommonsProfileImageKind, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<void> {
  const url = commonsProfileImageUrl(base, kind); if (!url) throw new Error('Profile image uploads are not configured.');
  await call(fetcher, url, token, { method: 'DELETE', signal });
}
