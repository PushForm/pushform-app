// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { isIndexableHost, loadSeoConfig, type EdgeEnv } from './render';
const eventSchema = z
  .object({
    sourceId: z.uuid(),
    clickId: z.uuid(),
    destinationVersion: z.string().regex(/^[a-f0-9]{32}$/),
    version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

/** No redirects, visitor identifiers or browser headers are forwarded to the click store. */
export async function purchaseClick(
  request: Request,
  env: EdgeEnv,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store' };
  if (request.method !== 'POST')
    return new Response(null, { status: 405, headers: { ...headers, Allow: 'POST' } });
  const origin = new URL(request.url).origin;
  if (
    request.headers.get('Origin') !== origin ||
    /bot|crawler|spider|headless/i.test(request.headers.get('User-Agent') ?? '')
  )
    return new Response(null, { status: 204, headers });
  if (Number(request.headers.get('Content-Length') ?? 0) > 1024)
    return new Response(null, { status: 413, headers });
  try {
    const text = await request.text();
    if (text.length > 1024) return new Response(null, { status: 413, headers });
    const event = eventSchema.safeParse(JSON.parse(text));
    if (!event.success) return new Response(null, { status: 400, headers });
    const config = await loadSeoConfig(env, origin);
    if (!isIndexableHost(request, config)) return new Response(null, { status: 204, headers });
    if (config.supabaseUrl && config.publishableKey) {
      await fetcher(
        `${config.supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc/commons_record_purchase_click`,
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(5000),
          headers: {
            apikey: config.publishableKey,
            Authorization: `Bearer ${config.publishableKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            p_source: event.data.sourceId,
            p_click: event.data.clickId,
            p_expected_version: event.data.version,
            p_destination_version: event.data.destinationVersion,
          }),
        },
      );
    }
  } catch {
    /* navigation and page lifetime are independent of measurement */
  }
  return new Response(null, { status: 204, headers });
}
