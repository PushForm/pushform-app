// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it, vi } from 'vitest';
import { commonsProfileImageUrl, removeCommonsProfileImage, uploadCommonsProfileImage, type CommonsProfileImageSender, type CommonsUploadProgress } from './CommonsProfileImages';
import { commonsProfileSchema } from './CommonsProfiles';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const base = 'https://files.example.com';
async function sha(blob: Blob) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), b => b.toString(16).padStart(2, '0')).join(''); }
function service(reservation: Record<string, unknown> = {}, status = 201) {
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ id, kind: body.kind, format: body.format, status: 'pending', size_bytes: body.sizeBytes, sha256: body.sha256, width: body.width, height: body.height, ...reservation }), { status });
  });
  const send = vi.fn<CommonsProfileImageSender>(async (_url, _token, body, _signal, onProgress) => { onProgress(body.size / 2); onProgress(body.size); return { status: 200, body: { id, status: 'ready' } }; });
  return { fetcher: fetcher as unknown as typeof fetch & typeof fetcher, send };
}

it('builds file service addresses only from a configured origin and known targets', () => {
  expect(commonsProfileImageUrl(base)).toBe(`${base}/profile-images`);
  expect(commonsProfileImageUrl(base, id)).toBe(`${base}/profile-images/${id}`);
  expect(commonsProfileImageUrl(base, 'banner')).toBe(`${base}/profile-images/banner`);
  for (const value of [undefined, 'http://files.example.com', 'https://files.example.com/path', 'https://files.example.com/?token=1']) expect(commonsProfileImageUrl(value, id)).toBeNull();
  expect(commonsProfileImageUrl(base, '../uploads')).toBeNull();
});

it('reserves the exact cropped bytes and size, uploads with progress and waits for verification', async () => {
  const image = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/jpeg' }); const { fetcher, send } = service(); const stages: CommonsUploadProgress[] = [];
  expect(await uploadCommonsProfileImage(base, 'token', 'banner', image, new AbortController().signal, { fetcher, send, onProgress: value => stages.push(value) })).toEqual({ id });
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe(`${base}/profile-images`); expect(init.method).toBe('POST'); expect(new Headers(init.headers).get('Authorization')).toBe('Bearer token');
  expect(init.credentials).toBe('omit'); expect(url).not.toContain('token');
  expect(JSON.parse(String(init.body))).toEqual({ kind: 'banner', format: 'jpeg', sizeBytes: 4, sha256: await sha(image), width: 1500, height: 500 });
  expect(send.mock.calls[0]![0]).toBe(`${base}/profile-images/${id}`);
  expect(stages.map(value => value.stage)).toEqual(['preparing', 'uploading', 'uploading', 'verifying']);
});

it('refuses unsupported or oversized images and mismatched or failed uploads', async () => {
  const signal = new AbortController().signal;
  const { fetcher, send } = service();
  await expect(uploadCommonsProfileImage(base, 'token', 'avatar', new Blob(['x'], { type: 'image/gif' }), signal, { fetcher, send })).rejects.toThrow('PNG or JPEG');
  await expect(uploadCommonsProfileImage(base, 'token', 'avatar', new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], { type: 'image/png' }), signal, { fetcher, send })).rejects.toThrow('2 MiB');
  await expect(uploadCommonsProfileImage('', 'token', 'avatar', new Blob(['x'], { type: 'image/png' }), signal, { fetcher, send })).rejects.toThrow('not configured');
  expect(fetcher).not.toHaveBeenCalled();
  const image = new Blob(['x'], { type: 'image/png' });
  await expect(uploadCommonsProfileImage(base, 'token', 'avatar', image, signal, { ...service({ sha256: 'b'.repeat(64) }) })).rejects.toThrow('does not match');
  await expect(uploadCommonsProfileImage(base, 'token', 'avatar', image, signal, { ...service({}, 403) })).rejects.toThrow('Save your public profile');
  const rejected = service(); rejected.send.mockResolvedValueOnce({ status: 422, body: { error: 'internal' } });
  await expect(uploadCommonsProfileImage(base, 'token', 'avatar', image, signal, rejected)).rejects.toThrow('size, type or checksum');
  const unverified = service(); unverified.send.mockResolvedValueOnce({ status: 200, body: { id, status: 'pending' } });
  await expect(uploadCommonsProfileImage(base, 'token', 'avatar', image, signal, unverified)).rejects.toThrow('not verified');
  const ready = service({ status: 'ready' }); expect(await uploadCommonsProfileImage(base, 'token', 'avatar', image, signal, ready)).toEqual({ id }); expect(ready.send).not.toHaveBeenCalled();
});

it('removes an image kind with the session token', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ removed: true })));
  await removeCommonsProfileImage(base, 'token', 'avatar', new AbortController().signal, fetcher as unknown as typeof fetch);
  expect(fetcher).toHaveBeenCalledWith(`${base}/profile-images/avatar`, expect.objectContaining({ method: 'DELETE', credentials: 'omit' }));
});

it('reads profiles with or without uploaded images and rejects malformed image records', () => {
  const profile = { id, handle: 'example-maker', displayName: 'Example Maker', bio: '', avatarUrl: null, links: [], active: true, version: 1 };
  expect(commonsProfileSchema.parse(profile)).toEqual(profile);
  const image = { id, width: 512, height: 512, sizeBytes: 1000, sha256: 'a'.repeat(64) };
  expect(commonsProfileSchema.parse({ ...profile, avatarImage: image, bannerImage: null }).avatarImage).toEqual(image);
  expect(commonsProfileSchema.safeParse({ ...profile, avatarImage: { ...image, objectKey: 'profile-images/x' } }).success).toBe(false);
});
