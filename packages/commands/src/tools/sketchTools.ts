// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Tool } from './Tool';
import { EraserTool } from './impl/Eraser';
import { LassoTool } from './impl/Lasso';
import { LineTool } from './impl/Line';
import { RectangleTool } from './impl/Rectangle';
import { SelectTool } from './impl/Select';

/**
 * Fresh instances of the sketch tools (Select, Lasso, Line, Rectangle, Eraser) for
 * `ToolManager.register`. Their `tool.<id>` commands match `defaultKeymap.json` (Space, Shift+Space, L, R, E).
 */
export function sketchTools(): Tool[] {
  return [new SelectTool(), new LassoTool(), new LineTool(), new RectangleTool(), new EraserTool()];
}
