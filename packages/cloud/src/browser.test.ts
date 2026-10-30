// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { authCallbackFromUrl, validateBrowserCloudConfig } from './browser';
const publicKey = 'sb_publishable_test';
it('accepts public keys and secure project origins, including local development', () => {
  expect(validateBrowserCloudConfig({ url: ' https://example.supabase.co/ ', publishableKey: publicKey }).url).toBe('https://example.supabase.co');
  expect(validateBrowserCloudConfig({ url: 'http://127.0.0.1:54321', publishableKey: publicKey }).url).toBe('http://127.0.0.1:54321');
  const anon = `e30.${btoa(JSON.stringify({ role: 'anon' }))}.signature`;
  expect(validateBrowserCloudConfig({ url: 'https://example.supabase.co', publishableKey: anon }).publishableKey).toBe(anon);
});
it.each(['sb_secret_test', `e30.${btoa(JSON.stringify({ role: 'service_role' }))}.signature`, 'invalid'])('rejects private or invalid browser credentials', publishableKey => {
  expect(() => validateBrowserCloudConfig({ url: 'https://example.supabase.co', publishableKey })).toThrow();
});
it.each(['http://example.com', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com?key=value'])('rejects unsafe project origins: %s', url => {
  expect(() => validateBrowserCloudConfig({ url, publishableKey: publicKey })).toThrow();
});
it('only consumes auth credentials on the dedicated callback route', () => {
  expect(authCallbackFromUrl(new URL('https://app.example/?code=ignored'))).toBeNull();
  expect(authCallbackFromUrl(new URL('https://app.example/auth/callback?code=one&sb_flow_id=two&next=https://evil.example'))).toEqual({ kind: 'code', code: 'one', flowId: 'two' });
  expect(authCallbackFromUrl(new URL('https://app.example/auth/callback?token_hash=token&type=email'))).toEqual({ kind: 'emailToken', tokenHash: 'token' });
});
it.each(['?error=denied&error_description=private', '#access_token=private', '?token_hash=token&type=recovery', ''])('rejects unsupported or failed callbacks safely: %s', suffix => {
  expect(authCallbackFromUrl(new URL(`https://app.example/auth/callback${suffix}`))).toEqual({ kind: 'error' });
});
