// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Tool } from './Tool';
import { TagTool } from './impl/TagTool';

/** Fresh instance of the Tag tool for `ToolManager.register`; needs `tagCommands` on the registry. */
export function tagTools(): Tool[] {
  return [new TagTool()];
}
