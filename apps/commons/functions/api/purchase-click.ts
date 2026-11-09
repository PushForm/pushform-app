// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { purchaseClick } from '../../src/edge/purchaseClicks';
import type { EdgeEnv } from '../../src/edge/render';
export const onRequest = ({ request, env }: { request: Request; env: EdgeEnv }) =>
  purchaseClick(request, env);
