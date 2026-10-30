// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it, vi } from 'vitest';
import type { Box3 } from '@pushform/core';
import { CommandRegistry } from '../registry/CommandRegistry';
import { DocumentHost } from '../host/DocumentHost';
import { SERVICE_DOCUMENT } from '../host/services';
import { sketchCommands } from '../commands/sketch';
import { cameraCommands } from './cameraCommands';
import type { CameraHost } from './CameraHost';

function fakeCamera(zoomBox?: (box: Box3) => void): CameraHost {
  return {
    getState: () => ({ eye: [0, -10, 0], target: [0, 0, 0], up: [0, 0, 1], fov: 35, projection: 'perspective', orthoHeight: 10 }),
    setState: () => undefined,
    viewportSize: () => ({ width: 800, height: 600 }),
    screenToRay: () => ({ origin: [0, 0, 0], dir: [0, 1, 0] }),
    pick: () => null,
    sceneBounds: () => null,
    orbitStart: () => undefined,
    orbitDrag: () => undefined,
    orbitEnd: () => undefined,
    panStart: () => undefined,
    panDrag: () => undefined,
    panEnd: () => undefined,
    zoomAt: () => undefined,
    zoomExtents: () => undefined,
    ...(zoomBox ? { zoomBox } : {}),
    zoomWindow: () => undefined,
    standardView: () => undefined,
    setProjection: () => undefined,
    setFov: () => undefined,
    setFocalLength: () => undefined,
    previousView: () => false,
    nextView: () => false,
  };
}

function setup(camera: CameraHost) {
  const host = new DocumentHost();
  const registry = new CommandRegistry({ tx: host, camera, services: new Map([[SERVICE_DOCUMENT, host]]) });
  registry.registerAll(sketchCommands);
  registry.registerAll(cameraCommands);
  return { host, registry };
}

describe('camera.zoomSelection', () => {
  it('frames the bounds of the selection, and is available only with a selection', () => {
    const zoomBox = vi.fn<(box: Box3) => void>();
    const { host, registry } = setup(fakeCamera(zoomBox));
    registry.execute('sketch.rectangle', { a: [1, 2, 0], b: [4, 2, 0], c: [4, 3, 0], d: [1, 3, 0] });
    registry.execute('sketch.rectangle', { a: [10, 10, 0], b: [11, 10, 0], c: [11, 11, 0], d: [10, 11, 0] });
    expect(registry.isEnabled('camera.zoomSelection')).toBe(false);
    const face = [...host.doc.rootDefinition.entities.sketch.faces.keys()][0]!;
    host.selection.set([{ kind: 'sketchFace', path: [], id: face }]);
    expect(registry.isEnabled('camera.zoomSelection')).toBe(true);
    expect(registry.execute('camera.zoomSelection')).toBe(true);
    expect(zoomBox).toHaveBeenCalledWith({ min: [1, 2, 0], max: [4, 3, 0] });
    expect(registry.list().find((c) => c.id === 'camera.zoomSelection')).toMatchObject({ title: 'Zoom Selection' });
  });

  it('is unavailable without a camera that can frame a box', () => {
    const { host, registry } = setup(fakeCamera());
    registry.execute('sketch.rectangle', { a: [0, 0, 0], b: [1, 0, 0], c: [1, 1, 0], d: [0, 1, 0] });
    host.selection.set([{ kind: 'sketchFace', path: [], id: [...host.doc.rootDefinition.entities.sketch.faces.keys()][0]! }]);
    expect(registry.isEnabled('camera.zoomSelection')).toBe(false);
  });
});
