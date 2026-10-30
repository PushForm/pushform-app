// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { JSX } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Links open beside the app; images are not shown, so a reply cannot load an outside picture.
const COMPONENTS: Components = {
  a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>,
};
const PLUGINS = [remarkGfm];
const DISALLOWED = ['img'];

/**
 * An agent message rendered as Markdown: GitHub-flavored Markdown, never raw HTML, with links limited to
 * safe protocols by react-markdown's URL filter. A message still streaming in renders as it stands.
 */
export function MessageMarkdown({ text }: { text: string }): JSX.Element {
  return <div className="pf-fr-markdown">
    <Markdown remarkPlugins={PLUGINS} components={COMPONENTS} disallowedElements={DISALLOWED} unwrapDisallowed>{text}</Markdown>
  </div>;
}
