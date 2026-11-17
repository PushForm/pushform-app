// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { IconBaseProps } from 'react-icons';

export function RevolveIcon({ size = 18, title, ...props }: IconBaseProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
      strokeWidth={1.75}
    >
      {title ? <title>{title}</title> : null}
      <path d="M11 6l5.6-1.8A7 3 0 1 0 11 9ZM4 6v7.5a7 3 0 0 0 7 3V9m5.6-4.8v6.55" />
      <path d="M2.8 15.35c-1.35 1.95 2.9 5.15 9.1 5.15 4.15 0 7.7-1.8 7.7-4.15v-2.6m-2.5 2.75 2.5-2.75 2.5 2.75" />
    </svg>
  );
}
