// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { edgeCommands, lastOpCommands, viewCommands } from '@pushform/commands';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import type { JSX } from 'react';
import { AppContext } from '../AppContext';
import { createApp } from '../bootstrap';
import type { AppInstance } from '../bootstrap';
import { StatusBar } from '../components/StatusBar';
import { useAppStore } from '../store';
import { DisplayPanel } from './DisplayPanel';
import { InstructorPanel } from './InstructorPanel';
import { LastOperationPanel } from './LastOperationPanel';
import { SoftenEdgesPanel } from './SoftenEdgesPanel';

let app: AppInstance | null = null;
afterEach(() => {
  cleanup();
  app?.dispose();
  app = null;
  useAppStore.getState().setNotice(null);
});

function boot(): AppInstance {
  const a = createApp({ demo: false, expose: false, kernel: new KernelClient(new InlineBackend()) });
  // the bootstrap integrator registers these; tests add them when missing
  for (const list of [viewCommands, lastOpCommands, edgeCommands]) for (const c of list) if (!a.commands.has(c.id)) a.commands.register(c);
  app = a;
  return a;
}

function mount(a: AppInstance, el: JSX.Element) {
  return render(<AppContext.Provider value={a}>{el}</AppContext.Provider>);
}

describe('DisplayPanel', () => {
  it('checkboxes route through view.set into store.display; K/I commands update the panel', () => {
    const a = boot();
    mount(a, <DisplayPanel />);
    const xray = screen.getByLabelText('X-ray (I)') as HTMLInputElement;
    const back = screen.getByLabelText('Back Edges (K)') as HTMLInputElement;
    expect(xray.checked).toBe(false);
    fireEvent.click(xray);
    expect(useAppStore.getState().display.xray).toBe(true);
    expect(xray.checked).toBe(true);
    act(() => void a.commands.execute('view.backEdges'));
    expect(back.checked).toBe(true);
    expect(xray.checked).toBe(false);
    fireEvent.click(screen.getByLabelText('Wireframe'));
    expect(useAppStore.getState().display.faceStyle).toBe('wireframe');
    expect((screen.getByLabelText('Wireframe') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByLabelText('Hidden Geometry'));
    expect(a.commands.execute('view.get')).toMatchObject({ hiddenGeometry: true, faceStyle: 'wireframe', backEdges: true });
    // keymap entries exist for K and I
    expect(a.keymap.resolve({ key: 'k', code: 'KeyK', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false })).toBe('view.backEdges');
    expect(a.keymap.resolve({ key: 'i', code: 'KeyI', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false })).toBe('view.xray');
  });
});

describe('InstructorPanel', () => {
  it('shows the active tool title, its live hint and the static help with modifier keys', () => {
    const a = boot();
    mount(a, <InstructorPanel />);
    expect(screen.getByText('Select')).toBeTruthy();
    expect(screen.getByText(/Click an entity to select it/)).toBeTruthy();
    expect(screen.getByText('Ctrl+Shift')).toBeTruthy();
    act(() => a.toolManager.activate('pushpull'));
    expect(screen.getByText('Push/Pull')).toBeTruthy();
    expect(screen.getByText(/Keep the starting face/)).toBeTruthy();
    expect(screen.getByText(useAppStore.getState().instructor)).toBeTruthy();
  });
});

describe('LastOperationPanel', () => {
  it('lists the top entry and re-executes the command when a field is edited; Repeat last repeats', () => {
    const a = boot();
    mount(a, <LastOperationPanel />);
    expect(screen.getByText('Nothing to adjust yet.')).toBeTruthy();
    act(() => void a.commands.execute('model.addBox', { min: [0, 0, 0], max: [1, 1, 1] }));
    expect(screen.getByText('Add Box')).toBeTruthy();
    const maxZ = screen.getByLabelText('max z') as HTMLInputElement;
    expect(maxZ.value).toBe('1');
    fireEvent.change(maxZ, { target: { value: '4' } });
    fireEvent.keyDown(maxZ, { key: 'Enter' });
    expect(a.document.undoStack.length).toBe(1);
    expect(a.document.undoStack.peek()?.params).toEqual({ min: [0, 0, 0], max: [1, 1, 4] });
    const body = a.document.doc.rootDefinition.entities.bodies.values().next().value!;
    let zmax = -Infinity;
    for (let i = 2; i < body.mesh.verts.length; i += 3) zmax = Math.max(zmax, body.mesh.verts[i]!);
    expect(zmax).toBe(4);
    fireEvent.click(screen.getByText('Repeat last'));
    expect(a.document.undoStack.length).toBe(2);
    expect(a.document.doc.rootDefinition.entities.bodies.size).toBe(2);
  });
});

describe('SoftenEdgesPanel', () => {
  it('applies edges.soften to the selection and amends the same undo step while editing', () => {
    const a = boot();
    const bodyId = a.commands.execute('model.addBox', { min: [0, 0, 0], max: [1, 1, 1] }) as number;
    const body = () => a.document.doc.rootDefinition.entities.bodies.get(bodyId as never)!;
    mount(a, <SoftenEdgesPanel />);
    expect(screen.getByText('Select edges, faces or bodies to soften.')).toBeTruthy();
    expect((screen.getByLabelText('Angle between normals') as HTMLInputElement).disabled).toBe(true);

    act(() => a.document.selection.set([{ kind: 'body', path: [], id: bodyId as never }]));
    expect(screen.getByText('12 edges in selection, 0 soft')).toBeTruthy();
    const slider = screen.getByLabelText('Angle between normals') as HTMLInputElement;
    expect(slider.value).toBe('20');
    const before = a.document.undoStack.length;
    fireEvent.change(slider, { target: { value: '95' } });
    expect([...body().edges.values()].every((e) => e.soft && e.smooth)).toBe(true);
    expect(a.document.undoStack.length).toBe(before + 1);
    fireEvent.click(screen.getByLabelText('Smooth normals'));
    expect([...body().edges.values()].every((e) => e.soft && !e.smooth)).toBe(true);
    expect(a.document.undoStack.length).toBe(before + 1); // amended, not appended
    expect(screen.getByText('12 edges in selection, 12 soft')).toBeTruthy();
    expect(slider.value).toBe('95'); // local value kept while editing

    // reselecting reflects the stored flags
    act(() => a.document.selection.clear());
    act(() => a.document.selection.set([{ kind: 'body', path: [], id: bodyId as never }]));
    expect((screen.getByLabelText('Angle between normals') as HTMLInputElement).value).toBe('90');
    expect((screen.getByLabelText('Smooth normals') as HTMLInputElement).checked).toBe(false);
  });
});

describe('StatusBar value entry', () => {
  it('has no Measurements box: values are typed into fields in the viewport', () => {
    const a = boot();
    mount(a, <StatusBar />);
    expect(screen.queryByLabelText(/Measurements/)).toBeNull();
    expect(document.querySelector('.pf-status-right input')).toBeNull();
  });
});

describe('StatusBar notices', () => {
  it('shows command errors and result messages, and clears them on the next command / tool change', () => {
    const a = boot();
    mount(a, <StatusBar />);
    const status = screen.getByRole('status');
    expect(status.textContent).toBe(useAppStore.getState().instructor);
    act(() => void a.commands.tryExecute('no.such.command'));
    expect(status.textContent).toBe('Unknown command: no.such.command');
    expect(status.className).toContain('pf-status-notice');
    act(() => void a.commands.tryExecute('view.get'));
    expect(status.className).not.toContain('pf-status-notice');

    // Select tool delete message (body faces cannot be erased directly)
    const bodyId = a.commands.execute('model.addBox') as number;
    const faceId = a.document.doc.rootDefinition.entities.bodies.get(bodyId as never)!.faces.keys().next().value!;
    act(() => a.document.selection.set([{ kind: 'face', path: [], id: bodyId as never, faceId, region: null }]));
    act(() => void a.commands.execute('edit.delete'));
    expect(status.textContent).toMatch(/1 item not deleted/);
    act(() => a.toolManager.activate('line'));
    expect(useAppStore.getState().notice).toBeNull();
  });
});
