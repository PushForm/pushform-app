// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Tool } from './Tool';
import { PaintTool } from './impl/Paint';
import { PositionTextureTool } from './impl/PositionTexture';

/**
 * Fresh instances of the material tools for `ToolManager.register`: the Paint Bucket
 * (`tool.paint`, key B in `defaultKeymap.json`) and Position Texture (`texturePosition`, entered
 * from the context menu `Texture › Position`). Register them before the bootstrap's placeholder
 * tools so the `paint` placeholder is skipped.
 */
export function paintTools(): Tool[] {
  return [new PaintTool(), new PositionTextureTool()];
}
