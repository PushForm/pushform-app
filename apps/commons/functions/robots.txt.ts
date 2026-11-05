// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { renderRobots, type EdgeEnv } from '../src/edge/render';
import { methodGuard } from '../src/edge/method';

export const onRequest = ({ request, env }: { request: Request; env: EdgeEnv }): Promise<Response> | Response =>
  methodGuard(request) ?? renderRobots(request, env);
