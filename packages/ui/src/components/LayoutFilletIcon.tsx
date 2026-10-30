// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { IconBaseProps } from 'react-icons';

/** User-refined Inkscape geometry, retaining the toolbar's theme color. */
export function LayoutFilletIcon({ size = 18, title, ...props }: IconBaseProps) {
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
      <path d="m 3.4683956,3.9409328 v 3 M 6.6342888,3.91004 3.4683956,3.9409328" />
      <path
        d="m 4.3600771,21.601524 c -0.07466,-0.51945 -0.113293,-1.050853 -0.113293,-1.591611 v -4.623884 c 0,-6.0940003 4.906,-11.0000003 10.9999999,-11.0000003 v 0 h 5.413064"
        strokeWidth={1.6181}
      />
    </svg>
  );
}
