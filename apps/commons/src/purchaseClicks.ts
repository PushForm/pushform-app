// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { CommonsPublicPurchase } from '@pushform/cloud';

/** Measurement is best effort and never redirects or delays the retailer navigation. */
export function recordPurchaseClick(
  source: Pick<CommonsPublicPurchase, 'id' | 'version' | 'destinationVersion'>,
): void {
  try {
    const body = JSON.stringify({
      sourceId: source.id,
      version: source.version,
      destinationVersion: source.destinationVersion,
      clickId: crypto.randomUUID(),
    });
    if (
      navigator.sendBeacon?.('/api/purchase-click', new Blob([body], { type: 'application/json' }))
    )
      return;
    void fetch('/api/purchase-click', {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'omit',
      keepalive: true,
      referrerPolicy: 'no-referrer',
    }).catch(() => {});
  } catch {
    /* a blocked measurement request must not interfere with a purchase */
  }
}
