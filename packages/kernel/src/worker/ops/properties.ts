// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { PropertiesRequest, PropertiesResult } from '../../protocol';
import type { KernelContext } from '../context';
import { getBody } from './bodies';

export function properties(ctx: KernelContext, req: PropertiesRequest): PropertiesResult {
  const { manifold } = getBody(ctx, req.body);
  const box = manifold.boundingBox();
  return {
    volume: manifold.volume(),
    area: manifold.surfaceArea(),
    genus: manifold.genus(),
    bounds: { min: [box.min[0], box.min[1], box.min[2]], max: [box.max[0], box.max[1], box.max[2]] },
  };
}
