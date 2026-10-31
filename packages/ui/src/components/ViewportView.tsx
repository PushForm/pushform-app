// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef } from 'react';
import type { JSX } from 'react';
import type { Modifiers, ToolPointerEvent } from '@pushform/commands';
import { GROUND_PLANE, freeInference, hitSelectable } from '@pushform/inference';
import { ContextMenuHost } from './ContextMenu';
import { DialogHost } from './MakeComponentDialog';
import { NavigationCube } from './NavigationCube';
import { SceneTabs } from './SceneTabs';
import type { InferenceResult } from '@pushform/inference';
import { useApp } from '../AppContext';
import { useAppStore } from '../store';
import { viewAxesOf } from '../engine/viewAxes';

const modifiersOf = (e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): Modifiers => ({
  shift: e.shiftKey,
  ctrl: e.ctrlKey,
  alt: e.altKey,
  meta: e.metaKey,
});

/** Mounts the render Viewport and forwards pointer/wheel events to the ToolManager. */
export function ViewportView(): JSX.Element {
  const app = useApp();
  const ref = useRef<HTMLDivElement>(null);
  const activeToolId = useAppStore((s) => s.activeToolId);
  const hint = useAppStore((s) => s.cursorHint);
  const pointer = useRef<[number, number]>([0, 0]);
  const cursor = (activeToolId && app.toolManager.get(activeToolId)?.cursor) || 'default';

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    app.viewport.mount(el);
    el.focus();

    const toEvent = (e: PointerEvent | MouseEvent, button: number, withPick: boolean): ToolPointerEvent => {
      const rect = el.getBoundingClientRect();
      const screen: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
      pointer.current = screen;
      const ray = app.viewport.screenToRay(screen[0], screen[1]);
      let inference: InferenceResult | null = null;
      if (withPick) {
        const tool = app.toolManager.activeTool;
        const opts = tool?.inferenceOptions?.() ?? {};
        try {
          inference = app.inference.resolve(
            { ray, screen, pixelSizeAt: app.viewport.pixelSizeAlong(ray), project: (p) => app.viewport.project(p), view: viewAxesOf(app.viewport.camera.getState(), rect.width, rect.height) },
            opts,
          );
        } catch {
          const picked = app.viewport.pick(screen);
          inference = picked ? freeInference(picked, GROUND_PLANE) : null;
        }
      }
      return {
        screen,
        ray,
        button,
        buttons: e.buttons,
        modifiers: modifiersOf(e),
        inference,
        camera: app.viewport.camera.getState(),
      };
    };

    const onPointerDown = (e: PointerEvent) => {
      el.focus();
      el.setPointerCapture(e.pointerId);
      if (e.button === 1) e.preventDefault();
      app.toolManager.pointerDown(toEvent(e, e.button, true));
    };
    const onPointerMove = (e: PointerEvent) => app.toolManager.pointerMove(toEvent(e, -1, e.buttons === 0));
    const onPointerUp = (e: PointerEvent) => {
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      app.toolManager.pointerUp(toEvent(e, e.button, true));
    };
    const onClick = (e: MouseEvent) => app.toolManager.click(toEvent(e, e.button, true));
    const onDblClick = (e: MouseEvent) => app.toolManager.doubleClick(toEvent(e, e.button, true));
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const deltaY = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      app.toolManager.wheel({ screen: [e.clientX - rect.left, e.clientY - rect.top], deltaY, modifiers: modifiersOf(e) });
    };
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      const ev = toEvent(e, 2, true);
      const hit = ev.inference?.hit ?? null;
      app.commands.tryExecute('ui.contextMenu.open', { x: e.clientX, y: e.clientY, refs: hit ? [hitSelectable(hit)] : [] });
    };

    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerUp);
    el.addEventListener('click', onClick);
    el.addEventListener('dblclick', onDblClick);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('contextmenu', onContextMenu);
    return () => {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerUp);
      el.removeEventListener('click', onClick);
      el.removeEventListener('dblclick', onDblClick);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('contextmenu', onContextMenu);
      app.viewport.unmount();
    };
  }, [app]);

  const hintPos = hint?.screen ?? pointer.current;
  return (
    <div className="pf-viewport-wrap">
      <SceneTabs />
      <div ref={ref} className="pf-viewport" tabIndex={0} style={{ cursor }} aria-label="3D viewport" />
      <NavigationCube />
      <DialogHost />
      <ContextMenuHost />
      {hint ? (
        <div className="pf-cursor-hint" style={{ left: hintPos[0] + 14, top: hintPos[1] + 18 }}>
          {hint.text}
        </div>
      ) : null}
    </div>
  );
}
