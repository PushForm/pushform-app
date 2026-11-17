// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it, vi } from 'vitest';
import { purchaseClick } from './purchaseClicks';
const event = {
  sourceId: '11111111-1111-4111-8111-111111111111',
  clickId: '22222222-2222-4222-8222-222222222222',
  version: 3,
  destinationVersion: 'a'.repeat(32),
};
const env = {
  ASSETS: {
    fetch: async () =>
      Response.json({
        siteUrl: 'https://commons.example',
        supabaseUrl: 'https://database.example',
        publishableKey: 'public-example',
      }),
  },
};
const request = (body: unknown = event, origin = 'https://commons.example') =>
  new Request('https://commons.example/api/purchase-click', {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0',
      'X-Forwarded-For': '192.0.2.1',
      Referer: 'https://private.example/',
    },
    body: JSON.stringify(body),
  });
it('records an activation separately and forwards only the source, versions and click identity', async () => {
  const fetcher = vi.fn(async () => Response.json(true));
  expect((await purchaseClick(request(), env, fetcher)).status).toBe(204);
  const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('https://database.example/rest/v1/rpc/commons_record_purchase_click');
  expect(JSON.parse(init.body as string)).toEqual({
    p_source: event.sourceId,
    p_click: event.clickId,
    p_expected_version: 3,
    p_destination_version: event.destinationVersion,
  });
  expect(JSON.stringify(init)).not.toMatch(/192\.0\.2|private\.example|Mozilla|Referer|Forwarded/);
  expect(init.redirect).toBe('error');
});
it('does not count GETs, other origins, bots or invalid payloads and survives a failed measurement request', async () => {
  const fetcher = vi.fn(async () => {
    throw new Error('offline');
  });
  expect(
    (await purchaseClick(new Request('https://commons.example/api/purchase-click'), env, fetcher))
      .status,
  ).toBe(405);
  expect((await purchaseClick(request(event, 'https://other.example'), env, fetcher)).status).toBe(
    204,
  );
  expect((await purchaseClick(request({ ...event, version: -1 }), env, fetcher)).status).toBe(400);
  const bot = request();
  bot.headers.set('User-Agent', 'CrawlerBot');
  expect((await purchaseClick(bot, env, fetcher)).status).toBe(204);
  expect(fetcher).not.toHaveBeenCalled();
  expect((await purchaseClick(request(), env, fetcher)).status).toBe(204);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
