// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type { Box3, Id, Ray, SceneId, TagId, Vec2, Vec3 } from '@pushform/core';
import { CommandRegistry } from '../registry/CommandRegistry';
import { editCommands } from '../registry/editCommands';
import { DocumentHost } from '../host/DocumentHost';
import { MemoryDisplayHost } from '../host/DisplayHost';
import { SERVICE_DISPLAY, SERVICE_DOCUMENT } from '../host/services';
import type { CameraHost, CameraState, Projection, StandardView } from '../camera/CameraHost';
import { modelCommands } from './model';
import { sketchCommands } from './sketch';
import { styleCommands } from './styles';
import { tagCommands } from './tags';
import { shadowCommands } from './shadows';
import { fogCommands } from './fog';
import { sectionPlaneCommands } from './sectionPlanes';
import { SceneRuntime, cameraFromModel, cameraToModel, lerpCamera, sceneCommands, sceneRuntimeOf } from './scenes';

class FakeCamera implements CameraHost {
  state: CameraState = { eye: [10, -10, 10], target: [0, 0, 0], up: [0, 0, 1], fov: 35, projection: 'perspective', orthoHeight: 10 };
  sets: boolean[] = [];
  getState(): CameraState {
    return this.state;
  }
  setState(s: CameraState, history = true): void {
    this.state = s;
    this.sets.push(history);
  }
  viewportSize() {
    return { width: 800, height: 600 };
  }
  screenToRay(): Ray {
    return { origin: [0, 0, 0], dir: [0, 0, -1] };
  }
  pick(_s: Vec2): Vec3 | null {
    return null;
  }
  sceneBounds(): Box3 | null {
    return null;
  }
  orbitStart(): void {}
  orbitDrag(): void {}
  orbitEnd(): void {}
  panStart(): void {}
  panDrag(): void {}
  panEnd(): void {}
  zoomAt(): void {}
  zoomExtents(): void {}
  zoomWindow(): void {}
  standardView(_v: StandardView): void {}
  setProjection(_p: Projection): void {}
  setFov(): void {}
  setFocalLength(): void {}
  previousView(): boolean {
    return false;
  }
  nextView(): boolean {
    return false;
  }
}

function setup() {
  const host = new DocumentHost();
  const camera = new FakeCamera();
  const registry = new CommandRegistry({
    tx: host,
    camera,
    services: new Map<string, unknown>([
      [SERVICE_DOCUMENT, host],
      [SERVICE_DISPLAY, new MemoryDisplayHost()],
    ]),
  });
  for (const list of [editCommands, modelCommands, sketchCommands, styleCommands, tagCommands, shadowCommands, fogCommands, sceneCommands, sectionPlaneCommands]) registry.registerAll(list);
  const runtime = sceneRuntimeOf(registry.ctx);
  runtime.raf = null; // instant camera transitions in tests
  const state = () => host.doc.state;
  return { host, camera, registry, runtime, state };
}

describe('scenes and active section planes', () => {
  it('saves the active cuts and restores them, turning off cuts the scene does not name', () => {
    const { registry, state } = setup();
    const root = () => state().definitions.get(state().rootDefinitionId)!.entities;
    const a = registry.execute('sectionPlane.add', { point: [0, 0, 1], normal: [0, 0, -1] }) as number;
    const withCut = registry.execute('scene.add', { name: 'Cut' }) as number;
    registry.execute('sectionPlane.setActive', { path: [], id: a, active: false });
    const without = registry.execute('scene.add', { name: 'Whole' }) as number;
    registry.execute('scene.activate', { id: withCut, animate: false });
    expect(root().activeSectionPlaneId).toBe(a);
    registry.execute('scene.activate', { id: without, animate: false });
    expect(root().activeSectionPlaneId).toBeNull();
    // a scene that does not use section planes leaves the cut alone
    registry.execute('scene.update', { id: withCut, flags: { useSectionPlanes: false }, recapture: false });
    registry.execute('scene.activate', { id: withCut, animate: false });
    expect(root().activeSectionPlaneId).toBeNull();
  });
});

