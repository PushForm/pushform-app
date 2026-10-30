// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import type { EntityRef } from '@pushform/model';
import { AppContext } from '../AppContext';
import { createApp } from '../bootstrap';
import type { AppInstance } from '../bootstrap';
import { formatVolume } from '../engine/format';
import { bodiesToRender } from '../engine/renderAdapter';
import { EntityInfoPanel } from './EntityInfoPanel';

let app: AppInstance | null = null;
afterEach(() => {
  cleanup();
  app?.dispose();
  app = null;
});

function mount(a: AppInstance) {
  return render(
    <AppContext.Provider value={a}>
      <EntityInfoPanel />
    </AppContext.Provider>,
  );
}

describe('EntityInfoPanel', () => {
  it('shows "Solid Body" with its volume for a selected box and "4 Entities" for a multi-selection', () => {
    app = createApp({ demo: false, expose: false, kernel: new KernelClient(new InlineBackend()) });
    app.commands.execute('model.addBox', { min: [0, 0, 0], max: [1, 2, 3] });
    const body = app.document.doc.rootDefinition.entities.bodies.values().next().value!;
    mount(app);
    expect(screen.getByText('Nothing selected')).toBeTruthy();

    act(() => app!.document.selection.set([{ kind: 'body', path: [], id: body.id }]));
    expect(screen.getByText('Solid Body')).toBeTruthy();
    const expected = formatVolume(6, app.document.doc.state.meta.units);
    expect(expected).toMatch(/ft³$/);
    expect(screen.getByText(expected)).toBeTruthy();
    expect(screen.getByText('6')).toBeTruthy(); // 6 faces
    expect((screen.getByLabelText('Tag') as HTMLSelectElement).disabled).toBe(false);

    const faces = [...body.faces.keys()].slice(0, 4);
    const refs: EntityRef[] = faces.map((faceId) => ({ kind: 'face', path: [], id: body.id, faceId, region: null }));
    act(() => app!.document.selection.set(refs));
    expect(screen.getByText('4 Entities')).toBeTruthy();

    act(() => app!.document.selection.set([refs[0]!]));
    expect(screen.getByText('Face')).toBeTruthy();
    expect(screen.getByText('Area')).toBeTruthy();
    expect(screen.getAllByText('Default')).toHaveLength(2); // front/back material swatches

    const edgeKey = body.edges.keys().next().value!;
    act(() => app!.document.selection.set([{ kind: 'edge', path: [], id: body.id, edgeKey }]));
    expect(screen.getByText('Edge')).toBeTruthy();
    expect((screen.getByLabelText('Length') as HTMLInputElement).readOnly).toBe(true);
  });

  it('describes every face of one smooth surface as one Surface with the total area', () => {
    app = createApp({ demo: false, expose: false, kernel: new KernelClient(new InlineBackend()) });
    app.commands.execute('model.addBox', { min: [0, 0, 0], max: [1, 1, 1] });
    const body = app.document.doc.rootDefinition.entities.bodies.values().next().value!;
    const sides = [...body.faces.values()].filter((f) => Math.abs(f.plane.n[2]) < 0.5).map((f) => f.id);
    expect(sides).toHaveLength(4);
    // soften the four vertical edges: the sides become one surface
    app.document.doc.transact('soften', (d) => {
      const b = d.definitions.get(d.rootDefinitionId)!.entities.bodies.get(body.id)!;
      for (const e of b.edges.values()) if (sides.includes(e.faceA) && sides.includes(e.faceB)) e.soft = true;
    });
    mount(app);
    const refs: EntityRef[] = sides.map((faceId) => ({ kind: 'face', path: [], id: body.id, faceId, region: null }));
    act(() => app!.document.selection.set(refs));
    expect(screen.getByText('Surface')).toBeTruthy();
    expect(screen.getByText('Area')).toBeTruthy();
    // part of a surface is not described as one
    act(() => app!.document.selection.set(refs.slice(0, 3)));
    expect(screen.getByText('3 Entities')).toBeTruthy();
  });

  it('Hidden hides and unhides the selected edges and faces, each as one undo step', () => {
    app = createApp({ demo: false, expose: false, kernel: new KernelClient(new InlineBackend()) });
    app.commands.execute('model.addBox', { min: [0, 0, 0], max: [1, 1, 1] });
    const body = () => app!.document.doc.rootDefinition.entities.bodies.values().next().value!;
    const edgeKey = body().edges.keys().next().value!;
    const edge: EntityRef = { kind: 'edge', path: [], id: body().id, edgeKey };
    mount(app);
    act(() => app!.document.selection.set([edge]));
    const hidden = () => screen.getByLabelText('Hidden') as HTMLInputElement;
    expect(hidden().disabled).toBe(false);
    expect(hidden().checked).toBe(false);
    act(() => { fireEvent.click(hidden()); });
    expect(body().edges.get(edgeKey)!.hidden).toBe(true);
    expect(app.document.selection.isEmpty).toBe(true);

    act(() => app!.document.selection.set([edge]));
    expect(hidden().checked).toBe(true);
    act(() => { fireEvent.click(hidden()); });
    expect(body().edges.get(edgeKey)!.hidden).toBe(false);
    act(() => { app!.document.undo(); });
    expect(body().edges.get(edgeKey)!.hidden).toBe(true);

    const faceId = body().faces.keys().next().value!;
    const faces: EntityRef[] = [{ kind: 'face', path: [], id: body().id, faceId, region: null }, edge];
    act(() => app!.document.selection.set(faces));
    act(() => { fireEvent.click(hidden()); });
    expect(body().faces.get(faceId)!.hidden).toBe(true);
    expect(body().edges.get(edgeKey)!.hidden).toBe(true);
  });

  it('assigns a tag to the whole selection and toggles a solid edge\'s flags, one undo step each', () => {
    app = createApp({ demo: false, expose: false, kernel: new KernelClient(new InlineBackend()) });
    app.commands.execute('model.addBox', { min: [0, 0, 0], max: [1, 1, 1] });
    app.commands.execute('tag.create', { name: 'Walls' });
    const walls = [...app.document.doc.state.tags.values()].find((t) => t.name === 'Walls')!;
    const body = () => app!.document.doc.rootDefinition.entities.bodies.values().next().value!;
    const faces = [...body().faces.keys()].slice(0, 2).map((faceId): EntityRef => ({ kind: 'face', path: [], id: body().id, faceId, region: null }));
    mount(app);
    act(() => app!.document.selection.set(faces));
    fireEvent.change(screen.getByLabelText('Tag'), { target: { value: String(walls.id) } });
    expect(faces.every((f) => f.kind === 'face' && body().faces.get(f.faceId)!.tagId === walls.id)).toBe(true);
    expect((screen.getByLabelText('Tag') as HTMLSelectElement).value).toBe(String(walls.id));
    app.commands.execute('edit.undo');
    expect(faces.some((f) => f.kind === 'face' && body().faces.get(f.faceId)!.tagId === walls.id)).toBe(false);

    const edgeKey = body().edges.keys().next().value!;
    act(() => app!.document.selection.set([{ kind: 'edge', path: [], id: body().id, edgeKey }]));
    fireEvent.click(screen.getByLabelText('Soft'));
    fireEvent.click(screen.getByLabelText('Smooth'));
    expect(body().edges.get(edgeKey)).toMatchObject({ soft: true, smooth: true });
    app.commands.execute('edit.undo');
    expect(body().edges.get(edgeKey)).toMatchObject({ soft: true, smooth: false });
  });

  it('edits a free sketch edge\'s length in any unit and keeps it read-only once it bounds a face', () => {
    app = createApp({ demo: false, expose: false, kernel: new KernelClient(new InlineBackend()) });
    app.commands.execute('sketch.addEdge', { a: [0, 0, 0], b: [1, 0, 0] });
    const sketch = () => app!.document.doc.rootDefinition.entities.sketch;
    const edge = [...sketch().edges.values()][0]!;
    mount(app);
    act(() => app!.document.selection.set([{ kind: 'sketchEdge', path: [], id: edge.id }]));
    const length = screen.getByLabelText('Length') as HTMLInputElement;
    expect(length.readOnly).toBe(false);
    fireEvent.change(length, { target: { value: '2.5m' } });
    fireEvent.blur(length);
    expect(sketch().vertices.get(edge.b)!.p[0]).toBeCloseTo(2.5, 9);
    expect(sketch().vertices.get(edge.a)!.p).toEqual([0, 0, 0]);
    // Text that is not a length is put back.
    fireEvent.change(screen.getByLabelText('Length'), { target: { value: 'wide' } });
    fireEvent.blur(screen.getByLabelText('Length'));
    expect(sketch().vertices.get(edge.b)!.p[0]).toBeCloseTo(2.5, 9);
    app.commands.execute('edit.undo');
    expect(sketch().vertices.get(edge.b)!.p[0]).toBeCloseTo(1, 9);

    // Closing a triangle makes the edge bound a face.
    app.commands.execute('sketch.addEdge', { a: [1, 0, 0], b: [0, 1, 0] });
    app.commands.execute('sketch.addEdge', { a: [0, 1, 0], b: [0, 0, 0] });
    expect(sketch().faces.size).toBe(1);
    act(() => app!.document.selection.set([{ kind: 'sketchEdge', path: [], id: edge.id }]));
    expect((screen.getByLabelText('Length') as HTMLInputElement).readOnly).toBe(true);
  });

  it('shows a circle edge\'s radius and segments and redraws the circle when they change', () => {
    app = createApp({ demo: false, expose: false, kernel: new KernelClient(new InlineBackend()) });
    const points = Array.from({ length: 24 }, (_, i): [number, number, number] => [Math.cos(i * Math.PI / 12), Math.sin(i * Math.PI / 12), 0]);
    app.commands.execute('sketch.addCurve', { points, closed: true, curve: { kind: 'circle', center: [0, 0, 0], normal: [0, 0, 1], radius: 1, segments: 24 } });
    const sketch = () => app!.document.doc.rootDefinition.entities.sketch;
    const curve = () => [...sketch().curves.values()][0]!;
    const select = () => act(() => app!.document.selection.set([{ kind: 'sketchEdge', path: [], id: curve().edgeRefs[0] as never }]));
    mount(app);
    select();
    expect((screen.getByLabelText('Segments') as HTMLInputElement).value).toBe('24');
    fireEvent.change(screen.getByLabelText('Segments'), { target: { value: '12' } });
    fireEvent.keyDown(screen.getByLabelText('Segments'), { key: 'Enter' });
    expect(curve().segments).toBe(12);
    expect(sketch().edges.size).toBe(12);
    // Fewer than three sides is not a circle: the field goes back.
    select();
    fireEvent.change(screen.getByLabelText('Segments'), { target: { value: '2' } });
    fireEvent.blur(screen.getByLabelText('Segments'));
    expect(curve().segments).toBe(12);
    fireEvent.change(screen.getByLabelText('Radius'), { target: { value: '0.5m' } });
    fireEvent.blur(screen.getByLabelText('Radius'));
    expect(curve().radius).toBeCloseTo(0.5, 9);
    expect(sketch().faces.size).toBe(1);
  });

  it('turns shadows off for a solid and for a group, whose contents then neither cast nor receive', () => {
    app = createApp({ demo: false, expose: false, kernel: new KernelClient(new InlineBackend()) });
    app.commands.execute('model.addBox', { min: [0, 0, 0], max: [1, 1, 1] });
    const root = () => app!.document.doc.rootDefinition.entities;
    const body = root().bodies.values().next().value!;
    mount(app);
    act(() => app!.document.selection.set([{ kind: 'body', path: [], id: body.id }]));
    fireEvent.click(screen.getByLabelText('Cast Shadows'));
    expect(root().bodies.get(body.id)!.castShadows).toBe(false);
    expect(bodiesToRender(app.document.doc.state)[0]).toMatchObject({ castShadows: false, receiveShadows: true });
    app.commands.execute('edit.undo');

    app.commands.execute('group.make', { refs: [{ kind: 'body', path: [], id: body.id }] });
    const instance = root().instances.values().next().value!;
    act(() => app!.document.selection.set([{ kind: 'instance', path: [], id: instance.id }]));
    fireEvent.click(screen.getByLabelText('Receive Shadows'));
    expect(root().instances.get(instance.id)!.receiveShadows).toBe(false);
    expect(bodiesToRender(app.document.doc.state)[0]).toMatchObject({ castShadows: true, receiveShadows: false });
    expect((screen.getByLabelText('Receive Shadows') as HTMLInputElement).checked).toBe(false);
  });

  it('edits a dimension\'s text with <> for the measurement and switches a circle dimension between radius and diameter', () => {
    app = createApp({ demo: false, expose: false, kernel: new KernelClient(new InlineBackend()) });
    const id = app.commands.execute('dimension.add', { kind: 'linear', start: [0, 0, 0], end: [2, 0, 0], offset: [0, -0.5, 0], normal: [0, 0, 1] }) as number;
    const dims = () => [...app!.document.doc.rootDefinition.entities.dimensions.values()];
    mount(app);
    act(() => app!.document.selection.set([{ kind: 'dimension', path: [], id: id as never }]));
    expect(screen.getByText('Dimension')).toBeTruthy();
    const field = screen.getByRole('textbox', { name: 'Dimension text' }) as HTMLInputElement;
    expect(field.value).toBe('');
    expect(field.placeholder).toBe(`6' 6 3/4"`);
    expect(screen.queryByRole('combobox', { name: 'Dimension type' })).toBeNull();
    fireEvent.change(field, { target: { value: 'Wall <>' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(dims()[0]!.text).toBe('Wall <>');
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.blur(field);
    expect(dims()[0]!.text).toBeNull();

    const r = app.commands.execute('dimension.add', { kind: 'radial', start: [10, 0, 0], end: [11, 0, 0], offset: [1, 1, 0], normal: [0, 0, 1] }) as number;
    act(() => app!.document.selection.set([{ kind: 'dimension', path: [], id: r as never }]));
    const type = screen.getByRole('combobox', { name: 'Dimension type' }) as HTMLSelectElement;
    expect(type.value).toBe('radial');
    fireEvent.change(type, { target: { value: 'diametric' } });
    expect(dims().find((d) => d.id === r)!.kind).toBe('diametric');
    expect((screen.getByRole('textbox', { name: 'Dimension text' }) as HTMLInputElement).placeholder).toMatch(/^DIA /);
  });
});
