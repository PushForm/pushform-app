// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { browserSelectionRange } from './browserSelectionRange';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { CSSProperties, JSX, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { entityRefKey } from '@pushform/model';
import { PiCaretRight, PiCube, PiPencilSimple } from 'react-icons/pi';
import { useGuidanceBrowser } from '../hooks/useGuidanceBrowser';
import { useApp } from '../AppContext';
import { installUiCommands } from '../engine/uiCommands';
import { useEditContext } from '../hooks/useEditContext';
import { useSelectionRefs } from '../hooks/useSelection';
import { TagsPanel } from '../panels/TagsPanel';
import { rgbToCss } from '../panels/colors';
import { useDocumentState } from '../hooks/useDocument';
import { Icon } from './Icon';
import { modelBrowserTree, type ModelBrowserKind, type ModelBrowserNode } from './modelBrowserTree';

/** The only keys a tree item passes to the modeler are undo and redo (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl/Cmd+Y). */
export function modelBrowserPassesKey(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && /^[zy]$/i.test(event.key);
}

/** Eye and lock icon size, as in the Layout object browser. */
const TOGGLE_ICON_PX = 16;
const KIND_ICONS: Record<ModelBrowserKind, ReactNode> = {
  group: <Icon name="outliner-group" size={18} />,
  component: <Icon name="outliner-component" size={18} />,
  solid: <PiCube />,
  meshPart: <PiCube />,
};
const KIND_NAMES: Record<ModelBrowserKind, string> = { group: 'Group', component: 'Component', solid: 'Solid', meshPart: 'Mesh Part' };

/**
 * The Model object browser: the model's solids, groups and components in the left menu bar's docked
 * panel, with the Layout object browser's look and keys. Selection, hiding, locking and renames go through commands.
 */
