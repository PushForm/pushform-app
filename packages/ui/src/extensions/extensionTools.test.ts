// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import { toolViewSchema, type ToolSource, type ToolStopReason } from '@pushform/extension-protocol';
import type { ExtensionToolViewport } from '@pushform/extensions';
import { NO_MODIFIERS, type ToolPointerEvent } from '@pushform/commands';
import { asId, type FaceLocalId } from '@pushform/core';
import { createApp, type AppInstance } from '../bootstrap';
import type { DocumentSession } from '../session';
import { sessionExtensionTools } from './extensionTools';

const apps: AppInstance[] = [];
afterEach(() => { for (const app of apps.splice(0)) app.dispose(); });
function setup() {
  const app = createApp({ demo: false, expose: false, kernel: new KernelClient(new InlineBackend()) }); apps.push(app);
  vi.spyOn(app.viewport.camera, 'viewportSize').mockReturnValue({ width: 800, height: 600 });
  const tab = { id: 'model-A', type: 'model', app }, listeners = new Set<() => void>();
  const session = { active: tab, activeId: tab.id, subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); } };
  const tools = sessionExtensionTools(() => session as unknown as DocumentSession);
  const inputs: ToolSource[] = [], stopped: ToolStopReason[] = [];
  let view: ExtensionToolViewport;
  const open = (id = 'tool-A') => view = tools.open({ documentId: tab.id, id, title: 'Draw part', input: input => inputs.push(input), ended: reason => { stopped.push(reason); view.close(reason); } });
  return { app, session, tools, inputs, stopped, listeners, open, switchModel: () => { session.activeId = 'model-B'; for (const listener of [...listeners]) listener(); } };
}
function pointer(app: AppInstance): ToolPointerEvent {
  const ref = { kind: 'face' as const, id: asId(42), path: [], faceId: 7 as FaceLocalId, region: null };
  return { screen: [400, 150], ray: { origin: [0, 0, 1], dir: [0, 0, -1] }, button: 0, buttons: 1, modifiers: NO_MODIFIERS, camera: app.viewport.camera.getState(),
    inference: { point: [1, 2, 3], primary: { kind: 'onFace', point: [1, 2, 3], ref, plane: { n: [0, 0, 1], d: 3 }, color: '#ffffff', label: 'On face' },
      secondary: [], lines: [], lockedAxis: null, tooltip: '', plane: { n: [0, 0, 1], d: 3 }, hit: { ref, point: [1, 2, 3], normal: [0, 0, 1], t: 1, screenDist: 0 } } };
}
describe('model viewport extension tools', () => {
  it('uses native resolved snaps and converts normalized overlays without modifying geometry', () => {
    const s = setup(), version = s.app.document.doc.version, viewport = s.open();
    viewport.present(toolViewSchema.parse({ instructor: 'Choose a corner', measurement: { label: 'Width', kinds: ['length'] }, pending: true,
      inference: { anchor: [0, 0, 0], plane: { normal: [0, 0, 1], offset: 3 }, lockAxis: 'x', ignore: [{ kind: 'face', id: 42, path: [], faceId: 7 }] },
      overlay: [{ kind: 'screenRect', a: [0.25, 0.25], b: [0.5, 0.5], color: '#123456' }] }));
    expect(s.app.toolManager.overlay()).toEqual([{ kind: 'screenRect', a: [200, 150], b: [400, 300], color: '#123456' }]);
    expect(s.app.toolManager.activeTool?.inferenceOptions?.()).toMatchObject({ plane: { n: [0, 0, 1], d: 3 }, ignore: [{ kind: 'face', faceId: 7, region: null }] });
    s.app.toolManager.pointerDown(pointer(s.app));
    expect(s.inputs).toMatchObject([{ kind: 'pointerDown', data: { screen: [0.5, 0.25], point: [1, 2, 3], snap: { kind: 'onFace', ref: { faceId: 7 }, plane: { normal: [0, 0, 1], offset: 3 } }, hit: { normal: [0, 0, 1] } } }]);
    expect(s.app.document.doc.version).toBe(version);
    viewport.close('ended'); expect(s.listeners.size).toBe(0);
  });
  it('suspends for native camera navigation, invalidates stale overlays and delivers raw expressions', () => {
    const s = setup(), viewport = s.open();
    const ready = toolViewSchema.parse({ instructor: 'Width', pending: true, keys: ['ArrowRight'], overlay: [{ kind: 'point', position: [0, 0, 0], shape: 'circle', color: '#123456' }] });
    viewport.present(ready);
    expect(s.app.toolManager.keyDown({ key: 'ArrowRight', code: 'ArrowRight', repeat: false, modifiers: NO_MODIFIERS })).toBe(true);
    expect(s.app.toolManager.keyDown({ key: 'ArrowRight', code: 'ArrowRight', repeat: false, modifiers: { ...NO_MODIFIERS, ctrl: true } })).toBe(false);
    s.app.toolManager.activate('orbit'); expect(s.inputs.at(-1)?.kind).toBe('suspend');
    const stamp = viewport.stamp(); s.app.viewport.events.emit('cameraChanged', s.app.viewport.camera.getState());
    expect(viewport.stamp().cameraVersion).toBe(stamp.cameraVersion + 1); expect(s.inputs.at(-1)?.kind).toBe('resync');
    expect(s.app.toolManager.overlay()).toEqual([]);
    expect(s.app.toolManager.onRawVcb('@+10mm', 'mm')).toBe(true);
    expect(s.inputs.at(-1)).toEqual({ kind: 'measurement', data: { text: '@+10mm', defaultUnit: 'mm' } });
    s.app.toolManager.cancel(); expect(s.app.toolManager.activeToolId).toBe('tool-A'); expect(s.inputs.at(-1)?.kind).toBe('resume');
    viewport.present(ready); expect(s.app.toolManager.overlay()).toHaveLength(1);
    s.app.toolManager.cancel(); expect(s.stopped).toEqual(['cancelled']); expect(s.app.toolManager.activeToolId).toBe('select');
    viewport.present(ready); expect(s.app.toolManager.overlay()).toEqual([]); expect(s.app.toolManager.get('tool-A')).toBeUndefined();
  });
  it('replaces tools and releases their input listeners when the active model changes', () => {
    const s = setup(); s.open(); s.open('tool-B');
    expect(s.stopped).toEqual(['replaced']); expect(s.app.toolManager.list().filter(tool => tool.id.startsWith('tool-')).map(tool => tool.id)).toEqual(['tool-B']);
    s.switchModel(); expect(s.stopped).toEqual(['replaced', 'replaced']); expect(s.listeners.size).toBe(0);
    expect(s.app.toolManager.activeToolId).toBe('select');
    expect(() => s.tools.open({ documentId: 'another-model', id: 'bad', title: 'Bad', input() {}, ended() {} })).toThrow(/active model/);
  });
});


it('maps extension choices to the current host settings interface and delivers changes', () => {
  const s = setup(), viewport = s.open();
  viewport.present(toolViewSchema.parse({ instructor: 'Capture grain group', pending: true,
    choices: [{ id: 'source', label: 'Group from', value: 'selection', options: [{ value: 'selection', label: 'Selection' }, { value: 'assembly', label: 'Assembly' }] }],
    fields: [{ id: 'name', label: 'Group name', kind: 'text', value: '', placement: 'options' }] }));
  expect(s.app.toolManager.status()).toMatchObject({ placing: false, settings: [{ kind: 'choice', id: 'source', display: 'menu' }] });
  s.app.toolManager.setting('source', 'assembly');
  expect(s.inputs.at(-1)).toEqual({ kind: 'choice', data: { id: 'source', value: 'assembly' } });
  viewport.close('ended');
});
