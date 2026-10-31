// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { ExtensionManifest, ExtensionPermission } from '@pushform/extension-protocol';

/** What each permission lets an extension do, as one plain sentence for the install dialog and the manager. */
export const PERMISSION_TEXT: Readonly<Record<ExtensionPermission, string>> = {
  'model.read': 'Can read the model',
  'model.write': 'Can read and change the model',
  'selection.read': 'Can see what you select',
  'selection.write': 'Can change what is selected',
  'tool.interaction': 'Can offer tools that respond to the mouse and keyboard in the view',
  'viewport.presentation': 'Can move the view and highlight things in it',
  'file.read': 'Can open files you choose',
  'file.export': 'Can save files where you choose',
  settings: 'Can keep its own settings',
  'clipboard.write': 'Can copy to the clipboard when you use it',
  network: 'Can connect to the internet addresses listed below',
  'model.egress': 'Can send model data to the addresses marked below',
};

/** The permission lines for a manifest, with each network destination spelled out. */
export function permissionLines(manifest: ExtensionManifest, permissions: readonly ExtensionPermission[] = manifest.permissions): string[] {
  return permissions.map((p) => PERMISSION_TEXT[p]);
}

/** A destination as the user should read it: its host and path, and its stated purpose. */
export function destinationText(destination: ExtensionManifest['destinations'][number]): string {
  const url = new URL(destination.url);
  return `${url.host}${url.pathname === '/' ? '' : url.pathname}: ${destination.purpose}${destination.sendsModelData ? ' (can receive model data)' : ''}`;
}

export const INTEGRITY_TEXT = { official: 'Official, countersigned by PushForm', unsigned: 'Unsigned (developer)' } as const;
