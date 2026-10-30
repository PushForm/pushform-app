// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef, type JSX } from 'react';
import { editLayoutTextContent, layoutTextStyleAt, tableCellEntities, tableCellOwner, type LayoutEntity } from '@pushform/layout';
import { insertClipboardRichText, readClipboardRichText, type ClipboardRichText } from './layoutClipboardRichText';
import { layoutEditorLineHeight, layoutEditorTabSizeMm, layoutTextInset } from './layoutText';
import type { TableGridEditorProps } from './TableGrid';

/** Text placement is local to the grid's affine frame, matching the canvas painter. */
export function LayoutTableCellEditor({
  entity,
  pixelsPerMm,
  cell,
  value,
  onChange,
  onBlur,
  onRichChange,
}: TableGridEditorProps & {
  entity: LayoutEntity;
  pixelsPerMm: number;
  onRichChange(text: ClipboardRichText | null): void;
}): JSX.Element | null {
  const input = useRef<HTMLTextAreaElement>(null);
  const plainPaste = useRef(false), richDraft = useRef<ClipboardRichText | null>(null);
  useEffect(() => {
    const editor = input.current;
    editor?.focus();
    editor?.setSelectionRange(editor.value.length, editor.value.length);
    return () => onRichChange(null);
  }, []);
  const table = entity.table!,
    owner = tableCellOwner(table, cell.row, cell.column);
  const local = tableCellEntities(entity).find(
    (e) => e.id === owner.row * table.columns.length + owner.column,
  );
  if (!local) return null;
  const p = local.points[0]!,
    q = local.points[1]!,
    text = local.text!;
  const boxWidth = q[0] - p[0],
    boxHeight = q[1] - p[1];
  return (
    <textarea
      ref={input}
      className="pf-layout-table-cell-editor"
      aria-label="Edit table cell on page"
      value={value}
      style={{
        left: p[0] * pixelsPerMm,
        top: p[1] * pixelsPerMm,
        width: boxWidth * pixelsPerMm,
        height: boxHeight * pixelsPerMm,
        transform: `rotate(${text.rotationDeg ?? 0}deg)`,
        transformOrigin: 'center',
        fontFamily: text.fontFamily,
        fontSize: ((text.fontSizePt * 25.4) / 72) * pixelsPerMm,
        lineHeight: layoutEditorLineHeight(text),
        tabSize: `${layoutEditorTabSizeMm(text) * pixelsPerMm}px`,
        fontWeight: text.bold ? 'bold' : 'normal',
        fontStyle: text.italic ? 'italic' : 'normal',
        textDecoration: text.underline ? 'underline' : 'none',
        textAlign: text.align,
        color: text.color,
        background: local.style?.fillColor ?? '#ffffff',
        padding: `0 ${layoutTextInset(boxWidth) * pixelsPerMm}px`,
      }}
      onChange={(event) => {
        if (richDraft.current) {
          richDraft.current = { ...richDraft.current, ...editLayoutTextContent(richDraft.current, event.target.value) };
          onRichChange(richDraft.current);
        }
        onChange(event.target.value);
      }}
      onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v') plainPaste.current = event.shiftKey; }}
      onPaste={event => {
        const editor = event.currentTarget, start = editor.selectionStart, end = editor.selectionEnd;
        const current = { ...text, ...editLayoutTextContent(text, value), ...richDraft.current };
        const rich = readClipboardRichText(event.clipboardData, plainPaste.current, layoutTextStyleAt(current, start));
        plainPaste.current = false;
        if (!rich) return;
        event.preventDefault(); event.stopPropagation();
        richDraft.current = insertClipboardRichText(current, start, end, rich);
        onRichChange(richDraft.current); onChange(richDraft.current.content, true);
        queueMicrotask(() => editor.setSelectionRange(start + rich.content.length, start + rich.content.length));
      }}
      onBlur={onBlur}
    />
  );
}
