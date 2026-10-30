// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { CommandRegistry } from '../registry/CommandRegistry';
import { MemoryTransactionHost } from '../registry/Command';
import { DEFAULT_DISPLAY, MemoryDisplayHost } from '../host/DisplayHost';
import type { DisplayState } from '../host/DisplayHost';
import { displayOf, SERVICE_DISPLAY } from '../host/services';
import { viewCommands } from './view';

function setup(withHost = true) {
  const services = new Map<string, unknown>();
  const display = new MemoryDisplayHost();
  if (withHost) services.set(SERVICE_DISPLAY, display);
  const registry = new CommandRegistry({ tx: new MemoryTransactionHost(), services });
  registry.registerAll(viewCommands);
  return { registry, display, services };
}

describe('view.* display commands', () => {
  it('toggles and sets booleans through view.<key> and view.set', () => {
    const { registry, display } = setup();
    expect(display.get()).toEqual(DEFAULT_DISPLAY);
    registry.execute('view.hiddenGeometry');
    expect(display.get().hiddenGeometry).toBe(true);
    registry.execute('view.hiddenGeometry');
    expect(display.get().hiddenGeometry).toBe(false);
    registry.execute('view.edges', { value: false });
    expect(display.get().edges).toBe(false);
    registry.execute('view.set', { key: 'guides', value: false });
    expect(display.get().guides).toBe(false);
    registry.execute('view.set', { key: 'faceStyle', value: 'wireframe' });
    expect(display.get().faceStyle).toBe('wireframe');
    registry.execute('view.faceStyle', { style: 'hiddenLine' });
    expect(display.get().faceStyle).toBe('hiddenLine');
    expect(registry.execute('view.get')).toEqual(display.get());
  });

  it('rejects mismatched values', () => {
    const { registry } = setup();
    expect(() => registry.execute('view.set', { key: 'edges', value: 'wireframe' })).toThrow(/boolean/);
    expect(() => registry.execute('view.set', { key: 'faceStyle', value: true })).toThrow(/faceStyle/);
    expect(() => registry.execute('view.set', { key: 'faceStyle', value: 'photoreal' })).toThrow(/Invalid params/);
  });

  it('Back Edges (K) and X-ray (I) are exclusive', () => {
    const { registry, display } = setup();
    registry.execute('view.backEdges');
    expect(display.get()).toMatchObject({ backEdges: true, xray: false });
    registry.execute('view.xray');
    expect(display.get()).toMatchObject({ backEdges: false, xray: true });
    registry.execute('view.backEdges');
    expect(display.get()).toMatchObject({ backEdges: true, xray: false });
    registry.execute('view.backEdges');
    expect(display.get()).toMatchObject({ backEdges: false, xray: false });
    expect(registry.list({ category: 'view' }).find((c) => c.id === 'view.backEdges')?.keybinding).toBe('K');
    expect(registry.list({ category: 'view' }).find((c) => c.id === 'view.xray')?.keybinding).toBe('I');
  });

  it('installs an in-memory display host when none is registered, and notifies listeners', () => {
    const { registry, services } = setup(false);
    const seen: DisplayState[] = [];
    const d = displayOf(registry.ctx);
    expect(services.get(SERVICE_DISPLAY)).toBe(d);
    const off = d.onChange((s) => seen.push(s));
    registry.execute('view.axes');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.axes).toBe(false);
    off();
  });
});
