// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { IconBaseProps } from 'react-icons';

/** Overlapping regions with a small pointer choosing the shaded region. */
export function LayoutShapeBuilderIcon({ size = 18, title, ...props }: IconBaseProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {title ? <title>{title}</title> : null}
      <path
        d="M10.5 4.1a5.5 5.5 0 1 1 0 9.8 5.5 5.5 0 0 0 0-9.8Z"
        fill="currentColor"
        fillOpacity={0.22}
        stroke="none"
      />
      <circle cx={8} cy={9} r={5.5} />
      <path d="M11.5 14.3A5.5 5.5 0 1 1 18.4 10" />
      <path d="m14 12 7.5 4-4 1.5-1.5 4Z" fill="currentColor" strokeWidth={1.2} />
    </svg>
  );
}
