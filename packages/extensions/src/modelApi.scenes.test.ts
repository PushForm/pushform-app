// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import {
  CommandRegistry, DocumentHost, SERVICE_DOCUMENT, SERVICE_KERNEL, editCommands, groupCommands, modelCommands, sceneCommands, sceneRuntimeOf,
  type CameraHost, type CameraState,
} from '@pushform/commands';
import { MODEL_TOOLS, type ModelBatchResult, type ModelViewResult } from '@pushform/extension-protocol';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import { ModelApiFailure, ModelDocumentApi, runModelTool } from './modelApi';
import { frameCamera } from './modelCamera';

const kernels: KernelClient[] = [];
afterEach(() => { for (const kernel of kernels.splice(0)) kernel.dispose(); });

const START: CameraState = { eye: [10, -10, 5], target: [0, 0, 0], up: [0, 0, 1], fov: 35, projection: 'perspective', orthoHeight: 10 };

/** The parts of a viewport the model API uses: state, size and drawable bounds. */
function fakeCamera(width = 1600, height = 900): CameraHost & { state: CameraState; history: number } {
  const camera = {
    state: START, history: 0,
    getState: () => camera.state,
    setState: (state: CameraState, history = true) => { camera.state = state; if (history) camera.history++; },
    viewportSize: () => ({ width, height }),
    sceneBounds: () => null,
  };
  return camera as unknown as CameraHost & { state: CameraState; history: number };
}

function setup(options: { camera?: boolean } = {}) {
  const host = new DocumentHost();
  const kernel = new KernelClient(new InlineBackend());
  kernels.push(kernel);
  const camera = options.camera === false ? undefined : fakeCamera();
  const commands = new CommandRegistry({ tx: host, ...(camera ? { camera } : {}), services: new Map<string, unknown>([[SERVICE_DOCUMENT, host], [SERVICE_KERNEL, kernel]]) });
  for (const group of [editCommands, modelCommands, groupCommands, sceneCommands]) commands.registerAll(group);
  sceneRuntimeOf(commands.ctx).raf = null;
  const api = new ModelDocumentApi(commands, 'AI Chat');
  const apply = (operations: unknown[]) => api.apply({ expectedRevision: api.revision, label: 'Scenes', operations });
  const addBox = (min: [number, number, number], max: [number, number, number]): number => commands.execute('model.addBox', { min, max }) as number;
  return { host, commands, api, apply, camera, addBox };
}
async function failure(run: () => unknown): Promise<ModelApiFailure> {
  try { await run(); } catch (error) { if (error instanceof ModelApiFailure) return error; throw error; }
  throw new Error('expected a ModelApiFailure');
}
const forward = (c: { eye: readonly number[]; target: readonly number[] }) => {
  const d = [0, 1, 2].map(i => c.target[i]! - c.eye[i]!);
  const length = Math.hypot(...d);
  return d.map(x => x / length);
};

