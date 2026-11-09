// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { IconBaseProps } from 'react-icons';

export function RevolveIcon({ size = 18, title, ...props }: IconBaseProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="96 93 68 68"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
      strokeWidth={4.2}
    >
      {title ? <title>{title}</title> : null}
      <path d="M126.5 111.6 141.5 107.6C137.9 104.7 131.5 102.9 124.2 102.9 112.7 102.9 103.4 106.8 103.4 111.6c0 3.7 5.5 6.8 13.1 8.1l10-8.1Z" />
      <path d="M103.4 111.6v30.7c0 3.7 5.5 6.8 13.1 8.1l10-8.1 15-4v-30.7M116.5 119.7v30.7m10-38.8v30.7" />
      <path d="M132.7 130.2c13.3-.4 23.4-3.7 23.4-7.7 0-2.3-3.4-4.5-8.8-5.9m2.9 6.1-2.9-6.1 6.3-2.6" />
    </svg>
  );
}
