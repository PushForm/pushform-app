// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { releaseCloudConfig, serverCredentialsIn } from './cloudConfig';

const jwt = (role: string): string => `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ role })).replace(/=+$/, '')}.c2lnbmF0dXJl`;

describe('release cloud configuration', () => {
  it('accepts a project URL with a publishable key, or with a legacy anon key', () => {
    expect(releaseCloudConfig({ VITE_SUPABASE_URL: 'https://abc.supabase.co/', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x1' }))
      .toEqual({ url: 'https://abc.supabase.co', publishableKey: 'sb_publishable_x1' });
    expect(releaseCloudConfig({ VITE_SUPABASE_URL: 'https://abc.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: '', VITE_SUPABASE_ANON_KEY: jwt('anon') }).publishableKey)
      .toBe(jwt('anon'));
  });

  it('names a missing or invalid variable', () => {
    expect(() => releaseCloudConfig({ VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x1' })).toThrow('VITE_SUPABASE_URL is not set.');
    expect(() => releaseCloudConfig({ VITE_SUPABASE_URL: ' ', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x1' })).toThrow('VITE_SUPABASE_URL is not set.');
    expect(() => releaseCloudConfig({ VITE_SUPABASE_URL: 'https://abc.supabase.co' })).toThrow(/Neither VITE_SUPABASE_PUBLISHABLE_KEY/);
    expect(() => releaseCloudConfig({ VITE_SUPABASE_URL: 'abc', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x1' })).toThrow('VITE_SUPABASE_URL is not a URL.');
    expect(() => releaseCloudConfig({ VITE_SUPABASE_URL: 'http://abc.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x1' })).toThrow('Invalid cloud project URL.');
  });

  it('refuses secret and service-role keys without echoing them', () => {
    for (const key of ['sb_secret_abc123', jwt('service_role')]) {
      expect(() => releaseCloudConfig({ VITE_SUPABASE_URL: 'https://abc.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: key }))
        .toThrow('Cloud configuration requires a public publishable or anon key.');
    }
  });
});

describe('server credentials in shipped text', () => {
  it('finds secret keys and service-role JWTs, describing them without the value', () => {
    const found = serverCredentialsIn(`const a="sb_secret_abc123";const b="${jwt('service_role')}";`);
    expect(found).toEqual(['1 Supabase secret key (sb_secret_…)', '1 service-role credential']);
    expect(found.join(' ')).not.toContain('abc123');
    expect(serverCredentialsIn('{"role":"service_role"}')).toEqual(['1 service-role credential']);
  });

  it('passes public keys and code that only mentions the prefixes', () => {
    expect(serverCredentialsIn(`k="sb_publishable_x1";a="${jwt('anon')}";if(k.startsWith("sb_secret_"))throw 0;`)).toEqual([]);
  });
});
