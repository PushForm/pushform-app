// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { PaperSnapKind } from '@pushform/layout';

const labels: Record<PaperSnapKind | 'center', string> = {
  endpoint: 'Endpoint', midpoint: 'Midpoint', center: 'Center', intersection: 'Intersection', 'on-path': 'On path', grid: 'Grid',
};

/** Mounted anew for each hovered snap target, so moving away always restarts the one-second delay. */
export function LayoutSnapTooltip({ type, x, y, pageWidth, pageHeight }: {
  type: PaperSnapKind | 'center'; x: number; y: number; pageWidth: number; pageHeight: number;
}): JSX.Element | null {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 1000);
    return () => clearTimeout(timer);
  }, []);
  return visible ? <span className="pf-layout-snap-tooltip" role="tooltip" aria-label="Snap type"
    style={{ left: Math.max(0, Math.min(pageWidth - 85, x + 14)), top: Math.max(0, Math.min(pageHeight - 26, y + 16)) }}>
    {labels[type]}
  </span> : null;
}
