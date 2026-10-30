// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type { StyleId } from '@pushform/core';
import { CommandRegistry } from '../registry/CommandRegistry';
import { editCommands } from '../registry/editCommands';
import { DocumentHost } from '../host/DocumentHost';
import { MemoryDisplayHost } from '../host/DisplayHost';
import { SERVICE_DISPLAY, SERVICE_DOCUMENT } from '../host/services';
import { viewCommands } from './view';
import { STYLE_PRESETS, displayFromStyle, presetStyle, styleCommands } from './styles';
import { dayOfYear, monthDayOf, shadowCommands } from './shadows';
import { fogCommands, fogOf } from './fog';

function setup() {
  const host = new DocumentHost();
  const display = new MemoryDisplayHost();
  const registry = new CommandRegistry({
    tx: host,
    services: new Map<string, unknown>([
      [SERVICE_DOCUMENT, host],
      [SERVICE_DISPLAY, display],
    ]),
  });
  for (const list of [editCommands, viewCommands, styleCommands, shadowCommands, fogCommands]) registry.registerAll(list);
  const state = () => host.doc.state;
  const active = () => state().styles.get(state().activeStyleId)!;
  return { host, registry, display, state, active };
}

describe('style.* commands', () => {
  it('update patches nested fields, create copies / uses presets, delete and reset', () => {
    const { registry, state, active, host } = setup();
    registry.execute('style.update', { patch: { edges: { profiles: false, profileWidth: 4 }, faces: { mode: 'monochrome' }, background: { sky: false } } });
    expect(active().edges).toMatchObject({ profiles: false, profileWidth: 4, edges: true });
    expect(active().faces.mode).toBe('monochrome');
    expect(active().background.sky).toBe(false);
    expect(() => registry.execute('style.update', { patch: { edges: { profileWidth: 99 } } })).toThrow(/Invalid params/);
    host.undo();
    expect(active().faces.mode).toBe('shadedWithTextures');

    const copy = registry.execute('style.create', { name: 'Copy' }) as number;
    expect(state().activeStyleId).toBe(copy);
    expect(active().name).toBe('Copy');
    const again = registry.execute('style.create', { name: 'Copy', activate: false }) as number;
    expect(state().styles.get(again as StyleId)?.name).toBe('Copy 1');
    expect(state().activeStyleId).toBe(copy);

    for (const p of STYLE_PRESETS) expect(presetStyle(p.name, 1 as StyleId).name).toBe(p.name);
    const hidden = registry.execute('style.usePreset', { name: 'Hidden Line' }) as number;
    expect(active().faces.mode).toBe('hiddenLine');
    expect(registry.execute('style.usePreset', { name: 'Hidden Line' })).toBe(hidden); // created once
    expect(state().styles.size).toBe(4);
    expect(() => registry.execute('style.usePreset', { name: 'Nope' })).toThrow(/preset/);
    const xray = registry.execute('style.usePreset', { name: 'X-ray blueprint' }) as number;
    expect(active().faces.mode).toBe('xray');
    expect(registry.execute('style.list')).toMatchObject({ presets: STYLE_PRESETS.map((p) => p.name) });

    registry.execute('style.setActive', { id: copy });
    registry.execute('style.delete', { id: xray });
    expect(state().styles.has(xray as StyleId)).toBe(false);
    registry.execute('style.delete', { id: copy }); // deleting the active style falls back to another
    expect(state().styles.has(copy as StyleId)).toBe(false);
    expect(state().styles.has(state().activeStyleId)).toBe(true);
    registry.execute('style.update', { patch: { edges: { jitter: true }, name: 'Mine' } });
    registry.execute('style.resetToDefault', {});
    expect(active().edges.jitter).toBe(false);
    expect(active().name).toBe('Mine');
  });

  it('view.set patches the active style and displayFromStyle mirrors it back', () => {
    const { registry, active, display } = setup();
    registry.execute('view.set', { key: 'edges', value: false });
    expect(active().edges.edges).toBe(false);
    registry.execute('view.xray');
    expect(active().faces.mode).toBe('xray');
    expect(active().edges.backEdges).toBe(false);
    registry.execute('view.backEdges');
    expect(active().faces.mode).toBe('shadedWithTextures');
    expect(active().edges.backEdges).toBe(true);
    registry.execute('view.faceStyle', { style: 'hiddenLine' });
    expect(active().faces.mode).toBe('hiddenLine');
    registry.execute('view.hiddenGeometry');
    registry.execute('view.guides', { value: false });
    registry.execute('view.axes', { value: false });
    expect(active().modeling).toMatchObject({ hiddenGeometry: true, guidesVisible: false, modelAxesVisible: false });
    const d = display.get();
    expect(displayFromStyle(active())).toEqual({
      hiddenGeometry: d.hiddenGeometry,
      edges: d.edges,
      profiles: d.profiles,
      guides: d.guides,
      axes: d.axes,
      backEdges: d.backEdges,
      xray: d.xray,
      faceStyle: d.faceStyle,
    });
  });
});

describe('shadows.* and fog.* commands', () => {
  it('patches shadow settings with clamping, location, toggle and reset', () => {
    const { registry, state, host } = setup();
    registry.execute('shadows.set', { patch: { enabled: true, month: 2, day: 31, time: 720, light: 60 } });
    expect(state().shadows).toMatchObject({ enabled: true, month: 2, day: 29, time: 720, light: 60 });
    expect(() => registry.execute('shadows.set', { patch: { month: 13 } })).toThrow(/Invalid params/);
    registry.execute('shadows.setLocation', { latitude: 51.5, longitude: -0.12, northAngle: 370 });
    expect(state().shadows).toMatchObject({ latitude: 51.5, longitude: -0.12, northAngle: 10 });
    expect(registry.execute('shadows.toggle')).toBe(false);
    expect(registry.execute('shadows.get')).toMatchObject({ enabled: false });
    registry.execute('shadows.reset');
    expect(state().shadows.latitude).toBeCloseTo(40.017);
    host.undo();
    expect(state().shadows.latitude).toBe(51.5);
    expect(dayOfYear(1, 1)).toBe(1);
    expect(dayOfYear(3, 1)).toBe(61);
    expect(monthDayOf(61)).toEqual({ month: 3, day: 1 });
    expect(monthDayOf(366)).toEqual({ month: 12, day: 31 });
  });

  it('fog.set keeps far >= near, uses the document default when absent, toggles', () => {
    const { registry, state, host } = setup();
    expect(fogOf(state())).toMatchObject({ enabled: false, near: 0, far: 100 });
    registry.execute('fog.set', { patch: { enabled: true, near: 50, far: 10, color: [1, 0, 0], useBackground: false } });
    expect(fogOf(state())).toEqual({ enabled: true, near: 50, far: 50, color: [1, 0, 0], useBackground: false });
    expect(registry.execute('fog.toggle')).toBe(false);
    host.undo();
    expect(fogOf(state()).enabled).toBe(true);
    host.doc.transact('strip', (draft) => {
      delete draft.fog;
    });
    expect(fogOf(state()).far).toBe(100);
    expect(registry.execute('fog.get')).toMatchObject({ enabled: false });
  });
});
