// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { OverlayPrimitive } from '../overlay';
import type { Tool, ToolContext, ToolStatus } from '../Tool';

/** A tool that exists only so the toolbar/keymap are complete before the real tool lands. */
export function placeholderTool(id: string, title: string, vcbLabel = ''): Tool {
  let ctx: ToolContext | null = null;
  return {
    id,
    title,
    cursor: 'crosshair',
    activate(c: ToolContext) {
      ctx = c;
    },
    deactivate() {
      ctx = null;
    },
    onCancel() {
      ctx?.statusChanged();
    },
    overlay(): readonly OverlayPrimitive[] {
      return [];
    },
    status(): ToolStatus {
      return { instructor: `${title} is not implemented yet (M0 shell).`, vcbLabel };
    },
  };
}
