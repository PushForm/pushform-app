// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { browserSelectionRange } from './browserSelectionRange';
import { useGuidanceBrowser } from '../hooks/useGuidanceBrowser';
import { memo, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { CSSProperties, JSX, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { LAYOUT_OBJECT_NAME_MAX, isCloudSource, isLayoutLayerVisible, layoutDefaultObjectNames, layoutObjectKind, layoutObjectName } from '@pushform/layout';
import { MdOutlinePushPin } from 'react-icons/md';
import { layoutViewportSources } from './layoutViewportRenders';
import type { LayoutDocumentState, LayoutEntity, LayoutObjectKind, LayoutPage } from '@pushform/layout';
import {
  PiBoundingBox, PiCaretRight, PiCube, PiFile, PiFrameCorners, PiGear, PiGridFour, PiImage, PiLineSegment, PiPolygon, PiRuler, PiStack, PiTable, PiTag, PiTextT,
} from 'react-icons/pi';
import { Icon } from './Icon';
import { LayoutContextMenu, type LayoutMenuItem } from './LayoutContextMenu';
import { formatPaperLength, paperPresetFor } from './layoutPaper';
import type { LayoutBrowserView } from '../session';

/** What a browser item names; Document Settings has no target. */
export type LayoutBrowserTarget =
  | { readonly kind: 'page'; readonly pageId: number }
  | { readonly kind: 'layer'; readonly pageId: number; readonly layerId: number }
  | { readonly kind: 'object'; readonly pageId: number; readonly entityId: number }
  /** A group's members on one layer, front-most first; `outer` groups are not nested in another group. */
  | { readonly kind: 'group'; readonly pageId: number; readonly layerId: number; readonly groupId: number; readonly entityIds: readonly number[]; readonly outer: boolean }
  /** A model the document's views look at; `referenceId` for a cloud model, none for an embedded one. */
  | { readonly kind: 'model'; readonly referenceId: number | null };

/**
 * Where dragged objects land: just in front of or behind `neighborId` in its layer, or, with no neighbor,
 * in front of everything else on `layerId`.
 */
export type LayoutBrowserDrop = { readonly layerId: number; readonly neighborId: number | null; readonly side: 'front' | 'back' };

/** How an object click changes the selection, by the canvas rules. */
export type LayoutBrowserSelectMode = 'replace' | 'toggle' | 'add' | 'remove';

/** The only keys a tree item passes to Layout are undo, redo (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl/Cmd+Y) and Print (Ctrl/Cmd+P). */
export function layoutBrowserPassesKey(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && /^[zyp]$/i.test(event.key);
}

export interface LayoutObjectBrowserProps {
  readonly state: LayoutDocumentState;
  readonly activePageId: number;
  readonly selectionIds: readonly number[];
  readonly onActivatePage: (pageId: number) => void;
  readonly onActivateLayer: (pageId: number, layerId: number) => void;
  readonly onSelectObject: (pageId: number, entityId: number, mode: LayoutBrowserSelectMode) => void;
  /** A group item selects exactly that group's members. */
  readonly onSelectGroup: (pageId: number, entityIds: readonly number[], mode: LayoutBrowserSelectMode) => void;
  /** Ungroup on an outer group's item. */
  readonly onUngroup: (pageId: number, entityIds: readonly number[]) => void;
  /** The expansion to start from, and where to keep it so reopening the browser restores it. */
  readonly view?: LayoutBrowserView | undefined;
  readonly onViewChange?: ((view: LayoutBrowserView) => void) | undefined;
  /** Delete on an object's or group's item erases its editable objects as one undoable action. */
  readonly onDeleteObjects: (pageId: number, entityIds: readonly number[]) => void;
  /** Objects: an empty name restores the default. Pages and layers never receive an empty name. */
  readonly onRename: (target: LayoutBrowserTarget, name: string) => void;
  readonly onDocumentSettings: () => void;
  /** The eye and lock buttons of layer and object rows. A layer's eye acts on that page only. */
  readonly onSetVisible: (target: LayoutBrowserTarget, visible: boolean) => void;
  readonly onSetLocked: (target: LayoutBrowserTarget, locked: boolean) => void;
  /** A dragged object (the workspace widens it to its selection or group) or group's members, and where they land; `exact` moves only those (an item inside a group). */
  readonly onMoveObject: (pageId: number, entityIds: readonly number[], drop: LayoutBrowserDrop, exact?: boolean) => void;
  /** A dragged layer and its new index in the document's layer order (0 is the bottom layer). */
  readonly onMoveLayer: (layerId: number, toIndex: number) => void;
  /** A dragged page and its new index in the document's page order. */
  readonly onMovePage: (pageId: number, toIndex: number) => void;
  /** A page's context menu adds a page after it, adds a layer (returning its id) or deletes the page. */
  readonly onAddPageAfter: (pageId: number) => void;
  readonly onAddLayer: () => number | null;
  readonly onDeletePage: (pageId: number) => void;
  /** Duplicating a page or layer, a layer's Show on Every Page, and deleting a layer. */
  readonly onDuplicatePage: (pageId: number) => void;
  readonly onDuplicateLayer: (layerId: number) => number | null;
  readonly onSetShared: (pageId: number, layerId: number, shared: boolean) => void;
  readonly onDeleteLayer: (layerId: number) => void;
  /** The pin button of a cloud model row. */
  readonly onPinModel?: ((referenceId: number, pinned: boolean) => void) | undefined;
  /** Escape on a tree item hides the docked panel. */
  readonly onClose?: (() => void) | undefined;
}

const SETTINGS_KEY = 'settings', PAGE_SIZE_KEY = 'settings:page-size', UNITS_KEY = 'settings:units', MODELS_KEY = 'models';
/** Pointer travel, in CSS pixels, that turns a press on a row into a drag, as in the Layers panel. */
const DRAG_THRESHOLD_PX = 4;
/** Eye and lock icon size in the browser's rows. */
const TOGGLE_ICON_PX = 16;
const KIND_ICONS: Record<LayoutObjectKind, ReactNode> = {
  Line: <PiLineSegment />, Shape: <PiPolygon />, Text: <PiTextT />, Label: <PiTag />, Dimension: <PiRuler />, Image: <PiImage />, Table: <PiTable />,
  // A model view uses the + menu's Model icon.
  View: <Icon name="document-model" size={18} />,
};

interface BrowserNode {
  readonly key: string;
  readonly level: number;
  readonly label: string;
  readonly icon: ReactNode;
  readonly target: LayoutBrowserTarget | null;
  readonly parent: string | null;
  readonly children: readonly BrowserNode[];
  /** True when the object has a custom name, so an empty rename restores the default. */
  readonly custom?: boolean;
  /** Dimmed: a layer hidden on the page, an object on such a layer, or a hidden object. */
  readonly hidden?: boolean;
  /** Read to assistive technology for dimmed objects. */
  readonly description?: string;
  /** Eye and lock button states; object buttons are disabled while their layer is hidden or locked. */
  readonly visibility?: { readonly shown: boolean; readonly disabled: boolean };
  readonly lock?: { readonly locked: boolean; readonly disabled: boolean };
  /** Whether the item can be dragged. */
  readonly draggable?: boolean;
  readonly selected?: boolean;
  readonly current?: boolean;
  readonly drawing?: boolean;
  /** A cloud model's pin state and revision. */
  readonly pin?: { readonly pinned: boolean; readonly referenceId: number; readonly revisionNumber: number };
}

const pageKey = (pageId: number): string => `page:${pageId}`;
const layerKey = (pageId: number, layerId: number): string => `layer:${pageId}:${layerId}`;
const objectKey = (pageId: number, entityId: number): string => `object:${pageId}:${entityId}`;

/** A layer's objects on one page, front-most first (reverse paint order), including those hidden on the page. */
function layerObjects(page: LayoutPage, state: LayoutDocumentState, layerId: number): LayoutEntity[] {
  const shared = state.layers.get(layerId)?.shared;
  const entities = shared ? state.sharedEntities : page.entities, order = shared ? state.sharedEntityOrder : page.entityOrder;
  return order.flatMap(id => { const entity = entities.get(id); return entity?.layerId === layerId ? [entity] : []; }).reverse();
}

const groupKey = (pageId: number, layerId: number, groupId: number): string => `group:${pageId}:${layerId}:${groupId}`;

/** "Group N" numbers every outer and nested group across the document in creation (id) order. */
function groupNumbers(state: LayoutDocumentState): Map<number, number> {
  const ids = new Set<number>();
  const visit = (entity: LayoutEntity): void => {
    if (entity.groupId !== undefined) ids.add(entity.groupId);
    for (const id of entity.nestedGroupIds ?? []) ids.add(id);
  };
  for (const page of state.pages.values()) page.entities.forEach(visit);
  state.sharedEntities.forEach(visit);
  return new Map([...ids].sort((a, b) => a - b).map((id, index) => [id, index + 1]));
}

/** The group an object belongs to at `depth`: its outer group, then each nested group inward. */
const groupAt = (entity: LayoutEntity, depth: number): number | undefined => depth === 0 ? entity.groupId : entity.nestedGroupIds?.[depth - 1];

function buildTree(state: LayoutDocumentState, activePageId: number, selected: ReadonlySet<number>, defaults: ReadonlyMap<number, string>): BrowserNode[] {
  const numbers = groupNumbers(state);
  // Layers in the Layers panel's order, top layer first.
  const layerOrder = [...state.layerOrder].reverse();
  const pages = state.pageOrder.flatMap((pageId): BrowserNode[] => {
    const page = state.pages.get(pageId);
    if (!page) return [];
    const layers = layerOrder.flatMap((layerId): BrowserNode[] => {
      const layer = state.layers.get(layerId);
      if (!layer) return [];
      const objectsOnPage = layerObjects(page, state, layerId);
      // A layer not shown on every page is listed under the active page and under other pages only where it has objects (user request 2026-10-26).
      if (!layer.shared && !objectsOnPage.length && pageId !== activePageId) return [];
      const hidden = !isLayoutLayerVisible(page, state, layerId), key = layerKey(pageId, layerId);
      // Object buttons and dragging follow the object commands: the layer must be shown on the page and unlocked.
      const unavailable = hidden || layer.locked;
      const objectNode = (entity: LayoutEntity, level: number, parent: string): BrowserNode => ({
        key: objectKey(pageId, entity.id), level, label: layoutObjectName(entity, defaults), icon: KIND_ICONS[layoutObjectKind(entity)],
        target: { kind: 'object', pageId, entityId: entity.id }, parent, children: [], custom: Boolean(entity.name?.trim()),
        hidden: hidden || Boolean(entity.hidden), ...(hidden ? { description: 'Hidden on this page' } : entity.hidden ? { description: 'Hidden' } : {}),
        visibility: { shown: !entity.hidden, disabled: unavailable }, lock: { locked: Boolean(entity.locked), disabled: unavailable },
        draggable: !unavailable && !entity.locked, selected: pageId === activePageId && selected.has(entity.id),
      });
      // A group sits where its front-most member on this layer would, with its members (and nested groups) under it.
      const nest = (entities: readonly LayoutEntity[], depth: number, level: number, parent: string): BrowserNode[] => {
        const seen = new Set<number>();
        return entities.flatMap((entity): BrowserNode[] => {
          const groupId = groupAt(entity, depth);
          if (groupId === undefined) return [objectNode(entity, level, parent)];
          if (seen.has(groupId)) return [];
          seen.add(groupId);
          const members = entities.filter(other => groupAt(other, depth) === groupId), ids = members.map(member => member.id);
          const node = groupKey(pageId, layerId, groupId), allHidden = members.every(member => member.hidden);
          return [{ key: node, level, label: `Group ${numbers.get(groupId) ?? ''}`, icon: <PiBoundingBox />,
            target: { kind: 'group', pageId, layerId, groupId, entityIds: ids, outer: depth === 0 }, parent, children: nest(members, depth + 1, level + 1, node),
            hidden: hidden || allHidden, ...(hidden ? { description: 'Hidden on this page' } : allHidden ? { description: 'Hidden' } : {}),
            visibility: { shown: !allHidden, disabled: unavailable }, lock: { locked: members.every(member => member.locked), disabled: unavailable },
            draggable: !unavailable && !members.some(member => member.locked), selected: pageId === activePageId && ids.every(id => selected.has(id)) }];
        });
      };
      const objects = nest(objectsOnPage, 0, 3, key);
      return [{ key, level: 2, label: layer.name, icon: <PiStack />, target: { kind: 'layer', pageId, layerId }, parent: pageKey(pageId),
        children: objects, hidden, visibility: { shown: !hidden, disabled: false }, lock: { locked: layer.locked, disabled: false },
        draggable: true, drawing: layerId === state.activeLayerId }];
    });
    return [{ key: pageKey(pageId), level: 1, label: page.name, icon: <PiFile />, target: { kind: 'page', pageId }, parent: null,
      children: layers, current: pageId === activePageId, draggable: true }];
  });
  // Under Document Settings, the document's paper (named by its preset, else Custom) and its units and grid.
  const paper = state.pages.get(state.pageOrder[0]!);
  const unit = state.settings.paperUnits ?? 'mm', gridUnit = state.settings.grid.units ?? 'mm';
  const size: BrowserNode[] = paper ? [{ key: PAGE_SIZE_KEY, level: 2,
    label: `${paperPresetFor(paper.size)?.name ?? 'Custom'}: ${formatPaperLength(paper.size[0], unit)} × ${formatPaperLength(paper.size[1], unit)} ${unit}`,
    icon: <PiFrameCorners />, target: null, parent: SETTINGS_KEY, children: [] }, { key: UNITS_KEY, level: 2,
    label: `Units: ${unit} · Grid: ${formatPaperLength(state.settings.grid.spacingMm, gridUnit)} ${gridUnit}`,
    icon: <PiGridFour />, target: null, parent: SETTINGS_KEY, children: [] }] : [];
  // The models the document's views look at, cloud references first; absent while there are none.
  const models: BrowserNode[] = layoutViewportSources(state).map(source => {
    const reference = isCloudSource(source.source) ? state.references.get(source.source.referenceId) : undefined;
    const cloud = reference?.target.kind === 'cloud' ? reference.target : null;
    return { key: `model:${source.key}`, level: 2, label: source.name, icon: <PiCube />, parent: MODELS_KEY, children: [],
      target: { kind: 'model', referenceId: reference?.id ?? null },
      description: cloud ? `Cloud model, revision ${cloud.revisionNumber}${cloud.pinned ? ', pinned' : ''}` : 'Embedded SketchUp model',
      ...(cloud && reference ? { pin: { pinned: cloud.pinned, referenceId: reference.id, revisionNumber: cloud.revisionNumber } } : {}) };
  });
  return [{ key: SETTINGS_KEY, level: 1, label: 'Document Settings', icon: <PiGear />, target: null, parent: null, children: size },
    ...(models.length ? [{ key: MODELS_KEY, level: 1, label: 'Models', icon: <Icon name="document-model" size={18} />, target: null, parent: null, children: models }] : []),
    ...pages];
}

const DEFAULT_VIEW: LayoutBrowserView = { collapsedPages: new Set(), expandedLayers: new Set(), collapsedGroups: new Set(), settingsOpen: true };

/**
 * The Layout object browser: Document Settings, then pages, their layers and their objects. It is
 * presentational; the workspace turns its callbacks into page activation, selection, rename, show, lock and arrange commands.
 */
export const LayoutObjectBrowser = memo(function LayoutObjectBrowser({
  state, activePageId, selectionIds, onActivatePage, onActivateLayer, onSelectObject, onSelectGroup, onUngroup, onDeleteObjects, onRename, onDocumentSettings,
  onSetVisible, onSetLocked, onMoveObject, onMoveLayer, onMovePage, onAddPageAfter, onAddLayer, onDeletePage,
  onDuplicatePage, onDuplicateLayer, onSetShared, onDeleteLayer, onPinModel, onClose, view: initialView, onViewChange,
}: LayoutObjectBrowserProps): JSX.Element {
  const selectionAnchor = useRef<string | null>(null);
  const idPrefix = useId();
  const defaults = useMemo(() => layoutDefaultObjectNames(state), [state]);
  const selected = useMemo(() => new Set(selectionIds), [selectionIds]);
  const tree = useMemo(() => buildTree(state, activePageId, selected, defaults), [state, activePageId, selected, defaults]);
  const allByKey = useMemo(() => {
    const nodes = new Map<string, BrowserNode>();
    const walk = (list: readonly BrowserNode[]): void => { for (const node of list) { nodes.set(node.key, node); walk(node.children); } };
    walk(tree);
    return nodes;
  }, [tree]);
  // Expansion is view state, kept by the workspace across closing and reopening the browser.
  const [view, setView] = useState<LayoutBrowserView>(() => initialView ?? DEFAULT_VIEW);
  const viewChange = useRef(onViewChange);
  viewChange.current = onViewChange;
  useEffect(() => { viewChange.current?.(view); }, [view]);
  const { collapsedPages, expandedLayers, collapsedGroups, settingsOpen } = view;
  const [focusKey, setFocusKey] = useState(SETTINGS_KEY);
  const [editing, setEditing] = useState<BrowserNode | null>(null);
  const editingRef = useRef<BrowserNode | null>(null);
  const treeRef = useRef<HTMLUListElement>(null);
  const pendingFocus = useRef<string | null>(null), pendingReveal = useRef<string | null>(null);
  // A focus or reveal request always renders once, even when no expansion or focus state changes, so it is never left pending.
  const [, requestRender] = useReducer((count: number) => count + 1, 0);
  useGuidanceBrowser(treeRef, allByKey, ancestors => setView(current => ({ ...current,
    settingsOpen: current.settingsOpen || ancestors.has(SETTINGS_KEY),
    collapsedPages: new Set([...current.collapsedPages].filter(id => !ancestors.has(pageKey(id)))),
    expandedLayers: new Set([...current.expandedLayers, ...[...ancestors].filter(key => allByKey.get(key)?.target?.kind === 'layer')]),
    collapsedGroups: new Set([...current.collapsedGroups].filter(key => !ancestors.has(key))),
  })));
  // A press on a draggable row becomes a drag once the pointer travels; the click that ends a drag is ignored.
  const dragStart = useRef<{ node: BrowserNode; x: number; y: number; pointerId: number; dragging: boolean } | null>(null);
  const suppressClick = useRef(false);
  const [drop, setDrop] = useState<{ readonly key: string; readonly position: 'before' | 'after' | 'into' } | null>(null);
  // The open context menu and the item it belongs to; a layer it adds is renamed once its item appears.
  const [menu, setMenu] = useState<{ readonly x: number; readonly y: number; readonly node: BrowserNode } | null>(null);
  const pendingRename = useRef<string | null>(null);

  const expandPage = (pageId: number): void => setView(current => current.collapsedPages.has(pageId)
    ? { ...current, collapsedPages: new Set([...current.collapsedPages].filter(id => id !== pageId)) } : current);
  useEffect(() => { expandPage(activePageId); }, [activePageId]);
  // A canvas selection expands its page and layer and scrolls the first selected object into view.
  const selectionKey = selectionIds.join(',');
  useEffect(() => {
    if (!state.pages.has(activePageId) || !selectionIds.length) return;
    // Every layer and group above a selected object opens.
    const ancestors = new Set<string>();
    for (const id of selectionIds) {
      for (let key = allByKey.get(objectKey(activePageId, id))?.parent; key && key !== pageKey(activePageId); key = allByKey.get(key)?.parent) ancestors.add(key);
    }
    if (!ancestors.size) return;
    expandPage(activePageId);
    setView(current => {
      const layers = [...ancestors].filter(key => allByKey.get(key)?.target?.kind === 'layer' && !current.expandedLayers.has(key));
      const groups = [...ancestors].filter(key => current.collapsedGroups.has(key));
      if (!layers.length && !groups.length) return current;
      return { ...current, expandedLayers: new Set([...current.expandedLayers, ...layers]),
        collapsedGroups: new Set([...current.collapsedGroups].filter(key => !groups.includes(key))) };
    });
    pendingReveal.current = objectKey(activePageId, selectionIds[0]!);
    requestRender();
    // Only a new selection reveals; document edits that keep the selection leave the view where the user put it.
  }, [selectionKey, activePageId]);

  // Pages are expanded and layers collapsed until toggled; groups and the Models group are expanded.
  const isExpanded = (node: BrowserNode): boolean => node.key === SETTINGS_KEY ? settingsOpen
    : node.target?.kind === 'page' ? !collapsedPages.has(node.target.pageId)
      : node.target?.kind === 'layer' ? expandedLayers.has(node.key)
        : node.key === MODELS_KEY || node.target?.kind === 'group' ? !collapsedGroups.has(node.key) : false;
  const expandable = (node: BrowserNode): boolean => node.children.length > 0;
  const visible = useMemo(() => {
    const items: BrowserNode[] = [];
    const walk = (nodes: readonly BrowserNode[]): void => {
      for (const node of nodes) { items.push(node); if (expandable(node) && isExpanded(node)) walk(node.children); }
    };
    walk(tree);
    return items;
  }, [tree, view]);
  const byKey = useMemo(() => new Map(visible.map(node => [node.key, node])), [visible]);
  const tabKey = byKey.has(focusKey) ? focusKey : SETTINGS_KEY;

  useLayoutEffect(() => {
    const root = treeRef.current;
    if (!root) return;
    const item = (key: string): HTMLElement | null => root.querySelector<HTMLElement>(`[data-key="${key}"]`);
    if (pendingReveal.current) {
      item(pendingReveal.current)?.querySelector<HTMLElement>('.pf-layout-browser-row')?.scrollIntoView?.({ block: 'nearest' });
      pendingReveal.current = null;
    }
    const renaming = pendingRename.current ? byKey.get(pendingRename.current) : undefined;
    if (renaming) { pendingRename.current = null; startRename(renaming); }
    if (pendingFocus.current) {
      item(pendingFocus.current)?.focus();
      pendingFocus.current = null;
    }
  });

  const setExpanded = (node: BrowserNode, open: boolean): void => {
    const toggled = <T,>(set: ReadonlySet<T>, item: T, add: boolean): ReadonlySet<T> => {
      const next = new Set(set); if (add) next.add(item); else next.delete(item); return next;
    };
    const target = node.target;
    if (node.key === SETTINGS_KEY) setView(current => ({ ...current, settingsOpen: open }));
    else if (target?.kind === 'page') setView(current => ({ ...current, collapsedPages: toggled(current.collapsedPages, target.pageId, !open) }));
    else if (target?.kind === 'layer') setView(current => ({ ...current, expandedLayers: toggled(current.expandedLayers, node.key, open) }));
    else if (node.key === MODELS_KEY || target?.kind === 'group') setView(current => ({ ...current, collapsedGroups: toggled(current.collapsedGroups, node.key, !open) }));
  };
  const moveFocus = (key: string): void => { setFocusKey(key); pendingFocus.current = key; requestRender(); };
  const activate = (node: BrowserNode, mode: LayoutBrowserSelectMode): void => {
    setFocusKey(node.key);
    const target = node.target;
    if (!target) { if (node.key !== MODELS_KEY) onDocumentSettings(); }
    else if (target.kind === 'model') return;
    else if (target.kind === 'page') onActivatePage(target.pageId);
    else if (target.kind === 'layer') onActivateLayer(target.pageId, target.layerId);
    else if (target.kind === 'group') onSelectGroup(target.pageId, target.entityIds, mode);
    else onSelectObject(target.pageId, target.entityId, mode);
  };
  const startRename = (node: BrowserNode): void => {
    // Groups and models have no stored name to edit here.
    if (!node.target || node.target.kind === 'group' || node.target.kind === 'model') return;
    // The field takes focus; a pending item focus would pull it straight back out and commit.
    pendingFocus.current = null;
    editingRef.current = node; setEditing(node); setFocusKey(node.key);
  };
  /** The items of an item's context menu. */
  const menuItems = (node: BrowserNode): LayoutMenuItem[] => {
    const target = node.target;
    if (!target) return node.key === MODELS_KEY ? [] : [{ label: 'Open Document Settings', action: () => onDocumentSettings() }];
    if (target.kind === 'model') return node.pin ? [{ label: node.pin.pinned ? 'Unpin Version' : 'Pin Version', action: () => onPinModel?.(node.pin!.referenceId, !node.pin!.pinned) }] : [];
    const rename: LayoutMenuItem = { label: 'Rename', action: () => startRename(node) };
    if (target.kind === 'page') return [
      { label: 'Add Page After', action: () => onAddPageAfter(target.pageId) },
      { label: 'Duplicate Page', action: () => onDuplicatePage(target.pageId) },
      { label: 'Add Layer', action: () => {
        // The new layer is the drawing layer, listed on the active page: make this page active first.
        onActivatePage(target.pageId);
        const layerId = onAddLayer();
        if (layerId === null) return;
        setExpanded(node, true);
        pendingRename.current = layerKey(target.pageId, layerId); requestRender();
      } },
      { ...rename, separator: true },
      { label: 'Delete Page', disabled: state.pageOrder.length < 2, action: () => onDeletePage(target.pageId) },
    ];
    const layer = target.kind === 'layer', items: LayoutMenuItem[] = target.kind === 'group' ? [] : [rename];
    if (target.kind === 'layer') {
      const source = state.layers.get(target.layerId);
      items.push({ label: 'Duplicate Layer', action: () => {
        const layerId = onDuplicateLayer(target.layerId);
        if (layerId !== null) moveFocus(layerKey(target.pageId, layerId));
      } });
      items.push({ label: 'Show on Every Page', checked: Boolean(source?.shared), disabled: Boolean(source?.locked),
        action: () => onSetShared(target.pageId, target.layerId, !source?.shared) });
    }
    if (node.visibility) {
      const shown = node.visibility.shown;
      items.push({ label: `${shown ? 'Hide' : 'Show'}${layer ? ' on This Page' : ''}`, separator: items.length > 0, disabled: node.visibility.disabled,
        action: () => onSetVisible(target, !shown) });
    }
    if (node.lock) {
      const locked = node.lock.locked;
      items.push({ label: locked ? 'Unlock' : 'Lock', disabled: node.lock.disabled, action: () => onSetLocked(target, !locked) });
    }
    // Ungroup removes the outermost group level, so only an outer group's item offers it.
    if (target.kind === 'group' && target.outer) items.push({ label: 'Ungroup', separator: true, disabled: Boolean(node.lock?.disabled || !node.draggable),
      action: () => onUngroup(target.pageId, target.entityIds) });
    if (target.kind === 'object' || target.kind === 'group') items.push({ label: 'Delete', separator: true,
      disabled: Boolean(node.lock?.disabled || node.lock?.locked),
      action: () => onDeleteObjects(target.pageId, target.kind === 'group' ? target.entityIds : [target.entityId]) });
    // The command keeps one unlocked layer; a locked layer must be unlocked before it is deleted.
    if (target.kind === 'layer') items.push({ label: 'Delete Layer', separator: true,
      disabled: Boolean(state.layers.get(target.layerId)?.locked) || !state.layerOrder.some(id => id !== target.layerId && !state.layers.get(id)?.locked),
      action: () => onDeleteLayer(target.layerId) });
    return items;
  };
  const openMenu = (node: BrowserNode, x: number, y: number): void => { setFocusKey(node.key); setMenu({ x, y, node }); };
  /** Enter or leaving the field commits; an unchanged name or an empty page or layer name changes nothing. */
  const finishRename = (value: string | null, refocus: boolean): void => {
    const node = editingRef.current;
    if (!node?.target) return;
    editingRef.current = null; setEditing(null);
    if (refocus) pendingFocus.current = node.key;
    if (value === null) return;
    const name = value.trim();
    if (name ? name !== node.label : node.target.kind === 'object' && node.custom) onRename(node.target, name);
  };

  /** The drop a dragged item would make over `over`, or null where it cannot land. */
  const dropAt = (dragged: BrowserNode, over: BrowserNode, lower: boolean): { key: string; position: 'before' | 'after' | 'into' } | null => {
    const from = dragged.target, to = over.target;
    // Pages land above or below another page's row.
    if (from?.kind === 'page') return to?.kind === 'page' && over.key !== dragged.key ? { key: over.key, position: lower ? 'after' : 'before' } : null;
    if (!from || !to || from.kind === 'model' || to.kind === 'model' || from.pageId !== to.pageId || over.key === dragged.key) return null;
    if (from.kind === 'layer') return to.kind === 'layer' ? { key: over.key, position: lower ? 'after' : 'before' } : null;
    if ((from.kind !== 'object' && from.kind !== 'group') || to.kind === 'page') return null;
    // Nothing lands inside itself.
    for (let key = over.parent; key; key = allByKey.get(key)?.parent ?? null) if (key === dragged.key) return null;
    // An item inside a group only changes its order among that group's items.
    if (inGroup(dragged)) return over.parent === dragged.parent && to.kind !== 'layer' ? { key: over.key, position: lower ? 'after' : 'before' } : null;
    // Objects land only where the destination layer accepts them: shown on the page and unlocked.
    const layerNode = layerOf(over);
    if (!layerNode?.visibility?.shown || layerNode.lock?.locked) return null;
    return to.kind === 'layer' ? { key: over.key, position: 'into' } : { key: over.key, position: lower ? 'after' : 'before' };
  };
  const commitDrop = (dragged: BrowserNode, target: { key: string; position: 'before' | 'after' | 'into' }): void => {
    const from = dragged.target, over = byKey.get(target.key), to = over?.target;
    if (!from || !to) return;
    if (from.kind === 'page') {
      if (to.kind !== 'page') return;
      const order = state.pageOrder.filter(id => id !== from.pageId);
      order.splice(order.indexOf(to.pageId) + (target.position === 'after' ? 1 : 0), 0, from.pageId);
      const toIndex = order.indexOf(from.pageId);
      if (toIndex !== state.pageOrder.indexOf(from.pageId)) onMovePage(from.pageId, toIndex);
    } else if (from.kind === 'layer' && to.kind === 'layer') {
      // The tree lists layers top first; the document orders them bottom first.
      const order = [...state.layerOrder].reverse().filter(id => id !== from.layerId);
      order.splice(order.indexOf(to.layerId) + (target.position === 'after' ? 1 : 0), 0, from.layerId);
      const toIndex = order.reverse().indexOf(from.layerId);
      if (toIndex !== state.layerOrder.indexOf(from.layerId)) onMoveLayer(from.layerId, toIndex);
    } else if (from.kind === 'object' || from.kind === 'group') {
      if (to.kind === 'layer') onMoveObject(from.pageId, movingIds(from), { layerId: to.layerId, neighborId: null, side: 'front' }, inGroup(dragged));
      else if (over) {
        // Above an item in the tree is in front of it; a group's edge is its front-most or back-most member.
        const layer = layerOf(over)?.target, front = target.position === 'before', neighborId = edgeOf(to, front);
        if (layer?.kind === 'layer' && neighborId !== null)
          onMoveObject(from.pageId, movingIds(from), { layerId: layer.layerId, neighborId, side: front ? 'front' : 'back' }, inGroup(dragged));
      }
    }
  };
  const endDrag = (): void => { dragStart.current = null; setDrop(null); };
  /** The layer item an object or group sits under. */
  const layerOf = (node: BrowserNode): BrowserNode | undefined => {
    let current: BrowserNode | undefined = node;
    while (current && current.target?.kind !== 'layer') current = current.parent ? allByKey.get(current.parent) : undefined;
    return current;
  };
  const inGroup = (node: BrowserNode): boolean => allByKey.get(node.parent ?? '')?.target?.kind === 'group';
  const movingIds = (target: LayoutBrowserTarget): readonly number[] => target.kind === 'group' ? target.entityIds : target.kind === 'object' ? [target.entityId] : [];
  const edgeOf = (target: LayoutBrowserTarget | null, front: boolean): number | null => target?.kind === 'object' ? target.entityId
    : target?.kind === 'group' ? (front ? target.entityIds[0] : target.entityIds.at(-1)) ?? null : null;
  /** Ignores the click that ends a drag; it arrives in the same task, so the flag never outlives it. */
  const swallowClick = (): void => { suppressClick.current = true; window.setTimeout(() => { suppressClick.current = false; }, 0); };
  /** Alt+Up and Alt+Down move an object one step toward the front or back of its layer, or a page or layer up or down. */
  const keyboardMove = (node: BrowserNode, up: boolean): void => {
    const target = node.target;
    if (target?.kind === 'page') {
      const toIndex = state.pageOrder.indexOf(target.pageId) + (up ? -1 : 1);
      if (toIndex < 0 || toIndex >= state.pageOrder.length) return;
      onMovePage(target.pageId, toIndex);
    } else if (target?.kind === 'layer') {
      const toIndex = state.layerOrder.indexOf(target.layerId) + (up ? 1 : -1);
      if (toIndex < 0 || toIndex >= state.layerOrder.length) return;
      onMoveLayer(target.layerId, toIndex);
    } else if ((target?.kind === 'object' || target?.kind === 'group') && node.draggable) {
      const siblings = allByKey.get(node.parent ?? '')?.children ?? [], layer = layerOf(node)?.target;
      const neighborId = edgeOf(siblings[siblings.indexOf(node) + (up ? -1 : 1)]?.target ?? null, up);
      if (neighborId === null || layer?.kind !== 'layer') return;
      onMoveObject(target.pageId, movingIds(target), { layerId: layer.layerId, neighborId, side: up ? 'front' : 'back' }, inGroup(node));
    } else return;
    moveFocus(node.key);
  };

  const onTreeKeyDown = (event: ReactKeyboardEvent<HTMLUListElement>): void => {
    if (event.target instanceof HTMLInputElement) { event.stopPropagation(); return; }
    // Escape during a drag cancels it and keeps the panel open.
    if (event.key === 'Escape' && dragStart.current) {
      event.preventDefault(); event.stopPropagation();
      if (dragStart.current.dragging) swallowClick();
      endDrag(); return;
    }
    // No other key pressed on a tree item reaches Layout shortcuts or tools.
    if (layoutBrowserPassesKey(event)) return;
    event.stopPropagation();
    const item = event.target instanceof Element ? event.target.closest('[role="treeitem"]') : null;
    const node = byKey.get(item?.getAttribute('data-key') ?? tabKey);
    if (!node) return;
    const index = visible.indexOf(node);
    const go = (key: string | undefined): void => { if (key) moveFocus(key); };
    let handled = true;
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      const bounds = item?.querySelector('.pf-layout-browser-row')?.getBoundingClientRect();
      openMenu(node, bounds ? bounds.left + 24 : 0, bounds ? bounds.bottom : 0); return;
    }
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault(); keyboardMove(node, event.key === 'ArrowUp'); return;
    }
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
      case 'Enter': activate(node, 'replace'); break;
      case 'F2': startRename(node); break;
      case 'Escape': onClose?.(); break;
      default: handled = false;
    }
    if (handled) event.preventDefault();
  };

  const renderNode = (node: BrowserNode, setSize: number, position: number): JSX.Element => {
    const open = expandable(node) && isExpanded(node);
    const labelId = `${idPrefix}-${node.key}`;
    const renaming = editing?.key === node.key;
    // An object on a hidden layer is dimmed; assistive technology hears the same state.
    // The description also names a model's kind and revision, and the drawing layer.
    const hiddenObject = Boolean(node.description) || Boolean(node.drawing), hiddenId = `${labelId}-hidden`;
    const onRowClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
      if (suppressClick.current) { suppressClick.current = false; return; }
      if (renaming) return;
      const primary = event.ctrlKey || event.metaKey;
      if (event.shiftKey && !primary && node.target && 'pageId' in node.target) {
        const pageId = node.target.pageId;
        const anchor = visible.find(item => item.key === selectionAnchor.current);
        const range = browserSelectionRange(visible, anchor?.target && 'pageId' in anchor.target && anchor.target.pageId === pageId ? anchor.key : null, node);
        const ids = [...new Set(range.flatMap(item => {
          const target = item.target;
          if (!target || !('pageId' in target) || target.pageId !== pageId) return [];
          return target.kind === 'object' ? [target.entityId] : target.kind === 'group' ? [...target.entityIds] : [];
        }))];
        setFocusKey(node.key);
        if (ids.length) onSelectGroup(pageId, ids, 'replace');
        else activate(node, 'replace');
      } else {
        selectionAnchor.current = node.key;
        activate(node, primary ? event.shiftKey ? 'remove' : 'add' : 'replace');
      }
    };
    const className = ['pf-layout-browser-item', node.hidden ? 'is-hidden' : '', node.current ? 'is-current' : '', node.drawing ? 'is-drawing' : ''].filter(Boolean).join(' ');
    const dropClass = drop?.key === node.key ? ` drop-${drop.position}` : '';
    const isLayer = node.target?.kind === 'layer';
    const stop = (event: { stopPropagation: () => void }): void => event.stopPropagation();
    return <li key={node.key} role="treeitem" data-guidance-id={`object:${node.key}`} data-key={node.key} className={className} aria-labelledby={labelId} aria-level={node.level}
      aria-setsize={setSize} aria-posinset={position} tabIndex={node.key === tabKey ? 0 : -1}
      {...(expandable(node) ? { 'aria-expanded': open } : {})}
      {...(node.target?.kind === 'object' || node.target?.kind === 'group' ? { 'aria-selected': Boolean(node.selected) } : {})}
      {...(node.current ? { 'aria-current': 'page' as const } : {})}
      {...(hiddenObject ? { 'aria-describedby': hiddenId } : {})}
      onFocus={event => { if (event.target === event.currentTarget) setFocusKey(node.key); }}>
      <div className={`pf-layout-browser-row${node.selected ? ' is-selected' : ''}${dropClass}`} style={{ '--pf-browser-level': node.level - 1 } as CSSProperties}
        onClick={onRowClick} onDoubleClick={() => startRename(node)}
        onContextMenu={event => { event.preventDefault(); if (!renaming) openMenu(node, event.clientX, event.clientY); }}
        onPointerDown={event => {
          // A new press clears a click left unclaimed by a drag whose row moved away before the click arrived.
          suppressClick.current = false;
          if (event.button !== 0 || renaming || !node.draggable) return;
          dragStart.current = { node, x: event.clientX, y: event.clientY, pointerId: event.pointerId, dragging: false };
        }}>
        {expandable(node)
          ? <span className={`pf-layout-browser-chevron${open ? ' is-open' : ''}`} aria-hidden="true"
            onClick={event => { event.stopPropagation(); setFocusKey(node.key); setExpanded(node, !open); }}
            onDoubleClick={event => event.stopPropagation()}><PiCaretRight /></span>
          : <span className="pf-layout-browser-chevron" aria-hidden="true" />}
        <span className="pf-layout-browser-icon" aria-hidden="true">{node.icon}</span>
        {renaming
          ? <RenameField label={node.label} id={labelId} limit={node.target?.kind === 'object' ? LAYOUT_OBJECT_NAME_MAX : undefined} onFinish={finishRename} />
          : <span id={labelId} className="pf-layout-browser-name" title={node.drawing ? `${node.label} (drawing layer)` : node.label}>{node.label}</span>}
        {hiddenObject ? <span id={hiddenId} className="pf-layout-browser-sr">{node.drawing ? 'Drawing layer' : node.description}</span> : null}
        {node.pin ? <button type="button" tabIndex={-1} aria-label={`Pin Version of ${node.label}`} aria-pressed={node.pin.pinned}
          className={`pf-layout-browser-toggle${node.pin.pinned ? ' is-on' : ''}`} title="Pin Version"
          onPointerDown={stop} onDoubleClick={stop}
          onClick={event => { event.stopPropagation(); onPinModel?.(node.pin!.referenceId, !node.pin!.pinned); }}>
          <MdOutlinePushPin size={TOGGLE_ICON_PX} /></button> : null}
        {node.visibility && node.target ? <button type="button" tabIndex={-1} aria-label={`Show ${node.label}`} aria-pressed={node.visibility.shown}
          className={`pf-layout-browser-toggle${node.visibility.shown ? '' : ' is-on'}`} disabled={node.visibility.disabled}
          title={node.visibility.disabled ? 'Show the layer on this page and unlock it first'
            : `${node.visibility.shown ? 'Hide' : 'Show'} ${isLayer ? 'layer on this page' : 'object'}`}
          onPointerDown={stop} onDoubleClick={stop}
          onClick={event => { event.stopPropagation(); onSetVisible(node.target!, !node.visibility!.shown); }}>
          {/* The Layers panel's eye and lock icons. */}
          <Icon name={node.visibility.shown ? 'eye' : 'eye-off'} size={TOGGLE_ICON_PX} /></button> : null}
        {node.lock && node.target ? <button type="button" tabIndex={-1} aria-label={`Lock ${node.label}`} aria-pressed={node.lock.locked}
          className={`pf-layout-browser-toggle${node.lock.locked ? ' is-on' : ''}`} disabled={node.lock.disabled}
          title={node.lock.disabled ? 'Show the layer on this page and unlock it first'
            : `${node.lock.locked ? 'Unlock' : 'Lock'} ${isLayer ? 'layer' : 'object'}`}
          onPointerDown={stop} onDoubleClick={stop}
          onClick={event => { event.stopPropagation(); onSetLocked(node.target!, !node.lock!.locked); }}>
          <Icon name={node.lock.locked ? 'lock' : 'unlock'} size={TOGGLE_ICON_PX} /></button> : null}
      </div>
      {open ? <ul role="group">{node.children.map((child, i) => renderNode(child, node.children.length, i + 1))}</ul> : null}
    </li>;
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLUListElement>): void => {
    const start = dragStart.current;
    if (!start || event.pointerId !== start.pointerId) return;
    if (!start.dragging) {
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < DRAG_THRESHOLD_PX) return;
      start.dragging = true;
      treeRef.current?.querySelector<HTMLElement>(`[data-key="${start.node.key}"] > .pf-layout-browser-row`)?.setPointerCapture?.(event.pointerId);
    }
    const item = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[role="treeitem"]');
    const over = item && treeRef.current?.contains(item) ? byKey.get(item.dataset['key'] ?? '') : undefined;
    const bounds = item?.querySelector('.pf-layout-browser-row')?.getBoundingClientRect();
    const next = over && bounds ? dropAt(start.node, over, event.clientY >= bounds.top + bounds.height / 2) : null;
    setDrop(current => current?.key === next?.key && current?.position === next?.position ? current : next);
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLUListElement>): void => {
    const start = dragStart.current;
    if (!start || event.pointerId !== start.pointerId) return;
    if (start.dragging) { swallowClick(); if (drop) commitDrop(start.node, drop); }
    endDrag();
  };

  return <div className={`pf-layout-object-browser${drop ? ' is-dragging' : ''}`}>
    <h2 className="pf-layout-browser-title">Object browser</h2>
    <ul ref={treeRef} role="tree" aria-label="Object browser" aria-multiselectable="true" className="pf-layout-browser-tree" onKeyDown={onTreeKeyDown}
      onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={endDrag}
      onLostPointerCapture={() => { if (dragStart.current?.dragging) endDrag(); }}>
      {tree.map((node, index) => renderNode(node, tree.length, index + 1))}
    </ul>
    {/* Outside the tree, so clicks in the menu never reach a row; closing returns focus to the item. */}
    {menu ? <LayoutContextMenu x={menu.x} y={menu.y} items={menuItems(menu.node)} label={`${menu.node.label} menu`}
      onClose={() => { const key = menu.node.key; setMenu(null); moveFocus(key); }} /> : null}
  </div>;
});

/** The in-place name field; its keys stay inside it. */
function RenameField({ label, id, limit, onFinish }: {
  label: string; id: string; limit: number | undefined; onFinish: (value: string | null, refocus: boolean) => void;
}): JSX.Element {
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  return <input ref={input} id={id} className="pf-layout-browser-rename" aria-label={`Rename ${label}`} defaultValue={label}
    {...(limit !== undefined ? { maxLength: limit } : {})}
    onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); onFinish(event.currentTarget.value, true); }
      else if (event.key === 'Escape') { event.preventDefault(); onFinish(null, true); }
    }}
    onBlur={event => onFinish(event.currentTarget.value, false)} />;
}
