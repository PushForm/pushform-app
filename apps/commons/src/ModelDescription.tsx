// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { JSX } from 'react';
/** Descriptions are plain text; purchase destinations live in the staff-managed purchase section. */
export function ModelDescription({ text }: { text: string }): JSX.Element {
  return (
    <p className="description" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
      {text}
    </p>
  );
}