export function ModelObjectBrowser({ onClose }: { readonly onClose?: (() => void) | undefined }): JSX.Element {
  const app = useApp();
  const refs = useSelectionRefs();
  const context = useEditContext();
  useEffect(() => installUiCommands(app.commands), [app]);
  const idPrefix = useId();
  const state = useDocumentState();
  const [section, setSection] = useState<'objects' | 'tags'>('objects');
  // A viewport click selects a solid's face or edge; the tree lists the solid, so those mark its row.
  const selectedKeys = useMemo(() => new Set(refs.map(ref =>
    ref.kind === 'face' || ref.kind === 'edge' || ref.kind === 'imprintEdge' ? entityRefKey({ kind: 'body', path: ref.path, id: ref.id }) : entityRefKey(ref))), [refs]);
  const { definitions, rootDefinitionId } = state;
  // Selection and edit context decorate rows; neither changes the model hierarchy.
  const tree = useMemo(() => modelBrowserTree({ definitions, rootDefinitionId }, [], new Set()), [definitions, rootDefinitionId]);
  const allByKey = useMemo(() => {
    const nodes = new Map<string, ModelBrowserNode>();
    const walk = (list: readonly ModelBrowserNode[]): void => { for (const node of list) { nodes.set(node.key, node); walk(node.children); } };
    walk(tree);
    return nodes;
  }, [tree]);
  // Groups and components start collapsed; only explicit expansion or reveal opens them.
  const [expanded, setExpandedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const selectionAnchor = useRef<string | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [editing, setEditing] = useState<ModelBrowserNode | null>(null);
  const editingRef = useRef<ModelBrowserNode | null>(null);
  const treeRef = useRef<HTMLUListElement>(null);
  const pendingFocus = useRef<string | null>(null), pendingReveal = useRef<string | null>(null);
  const [, requestRender] = useReducer((count: number) => count + 1, 0);

  const revealAncestors = useCallback((ancestors: ReadonlySet<string>) =>
    setExpandedKeys(current => new Set([...current, ...ancestors])), []);
  useGuidanceBrowser(treeRef, allByKey, revealAncestors);

  const run = (id: string, params?: unknown): void => { app.commands.tryExecute(id, params); };

  // A selection made elsewhere opens every group and component above it and scrolls the first selected item into view.
  const selectionKey = [...selectedKeys].join(',');
  useEffect(() => {
    const listed = [...selectedKeys].filter(key => allByKey.has(key));
    if (!listed.length) return;
    const ancestors = new Set<string>();
    for (const key of listed) for (let parent = allByKey.get(key)?.parent; parent; parent = allByKey.get(parent)?.parent ?? null) ancestors.add(parent);
    setExpandedKeys(current => [...ancestors].some(key => !current.has(key)) ? new Set([...current, ...ancestors]) : current);
    pendingReveal.current = listed[0]!;
    requestRender();
    // Only a new selection reveals; edits that keep the selection leave the view where the user put it.
  }, [selectionKey]);

  const expandable = (node: ModelBrowserNode): boolean => node.children.length > 0;
  const isExpanded = (node: ModelBrowserNode): boolean => expanded.has(node.key);
  const visible = useMemo(() => {
    const items: ModelBrowserNode[] = [];
    const walk = (nodes: readonly ModelBrowserNode[]): void => {
      for (const node of nodes) { items.push(node); if (expandable(node) && isExpanded(node)) walk(node.children); }
    };
    walk(tree);
    return items;
  }, [tree, expanded]);
  const byKey = useMemo(() => new Map(visible.map(node => [node.key, node])), [visible]);
  const tabKey = focusKey !== null && byKey.has(focusKey) ? focusKey : visible[0]?.key ?? null;

  useLayoutEffect(() => {
    const root = treeRef.current;
    if (!root) return;
    const item = (key: string): HTMLElement | null => root.querySelector<HTMLElement>(`[data-key="${key}"]`);
    if (pendingReveal.current) {
      item(pendingReveal.current)?.querySelector<HTMLElement>('.pf-layout-browser-row')?.scrollIntoView?.({ block: 'nearest' });
      pendingReveal.current = null;
    }
    if (pendingFocus.current) {
      item(pendingFocus.current)?.focus();
      pendingFocus.current = null;
    }
  });

  const setExpanded = (node: ModelBrowserNode, open: boolean): void =>
    setExpandedKeys(current => { const next = new Set(current); if (open) next.add(node.key); else next.delete(node.key); return next; });
  const moveFocus = (key: string): void => { setFocusKey(key); pendingFocus.current = key; requestRender(); };
  /** Shift selects a tree range; primary modifiers add or remove individual items. */
  const select = (node: ModelBrowserNode, event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean } | null): void => {
    setFocusKey(node.key);
    const primary = !!event && (event.ctrlKey || event.metaKey), shift = !!event?.shiftKey;
    if (shift && !primary) {
      run('selection.set', { refs: browserSelectionRange(visible, selectionAnchor.current, node).map(item => item.ref) });
    } else {
      selectionAnchor.current = node.key;
      run(`selection.${primary ? shift ? 'remove' : 'add' : 'set'}`, { refs: [node.ref] });
    }
  };
  const startRename = (node: ModelBrowserNode): void => {
    // Solids have no stored name to edit; mesh part names are read-only here too.
    if (node.kind === 'solid' || node.kind === 'meshPart') return;
    pendingFocus.current = null;
    editingRef.current = node; setEditing(node); setFocusKey(node.key);
  };
  /** Enter or leaving the field commits; an unchanged name changes nothing and an empty one restores the definition name. */
  const finishRename = (value: string | null, refocus: boolean): void => {
    const node = editingRef.current;
    if (!node) return;
    editingRef.current = null; setEditing(null);
    if (refocus) pendingFocus.current = node.key;
    if (value === null) return;
    const name = value.trim();
    if (name ? name !== node.label : node.custom) run('instance.rename', { ref: node.ref, name });
  };
  const setHidden = (node: ModelBrowserNode, hidden: boolean): void =>
    run(node.kind === 'solid' || node.kind === 'meshPart' ? 'bodies.setHidden' : 'instance.setHidden', { refs: [node.ref], hidden });
  /** The modeler's own context menu for the item, which selects it first as a right-click in the viewport does. */
  const openMenu = (node: ModelBrowserNode, x: number, y: number): void => {
    setFocusKey(node.key);
    run('ui.contextMenu.open', { x, y, refs: [node.ref] });
  };

  const onTreeKeyDown = (event: ReactKeyboardEvent<HTMLUListElement>): void => {
    if (event.target instanceof HTMLInputElement) { event.stopPropagation(); return; }
    // No other key pressed on a tree item reaches modeler shortcuts or tools.
    if (modelBrowserPassesKey(event)) return;
    event.stopPropagation();
    const item = event.target instanceof Element ? event.target.closest('[role="treeitem"]') : null;
    const node = byKey.get(item?.getAttribute('data-key') ?? tabKey ?? '');
    if (event.key === 'Escape') { event.preventDefault(); onClose?.(); return; }
    if (!node) return;
    const index = visible.indexOf(node);
    const go = (key: string | undefined): void => { if (key) moveFocus(key); };
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      const bounds = item?.querySelector('.pf-layout-browser-row')?.getBoundingClientRect();
      openMenu(node, bounds ? bounds.left + 24 : 0, bounds ? bounds.bottom : 0); return;
    }
    let handled = true;
    switch (event.key) {
      case 'ArrowDown': go(visible[index + 1]?.key); break;
      case 'ArrowUp': go(visible[index - 1]?.key); break;
      case 'Home': go(visible[0]?.key); break;
      case 'End': go(visible[visible.length - 1]?.key); break;
      case 'ArrowRight':
        if (expandable(node) && !isExpanded(node)) setExpanded(node, true);
        else if (expandable(node)) go(node.children[0]?.key);
        break;
      case 'ArrowLeft':
        if (expandable(node) && isExpanded(node)) setExpanded(node, false);
        else go(node.parent ?? undefined);
        break;
      case 'Enter': select(node, null); break;
      case 'F2': startRename(node); break;
      default: handled = false;
    }
    if (handled) event.preventDefault();
  };

  const renderNode = (node: ModelBrowserNode, setSize: number, position: number): JSX.Element => {
    const tag = node.tagId === state.defaultTagId ? undefined : state.tags.get(node.tagId);
    const luminance = tag?.color.map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    const lightText = luminance ? luminance[0]! * 0.2126 + luminance[1]! * 0.7152 + luminance[2]! * 0.0722 < 0.179 : false;
    const open = expandable(node) && isExpanded(node);
    const labelId = `${idPrefix}-${node.key}`, hiddenId = `${labelId}-hidden`;
    const renaming = editing?.key === node.key;
    const dimmed = node.hidden || node.inHidden;
    const description = node.hidden ? 'Hidden' : node.inHidden ? 'Inside a hidden group or component' : null;
    const selected = selectedKeys.has(node.key);
    const current = context.path.length > 0 && node.fullPath?.length === context.path.length && node.fullPath.every((id, index) => id === context.path[index]);
    const className = ['pf-layout-browser-item', dimmed ? 'is-hidden' : '', current ? 'is-current' : ''].filter(Boolean).join(' ');
    const what = KIND_NAMES[node.kind].toLowerCase();
    const stop = (event: { stopPropagation: () => void }): void => event.stopPropagation();
    const onRowClick = (event: ReactMouseEvent<HTMLDivElement>): void => { if (!renaming) select(node, event); };
    return <li key={node.key} role="treeitem" data-key={node.key} data-guidance-id={`object:${node.key}`} className={className} aria-labelledby={labelId} aria-level={node.level}
      aria-setsize={setSize} aria-posinset={position} aria-selected={selected} tabIndex={node.key === tabKey ? 0 : -1}
      {...(expandable(node) ? { 'aria-expanded': open } : {})}
      {...(description ? { 'aria-describedby': hiddenId } : {})}
      onFocus={event => { if (event.target === event.currentTarget) setFocusKey(node.key); }}>
      <div className={`pf-layout-browser-row${selected ? ' is-selected' : ''}`} style={{ '--pf-browser-level': node.level - 1 } as CSSProperties}
        title={`${KIND_NAMES[node.kind]}: ${node.label}${node.definitionName ? ` <${node.definitionName}>` : ''}`}
        onClick={onRowClick} onDoubleClick={() => startRename(node)}
        onContextMenu={event => { event.preventDefault(); if (!renaming) openMenu(node, event.clientX, event.clientY); }}>
        {expandable(node)
          ? <span className={`pf-layout-browser-chevron${open ? ' is-open' : ''}`} aria-hidden="true"
            onClick={event => { event.stopPropagation(); setFocusKey(node.key); setExpanded(node, !open); }}
            onDoubleClick={stop}><PiCaretRight /></span>
          : <span className="pf-layout-browser-chevron" aria-hidden="true" />}
        <span className="pf-layout-browser-icon" role="img" aria-label={KIND_NAMES[node.kind]}>{KIND_ICONS[node.kind]}</span>
        {renaming
          ? <RenameField label={node.label} id={labelId} onFinish={finishRename} />
          : <span id={labelId} className="pf-layout-browser-name">{node.label}
            {node.definitionName ? <span className="pf-model-browser-def"> &lt;{node.definitionName}&gt;</span> : null}</span>}
        {tag ? <span className="pf-model-browser-tag" title={tag.name} aria-label={`Tag: ${tag.name}`}
          style={{ backgroundColor: rgbToCss(tag.color), color: lightText ? '#fff' : '#000' }}>{tag.name}</span> : null}
        {current ? <span className="pf-layout-browser-flag" role="img" aria-label="Open for editing" title="Open for editing"><PiPencilSimple /></span> : null}
        {description ? <span id={hiddenId} className="pf-layout-browser-sr">{description}</span> : null}
        <button type="button" tabIndex={-1} aria-label={`Show ${node.label}`} aria-pressed={!node.hidden}
          className={`pf-layout-browser-toggle${node.hidden ? ' is-on' : ''}`} title={`${node.hidden ? 'Show' : 'Hide'} ${what}`}
          onDoubleClick={stop} onClick={event => { event.stopPropagation(); setHidden(node, !node.hidden); }}>
          {/* The Layout object browser's eye and lock icons. */}
          <Icon name={node.hidden ? 'eye-off' : 'eye'} size={TOGGLE_ICON_PX} /></button>
        {node.locked !== undefined ? <button type="button" tabIndex={-1} aria-label={`Lock ${node.label}`} aria-pressed={node.locked}
          className={`pf-layout-browser-toggle${node.locked ? ' is-on' : ''}`} title={`${node.locked ? 'Unlock' : 'Lock'} ${what}`}
          onDoubleClick={stop} onClick={event => { event.stopPropagation(); run('instance.setLocked', { refs: [node.ref], locked: !node.locked }); }}>
          <Icon name={node.locked ? 'lock' : 'unlock'} size={TOGGLE_ICON_PX} /></button>
          // Solids keep the lock's place so names and eyes line up.
          : <span className="pf-model-browser-toggle-gap" aria-hidden="true" />}
      </div>
      {open ? <ul role="group">{node.children.map((child, i) => renderNode(child, node.children.length, i + 1))}</ul> : null}
    </li>;
  };

  return <div className="pf-layout-object-browser pf-model-object-browser">
    <h2 className="pf-layout-browser-title">Object browser</h2>
    <div className="pf-tabs pf-model-browser-tabs" role="tablist" aria-label="Object browser sections">
      {(['objects', 'tags'] as const).map(name => <button key={name} type="button" role="tab" className={`pf-tab${section === name ? ' is-active' : ''}`}
        id={`${idPrefix}-${name}-tab`} aria-controls={`${idPrefix}-${name}-panel`} aria-selected={section === name}
        tabIndex={section === name ? 0 : -1} onClick={() => setSection(name)}
        onKeyDown={event => {
          if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
            event.preventDefault(); event.stopPropagation();
            const next = event.key === 'Home' ? 'objects' : event.key === 'End' ? 'tags' : section === 'objects' ? 'tags' : 'objects';
            setSection(next); document.getElementById(`${idPrefix}-${next}-tab`)?.focus();
          } else if (event.key === 'Escape') { event.stopPropagation(); onClose?.(); }
          else if (!modelBrowserPassesKey(event.nativeEvent)) event.stopPropagation();
        }}>{name === 'objects' ? 'Objects' : 'Tags'}</button>)}
    </div>
    <div role="tabpanel" id={`${idPrefix}-objects-panel`} aria-labelledby={`${idPrefix}-objects-tab`} hidden={section !== 'objects'}>
      <ul ref={treeRef} role="tree" aria-label="Object browser" aria-multiselectable="true" className="pf-layout-browser-tree" onKeyDown={onTreeKeyDown}>
        {tree.map((node, index) => renderNode(node, tree.length, index + 1))}
      </ul>
      {tree.length ? null : <p className="pf-model-browser-empty">Solids, groups and components you make appear here.</p>}
    </div>
    <div role="tabpanel" id={`${idPrefix}-tags-panel`} aria-labelledby={`${idPrefix}-tags-tab`} hidden={section !== 'tags'}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); onClose?.(); }
        else if (!modelBrowserPassesKey(event.nativeEvent)) event.stopPropagation();
      }}>
      {section === 'tags' ? <TagsPanel /> : null}
    </div>
  </div>;
}

/** The in-place name field; its keys stay inside it. */
function RenameField({ label, id, onFinish }: { label: string; id: string; onFinish: (value: string | null, refocus: boolean) => void }): JSX.Element {
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  return <input ref={input} id={id} className="pf-layout-browser-rename" aria-label={`Rename ${label}`} defaultValue={label}
    onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); onFinish(event.currentTarget.value, true); }
      else if (event.key === 'Escape') { event.preventDefault(); onFinish(null, true); }
    }}
    onBlur={event => onFinish(event.currentTarget.value, false)} />;
}
