// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useLayoutEffect } from 'react';
import type { RefObject } from 'react';
import { registerGuidanceTargets } from '../guidance';

/** Register every browser node, including collapsed descendants, without exposing a document mutation. */
export function useGuidanceBrowser<T extends { key: string; label: string; parent: string | null }>(
  root: RefObject<HTMLElement | null>, nodes: ReadonlyMap<string, T>, expand: (ancestors: ReadonlySet<string>) => void,
): void {
  useLayoutEffect(() => {
    if (!root.current) return;
    return registerGuidanceTargets({ root: root.current,
      targets: [...nodes.values()].map(node => ({ id: `object:${node.key}`, label: node.label })),
      reveal: ids => {
        const ancestors = new Set<string>();
        for (const id of ids) {
          if (!id.startsWith('object:')) continue;
          for (let parent = nodes.get(id.slice(7))?.parent; parent; parent = nodes.get(parent)?.parent ?? null) ancestors.add(parent);
        }
        if (ancestors.size) expand(ancestors);
      },
    });
  }, [root, nodes, expand]);
}
