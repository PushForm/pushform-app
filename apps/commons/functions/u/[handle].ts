// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { workerCache } from '../../src/edge/cache';
import { renderPage, type EdgeEnv } from '../../src/edge/render';
import { methodGuard } from '../../src/edge/method';

export const onRequest = ({ request, env, params }: { request: Request; env: EdgeEnv; params: { handle: string } }): Promise<Response> | Response =>
  methodGuard(request) ?? renderPage(request, env, { kind: 'profile', handle: String(params.handle) }, { cache: workerCache() });
