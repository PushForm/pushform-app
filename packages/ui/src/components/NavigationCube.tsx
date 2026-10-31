// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef, useState } from 'react';
import type { JSX, PointerEvent as ReactPointerEvent } from 'react';
import type { CameraState } from '@pushform/commands';
import { useApp } from '../AppContext';
import { useAppStore } from '../store';
import {
  NAV_CUBE_DRAG_PX,
  NAV_CUBE_SCALE,
  NAV_CUBE_SIZE,
  navCubeFill,
  navCubePicture,
  navCubeRegion,
  navCubeTurn,
  navCubeView,
} from '../engine/navCube';
import type { NavCubeTurn } from '../engine/navCube';

const HALF = NAV_CUBE_SIZE / 2;
/** Arrow triangles beyond the cube's four sides, in widget px. */
const ARROWS: readonly { turn: NavCubeTurn; label: string; points: string }[] = [
  { turn: 'up', label: 'Turn up', points: `${HALF},3 ${HALF - 7},12 ${HALF + 7},12` },
  { turn: 'down', label: 'Turn down', points: `${HALF},${NAV_CUBE_SIZE - 3} ${HALF - 7},${NAV_CUBE_SIZE - 12} ${HALF + 7},${NAV_CUBE_SIZE - 12}` },
  { turn: 'left', label: 'Turn left', points: `3,${HALF} 12,${HALF - 7} 12,${HALF + 7}` },
  { turn: 'right', label: 'Turn right', points: `${NAV_CUBE_SIZE - 3},${HALF} ${NAV_CUBE_SIZE - 12},${HALF - 7} ${NAV_CUBE_SIZE - 12},${HALF + 7}` },
];

interface Press {
  readonly start: readonly [number, number];
  readonly pointerId: number;
  dragging: boolean;
}

/**
 * The navigation cube in the viewport's top right corner: click a face, edge or corner to look at
 * it, click an arrow to turn 45°, drag the cube to orbit the model. Hidden by View › Navigation Cube.
 */
export function NavigationCube(): JSX.Element | null {
  const app = useApp();
  const visible = useAppStore((s) => s.navigationCube);
  const [cam, setCam] = useState<CameraState>(() => app.viewport.camera.getState());
  const [hover, setHover] = useState<string | null>(null);
  const press = useRef<Press | null>(null);

  useEffect(() => {
    setCam(app.viewport.camera.getState());
    return app.viewport.events.on('cameraChanged', (s) => setCam(s));
  }, [app]);

  // A press that travels more than a few pixels orbits the model until the button is released.
  useEffect(() => {
    const camera = app.viewport.camera;
    const onMove = (e: PointerEvent) => {
      const p = press.current;
      if (!p || e.pointerId !== p.pointerId) return;
      const screen: [number, number] = [e.clientX, e.clientY];
      if (!p.dragging) {
        if (Math.hypot(screen[0] - p.start[0], screen[1] - p.start[1]) < NAV_CUBE_DRAG_PX) return;
        p.dragging = true;
        camera.orbitStart(p.start, { pivot: camera.defaultPivot() });
      }
      camera.orbitDrag(screen);
    };
    const onUp = (e: PointerEvent) => {
      const p = press.current;
      if (!p || e.pointerId !== p.pointerId) return;
      if (p.dragging) camera.orbitEnd();
      // Keep the press until the click event has been seen, so a drag does not also activate a region.
      setTimeout(() => { if (press.current === p) press.current = null; }, 0);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [app]);

  if (!visible) return null;
  const { cells, labels } = navCubePicture(cam);
  const camera = app.viewport.camera;

  const onPointerDown = (e: ReactPointerEvent<SVGElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    press.current = { start: [e.clientX, e.clientY], pointerId: e.pointerId, dragging: false };
  };
  const activate = (regionId: string) => {
    if (press.current?.dragging) return;
    const region = navCubeRegion(regionId);
    if (region) camera.setState(navCubeView(camera.getState(), region));
  };
  const turn = (t: NavCubeTurn) => camera.setState(navCubeTurn(camera.getState(), t));
  const fmt = (n: number) => n.toFixed(4);

  return (
    <div className="pf-nav-cube" data-testid="nav-cube" onPointerLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${NAV_CUBE_SIZE} ${NAV_CUBE_SIZE}`} aria-label="Navigation cube" role="group">
        <g transform={`translate(${HALF} ${HALF}) scale(${NAV_CUBE_SCALE})`}>
          {cells.map((c, i) => (
            <polygon
              key={`${c.face.id}:${i}`}
              className="pf-nav-cube-cell"
              role="button"
              aria-label={c.region.label}
              data-region={c.region.id}
              points={c.points.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(' ')}
              fill={navCubeFill(c.facing, hover === c.region.id)}
              stroke="#1f2328"
              strokeWidth={c.region.kind === 'face' ? 0.6 : 0.3}
              strokeOpacity={c.region.kind === 'face' ? 0.9 : 0.25}
              vectorEffect="non-scaling-stroke"
              onPointerEnter={() => setHover(c.region.id)}
              onPointerDown={onPointerDown}
              onClick={() => activate(c.region.id)}
            />
          ))}
          {labels.map((l) => (
            <text key={l.face.id} className="pf-nav-cube-label" transform={`matrix(${l.matrix.map(fmt).join(' ')})`}>
              {l.text}
            </text>
          ))}
        </g>
        {ARROWS.map((a) => (
          <polygon
            key={a.turn}
            className="pf-nav-cube-arrow"
            role="button"
            aria-label={a.label}
            points={a.points}
            onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
            onClick={() => turn(a.turn)}
          />
        ))}
      </svg>
    </div>
  );
}
