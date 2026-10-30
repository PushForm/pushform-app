// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { fogCommands, sceneCommands, sceneRuntimeOf, shadowCommands, styleCommands, tagCommands, tagTools, viewCommands } from '@pushform/commands';
import type { StyleId, TagId } from '@pushform/core';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import type { JSX } from 'react';
import { AppContext } from '../AppContext';
import { createApp } from '../bootstrap';
import type { AppInstance } from '../bootstrap';
import { SceneTabs } from '../components/SceneTabs';
import { applyDocumentView, syncDisplayStoreFromStyle } from '../engine/viewSync';
import { useAppStore } from '../store';
import { FogPanel } from './FogPanel';
import { ScenesPanel } from './ScenesPanel';
import { ShadowsPanel, formatTime, parseDate, parseTime } from './ShadowsPanel';
import { StylesPanel } from './StylesPanel';
import { TagsPanel } from './TagsPanel';

let app: AppInstance | null = null;
afterEach(() => {
  cleanup();
  app?.dispose();
  app = null;
  useAppStore.getState().setNotice(null);
  useAppStore.getState().setDisplay({ activeTagId: null });
});

function boot(): AppInstance {
  const a = createApp({ demo: false, expose: false, kernel: new KernelClient(new InlineBackend()) });
  // the bootstrap integrator registers these; tests add them when missing
  for (const list of [viewCommands, tagCommands, sceneCommands, styleCommands, shadowCommands, fogCommands]) for (const c of list) if (!a.commands.has(c.id)) a.commands.register(c);
  if (!a.toolManager.get('tag')) for (const t of tagTools()) a.toolManager.register(t);
  sceneRuntimeOf(a.commands.ctx).raf = null;
  app = a;
  return a;
}

function mount(a: AppInstance, el: JSX.Element) {
  return render(<AppContext.Provider value={a}>{el}</AppContext.Provider>);
}