describe('scene.add captures the view', () => {
  it('stores camera, hidden entities, hidden tags/folders, style, shadows, fog and axes with all flags on', () => {
    const { registry, state, camera, host, runtime } = setup();
    const tag = registry.execute('tag.create', { name: 'T' }) as number;
    registry.execute('tag.setVisible', { ids: [tag], visible: false });
    const folder = registry.execute('tag.folder.create', { name: 'F' }) as number;
    registry.execute('tag.folder.setVisible', { id: folder, visible: false });
    const box = registry.execute('model.addBox') as Id;
    host.doc.transact('hide', (draft) => {
      draft.definitions.get(draft.rootDefinitionId)!.entities.bodies.get(box)!.hidden = true;
    });
    registry.execute('shadows.set', { patch: { enabled: true, time: 600 } });
    registry.execute('fog.set', { patch: { enabled: true, far: 42 } });
    camera.state = { ...camera.state, eye: [1, 2, 3], projection: 'parallel', orthoHeight: 7 };
    const id = registry.execute('scene.add', { name: 'Front' }) as number;
    const scene = state().scenes.get(id as SceneId)!;
    expect(scene.name).toBe('Front');
    expect(state().sceneOrder).toEqual([id]);
    expect(scene.flags).toEqual({ useCamera: true, useHiddenGeometry: true, useHiddenObjects: true, useTags: true, useStyle: true, useShadows: true, useSectionPlanes: true, useAxes: true });
    expect(scene.camera).toMatchObject({ eye: [1, 2, 3], perspective: false, height: 7 });
    expect(scene.hiddenEntities).toEqual([box]);
    expect(scene.hiddenTags).toEqual([tag]);
    expect(scene.hiddenTagFolders).toEqual([folder]);
    expect(scene.styleId).toBe(state().activeStyleId);
    expect(scene.shadows).toMatchObject({ enabled: true, time: 600 });
    expect(scene.fog).toMatchObject({ enabled: true, far: 42 });
    expect(scene.axesVisible).toBe(true);
    expect(runtime.activeSceneId).toBe(id);
    // default names count up
    const id2 = registry.execute('scene.add') as number;
    expect(state().scenes.get(id2 as SceneId)?.name).toBe('Scene 2');
  });
});

describe('scene.activate restores camera, tags, style, shadows', () => {
  it('writes the saved properties back and moves the camera (no undo entry for activation)', () => {
    const { registry, state, camera, host, runtime } = setup();
    const tag = registry.execute('tag.create', { name: 'T' }) as number;
    const styleB = registry.execute('style.create', { name: 'B', activate: false }) as number;
    camera.state = { ...camera.state, eye: [5, 5, 5] };
    const a = registry.execute('scene.add', { name: 'A' }) as number;
    // change everything
    registry.execute('tag.setVisible', { ids: [tag], visible: false });
    registry.execute('style.setActive', { id: styleB });
    registry.execute('shadows.set', { patch: { enabled: true } });
    camera.state = { ...camera.state, eye: [0, -9, 2] };
    const b = registry.execute('scene.add', { name: 'B' }) as number;
    const undoBefore = host.undoStack.length;
    registry.execute('scene.activate', { id: a, animate: false });
    expect(camera.state.eye).toEqual([5, 5, 5]);
    expect(state().tags.get(tag as TagId)?.visible).toBe(true);
    expect(state().activeStyleId).not.toBe(styleB);
    expect(state().shadows.enabled).toBe(false);
    expect(runtime.activeSceneId).toBe(a);
    expect(host.undoStack.length).toBe(undoBefore); // activation is not undoable
    registry.execute('scene.activate', { id: b, animate: false });
    expect(camera.state.eye).toEqual([0, -9, 2]);
    expect(state().tags.get(tag as TagId)?.visible).toBe(false);
    expect(state().activeStyleId).toBe(styleB);
    expect(state().shadows.enabled).toBe(true);
    // flags off → property untouched
    registry.execute('scene.update', { id: a, flags: { useTags: false, useStyle: false }, recapture: false });
    registry.execute('scene.activate', { id: a, animate: false });
    expect(state().tags.get(tag as TagId)?.visible).toBe(false);
    expect(state().activeStyleId).toBe(styleB);
    expect(camera.state.eye).toEqual([5, 5, 5]);
    // next / previous cycle
    expect(registry.execute('scene.next', { animate: false })).toBe(b);
    expect(registry.execute('scene.next', { animate: false })).toBe(a);
    expect(registry.execute('scene.previous', { animate: false })).toBe(b);
  });

  it('camera tween lerps and commits history only at the end', () => {
    const camera = new FakeCamera();
    const runtime = new SceneRuntime();
    let t = 0;
    const frames: Array<(n: number) => void> = [];
    runtime.raf = (cb) => {
      frames.push(cb);
      return frames.length;
    };
    runtime.now = () => t;
    const target: CameraState = { eye: [0, 0, 10], target: [0, 0, 0], up: [0, 0, 1], fov: 35, projection: 'perspective', orthoHeight: 10 };
    runtime.animateCamera(camera, target, 1);
    expect(frames).toHaveLength(1);
    t = 500;
    frames.shift()!(t);
    expect(camera.sets).toEqual([false]);
    expect(camera.state.eye[0]).toBeCloseTo(5, 5);
    t = 1000;
    frames.shift()!(t);
    expect(camera.sets).toEqual([false, true]);
    expect(camera.state.eye).toEqual([0, 0, 10]);
    expect(lerpCamera(camera.state, target, 0.3).projection).toBe('perspective');
    expect(cameraFromModel(cameraToModel(target))).toEqual(target);
  });
});

