// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect } from 'react';
import type { CloudProfile } from '@pushform/cloud';
import { setLayoutAccountFields } from '@pushform/layout';

/** Feed the signed-in account's profile to Layout's account auto-text; cleared when signed out. */
export function useAccountAutoText(profile: CloudProfile | null): void {
  const first = profile?.firstName ?? null, last = profile?.lastName ?? null, company = profile?.companyName ?? null;
  useEffect(() => {
    setLayoutAccountFields(first !== null && last !== null ? { firstName: first, lastName: last, companyName: company } : null);
  }, [first, last, company]);
  useEffect(() => () => setLayoutAccountFields(null), []);
}

