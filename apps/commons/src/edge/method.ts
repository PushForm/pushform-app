// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors

/** Pages and sitemaps are read-only: anything but GET or HEAD is refused. */
export function methodGuard(request: Request): Response | null {
  return request.method === 'GET' || request.method === 'HEAD' ? null : new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
}
