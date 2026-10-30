// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { CommandRegistry, Keymap } from '@pushform/commands';
import type { DocumentTab } from '../session';

/** What the command search box indexes and where focus goes afterwards; one per document type. */
export interface CommandSearchSource {
  /** Commands of the document; only these are listed, so each mode offers its own tools. */
  readonly registry: CommandRegistry;
  /** Keymap supplying shortcut labels, or null when the document type has no keymap. */
  readonly keymap: Keymap | null;
  /** Return keyboard focus to the document's workspace after a command ran or the box was dismissed. */
  focusWorkspace(): void;
}

/**
 * The search source for a document tab.
 * - Model tabs search the modeling registry with the app keymap and return focus to the viewport.
 * - Layout tabs search the layout registry (tool commands and document commands). Layout has no
 *   keymap; shortcut labels come from the commands' keybinding hints. Its workspace listens on the
 *   window, so leaving the search box is enough to hand the keys back.
 */
export function commandSearchSourceFor(tab: DocumentTab): CommandSearchSource {
  switch (tab.type) {
    case 'model':
      return {
        registry: tab.app.commands,
        keymap: tab.app.keymap,
        focusWorkspace: () => tab.app.viewport.container?.focus(),
      };
    case 'layout':
      return {
        registry: tab.commands,
        keymap: null,
        focusWorkspace: () => {
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        },
      };
  }
}
