// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { ArcTool } from './Arc';

/** Pie tool: the centre Arc closed back through its centre with two radii, so the wedge forms a face. */
export class PieTool extends ArcTool {
  constructor() {
    super(true);
  }
}
