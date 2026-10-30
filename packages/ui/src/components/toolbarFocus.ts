// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/** Document controls, including contextual tool panes and portalled tool-stack flyouts. */
export function isDocumentToolbarTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !target.closest('[role="dialog"]') &&
    Boolean(target.closest('.pf-toolbar, .pf-topbar, .pf-tool-stack-menu, .pf-layout-tool-panel, [role="toolbar"]'));
}

/** These controls need native pointer focus; other toolbar clicks keep the document caret. */
export function toolbarNeedsInputFocus(target: Element): boolean {
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"], label'));
}
