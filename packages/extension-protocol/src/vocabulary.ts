// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors

/**
 * The words of the extension contract: contribution targets, permissions, activation events and editors. Kept free
 * of any dependency, so code running inside an extension runtime can use them without carrying the schema library.
 */

/** Contribution targets an extension can declare. */
export const EXTENSION_TARGETS = ['model.command', 'model.selection.action', 'model.inspector.block', 'model.panel',
  'model.tool', 'model.overlay', 'model.importer', 'model.exporter', 'app.settings.block'] as const;
export type ExtensionTarget = (typeof EXTENSION_TARGETS)[number];

/**
 * Permissions an extension can request. Each one is granted separately: model write does not imply file, clipboard
 * or network access, and `model.egress` (sending model content to a declared destination) is separate from `network`.
 */
export const EXTENSION_PERMISSIONS = ['model.read', 'model.write', 'selection.read', 'selection.write',
  'tool.interaction', 'viewport.presentation', 'file.read', 'file.export', 'settings', 'clipboard.write', 'network',
  'model.egress'] as const;
export type ExtensionPermission = (typeof EXTENSION_PERMISSIONS)[number];

/** What starts an extension's code. Code never runs at install or load; only one of these does. */
export const ACTIVATION_EVENTS = ['onCommand', 'onSelectionAction', 'onInspectorShow', 'onPanelOpen', 'onToolActivate',
  'onOverlayShow', 'onImport', 'onExport', 'onSettingsOpen'] as const;
export type ActivationEvent = (typeof ACTIVATION_EVENTS)[number];

/** The activation event each target uses; a contribution may omit `activation` or must name this one. */
export const TARGET_ACTIVATION: Readonly<Record<ExtensionTarget, ActivationEvent>> = {
  'model.command': 'onCommand',
  'model.selection.action': 'onSelectionAction',
  'model.inspector.block': 'onInspectorShow',
  'model.panel': 'onPanelOpen',
  'model.tool': 'onToolActivate',
  'model.overlay': 'onOverlayShow',
  'model.importer': 'onImport',
  'model.exporter': 'onExport',
  'app.settings.block': 'onSettingsOpen',
};

export const EXTENSION_EDITORS = ['modeling', 'layout'] as const;
