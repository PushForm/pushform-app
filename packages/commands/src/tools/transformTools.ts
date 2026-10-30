// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Tool } from './Tool';
import { MoveTool } from './impl/Move';
import { RotateTool } from './impl/Rotate';
import { ScaleTool } from './impl/Scale';

/**
 * Fresh instances of the M2 transform tools (Move, Rotate, Scale) for `ToolManager.register`.
 * Their `tool.<id>` commands match `defaultKeymap.json` (M, Q, S). They call `transform.apply`
 * and `transform.array`, so `transformCommands` must be registered as well.
 */
export function transformTools(): Tool[] {
  return [new MoveTool(), new RotateTool(), new ScaleTool()];
}
