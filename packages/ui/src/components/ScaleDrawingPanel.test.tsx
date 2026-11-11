// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { ScaleDrawingPanel } from './ScaleDrawingPanel';
import { DocumentTabs } from './DocumentTabs';
let session: DocumentSession;
beforeEach(() => {
  session = new DocumentSession(createApp({ demo: false, expose: false }), () => createApp({ demo: false, expose: false }));
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
});
afterEach(() => { cleanup(); session.dispose(); });
it('creates a full-size drawing from the document menu', () => {
  render(<DocumentTabs session={session} onNewLayout={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'New document' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Drawing' }));
  expect(session.active.type).toBe('layout');
  if (session.active.type === 'layout') expect(session.active.doc.state.settings.drawing).toBe(true);
});
it('places a drawing through the dialog and preserves cancel without changes', () => {
  const layout = session.newLayout(), source = session.newDrawing();
  source.commands.execute('layout.shape.add', { pageId: source.activePageId, points: [[0, 0], [6000, 0], [6000, 4000], [0, 4000]], closed: true });
  render(<ScaleDrawingPanel tab={source} session={session} />);
  fireEvent.click(screen.getByRole('button', { name: 'Add to layout…' }));
  expect(screen.getByText(/120.0 × 80.0 mm on paper/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(layout.doc.state.pages.get(layout.activePageId)!.entities.size).toBe(0);
  fireEvent.click(screen.getByRole('button', { name: 'Add to layout…' }));
  fireEvent.change(screen.getByLabelText('Scale denominator'), { target: { value: '100' } });
  fireEvent.click(screen.getByRole('button', { name: 'Place view' }));
  expect(session.activeId).toBe(layout.id);
  const view = [...layout.doc.state.pages.get(layout.activePageId)!.entities.values()][0]!;
  expect(view.drawingView?.denominator).toBe(100);
  expect(view.points[1]).toEqual([80, 20]);
});
it('inserts into an open model through the dialog', () => {
  const model = session.active;
  if (model.type !== 'model') throw new Error('Expected model');
  const source = session.newDrawing();
  source.commands.execute('layout.shape.add', { pageId: source.activePageId, points: [[0, 0], [6000, 0], [6000, 4000], [0, 4000]], closed: true });
  render(<ScaleDrawingPanel tab={source} session={session} />);
  fireEvent.click(screen.getByRole('button', { name: 'Insert into model…' }));
  fireEvent.click(screen.getByRole('button', { name: 'Insert sketch' }));
  expect(session.activeId).toBe(model.id);
  expect(model.app.document.doc.rootDefinition.entities.sketch.faces.size).toBe(1);
});