describe('scene.move / delete / rename / undo', () => {
  it('reorders, deletes and renames scenes undoably', () => {
    const { registry, state, host, runtime } = setup();
    const a = registry.execute('scene.add', { name: 'A' }) as number;
    const b = registry.execute('scene.add', { name: 'B' }) as number;
    const c = registry.execute('scene.add', { name: 'C' }) as number;
    expect(registry.execute('scene.move', { id: c, toIndex: 0 })).toBe(0);
    expect(state().sceneOrder).toEqual([c, a, b]);
    host.undo();
    expect(state().sceneOrder).toEqual([a, b, c]);
    registry.execute('scene.rename', { id: b, name: 'Bee', description: 'd' });
    expect(state().scenes.get(b as SceneId)).toMatchObject({ name: 'Bee', description: 'd' });
    registry.execute('scene.setIncludeInAnimation', { id: b, value: false });
    expect(state().scenes.get(b as SceneId)?.includeInAnimation).toBe(false);
    registry.execute('scene.activate', { id: c, animate: false });
    registry.execute('scene.delete', { id: c });
    expect(state().sceneOrder).toEqual([a, b]);
    expect(state().scenes.has(c as SceneId)).toBe(false);
    expect(runtime.activeSceneId).toBeNull();
    host.undo();
    expect(state().sceneOrder).toEqual([a, b, c]);
    expect(state().scenes.get(c as SceneId)?.name).toBe('C');
    host.undo(); // include in animation
    host.undo(); // rename
    expect(state().scenes.get(b as SceneId)?.name).toBe('B');
    host.undo(); // add C
    host.undo(); // add B
    host.undo(); // add A
    expect(state().scenes.size).toBe(0);
    host.redo();
    expect(state().scenes.size).toBe(1);
    expect(() => registry.execute('scene.delete', { id: 424242 })).toThrow(/not found/);
  });

  it('scene.play cycles through included scenes with the delay and scene.stop ends it', () => {
    const { registry, runtime, state } = setup();
    const a = registry.execute('scene.add', { name: 'A' }) as number;
    const b = registry.execute('scene.add', { name: 'B' }) as number;
    registry.execute('scene.setIncludeInAnimation', { id: b, value: false });
    const c = registry.execute('scene.add', { name: 'C' }) as number;
    runtime.setAnimationSettings({ transitionSeconds: 0, delaySeconds: 0 });
    expect(registry.execute('scene.play')).toBe(true);
    expect(runtime.playing).toBe(true);
    expect(runtime.activeSceneId).toBe(a); // from C, the next included scene wraps to A
    registry.execute('scene.stop');
    expect(runtime.playing).toBe(false);
    expect(state().scenes.has(c as SceneId)).toBe(true);
  });
});
