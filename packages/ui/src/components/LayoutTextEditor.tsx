// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { forwardRef, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { isDocumentToolbarTarget } from './toolbarFocus';
import { LAYOUT_AUTO_TEXT_TAGS, layoutTextStyleAt, type LayoutText } from '@pushform/layout';
import { insertClipboardRichText, readClipboardRichText, type ClipboardRichText } from './layoutClipboardRichText';

export type LayoutTextSelection = { start: number; end: number };

export function getLayoutTextSelection(editor: HTMLElement): LayoutTextSelection | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return null;
  const prefix = range.cloneRange(); prefix.selectNodeContents(editor); prefix.setEnd(range.startContainer, range.startOffset);
  return { start: prefix.toString().length, end: prefix.toString().length + range.toString().length };
}

export function setLayoutTextSelection(editor: HTMLElement, start: number, end: number): void {
  const locate = (offset: number): [Node, number] => {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const length = node.textContent?.length ?? 0;
      if (offset <= length) return [node, offset];
      offset -= length;
    }
    return [editor, editor.childNodes.length];
  };
  const range = document.createRange(); range.setStart(...locate(start)); range.setEnd(...locate(end));
  const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
}

/** Native selection and caret geometry follow the actual styled characters, including rotation. */
export const LayoutTextEditor = forwardRef<HTMLDivElement, {
  text: LayoutText; label: string; style: CSSProperties; pixelsPerMm: number;
  autoTextTags?: readonly string[];
  onChange: (content: string) => void; onSelection: (range: LayoutTextSelection) => void;
  onRichChange?: (text: ClipboardRichText) => void;
  onFinish: () => void; onUndo: (redo: boolean) => void;
  onEmphasis: (key: 'bold' | 'italic' | 'underline') => void;
}>(function LayoutTextEditor({ text, label, style, pixelsPerMm, autoTextTags = LAYOUT_AUTO_TEXT_TAGS, onChange, onRichChange, onSelection, onFinish, onUndo, onEmphasis }, forwardedRef) {
  const element = useRef<HTMLDivElement | null>(null), composing = useRef(false);
  const plainPaste = useRef(false), pasteCaret = useRef<number | null>(null);
  const listId = useId();
  const dismissed = useRef<string | null>(null);
  const [completion, setCompletion] = useState<{ start: number; end: number; query: string; x: number; y: number } | null>(null);
  const [active, setActive] = useState(0);
  const suggestions = completion ? [...new Set(autoTextTags)].filter(name => name.toLowerCase().startsWith(completion.query.toLowerCase())) : [];
  const open = suggestions.length > 0;
  const refreshCompletion = () => {
    const editor = element.current, selection = editor && getLayoutTextSelection(editor);
    if (!editor || document.activeElement !== editor || composing.current || !selection || selection.start !== selection.end) {
      setCompletion(null); return;
    }
    const prefix = (editor.textContent ?? '').slice(0, selection.start);
    const match = /<([^<>\r\n]*)$/.exec(prefix);
    if (!match || dismissed.current === `${match.index}:${match[1]}`) { setCompletion(null); return; }
    dismissed.current = null;
    const range = window.getSelection()?.getRangeAt(0);
    const rect = range?.getBoundingClientRect?.();
    const bounds = rect && rect.height > 0 ? rect : editor.getBoundingClientRect();
    const next = { start: match.index, end: selection.start, query: match[1]!,
      x: Math.max(4, Math.min(bounds.left, window.innerWidth - 240)),
      y: Math.max(4, Math.min(bounds.bottom + 4, window.innerHeight - 190)) };
    setCompletion(previous => {
      if (previous?.start === next.start && previous.end === next.end && previous.query === next.query && previous.x === next.x && previous.y === next.y) return previous;
      return next;
    });
  };
  useLayoutEffect(() => { setActive(0); }, [completion?.start, completion?.query]);
  useLayoutEffect(() => {
    if (open) document.getElementById(`${listId}-${Math.min(active, suggestions.length - 1)}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [active, open, listId, suggestions.length]);
  useLayoutEffect(() => {
    const editor = element.current;
    if (!editor || composing.current) return;
    const selection = getLayoutTextSelection(editor), focused = document.activeElement;
    const fragment = document.createDocumentFragment();
    // Group identical adjacent styles, retaining text nodes for UTF-16 selection offsets.
    let previous = '', span: HTMLSpanElement | null = null;
    for (let index = 0; index < text.content.length; index++) {
      const characterStyle = layoutTextStyleAt(text, index), signature = JSON.stringify(characterStyle);
      if (!span || signature !== previous) {
        span = document.createElement('span'); previous = signature;
        Object.assign(span.style, { fontFamily: characterStyle.fontFamily,
          fontSize: `${characterStyle.fontSizePt * 25.4 / 72 * pixelsPerMm}px`,
          fontWeight: characterStyle.bold ? 'bold' : 'normal', fontStyle: characterStyle.italic ? 'italic' : 'normal',
          textDecorationLine: characterStyle.underline ? 'underline' : 'none', color: characterStyle.color });
        fragment.append(span);
      }
      if (span.lastChild instanceof Text) span.lastChild.appendData(text.content[index]!);
      else span.append(document.createTextNode(text.content[index]!));
    }
    // A final break makes an empty last line reachable by the native caret.
    if (!text.content || text.content.endsWith('\n')) fragment.append(document.createElement('br'));
    editor.replaceChildren(fragment);
    if (selection || pasteCaret.current !== null) {
      setLayoutTextSelection(editor, Math.min(pasteCaret.current ?? selection!.start, text.content.length), Math.min(pasteCaret.current ?? selection!.end, text.content.length));
      pasteCaret.current = null;
      if (focused instanceof HTMLElement && focused !== editor && document.activeElement !== focused) focused.focus();
    }
  }, [text, pixelsPerMm]);
  useLayoutEffect(() => {
    const changed = () => { const editor = element.current; const range = editor && getLayoutTextSelection(editor); if (range) onSelection(range); refreshCompletion(); };
    document.addEventListener('selectionchange', changed);
    return () => document.removeEventListener('selectionchange', changed);
  }, [onSelection]);
  const reportSelection = () => { const editor = element.current; const range = editor && getLayoutTextSelection(editor); if (range) onSelection(range); refreshCompletion(); };
  const insert = (value: string) => {
    const editor = element.current, selection = window.getSelection();
    if (!editor || !selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return;
    range.deleteContents();
    const node = document.createTextNode(value); range.insertNode(node); range.setStartAfter(node); range.collapse(true);
    selection.removeAllRanges(); selection.addRange(range);
    onChange(editor.textContent ?? ''); reportSelection();
  };
  const complete = (name: string) => {
    const editor = element.current;
    if (!completion || !editor) return;
    editor.focus();
    const end = completion.end + ((editor.textContent ?? '')[completion.end] === '>' ? 1 : 0);
    setLayoutTextSelection(editor, completion.start, end);
    insert(`<${name}>`);
    setCompletion(null);
  };
  return <><div ref={node => { element.current = node; if (typeof forwardedRef === 'function') forwardedRef(node); else if (forwardedRef) forwardedRef.current = node; }}
    className="pf-layout-inline-text" role="textbox" aria-label={label} aria-multiline="true"
    contentEditable suppressContentEditableWarning style={style}
    aria-autocomplete="list" aria-expanded={open} aria-controls={open ? listId : undefined}
    aria-activedescendant={open ? `${listId}-${Math.min(active, suggestions.length - 1)}` : undefined}
    onInput={event => { if (!composing.current) onChange(event.currentTarget.textContent ?? ''); reportSelection(); }}
    onCompositionStart={() => { composing.current = true; setCompletion(null); }}
    onCompositionEnd={event => { composing.current = false; onChange(event.currentTarget.textContent ?? ''); reportSelection(); }}
    onSelect={reportSelection} onMouseUp={reportSelection} onKeyUp={reportSelection}
    onPaste={event => {
      event.preventDefault(); event.stopPropagation();
      const range = getLayoutTextSelection(event.currentTarget) ?? { start: text.content.length, end: text.content.length };
      const rich = readClipboardRichText(event.clipboardData, plainPaste.current, layoutTextStyleAt(text, range.start));
      plainPaste.current = false;
      if (!rich) return;
      if (onRichChange) {
        pasteCaret.current = range.start + rich.content.length;
        onRichChange(insertClipboardRichText(text, range.start, range.end, rich));
      } else insert(rich.content);
    }}
    onBlur={event => { setCompletion(null); if (!isDocumentToolbarTarget(event.relatedTarget)) onFinish(); }}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing || composing.current) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v') plainPaste.current = event.shiftKey;
      if (open && !event.ctrlKey && !event.metaKey && !event.altKey) {
        if (event.key === 'Tab' && !event.shiftKey) {
          event.preventDefault(); event.stopPropagation(); complete(suggestions[Math.min(active, suggestions.length - 1)]!); return;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); event.stopPropagation();
          setActive(index => (index + (event.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length); return;
        }
        if (event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation(); dismissed.current = `${completion!.start}:${completion!.query}`; setCompletion(null); return;
        }
      }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); event.currentTarget.blur(); onFinish(); }
      else if (event.key === 'Enter') { event.preventDefault(); insert('\n'); }
      else if ((event.metaKey || event.ctrlKey) && !event.altKey) {
        const key = event.key.toLowerCase();
        if (key === 'z') { event.preventDefault(); onUndo(event.shiftKey); }
        if (key === 'b' || key === 'i' || key === 'u') { event.preventDefault(); onEmphasis(key === 'b' ? 'bold' : key === 'i' ? 'italic' : 'underline'); }
      }
    }} />{open && completion ? createPortal(
      <div id={listId} className="pf-layout-autotext-suggestions" role="listbox" aria-label="Auto-Text suggestions"
        style={{ left: completion.x, top: completion.y }}>
        {suggestions.map((name, index) => <button key={name} type="button" role="option" id={`${listId}-${index}`}
          aria-selected={index === Math.min(active, suggestions.length - 1)} tabIndex={-1}
          onPointerDown={event => event.preventDefault()} onMouseDown={event => event.preventDefault()}
          onClick={() => complete(name)}>{`<${name}>`}</button>)}
      </div>, document.body) : null}</>;
});
