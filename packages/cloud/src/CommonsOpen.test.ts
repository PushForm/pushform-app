// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it, vi } from 'vitest';
import { commonsOpenUrl, rememberCommonsOpen, forgetCommonsOpen, loadCommonsModel, isCommonsOpenable } from './CommonsOpen';
const intent = { modelId: 'example-model', revision: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', assetId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
it('constructs ID-only editor links and refuses unsafe destinations or unsupported formats', () => {
  const url = new URL(commonsOpenUrl('https://app.example', { id: intent.modelId, revision: intent.revision }, intent.assetId)!);
  expect([...url.searchParams.keys()]).toEqual(['commonsModel', 'commonsRevision', 'commonsAsset']);
  expect(commonsOpenUrl('https://attacker:password@app.example', { id: intent.modelId, revision: intent.revision }, intent.assetId)).toBeNull();
  expect(isCommonsOpenable('part.STEP')).toBe(true); for (const name of ['part.fcstd', 'part.blend', 'part.zip']) expect(isCommonsOpenable(name)).toBe(false);
});
it('keeps the validated handoff through an authentication callback until handled', () => {
  const map = new Map<string, string>(); const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); }, removeItem: (k: string) => { map.delete(k); } };
  const url = new URL(commonsOpenUrl('https://app.example', { id: intent.modelId, revision: intent.revision }, intent.assetId)!);
  expect(rememberCommonsOpen(url, storage)).toEqual(intent); expect(rememberCommonsOpen(new URL('https://app.example/auth/callback?code=private'), storage)).toEqual(intent);
  expect([...map.values()].join('')).not.toContain('private'); forgetCommonsOpen(storage); expect(rememberCommonsOpen(new URL('https://app.example'), storage)).toBeNull();
  expect(rememberCommonsOpen(new URL('https://app.example?commonsModel=../../secret'), storage)).toBeNull();
});

// Original three-byte fixture, stored with source notices using the service ZIP protocol.
const packageBytes = Uint8Array.from(atob('UEsDBBQAAAAAAIltX13VOb2bmQIAAJkCAAAQAAAAQVRUUklCVVRJT04uanNvbnsibW9kZWxJZCI6ICJleGFtcGxlLW1vZGVsIiwgInJldmlzaW9uIjogImFhYWFhYWFhLWFhYWEtNGFhYS04YWFhLWFhYWFhYWFhYWFhYSIsICJtZXRhZGF0YSI6IHsidGl0bGUiOiAiVGVzdCBwYXJ0IiwgImRlc2NyaXB0aW9uIjogIk9yaWdpbmFsIGZpeHR1cmUiLCAiY3JlYXRvciI6ICJNYWtlciIsICJjYXRlZ29yeSI6ICJIYXJkd2FyZSIsICJ0YWdzIjogW10sICJmb3JtYXRzIjogWyJTVEVQIl0sICJpbWFnZVVybCI6IG51bGwsICJzb3VyY2UiOiBudWxsLCAibGljZW5zZXMiOiBbeyJuYW1lIjogIkNDIEJZIDMuMCIsICJ1cmwiOiAiaHR0cHM6Ly9jcmVhdGl2ZWNvbW1vbnMub3JnL2xpY2Vuc2VzL2J5LzMuMC8iLCAiY29tbWVyY2lhbFVzZSI6ICJhbGxvd2VkIiwgImNvbmRpdGlvbnMiOiBbIkNyZWRpdCBNYWtlci4iXX1dLCAiY3JlZGl0cyI6IFt7Im5hbWUiOiAiTWFrZXIiLCAidXJsIjogbnVsbCwgInRleHQiOiAiT3JpZ2luYWwgZml4dHVyZS4ifV19LCAiZmlsZSI6IHsibmFtZSI6ICJwYXJ0LnN0ZXAiLCAic2l6ZUJ5dGVzIjogMywgInNoYTI1NiI6ICJiYTc4MTZiZjhmMDFjZmVhNDE0MTQwZGU1ZGFlMjIyM2IwMDM2MWEzOTYxNzdhOWNiNDEwZmY2MWYyMDAxNWFkIn0sICJhc3NldElkIjogImJiYmJiYmJiLWJiYmItNGJiYi04YmJiLWJiYmJiYmJiYmJiYiJ9UEsDBBQAAAAAAIltX10cqJ2OFgAAABYAAAAKAAAAUkVBRE1FLnR4dEtlZXAgb3JpZ2luYWwgbm90aWNlcy5QSwMEFAAAAAAAiW1fXcJBJDUDAAAAAwAAAA8AAABmaWxlcy9wYXJ0LnN0ZXBhYmNQSwECFAMUAAAAAACJbV9d1Tm9m5kCAACZAgAAEAAAAAAAAAAAAAAAgAEAAAAAQVRUUklCVVRJT04uanNvblBLAQIUAxQAAAAAAIltX10cqJ2OFgAAABYAAAAKAAAAAAAAAAAAAACAAccCAABSRUFETUUudHh0UEsBAhQDFAAAAAAAiW1fXcJBJDUDAAAAAwAAAA8AAAAAAAAAAAAAAIABBQMAAGZpbGVzL3BhcnQuc3RlcFBLBQYAAAAAAwADALMAAAA1AwAAAAA='), c => c.charCodeAt(0));
it('authenticates the configured download, checks its revision and hash, and retains original notices', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(packageBytes,{headers:{'Content-Type':'application/zip'}}));
  const opened = await loadCommonsModel('https://files.example', 'current-token', intent, new AbortController().signal, fetcher);
  expect(new TextDecoder().decode(opened.bytes)).toBe('abc'); expect(opened.attribution).toMatchObject({ modelId: intent.modelId, revision: intent.revision, assetId: intent.assetId, creator: 'Maker', licenses: [{ name: 'CC BY 3.0', conditions: ['Credit Maker.'] }] });
  const [url, options] = fetcher.mock.calls[0]!; expect(url).toBe('https://files.example/downloads/' + intent.assetId);
  expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer current-token'); expect(options).toMatchObject({ credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
});
it('refuses unavailable content and mismatched revision notices before exposing import bytes', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('unavailable', { status: 404 }));
  await expect(loadCommonsModel('https://files.example', 'current-token', intent, new AbortController().signal, fetcher)).rejects.toThrow('could not complete');
  fetcher.mockResolvedValueOnce(new Response(packageBytes,{headers:{'Content-Type':'application/zip'}}));
  await expect(loadCommonsModel('https://files.example', 'current-token', { ...intent, revision: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, new AbortController().signal, fetcher)).rejects.toThrow('revision changed');
  fetcher.mockResolvedValueOnce(new Response(packageBytes,{headers:{'Content-Type':'application/zip'}}));
  await expect(loadCommonsModel('https://files.example','current-token',{...intent,assetId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd'},new AbortController().signal,fetcher)).rejects.toThrow('revision changed');
  const corrupt = packageBytes.slice(); const lastA = corrupt.lastIndexOf(97); corrupt[lastA] = 100;
  fetcher.mockResolvedValueOnce(new Response(corrupt));
  await expect(loadCommonsModel('https://files.example', 'current-token', intent, new AbortController().signal, fetcher)).rejects.toThrow();
});
