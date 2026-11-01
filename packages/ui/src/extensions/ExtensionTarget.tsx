// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useSyncExternalStore, type JSX, type ReactNode } from 'react';
import type { UnitSettings } from '@pushform/core';
import type { ExtensionUiHost } from '@pushform/extensions';
import { ExtensionDialog } from './ExtensionDialog';
import { ExtensionUiView } from './ExtensionUi';

/**
 * The interface an extension mounted for `target`, kept current as the extension updates it, with the dialog it has
 * open over the target, if any. Input goes back through the host, which checks it against the tree on screen.
 */
export function ExtensionTarget({ host, target, units, empty }: {
  readonly host: ExtensionUiHost;
  readonly target: string;
  readonly units: UnitSettings;
  readonly empty?: ReactNode;
}): JSX.Element | null {
  const shown = useSyncExternalStore(
    (notify) => host.subscribe((changed) => { if (changed === target) notify(); }),
    () => host.get(target),
  );
  if (!shown) return <>{empty ?? null}</>;
  const onEvent = (event: Parameters<ExtensionUiHost['dispatch']>[1]): void => { host.dispatch(target, event); };
  return (
    <>
      <ExtensionUiView tree={shown.tree} units={units} onEvent={onEvent} />
      {shown.dialog
        ? <ExtensionDialog title={shown.dialog.title} tree={shown.dialog.tree} units={units} onEvent={onEvent} onClose={() => host.closeDialog(target)} />
        : null}
    </>
  );
}
