// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { IconBaseProps } from 'react-icons';

/** Solid Shape Builder artwork traced from the user's supplied reference. */
export function LayoutShapeBuilderIcon({ size = 18, title, ...props }: IconBaseProps) {
  return (
    <svg width={size} height={size} viewBox="75 80 525 462" {...props}>
      {title ? <title>{title}</title> : null}
      <g fill="currentColor" fillRule="evenodd">
        <path d="M242 137A96.8 96.8 0 1 0 242 281A151 151 0 0 1 242 137Z M120.3 194.2H184.1V224.3H120.3Z" />
        <path d="M453.3 304.5A122.4 122.4 0 1 0 341.3 326.4L325 268.8Z M293.7 194.2H357.7V224.3H293.7Z M394.9 194.2H458.7V224.3H394.9Z" />
        <path d="M368.4 311.9L593.4 373.9L484.4 428.5L431.8 535.5Z" />
      </g>
    </svg>
  );
}