describe('scene operations', () => {
  it('adds scenes with the current view or a framed camera, and reads them back', async () => {
    const { api, apply, camera, addBox } = setup();
    addBox([0, 0, 0], [2, 1, 1]);
    const result = await apply([
      { op: 'add_scene', as: 'here', name: 'Overview', saves: { shadows: false } },
      { op: 'add_scene', name: 'Plan', camera: { mode: 'framed', direction: 'top', subject: 'model' }, includeInAnimation: false },
    ]);
    expect(result.results.map(r => r.name)).toEqual(['Overview', 'Plan']);
    expect(camera!.state).toBe(START);
    const { scenes, camera: current, playing } = api.getDocument();
    expect(scenes).toMatchObject([
      { name: 'Overview', index: 0, active: false, includeInAnimation: true, saves: { camera: true, shadows: false, style: true } },
      { name: 'Plan', index: 1, active: true, includeInAnimation: false },
    ]);
    expect(current?.eye).toEqual([10, -10, 5]);
    expect(playing).toBe(false);
    const plan = api.getDocument().scenes[1]!;
    const shown = (await api.apply({ expectedRevision: api.revision, label: 'x', operations: [{ op: 'rename_scene', scene: plan.id, description: 'From above' }] })).results[0];
    expect(shown?.name).toBe('Plan');
    const view = api.view({ action: { type: 'activate_scene', scene: 'plan', animate: false } });
    expect(forward(view.camera)).toEqual([0, 0, -1].map(x => expect.closeTo(x, 6)));
    expect(view.camera.target).toEqual([1, 0.5, 0.5]);
  });

  it('finds scenes by id, name in any case, "active" and "$name", and refuses ambiguous or duplicate names', async () => {
    const { api, apply, commands } = setup();
    await apply([{ op: 'add_scene', name: 'Front' }, { op: 'add_scene', name: 'Back' }]);
    expect((await failure(() => apply([{ op: 'add_scene', name: ' front ' }]))).error).toMatchObject({ code: 'invalid_operation' });
    await apply([{ op: 'rename_scene', scene: 'ACTIVE', name: 'Rear' }, { op: 'move_scene', scene: 'rear', index: 0 }]);
    expect(api.getDocument().scenes.map(s => s.name)).toEqual(['Rear', 'Front']);
    // Scenes from files can share a name; such a name must be given by id.
    commands.execute('scene.add', { name: 'Rear' });
    const ambiguous = await failure(() => apply([{ op: 'delete_scene', scene: 'Rear' }]));
    expect(ambiguous.error.code).toBe('invalid_reference');
    expect(ambiguous.error.message).toMatch(/2 scenes are named "Rear"/);
    expect((await failure(() => apply([{ op: 'delete_scene', scene: 'Side' }]))).error.code).toBe('invalid_reference');
    const made = await apply([{ op: 'add_scene', as: 's', name: 'Temp' }, { op: 'set_scene_animation', scene: '$s', include: false }, { op: 'delete_scene', scene: '$s' }]);
    expect(made.results.map(r => r.op)).toEqual(['add_scene', 'set_scene_animation', 'delete_scene']);
    expect(api.getDocument().scenes.some(s => s.name === 'Temp')).toBe(false);
  });

  it('is one undo step and changes nothing when an operation fails', async () => {
    const { host, api, apply } = setup();
    await apply([{ op: 'add_scene', name: 'A' }, { op: 'add_scene', name: 'B' }]);
    expect(api.getDocument().scenes).toHaveLength(2);
    host.undoStack.undo();
    expect(api.getDocument().scenes).toHaveLength(0);
    await failure(() => apply([{ op: 'add_scene', name: 'C' }, { op: 'delete_scene', scene: 'Missing' }]));
    expect(api.getDocument().scenes).toHaveLength(0);
  });

  it('updates a scene with a new camera or only its saved properties', async () => {
    const { api, apply, host } = setup();
    await apply([{ op: 'add_scene', name: 'Shot' }]);
    const exact = { mode: 'exact', eye: [0, -20, 2], target: [0, 0, 2], projection: 'parallel', viewHeight: 6 };
    await apply([{ op: 'update_scene', scene: 'Shot', camera: exact }]);
    const saved = [...host.doc.state.scenes.values()][0]!;
    expect(saved.camera).toMatchObject({ eye: [0, -20, 2], target: [0, 0, 2], up: [0, 0, 1], perspective: false, height: 6 });
    await apply([{ op: 'update_scene', scene: 'Shot', recapture: false, saves: { camera: false } }]);
    const updated = [...host.doc.state.scenes.values()][0]!;
    expect(updated.camera.eye).toEqual([0, -20, 2]);
    expect(api.getDocument().scenes[0]!.saves.camera).toBe(false);
  });

  it('needs an exact camera to add or update a scene without a viewport, and has no view tool there', async () => {
    const { api, apply } = setup({ camera: false });
    expect((await failure(() => apply([{ op: 'add_scene', name: 'X' }]))).error.code).toBe('unavailable');
    expect((await failure(() => apply([{ op: 'add_scene', camera: { mode: 'framed' } }]))).error.code).toBe('unavailable');
    await apply([{ op: 'add_scene', name: 'X', camera: { mode: 'exact', eye: [5, 5, 5], target: [0, 0, 0] } }, { op: 'rename_scene', scene: 'X', name: 'Y' }]);
    expect(api.getDocument()).toMatchObject({ scenes: [{ name: 'Y' }], camera: null });
    expect((await failure(() => api.view({ action: { type: 'stop' } }))).error.code).toBe('unavailable');
  });
});

