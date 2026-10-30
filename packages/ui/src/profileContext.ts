// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { createContext, useSyncExternalStore } from 'react';
import type { CloudProfileState, CloudProfileStore } from '@pushform/cloud';

/** The signed-in account's profile, for the header and account details; null when the host has none. */
export const ProfileContext = createContext<CloudProfileStore | null>(null);

const noProfileState: CloudProfileState = { status: 'signedOut', ownerId: null, profile: null, saving: false, error: null };
const noSubscribe = (): (() => void) => () => {};
const noSnapshot = (): CloudProfileState => noProfileState;

/** The store's state, or a signed-out state without a store. */
export function useProfileState(store: CloudProfileStore | null | undefined): CloudProfileState {
  return useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.getSnapshot ?? noSnapshot);
}
