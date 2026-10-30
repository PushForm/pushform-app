// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef, useState } from 'react';
import type { JSX, MouseEvent } from 'react';
import { useApp } from '../AppContext';
import { useDocumentState, useSceneRuntime } from '../hooks/useDocument';
import { THUMB_H, THUMB_W } from '../panels/ScenesPanel';
import { useAppStore } from '../store';

interface TabMenu {
  readonly sceneId: number | null;
  readonly x: number;
  readonly y: number;
}

/**
 * Scene tabs strip above the viewport: one tab per scene in `sceneOrder`; click
 * activates it (animated), right-click opens Update / Delete / Move Left / Move Right / Add.
 * Renders nothing while the document has no scenes.
 */
export function SceneTabs(): JSX.Element | null {
  const app = useApp();
  const state = useDocumentState();
  const runtime = useSceneRuntime();
  const [menu, setMenu] = useState<TabMenu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const run = (id: string, params?: unknown) => app.commands.tryExecute(id, params);
  /** Run and return a numeric result (new entity id), or undefined on failure. */
  const runId = (id: string, params?: unknown): number | undefined => {
    const r = app.commands.tryExecute(id, params);
    return r.ok && typeof r.result === 'number' ? r.result : undefined;
  };

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onDown = (e: globalThis.MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [menu]);

  const scenes = state.sceneOrder.map((id) => state.scenes.get(id)).filter((s): s is NonNullable<typeof s> => !!s);
  if (scenes.length === 0) return null;

  const capture = (id: number) => {
    void app.viewport.captureThumbnail(THUMB_W, THUMB_H).then((url) => {
      if (url) useAppStore.getState().setSceneThumbnail(id, url);
    });
  };
  const openMenu = (e: MouseEvent, sceneId: number | null) => {
    e.preventDefault();
    const host = (e.currentTarget as HTMLElement).closest('.pf-scene-tabs') as HTMLElement | null;
    const rect = host?.getBoundingClientRect();
    setMenu({ sceneId, x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) });
  };
  const menuScene = menu?.sceneId !== null && menu?.sceneId !== undefined ? state.scenes.get(menu.sceneId as never) : undefined;
  const menuIndex = menuScene ? state.sceneOrder.indexOf(menuScene.id) : -1;
  const act = (fn: () => void) => {
    setMenu(null);
    fn();
  };

  return (
    <div className="pf-scene-tabs" role="tablist" aria-label="Scenes" onContextMenu={(e) => openMenu(e, null)}>
      {scenes.map((s) => {
        const active = s.id === runtime.activeSceneId;
        return (
          <button
            key={s.id}
            type="button"
            role="tab"
            data-guidance-id={`scene:${s.id}`}
            aria-selected={active}
            className={`pf-scene-tab${active ? ' is-active' : ''}`}
            title={s.description || s.name}
            onClick={() => run('scene.activate', { id: s.id, animate: true })}
            onContextMenu={(e) => {
              e.stopPropagation();
              openMenu(e, s.id);
            }}
          >
            {s.name}
          </button>
        );
      })}
      {menu ? (
        <div ref={menuRef} className="pf-ctxmenu pf-scene-tab-menu" role="menu" aria-label="Scene tab menu" style={{ left: menu.x, top: menu.y }}>
          {menuScene ? (
            <>
              <div className="pf-ctxmenu-item" role="none">
                <button
                  type="button"
                  className="pf-ctxmenu-btn"
                  role="menuitem"
                  onClick={() =>
                    act(() => {
                      run('scene.update', { id: menuScene.id });
                      capture(menuScene.id);
                    })
                  }
                >
                  <span>Update</span>
                </button>
              </div>
              <div className="pf-ctxmenu-item" role="none">
                <button
                  type="button"
                  className="pf-ctxmenu-btn"
                  role="menuitem"
                  onClick={() =>
                    act(() => {
                      run('scene.delete', { id: menuScene.id });
                      useAppStore.getState().setSceneThumbnail(menuScene.id, null);
                    })
                  }
                >
                  <span>Delete</span>
                </button>
              </div>
              <div className="pf-ctxmenu-item has-separator" role="none">
                <button
                  type="button"
                  className="pf-ctxmenu-btn"
                  role="menuitem"
                  disabled={menuIndex <= 0}
                  onClick={() => act(() => run('scene.move', { id: menuScene.id, toIndex: menuIndex - 1 }))}
                >
                  <span>Move Left</span>
                </button>
              </div>
              <div className="pf-ctxmenu-item" role="none">
                <button
                  type="button"
                  className="pf-ctxmenu-btn"
                  role="menuitem"
                  disabled={menuIndex < 0 || menuIndex >= scenes.length - 1}
                  onClick={() => act(() => run('scene.move', { id: menuScene.id, toIndex: menuIndex + 1 }))}
                >
                  <span>Move Right</span>
                </button>
              </div>
            </>
          ) : null}
          <div className={`pf-ctxmenu-item${menuScene ? ' has-separator' : ''}`} role="none">
            <button
              type="button"
              className="pf-ctxmenu-btn"
              role="menuitem"
              onClick={() =>
                act(() => {
                  const id = runId('scene.add');
                  if (typeof id === 'number') capture(id);
                })
              }
            >
              <span>Add</span>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
