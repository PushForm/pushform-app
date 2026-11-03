// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { IconBaseProps } from 'react-icons';

export function SectionPlaneIcon({ size = 18, title, ...props }: IconBaseProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
      strokeWidth={1.8}
    >
      {title ? <title>{title}</title> : null}
      <path d="M12 10H5V22H12M20 10H27V22H20" />
      <path d="M12 4L20 8V28L12 24Z" />
    </svg>
  );
}
