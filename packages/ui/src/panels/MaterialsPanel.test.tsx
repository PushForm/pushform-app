// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import type { Id, MaterialId } from '@pushform/core';
import type { JSX } from 'react';
import { AppContext } from '../AppContext';
import { createApp } from '../bootstrap';
import type { AppInstance } from '../bootstrap';
import { useAppStore } from '../store';
import { EntityInfoPanel } from './EntityInfoPanel';
import { MaterialsPanel, cssToRgb01, hlsToRgb, rgbToHls } from './MaterialsPanel';

let app: AppInstance | null = null;
afterEach(() => {
  cleanup();
  app?.dispose();
  app = null;
  useAppStore.getState().setActiveMaterialId(null);
  useAppStore.getState().setMaterialsTab('select');
});

function boot(): AppInstance {
  app = createApp({ demo: false, expose: false, kernel: new KernelClient(new InlineBackend()) });
  return app;
}
function mount(a: AppInstance, el: JSX.Element) {
  return render(<AppContext.Provider value={a}>{el}</AppContext.Provider>);
}

describe('MaterialsPanel', () => {
  it('lists in-model materials, activates one on click, edits it and paints a face from Entity Info', () => {
    const a = boot();
    const red = a.commands.execute('material.create', { name: 'Red', color: [1, 0, 0], activate: false }) as number;
    const bodyId = a.commands.execute('model.addBox', { min: [0, 0, 0], max: [1, 1, 1] }) as Id;
    mount(
      a,
      <>
        <MaterialsPanel />
        <EntityInfoPanel />
      </>,
    );
    // header shows the default material; the list has Default + Red
    expect(screen.getByLabelText('Active material').textContent).toContain('Default');
    const item = screen.getByRole('option', { name: 'Red' });
    fireEvent.click(item);
    expect(useAppStore.getState().activeMaterialId).toBe(red);
    expect(screen.getByLabelText('Active material').textContent).toContain('Red');
    expect(a.commands.execute('material.getActive')).toBe(red);

    // Entity Info: select a face, click the front swatch → painted with the active material
    const body = a.document.doc.rootDefinition.entities.bodies.get(bodyId)!;
    const faceId = [...body.faces.keys()][0]!;
    act(() => a.document.selection.set([{ kind: 'face', path: [], id: bodyId, faceId, region: null }]));
    fireEvent.click(screen.getByRole('button', { name: 'Front material' }));
    expect(a.document.doc.rootDefinition.entities.bodies.get(bodyId)!.faces.get(faceId)?.frontMaterialId).toBe(red);
    expect(a.document.doc.rootDefinition.entities.bodies.get(bodyId)!.faces.get(faceId)?.backMaterialId).toBeNull();

    // Edit tab: opacity slider and color input update the material
    fireEvent.click(screen.getByRole('tab', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Opacity'), { target: { value: '40' } });
    expect(a.document.doc.state.materials.get(red as MaterialId)?.alpha).toBeCloseTo(0.4);
    fireEvent.change(screen.getByLabelText('Color'), { target: { value: '#00ff00' } });
    expect(a.document.doc.state.materials.get(red as MaterialId)?.color).toEqual([0, 1, 0]);
    expect(screen.getByLabelText('Use texture image')).toBeTruthy();

    // Create makes a new active material and opens the editor
    fireEvent.click(screen.getByRole('tab', { name: 'Select' }));
    fireEvent.click(screen.getByText('Create'));
    const active = useAppStore.getState().activeMaterialId!;
    expect(active).not.toBe(red);
    expect(a.document.doc.state.materials.get(active as MaterialId)?.name).toBe('Material');
    expect(useAppStore.getState().materialsTab).toBe('edit');

    // Sample arms the Paint Bucket's one-shot sampling
    fireEvent.click(screen.getByText('Sample'));
    expect(a.toolManager.activeToolId).toBe('paint');
    expect((a.toolManager.activeTool as { sampling?: boolean }).sampling).toBe(true);
  });

  it('right-click menu on an item deletes / selects / duplicates; the library dropdown lists built-in colors', async () => {
    const a = boot();
    const red = a.commands.execute('material.create', { name: 'Red', color: [1, 0, 0] }) as number;
    const bodyId = a.commands.execute('model.addBox', { min: [0, 0, 0], max: [1, 1, 1] }) as Id;
    const faceId = [...a.document.doc.rootDefinition.entities.bodies.get(bodyId)!.faces.keys()][0]!;
    a.commands.execute('paint.apply', { refs: [{ kind: 'face', path: [], id: bodyId, faceId, region: null }], materialId: red });
    mount(a, <MaterialsPanel />);
    fireEvent.contextMenu(screen.getByRole('option', { name: 'Red' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Select' }));
    expect(a.document.selection.refs).toHaveLength(1);
    fireEvent.contextMenu(screen.getByRole('option', { name: 'Red' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    expect(screen.getByRole('option', { name: 'Red#1' })).toBeTruthy();
    fireEvent.contextMenu(screen.getByRole('option', { name: 'Red#1' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(screen.queryByRole('option', { name: 'Red#1' })).toBeNull();
    // purge drops nothing used; the Red material is on a face
    fireEvent.click(screen.getByText('Purge'));
    expect(screen.getByRole('option', { name: 'Red' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Library'), { target: { value: 'Colors' } });
    expect(screen.getByRole('option', { name: 'Color_B01' })).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: 'Color_B01' }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect([...a.document.doc.state.materials.values()].some((m) => m.name === 'Color_B01')).toBe(true);
    fireEvent.change(screen.getByLabelText('Library'), { target: { value: 'inModel' } });
    expect(screen.getByRole('option', { name: 'Color_B01' })).toBeTruthy();
  });

  it('color helpers round-trip', () => {
    expect(cssToRgb01('#ff8000')).toEqual([1, 128 / 255, 0]);
    expect(rgbToHls([1, 0, 0])).toEqual([0, 50, 100]);
    const rgb = hlsToRgb(120, 50, 100);
    expect(rgb[0]).toBeCloseTo(0);
    expect(rgb[1]).toBeCloseTo(1);
    expect(rgb[2]).toBeCloseTo(0);
  });
});
