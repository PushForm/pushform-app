// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createLayoutShapeRegions, entitiesForLayer, isLayoutLayerVisible,
  layoutShapeBuildSnapshot, layoutShapeRegionsAlong, replayLayoutShapeBuild,
  type LayoutDocumentState, type LayoutEntity, type LayoutPage, type LayoutShapeBuildGesture,
  type LayoutShapeRegion,
} from '@pushform/layout';
import type { LayoutTab } from '../session';
import { showToast } from '../toasts';

type Point = [number, number];
interface Session {
  tab: LayoutTab;
  pageId: number;
  sources: LayoutEntity[];
  selectionIds: number[];
  snapshot: string;
  regions: LayoutShapeRegion[];
  busy: boolean;
}
interface Drag { point: Point; gesture: LayoutShapeBuildGesture }

/** Session previews stay outside the document; only Apply executes a command. */
export function useLayoutShapeBuilder(tab: LayoutTab, page: LayoutPage, state: LayoutDocumentState,
  active: boolean, onExit: (ids: number[]) => void, onError: (message: string) => void) {
  const [session, setSession] = useState<Session | null>(null);
  const [gestures, setGestures] = useState<LayoutShapeBuildGesture[]>([]);
  const [redo, setRedo] = useState<LayoutShapeBuildGesture[]>([]);
  const [pending, setPending] = useState<LayoutShapeBuildGesture | null>(null);
  const drag = useRef<Drag | null>(null);
  const [mode, setMode] = useState<'add' | 'remove'>('add');
  const [keepOriginals, setKeepOriginals] = useState(false);
  const [hover, setHover] = useState<string[]>([]);
  const [shift, setShift] = useState(false);
  const callbacks = useRef({ onExit, onError });
  callbacks.current = { onExit, onError };
  const historySelections = useRef(new WeakMap<object, { pageId: number; ids: number[] }>());
  useEffect(() => tab.doc.events.on('change', event => {
    if (event.source !== 'undo' && event.source !== 'redo') return;
    const selection = historySelections.current.get(event.patches);
    if (selection?.pageId === tab.activePageId) callbacks.current.onExit(selection.ids);
  }), [tab]);

  const start = (ids: readonly number[]): boolean => {
    if (!ids.length) {
      showToast('You must select some object to use with the Shape Builder tool.');
      return false;
    }
    try {
      const sources = state.layerOrder.flatMap(layerId => entitiesForLayer(page, state, layerId)).filter(entity => ids.includes(entity.id) && entity.kind === 'path');
      const first = sources[0];
      if (!first) throw new Error('Select lines or shapes before using Shape Builder.');
      if (sources.some(entity => entity.hidden ||
        entity.groupId !== undefined || entity.layerId !== first.layerId || entity.locked ||
        state.layers.get(entity.layerId)?.locked || !isLayoutLayerVisible(page, state, entity.layerId)))
        throw new Error('Shape Builder needs visible, unlocked, ungrouped lines or shapes on the same layer.');
      setSession({ tab, pageId: page.id, sources, selectionIds: [...ids], snapshot: layoutShapeBuildSnapshot(sources), regions: [], busy: true });
      setGestures([]); setRedo([]); setPending(null); drag.current = null;
      setMode('add'); setKeepOriginals(false); setHover([]); setShift(false);
      return true;
    } catch (error) { onError(error instanceof Error ? error.message : 'Cannot start Shape Builder.'); return false; }
  };

  useEffect(() => {
    if (!session?.busy || !active) return;
    // Yield a frame for the busy feedback; cleanup prevents stale work from applying.
    const task = setTimeout(() => {
      try {
        const regions = createLayoutShapeRegions(session.sources);
        setSession(current => current?.snapshot === session.snapshot ? { ...current, regions, busy: false } : current);
      } catch (error) {
        setSession(null);
        callbacks.current.onExit(session.selectionIds);
        callbacks.current.onError(error instanceof Error ? error.message : 'Cannot partition selected shapes.');
      }
    }, 0);
    return () => clearTimeout(task);
  }, [session, active]);

  useEffect(() => {
    if (!session) return;
    const sourceIds = new Set(session.sources.map(source => source.id));
    const sources = state.layerOrder.flatMap(layerId => entitiesForLayer(page, state, layerId)).filter(source => sourceIds.has(source.id));
    const invalid = session.tab !== tab || session.pageId !== page.id || sources.some(source => !source || source.hidden || source.locked ||
      state.layers.get(source.layerId)?.locked || !isLayoutLayerVisible(page, state, source.layerId)) ||
      layoutShapeBuildSnapshot(sources as LayoutEntity[]) !== session.snapshot;
    if (!active || invalid) {
      setSession(null); setPending(null); drag.current = null;
      if (active) {
        callbacks.current.onExit(session.tab === tab && session.pageId === page.id ? session.selectionIds : []);
        callbacks.current.onError('Shape Builder cancelled because its sources or page changed.');
      }
    }
  }, [session, active, page, state, tab]);

  useEffect(() => {
    if (!active) return;
    const update = (event: KeyboardEvent) => { if (event.key === 'Shift') setShift(event.shiftKey); };
    const reset = () => setShift(false);
    window.addEventListener('keydown', update); window.addEventListener('keyup', update); window.addEventListener('blur', reset);
    return () => { window.removeEventListener('keydown', update); window.removeEventListener('keyup', update); window.removeEventListener('blur', reset); };
  }, [active]);

  const result = useMemo(() => session && !session.busy
    ? replayLayoutShapeBuild(session.regions, pending ? [...gestures, pending] : gestures)
    : null, [session, gestures, pending]);

  const pointer = (point: Point, pressed: boolean, heldShift: boolean): void => {
    if (!session || session.busy) return;
    setShift(heldShift);
    const current = drag.current;
    if (pressed && current) {
      const visited = layoutShapeRegionsAlong(session.regions, current.point, point);
      const keys = [...new Set([...current.gesture.regions, ...visited])];
      current.point = point;
      if (keys.length !== current.gesture.regions.length) {
        current.gesture = { ...current.gesture, regions: keys }; setPending(current.gesture);
      }
    }
    setHover(layoutShapeRegionsAlong(session.regions, point, point));
  };
  const down = (point: Point, heldShift: boolean): void => {
    if (!session || session.busy) return;
    const gesture: LayoutShapeBuildGesture = { mode: heldShift ? mode === 'add' ? 'remove' : 'add' : mode,
      regions: layoutShapeRegionsAlong(session.regions, point, point) };
    drag.current = { point, gesture }; setPending(gesture); setShift(heldShift);
  };
  const up = (point: Point, heldShift: boolean): void => {
    if (!drag.current) return;
    pointer(point, true, heldShift);
    const gesture = drag.current.gesture;
    if (gesture.regions.length) {
      const before = replayLayoutShapeBuild(session!.regions, gestures);
      const after = replayLayoutShapeBuild(session!.regions, [...gestures, gesture]);
      if (JSON.stringify(before) !== JSON.stringify(after)) { setGestures([...gestures, gesture]); setRedo([]); }
    }
    drag.current = null; setPending(null);
  };
  const cancelPointer = (): void => { drag.current = null; setPending(null); };
  const cancel = (): void => {
    const ids = session?.selectionIds ?? [];
    setSession(null); cancelPointer(); onExit(ids);
  };
  const apply = (): void => {
    if (!session || session.busy || !gestures.length || pending) return;
    const patches: { forward: object; inverse: object }[] = [];
    const unsubscribe = tab.doc.events.on('change', event => {
      if (event.source === 'transact') patches.push({ forward: event.patches, inverse: event.inversePatches });
    });
    try {
      const ids = tab.commands.execute('layout.shape.build', { pageId: session.pageId,
        entityIds: session.sources.map(source => source.id), sourceSnapshot: session.snapshot, gestures, keepOriginals }) as number[];
      for (const patch of patches) {
        historySelections.current.set(patch.forward, { pageId: session.pageId, ids });
        historySelections.current.set(patch.inverse, { pageId: session.pageId, ids: session.selectionIds });
      }
      setSession(null); onExit(ids);
    } catch (error) { onError(error instanceof Error ? error.message : 'Cannot apply Shape Builder.'); }
    finally { unsubscribe(); }
  };
  const keyDown = (event: KeyboardEvent): boolean => {
    if (!active) return false;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && /^[zy]$/i.test(event.key)) {
      cancelPointer();
      if (event.shiftKey || event.key.toLowerCase() === 'y') {
        const next = redo.at(-1);
        if (next) { setGestures([...gestures, next]); setRedo(redo.slice(0, -1)); }
      } else {
        const last = gestures.at(-1);
        if (last) { setRedo([...redo, last]); setGestures(gestures.slice(0, -1)); }
      }
    } else if (event.key === 'Enter') apply();
    else if (event.key === 'Escape') cancel();
    else if (event.key !== 'Delete' && event.key !== 'Backspace') return false;
    event.preventDefault(); return true;
  };
  return { session, result, mode, setMode, keepOriginals, setKeepOriginals, hover,
    effectiveMode: pending?.mode ?? (shift ? mode === 'add' ? 'remove' : 'add' : mode),
    canApply: Boolean(session && !session.busy && gestures.length && !pending),
    start, down, pointer, up, leave: () => setHover([]), cancelPointer, cancel, apply, keyDown };
}