describe('TagsPanel', () => {
  it('adds, renames, hides, recolors, dashes, activates and deletes tags; Color by Tag toggles the style', () => {
    const a = boot();
    mount(a, <TagsPanel />);
    expect(screen.getByText('Untagged')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Add Tag'));
    const state = () => a.document.doc.state;
    expect(state().tags.size).toBe(2);
    const created = [...state().tags.values()].find((t) => t.name !== 'Untagged')!;
    // the new tag opens in rename mode
    const input = screen.getByLabelText('Tag name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Walls' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(state().tags.get(created.id)?.name).toBe('Walls');
    fireEvent.click(screen.getByLabelText('Hide Walls'));
    expect(state().tags.get(created.id)?.visible).toBe(false);
    expect(screen.getByLabelText('Show Walls')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Walls color'), { target: { value: '#00ff00' } });
    expect(state().tags.get(created.id)?.color).toEqual([0, 1, 0]);
    fireEvent.change(screen.getByLabelText('Walls dashes'), { target: { value: 'dash' } });
    expect(state().tags.get(created.id)?.dashes).toBe('dash');
    fireEvent.click(screen.getByLabelText('Make Walls the active tag'));
    expect(useAppStore.getState().display.activeTagId).toBe(created.id);
    expect(screen.getByLabelText('Walls is the active tag')).toBeTruthy();
    // filter
    fireEvent.change(screen.getByLabelText('Filter tags'), { target: { value: 'wal' } });
    expect(screen.queryByText('Untagged')).toBeNull();
    fireEvent.change(screen.getByLabelText('Filter tags'), { target: { value: '' } });
    // color by tag checkbox
    fireEvent.click(screen.getByLabelText('Color by Tag'));
    expect(state().styles.get(state().activeStyleId)?.modeling.colorByTag).toBe(true);
    // folder
    fireEvent.click(screen.getByLabelText('Add Folder'));
    const folderInput = screen.getByLabelText('Folder name') as HTMLInputElement;
    fireEvent.change(folderInput, { target: { value: 'Site' } });
    fireEvent.keyDown(folderInput, { key: 'Enter' });
    expect([...state().tagFolders.values()][0]?.name).toBe('Site');
    fireEvent.click(screen.getByLabelText('Hide folder Site'));
    expect([...state().tagFolders.values()][0]?.visible).toBe(false);
    // delete with the inline choice
    fireEvent.click(screen.getByText('Walls'));
    fireEvent.click(screen.getByLabelText('Delete Tag'));
    expect(screen.getByText(/Entities on this tag/)).toBeTruthy();
    fireEvent.click(screen.getByText('Move to Untagged'));
    expect(state().tags.has(created.id)).toBe(false);
    expect(useAppStore.getState().display.activeTagId).toBeNull();
    // details menu
    fireEvent.click(screen.getByLabelText('Details'));
    fireEvent.click(screen.getByText('Purge'));
    expect(state().tagFolders.size).toBe(0);
  });

  it('Tag tool assigns the active tag to the clicked entity', () => {
    const a = boot();
    const tag = a.commands.execute('tag.create', { name: 'Roof' }) as number;
    a.commands.execute('tag.setActive', { id: tag });
    const box = a.commands.execute('model.addBox') as number;
    a.toolManager.activate('tag');
    const ref = { kind: 'body' as const, path: [] as never[], id: box as never };
    a.toolManager.click({
      screen: [0, 0],
      ray: { origin: [0, 0, 0], dir: [0, 0, -1] },
      button: 0,
      buttons: 0,
      modifiers: { shift: false, ctrl: false, alt: false, meta: false },
      inference: { primary: { kind: 'onFace', point: [0, 0, 1], color: '#000' }, lines: [], tooltip: null, hit: { ref, point: [0, 0, 1], t: 1 } } as never,
      camera: a.viewport.camera.getState(),
    });
    expect(a.document.doc.rootDefinition.entities.bodies.get(box as never)?.tagId).toBe(tag);
    expect(a.toolManager.status().instructor).toMatch(/Tagged "Roof"/);
  });
});

describe('ScenesPanel and SceneTabs', () => {
  it('adds, activates, updates, moves and removes scenes; details edit name and flags', () => {
    const a = boot();
    mount(
      a,
      <>
        <SceneTabs />
        <ScenesPanel />
      </>,
    );
    const state = () => a.document.doc.state;
    expect(screen.queryByRole('tablist', { name: 'Scenes' })).toBeNull();
    fireEvent.click(screen.getByLabelText('Add Scene'));
    fireEvent.click(screen.getByLabelText('Add Scene'));
    expect(state().sceneOrder).toHaveLength(2);
    const tabs = screen.getByRole('tablist', { name: 'Scenes' });
    expect(within(tabs).getAllByRole('tab')).toHaveLength(2);
    const [s1, s2] = state().sceneOrder;
    expect(sceneRuntimeOf(a.commands.ctx).activeSceneId).toBe(s2);
    fireEvent.click(within(tabs).getByText('Scene 1'));
    expect(sceneRuntimeOf(a.commands.ctx).activeSceneId).toBe(s1);
    expect(within(tabs).getByText('Scene 1').getAttribute('aria-selected')).toBe('true');
    // move down through the panel (Scene 1 selected)
    fireEvent.click(screen.getByLabelText('Move Scene Down'));
    expect(state().sceneOrder).toEqual([s2, s1]);
    // details
    fireEvent.click(screen.getByLabelText('Show Details'));
    fireEvent.change(screen.getByLabelText('Scene name'), { target: { value: 'Front' } });
    expect(state().scenes.get(s1!)?.name).toBe('Front');
    fireEvent.click(screen.getByLabelText('Include in Animation'));
    expect(state().scenes.get(s1!)?.includeInAnimation).toBe(false);
    fireEvent.click(screen.getByLabelText('Visible Tags'));
    expect(state().scenes.get(s1!)?.flags.useTags).toBe(false);
    // update recaptures (camera changed)
    a.viewport.camera.setState({ ...a.viewport.camera.getState(), eye: [1, 2, 3] });
    fireEvent.click(screen.getByLabelText('Update Scene'));
    expect(state().scenes.get(s1!)?.camera.eye).toEqual([1, 2, 3]);
    // tab context menu: Move Left / Delete
    fireEvent.contextMenu(within(tabs).getByText('Front'));
    fireEvent.click(screen.getByText('Move Left'));
    expect(state().sceneOrder).toEqual([s1, s2]);
    fireEvent.contextMenu(within(tabs).getByText('Scene 2'));
    fireEvent.click(screen.getByText('Delete'));
    expect(state().sceneOrder).toEqual([s1]);
    // remove through the panel + undo
    fireEvent.click(within(screen.getByRole('listbox', { name: 'Scenes' })).getByText('Front'));
    fireEvent.click(screen.getByLabelText('Remove Scene'));
    expect(state().scenes.size).toBe(0);
    act(() => void a.commands.execute('edit.undo'));
    expect(state().scenes.size).toBe(1);
    // thumbnails view toggles without a renderer (captures resolve to '')
    fireEvent.click(screen.getByLabelText('Show thumbnails'));
    expect(screen.getByRole('listbox', { name: 'Scenes' }).className).toContain('is-thumbs');
    fireEvent.change(screen.getByLabelText('Search scenes'), { target: { value: 'zzz' } });
    expect(screen.getByText('No scenes match.')).toBeTruthy();
  });
});

describe('StylesPanel, ShadowsPanel, FogPanel', () => {
  it('styles: presets create on demand, edit fields patch the active style and the viewport display follows', () => {
    const a = boot();
    mount(a, <StylesPanel />);
    const state = () => a.document.doc.state;
    fireEvent.click(screen.getByLabelText('Hidden Line'));
    expect(state().styles.get(state().activeStyleId)?.faces.mode).toBe('hiddenLine');
    expect(state().styles.size).toBe(2);
    applyDocumentView(a.viewport, state());
    expect(a.viewport.display.faceStyle).toBe('hiddenLine');
    syncDisplayStoreFromStyle(state());
    expect(useAppStore.getState().display.faceStyle).toBe('hiddenLine');
    fireEvent.click(screen.getByRole('tab', { name: 'Edit' }));
    fireEvent.click(screen.getByLabelText('Profiles'));
    expect(state().styles.get(state().activeStyleId)?.edges.profiles).toBe(false);
    // The edge settings reach the viewport; those not drawn yet are disabled with a note.
    fireEvent.change(screen.getByLabelText('Edge color mode'), { target: { value: 'byAxis' } });
    applyDocumentView(a.viewport, state());
    expect(a.viewport.display.edgeAxisColors).toBe(true);
    expect((screen.getByLabelText('Endpoints') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Jitter') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('option', { name: 'By material' }) as HTMLOptionElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('tab', { name: 'Face' }));
    fireEvent.click(screen.getByRole('radio', { name: 'X-ray' }));
    expect(state().styles.get(state().activeStyleId)?.faces.mode).toBe('xray');
    fireEvent.click(screen.getByRole('tab', { name: 'Background' }));
    fireEvent.click(screen.getByLabelText('Sky'));
    expect(state().styles.get(state().activeStyleId)?.background.sky).toBe(true);
    fireEvent.click(screen.getByRole('tab', { name: 'Modeling' }));
    fireEvent.click(screen.getByLabelText('Model Axes'));
    expect(state().styles.get(state().activeStyleId)?.modeling.modelAxesVisible).toBe(false);
    // view.* commands keep the style in sync
    act(() => void a.commands.execute('view.axes', { value: true }));
    expect(state().styles.get(state().activeStyleId)?.modeling.modelAxesVisible).toBe(true);
    fireEvent.click(screen.getByRole('tab', { name: 'Select' }));
    const first = [...state().styles.keys()][0] as StyleId;
    fireEvent.click(within(screen.getByRole('listbox', { name: 'Styles in model' })).getByLabelText('Default'));
    expect(state().activeStyleId).toBe(first);
  });

  it('shadows: toggles, time/date fields and sliders write through shadows.set', () => {
    const a = boot();
    mount(a, <ShadowsPanel />);
    const s = () => a.document.doc.state.shadows;
    fireEvent.click(screen.getByLabelText('Show Shadows'));
    expect(s().enabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Time of day'), { target: { value: '600' } });
    expect(s().time).toBe(600);
    const time = screen.getByLabelText('Time (HH:MM)') as HTMLInputElement;
    expect(time.value).toBe('10:00');
    fireEvent.change(time, { target: { value: '4:30 pm' } });
    fireEvent.keyDown(time, { key: 'Enter' });
    expect(s().time).toBe(16 * 60 + 30);
    const date = screen.getByLabelText('Date (MM/DD)') as HTMLInputElement;
    fireEvent.change(date, { target: { value: '06/21' } });
    fireEvent.blur(date);
    expect(s()).toMatchObject({ month: 6, day: 21 });
    fireEvent.change(screen.getByLabelText('Day of year'), { target: { value: '1' } });
    expect(s()).toMatchObject({ month: 1, day: 1 });
    fireEvent.change(screen.getByLabelText('UTC offset'), { target: { value: '2' } });
    expect(s().utcOffsetHours).toBe(2);
    fireEvent.change(screen.getByLabelText('Light'), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('Dark'), { target: { value: '70' } });
    expect(s()).toMatchObject({ light: 30, dark: 70 });
    fireEvent.click(screen.getByLabelText('On ground'));
    fireEvent.click(screen.getByLabelText('From edges'));
    fireEvent.click(screen.getByLabelText('Use sun for shading'));
    expect(s()).toMatchObject({ onGround: false, fromEdges: true, useSunForShading: false });
    expect(parseTime('25:00')).toBeNull();
    expect(parseTime('0730')).toBe(450);
    expect(formatTime(0)).toBe('00:00');
    expect(parseDate('13/1')).toBeNull();
    expect(parseDate('2/31')).toEqual({ month: 2, day: 29 });
    applyDocumentView(a.viewport, a.document.doc.state);
    expect(a.viewport.shadows.enabled).toBe(true);
  });

  it('fog: toggle, distances and color', () => {
    const a = boot();
    mount(a, <FogPanel />);
    const fog = () => a.document.doc.state.fog!;
    fireEvent.click(screen.getByLabelText('Display Fog'));
    expect(fog().enabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Fog far'), { target: { value: '40' } });
    fireEvent.change(screen.getByLabelText('Fog near'), { target: { value: '10' } });
    expect(fog()).toMatchObject({ near: 10, far: 40 });
    expect((screen.getByLabelText('Fog color') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Use background color'));
    fireEvent.change(screen.getByLabelText('Fog color'), { target: { value: '#102030' } });
    expect(fog().useBackground).toBe(false);
    expect(fog().color[0]).toBeCloseTo(16 / 255);
    applyDocumentView(a.viewport, a.document.doc.state);
    expect(a.viewport.fog).toEqual({ enabled: true, near: 10, far: 40, color: '#102030' });
    expect(a.viewport.scene.fog).not.toBeNull();
    const t = a.document.doc.state.tags.get(a.document.doc.state.defaultTagId as TagId);
    expect(t?.name).toBe('Untagged');
  });
});
