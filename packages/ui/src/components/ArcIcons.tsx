// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { IconBaseProps } from 'react-icons';

function ArcGlyph({ size = 18, title, children, ...props }: IconBaseProps) {
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
      {children}
    </svg>
  );
}

export function ArcIcon(props: IconBaseProps) {
  return (
    <ArcGlyph {...props}>
      <path d="M4 4A16 16 0 0 1 20 20M4 8.5v2.75m0 3.5v1.75" />
      <circle cx="4" cy="20" r="1.75" fill="currentColor" stroke="none" />
    </ArcGlyph>
  );
}

export function TwoPointArcIcon(props: IconBaseProps) {
  return (
    <ArcGlyph {...props}>
      <path d="M4 15.25A9.375 9.375 0 0 1 20 15.25" />
      <circle cx="4" cy="15.25" r="1.75" fill="currentColor" stroke="none" />
      <circle cx="20" cy="15.25" r="1.75" fill="currentColor" stroke="none" />
    </ArcGlyph>
  );
}

export function ThreePointArcIcon(props: IconBaseProps) {
  return (
    <ArcGlyph {...props}>
      <path d="M4.5 17.5A7.8125 7.8125 0 1 1 19.5 17.5" />
      <circle cx="4.5" cy="17.5" r="1.75" fill="currentColor" stroke="none" />
      <circle cx="12" cy="7.5" r="1.75" fill="currentColor" stroke="none" />
      <circle cx="19.5" cy="17.5" r="1.75" fill="currentColor" stroke="none" />
    </ArcGlyph>
  );
}

export function PieIcon(props: IconBaseProps) {
  return (
    <ArcGlyph {...props}>
      <path d="M12 4.5l8.25 10a12.964 12.964 0 0 1-16.5 0Z" />
    </ArcGlyph>
  );
}
