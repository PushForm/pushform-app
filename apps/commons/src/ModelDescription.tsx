// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { JSX } from 'react';
/** Keep descriptions as text while making explicit HTTPS references usable without HTML injection. */
export function ModelDescription({ text }: { text: string }): JSX.Element {
  const parts: (string | JSX.Element)[] = [];
  let end = 0;
  for (const match of text.matchAll(/https:\/\/[^\s<>"'`]+/g)) {
    const at = match.index;
    const raw = match[0];
    const link = raw.replace(/[),.;!?]+$/, '');
    let safe = false;
    try {
      const url = new URL(link);
      safe = !url.username && !url.password;
    } catch {
      /* Leave malformed links as text. */
    }
    parts.push(text.slice(end, at));
    parts.push(
      safe ? (
        <a key={at} href={link} target="_blank" rel="noopener noreferrer">
          {link}
        </a>
      ) : (
        link
      ),
    );
    parts.push(raw.slice(link.length));
    end = at + raw.length;
  }
  parts.push(text.slice(end));
  return (
    <p className="description" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
      {parts}
    </p>
  );
}
