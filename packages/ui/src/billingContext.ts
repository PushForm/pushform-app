// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { createContext, useSyncExternalStore } from 'react';
import type { CloudBillingState, CloudBillingStore } from '@pushform/cloud';

export const BillingContext = createContext<CloudBillingStore | null>(null);
const empty: CloudBillingState = { status: 'signedOut', ownerId: null, summary: null, busy: null, returned: null, error: null };
const noSubscribe = (): (() => void) => () => {};
const noSnapshot = (): CloudBillingState => empty;
export function useBillingState(store: CloudBillingStore | null | undefined): CloudBillingState {
  return useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.getSnapshot ?? noSnapshot);
}
