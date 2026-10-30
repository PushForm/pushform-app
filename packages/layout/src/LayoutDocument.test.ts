// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { createLayoutDocument } from './LayoutDocument';

describe('LayoutDocument', () => {
  it('starts with an A4 landscape page and an independent id allocator', () => {
    const doc = createLayoutDocument();
    expect(doc.state.pageOrder).toHaveLength(1);
    expect(doc.state.pages.get(doc.state.pageOrder[0]!)?.size).toEqual([297, 210]);
    expect(doc.state.meta.nextId).toBe(3);
  });

  it('undoes page edits without losing ids or allowing the last page to be deleted', () => {
    const doc = createLayoutDocument();
    const id = doc.addPage();
    doc.renamePage(id, 'Cover');
    expect(doc.state.pages.get(id)?.name).toBe('Cover');
    expect(doc.state.pages.get(id)?.size).toEqual([297, 210]);
    expect(doc.undoStack.undo()).toBe(true);
    expect(doc.state.pages.get(id)?.name).toBe('Page 2');
    expect(doc.undoStack.undo()).toBe(true);
    expect(doc.state.pages.has(id)).toBe(false);
    expect(doc.state.meta.nextId).toBe(id);
    expect(() => doc.deletePage(doc.state.pageOrder[0]!)).toThrow('at least one page');
  });
});