describe('framing and the view tool', () => {
  it('frames entities from a standard view, orbited, in the viewport proportions', async () => {
    const { api, camera, addBox } = setup();
    const near = addBox([0, 0, 0], [1, 1, 1]);
    addBox([20, 20, 0], [21, 21, 1]);
    const result = api.view({ action: { type: 'set_camera', animate: false, camera: { mode: 'framed', direction: 'front', subject: { refs: [{ kind: 'body', id: near }] } } } });
    expect(result.camera.target).toEqual([0.5, 0.5, 0.5]);
    expect(forward(result.camera)).toEqual([0, 1, 0].map(x => expect.closeTo(x, 6)));
    expect(camera!.history).toBe(1);
    const turned = api.view({ action: { type: 'set_camera', animate: false, camera: { mode: 'framed', subject: 'target', orbitDeg: { horizontal: 90, vertical: 30 } } } });
    expect(turned.camera.target).toEqual([0.5, 0.5, 0.5]);
    const f = forward(turned.camera);
    expect(f[0]).toBeCloseTo(-Math.cos(Math.PI / 6));
    expect(f[2]).toBeCloseTo(-0.5);
    expect(Math.hypot(...[0, 1, 2].map(i => turned.camera.eye[i]! - turned.camera.target[i]!))).toBeCloseTo(Math.hypot(...[0, 1, 2].map(i => result.camera.eye[i]! - result.camera.target[i]!)));
    expect((await failure(() => api.view({ action: { type: 'set_camera', camera: { mode: 'framed', subject: 'selection' } } }))).error.code).toBe('invalid_operation');
  });

  it('fits the narrower field of view, and the view height for parallel projection', () => {
    const box = { min: [-1, -1, -1] as [number, number, number], max: [1, 1, 1] as [number, number, number] };
    const wide = frameCamera(START, { view: 'front', horizontalDeg: 0, verticalDeg: 0, box, margin: 0, aspect: 2 });
    const tall = frameCamera(START, { view: 'front', horizontalDeg: 0, verticalDeg: 0, box, margin: 0, aspect: 0.5 });
    const distance = (c: CameraState) => Math.hypot(...[0, 1, 2].map(i => c.eye[i]! - c.target[i]!));
    expect(distance(wide)).toBeCloseTo(Math.sqrt(3) / Math.sin((35 * Math.PI) / 360));
    expect(distance(tall)).toBeGreaterThan(distance(wide));
    const flat = frameCamera(START, { view: 'top', horizontalDeg: 0, verticalDeg: 0, box, margin: 0.1, aspect: 1, projection: 'parallel' });
    expect(flat).toMatchObject({ projection: 'parallel', up: [0, 1, 0] });
    expect(flat.orthoHeight).toBeCloseTo(2 * Math.sqrt(3) * 1.1);
  });

  it('goes to scenes, plays and stops the animation, and an edit stops playback', async () => {
    const { api, apply, commands } = setup();
    expect((await failure(() => api.view({ action: { type: 'next_scene' } }))).error.code).toBe('invalid_operation');
    await apply([{ op: 'add_scene', name: 'One' }, { op: 'add_scene', name: 'Two', includeInAnimation: false }]);
    const next = api.view({ action: { type: 'next_scene' } });
    expect(next.activeScene?.name).toBe('One');
    const playing = api.view({ action: { type: 'play' } });
    expect(playing.playing).toBe(true);
    expect(api.getDocument().playing).toBe(true);
    await apply([{ op: 'rename_scene', scene: 'One', name: 'First' }]);
    expect(sceneRuntimeOf(commands.ctx).playing).toBe(false);
    await apply([{ op: 'set_scene_animation', scene: 'First', include: false }]);
    expect((await failure(() => api.view({ action: { type: 'play' } }))).error.code).toBe('invalid_operation');
    expect(api.view({ action: { type: 'stop' } }).playing).toBe(false);
  });

  it('runs through runModelTool and reports failures as results', async () => {
    const { api } = setup();
    const ok = await runModelTool(api, MODEL_TOOLS.view.name, { action: { type: 'set_camera', camera: { mode: 'exact', eye: [3, 3, 3], target: [0, 0, 0] }, animate: false } });
    expect(ok.isError).toBe(false);
    expect((JSON.parse(ok.content) as ModelViewResult).camera.eye).toEqual([3, 3, 3]);
    const bad = await runModelTool(api, MODEL_TOOLS.view.name, { action: { type: 'activate_scene', scene: 'Nowhere' } });
    expect(bad.isError).toBe(true);
    expect((JSON.parse(bad.content) as { error: { code: string } }).error.code).toBe('invalid_reference');
    const batch = await runModelTool(api, MODEL_TOOLS.applyOperations.name, { expectedRevision: api.revision, label: 'Add', operations: [{ op: 'add_scene', name: 'A' }] });
    expect((JSON.parse(batch.content) as ModelBatchResult).results[0]).toMatchObject({ op: 'add_scene', name: 'A' });
  });
});
