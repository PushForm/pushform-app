// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { createLayoutDocument, viewportPaperPoint } from '@pushform/layout';
import { createLayoutRegistry } from '@pushform/commands';
import { LayoutViewportPanel } from './LayoutViewportPanel';

vi.mock('./layoutViewportRenders', () => ({
  layoutViewportModel: async () => ({ scenes: [], bounds: null }), layoutViewportStatus: () => 'current', layoutViewportFailure: () => null,
}));
afterEach(cleanup);

function setup() {
  const doc = createLayoutDocument(), { commands } = createLayoutRegistry(doc), pageId = doc.state.pageOrder[0]!;
  const referenceId = commands.execute('layout.reference.add', { displayName: 'House', documentId: 'model', revisionId: 'revision', revisionNumber: 1, sha256: 'a'.repeat(64) });
  const id = commands.execute('layout.viewport.add', { pageId, first: [10, 10], second: [110, 110], source: { referenceId }, scene: null,
    camera: { eye: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], projection: 'parallel', fov: 35, scale: 1 / 50 } }) as number;
  const entity = () => doc.state.pages.get(pageId)!.entities.get(id)!;
  function Harness() {
    useSyncExternalStore(notify => doc.events.on('change', notify), () => doc.version);
    return <LayoutViewportPanel entity={entity()} state={doc.state} disabled={!!entity().locked} navigating={false} onNavigate={() => {}}
      onCamera={(camera, scene) => { commands.execute('layout.viewport.setCamera', { pageId, entityId: id, camera, scene }); }}
      onResizeMode={preserveScale => { commands.execute('layout.viewport.setResizeMode', { pageId, entityId: id, preserveScale }); }} />;
  }
  render(<Harness />);
  return { doc, commands, entity, id, pageId };
}

it('changes preset and custom drawing scales without changing the frame and undoes each completed entry', async () => {
  const { commands, entity } = setup();
  await act(async () => {});
  const before = entity().points;
  fireEvent.change(screen.getByLabelText('Drawing scale'), { target: { value: '7' } });
  expect(entity().image!.viewport!.camera.scale).toBe(1 / 100);
  const input = () => screen.getByLabelText('Custom drawing scale ratio');
  fireEvent.change(input(), { target: { value: '75' } });
  expect(entity().image!.viewport!.camera.scale).toBe(1 / 100);
  fireEvent.keyDown(input(), { key: 'Enter' });
  expect(entity().image!.viewport!.camera.scale).toBe(1 / 75);
  expect(entity().points).toEqual(before);
  act(() => { commands.execute('edit.undo'); });
  expect(entity().image!.viewport!.camera.scale).toBe(1 / 100);
  fireEvent.change(input(), { target: { value: '80' } }); fireEvent.keyDown(input(), { key: 'Escape' }); fireEvent.blur(input());
  expect(entity().image!.viewport!.camera.scale).toBe(1 / 100);
  fireEvent.change(input(), { target: { value: '0' } }); fireEvent.blur(input());
  expect(entity().image!.viewport!.camera.scale).toBe(1 / 100);
});

it('identifies perspective as unscaled, retains target-plane framing, and changes resize behavior undoably', async () => {
  const { commands, entity } = setup();
  await act(async () => {});
  const projected = () => viewportPaperPoint(entity().points, entity().image!.viewport!.camera, [1, 0, 0])!;
  const before = projected();
  fireEvent.change(screen.getByLabelText('Projection'), { target: { value: 'perspective' } });
  expect((screen.getByLabelText('Drawing scale') as HTMLSelectElement).disabled).toBe(true);
  expect(screen.getByText('Perspective views have no uniform drawing scale.')).toBeTruthy();
  expect(projected()[0]).toBeCloseTo(before[0]);
  fireEvent.click(screen.getByLabelText('Preserve scale on resize'));
  expect(entity().image!.viewport!.preserveScaleOnResize).toBe(false);
  act(() => { commands.execute('edit.undo'); });
  expect((screen.getByLabelText('Preserve scale on resize') as HTMLInputElement).checked).toBe(true);
});

it('disables projection, scale and resize settings for a locked view', async () => {
  const { doc, id, pageId } = setup();
  await act(async () => {});
  act(() => { doc.undoStack.transact('Lock', draft => { draft.pages.get(pageId)!.entities.get(id)!.locked = true; }); });
  for (const name of ['Projection', 'Drawing scale', 'Custom drawing scale ratio', 'Preserve scale on resize'])
    expect((screen.getByLabelText(name) as HTMLInputElement).disabled).toBe(true);
});
