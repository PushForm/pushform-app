// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { createContext, useSyncExternalStore } from 'react';
import type { CloudAccountState, CloudAccountStore } from '@pushform/cloud';

/** Account deletion and file export for the signed-in account; null when the host has none. */
export const AccountContext = createContext<CloudAccountStore | null>(null);

const noAccountState: CloudAccountState = { status: 'signedOut', ownerId: null, deletion: null, latestExport: null, busy: null, error: null };
const noSubscribe = (): (() => void) => () => {};
const noSnapshot = (): CloudAccountState => noAccountState;

/** The store's state, or a signed-out state without a store. */
export function useAccountState(store: CloudAccountStore | null | undefined): CloudAccountState {
  return useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.getSnapshot ?? noSnapshot);
}

/** "Oct 29, 2026, 10:00 AM" in the viewer's locale and time zone. */
export function formatAccountTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
