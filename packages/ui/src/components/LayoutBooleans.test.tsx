// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { openLayoutFile } from '@pushform/io';
import { createLayoutEllipse } from '@pushform/layout';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';
import { CommandSearch } from './CommandSearch';
import { commandSearchSourceFor } from './commandSearchSource';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it.each(['Union', 'Difference', 'Intersection', 'Exclusion', 'Division', 'Cut Path'])(
  '%s previews, commits and saves smooth editable curves with undo/redo',
  async (name) => {
    const { session, tab, pageId, choose, click, page, dispose } = setup();
    const untouched = new Set(page().entities.keys());
    act(() => {
      tab.commands.execute('layout.shape.add', {
        pageId,
        ...createLayoutEllipse([150, 60], 30, 30),
      });
      tab.commands.execute('layout.rectangle.add', {
        pageId,
        kind: 'rectangle',
        first: [145, 20],
        second: [185, 100],
      });
    });
    const before = tab.doc.state;
    choose(name);
    click(125, 60);
    click(175, 60);
    const preview = screen.getByLabelText('Boolean result preview');
    expect(
      [...preview.querySelectorAll('path')].every((p) => p.getAttribute('d')?.includes('C')),
    ).toBe(true);
    expect(tab.doc.state).toBe(before);
    fireEvent.click(screen.getByRole('button', { name: 'Apply boolean' }));
    const pieces = [...page().entities.values()].filter((e) => !untouched.has(e.id));
    expect(pieces).toHaveLength(name === 'Division' || name === 'Cut Path' ? 2 : 1);
    expect(
      pieces.every((p) => p.points.length <= 14 && p.handles?.some((h) => h.in || h.out)),
    ).toBe(true);
    const restored = (await openLayoutFile((await session.saveLayoutBytes(tab.id))));
    for (const piece of pieces)
      expect(restored.state.pages.get(pageId)?.entities.get(piece.id)).toEqual(piece);
    act(() => {
      tab.commands.execute('edit.undo');
    });
    expect(tab.doc.state).toEqual(before);
    act(() => {
      tab.commands.execute('edit.redo');
    });
    for (const piece of pieces) expect(page().entities.get(piece.id)).toEqual(piece);
    dispose();
  },
);

function setup() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: 891,
    height: 630,
    right: 891,
    bottom: 630,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(
    app,
    () => createApp({ demo: false, expose: false }),
    false,
    null,
  );
  const tab = session.newLayout(),
    pageId = tab.activePageId;
  const add = (first: number[], second: number[]) =>
    tab.commands.execute('layout.rectangle.add', {
      pageId,
      kind: 'rectangle',
      first,
      second,
    }) as number;
  const targetId = add([20, 20], [80, 80]),
    cutterId = add([40, 40], [60, 60]);
  const view = render(<LayoutWorkspace tab={tab} session={session} />);
  const canvas = screen.getByLabelText('Page 1 canvas');
  const click = (x: number, y: number) => {
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: x * 3, clientY: y * 3 });
    fireEvent.pointerUp(canvas, { button: 0, pointerId: 1, clientX: x * 3, clientY: y * 3 });
  };
  const choose = (name: string) => {
    fireEvent.click(screen.getByRole('button', { name: 'Boolean tools' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name }));
  };
  const page = () => tab.doc.state.pages.get(pageId)!;
  return {
    session,
    tab,
    pageId,
    targetId,
    cutterId,
    canvas,
    click,
    choose,
    page,
    view,
    dispose: () => {
      cleanup();
      session.dispose();
      app.dispose();
    },
  };
}

it('puts contextual controls in a tool-titled right pane with Apply first and leaves the toolbar free of inputs', () => {
  const { choose, dispose } = setup();
  choose('Difference');
  const pane = screen.getByRole('region', { name: 'Difference tool options' });
  expect(pane.closest('aside')?.getAttribute('aria-label')).toBe('Layout settings');
  expect(within(pane).getByRole('heading', { name: 'Difference' })).toBeTruthy();
  expect(within(pane).getAllByRole('button')[0]!.textContent).toBe('Apply boolean');
  const toolbar = screen.getByRole('navigation', { name: 'Layout tools' });
  expect(toolbar.querySelector('input, select, .pf-layout-tool-option')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Table' }));
  expect(screen.queryByRole('region', { name: 'Difference tool options' })).toBeNull();
  const tablePane = screen.getByRole('region', { name: 'Table tool options' });
  fireEvent.change(within(tablePane).getByLabelText('Table rows'), { target: { value: '5' } });
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  expect(screen.queryByRole('region', { name: 'Table tool options' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Table' }));
  expect((screen.getByLabelText('Table rows') as HTMLInputElement).value).toBe('5');
  dispose();
});

it('picks the target before cutters, previews without mutation, and commits a hole with undo and persistence', async () => {
  const { session, tab, targetId, cutterId, canvas, click, choose, page, dispose } = setup();
  const original = tab.doc.state,
    version = tab.doc.version;
  choose('Difference');
  expect(canvas.getAttribute('data-tool')).toBe('boolean-subtract');
  click(25, 25);
  click(50, 50);
  expect(screen.getByLabelText('Boolean result preview')).toBeTruthy();
  expect(tab.doc.state).toBe(original);
  expect(tab.doc.version).toBe(version);
  fireEvent.keyDown(window, { key: 'Enter' });
  expect(page().entities.has(targetId)).toBe(false);
  expect(page().entities.has(cutterId)).toBe(false);
  const result = [...page().entities.values()][0]!;
  expect(result.contourStarts).toHaveLength(2);
  expect(canvas.getAttribute('data-tool')).toBe('boolean-subtract');
  expect(screen.queryByLabelText('Boolean result preview')).toBeNull();
  expect(
    (await openLayoutFile((await session.saveLayoutBytes(tab.id))))
      .state.pages.get(page().id)!
      .entities.get(result.id),
  ).toEqual(result);
  act(() => {
    tab.commands.execute('edit.undo');
  });
  expect(tab.doc.state).toEqual(original);
  act(() => {
    tab.commands.execute('edit.redo');
  });
  expect(page().entities.get(result.id)).toEqual(result);
  dispose();
});

it('can pick behind an already-picked target and explains an empty result before applying', () => {
  const { tab, canvas, click, choose, page, dispose } = setup();
  const original = tab.doc.state;
  choose('Difference');
  // The small, frontmost shape is the target. The next click reaches the larger shape behind it.
  click(50, 50);
  click(50, 50);
  expect(screen.getByRole('group', { name: 'Boolean operation' }).textContent).toContain(
    'Empty result',
  );
  expect(tab.doc.state).toBe(original);
  fireEvent.click(screen.getByRole('button', { name: 'Apply boolean' }));
  expect(page().entities.size).toBe(0);
  expect(canvas.getAttribute('data-tool')).toBe('boolean-subtract');
  act(() => {
    tab.commands.execute('edit.undo');
  });
  expect(tab.doc.state).toEqual(original);
  dispose();
});

it.each(['Escape', 'pointer cancel', 'tool change', 'keyboard tool change', 'page change'])(
  'cancels pending operands on %s without changing shapes',
  (reason) => {
    const { session, tab, pageId, canvas, click, choose, view, dispose } = setup();
    let secondPage = pageId;
    if (reason === 'page change')
      act(() => {
        secondPage = tab.commands.execute('layout.page.add', { name: 'Next' }) as number;
      });
    const original = tab.doc.state;
    choose('Union');
    click(25, 25);
    click(50, 50);
    expect(screen.getByLabelText('Boolean result preview')).toBeTruthy();
    if (reason === 'Escape') fireEvent.keyDown(window, { key: 'Escape' });
    if (reason === 'pointer cancel') fireEvent.pointerCancel(canvas);
    if (reason === 'tool change') fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    if (reason === 'keyboard tool change') fireEvent.keyDown(window, { key: 'm', code: 'KeyM' });
    if (reason === 'page change') {
      act(() => {
        session.setActivePage(secondPage);
      });
      view.rerender(<LayoutWorkspace tab={tab} session={session} />);
    }
    expect(screen.queryByLabelText('Boolean result preview')).toBeNull();
    expect(tab.doc.state).toBe(original);
    choose('Union');
    expect(
      (screen.getByRole('button', { name: 'Apply boolean' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    dispose();
  },
);

it('exposes all six tools through command search before selection and remembers the stack choice', () => {
  const { tab, canvas, dispose } = setup();
  render(<CommandSearch source={() => commandSearchSourceFor(tab)} />);
  const input = screen.getByRole('combobox', { name: 'Search tools and commands' });
  for (const [name, id] of [
    ['Union', 'union'],
    ['Difference', 'subtract'],
    ['Intersection', 'intersect'],
    ['Exclusion', 'exclude'],
    ['Division', 'division'],
    ['Cut Path', 'cut-path'],
  ] as const) {
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: name } });
    const option = screen.getByRole('option', { name });
    expect(option.getAttribute('aria-disabled')).not.toBe('true');
    fireEvent.click(option);
    expect(canvas.getAttribute('data-tool')).toBe(`boolean-${id}`);
    expect(screen.getByRole('button', { name }).getAttribute('aria-pressed')).toBe('true');
  }
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  expect(
    within(screen.getByRole('group', { name: 'Modify' })).getByRole('button', { name: 'Cut Path' }),
  ).toBeTruthy();
  dispose();
});

it('rejects locked cutters and revalidates a target changed after picking', () => {
  const { tab, pageId, targetId, cutterId, click, choose, page, dispose } = setup();
  act(() => {
    tab.doc.transact('Lock cutter', (draft) => {
      draft.pages.get(pageId)!.entities.get(cutterId)!.locked = true;
    });
  });
  choose('Difference');
  click(25, 25);
  click(50, 50);
  expect(screen.getByRole('alert').textContent).toContain('unlocked');
  expect(page().entities.size).toBe(2);
  act(() => {
    tab.doc.transact('Unlock cutter', (draft) => {
      draft.pages.get(pageId)!.entities.get(cutterId)!.locked = false;
    });
  });
  click(50, 50);
  act(() => {
    tab.doc.transact('Lock target', (draft) => {
      draft.pages.get(pageId)!.entities.get(targetId)!.locked = true;
    });
  });
  const original = tab.doc.state;
  fireEvent.keyDown(window, { key: 'Enter' });
  expect(screen.getByRole('alert').textContent).toContain('locked');
  expect(tab.doc.state).toBe(original);
  dispose();
});

it.each(['Division', 'Cut Path'])(
  '%s accepts an open cutter and previews and saves separate pieces',
  async (name) => {
    const { session, tab, pageId, targetId, cutterId, choose, click, page, canvas, dispose } =
      setup();
    let lineId = 0;
    act(() => {
      lineId = tab.commands.execute('layout.shape.add', {
        pageId,
        points: [
          [30, 10],
          [30, 90],
        ],
        closed: false,
      }) as number;
    });
    const original = tab.doc.state;
    choose(name);
    click(70, 70);
    click(30, 30);
    const preview = screen.getByLabelText('Boolean result preview');
    expect(preview.querySelectorAll('path')).toHaveLength(2);
    if (name === 'Cut Path')
      expect(
        [...preview.querySelectorAll('path')].every((path) => path.style.fill === 'none'),
      ).toBe(true);
    expect(tab.doc.state).toBe(original);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(page().entities.has(targetId)).toBe(false);
    expect(page().entities.has(lineId)).toBe(false);
    const pieces = [...page().entities.values()].filter((entity) => entity.id !== cutterId);
    expect(pieces).toHaveLength(2);
    expect(pieces.every((entity) => entity.closed === (name === 'Division'))).toBe(true);
    if (name === 'Cut Path')
      expect(pieces.every((entity) => entity.style?.fillColor === null)).toBe(true);
    expect(canvas.getAttribute('data-tool')).toBe(
      name === 'Division' ? 'boolean-division' : 'boolean-cut-path',
    );
    const restored = (await openLayoutFile((await session.saveLayoutBytes(tab.id))));
    for (const piece of pieces)
      expect(restored.state.pages.get(pageId)?.entities.get(piece.id)).toEqual(piece);
    act(() => {
      tab.commands.execute('edit.undo');
    });
    expect(tab.doc.state).toEqual(original);
    dispose();
  },
);

it('Cut Path accepts an open target and a closed cutter without inventing closing segments', () => {
  const { tab, pageId, choose, click, page, dispose } = setup();
  let target = 0;
  act(() => {
    target = tab.commands.execute('layout.shape.add', {
      pageId,
      points: [
        [10, 50],
        [90, 50],
      ],
      closed: false,
    }) as number;
  });
  choose('Cut Path');
  click(15, 50);
  click(50, 50);
  fireEvent.click(screen.getByRole('button', { name: 'Apply boolean' }));
  expect(page().entities.has(target)).toBe(false);
  const pieces = [...page().entities.values()].filter((entity) => !entity.closed);
  expect(pieces.map((entity) => entity.points)).toEqual([
    [
      [10, 50],
      [40, 50],
    ],
    [
      [40, 50],
      [expect.closeTo(60, 8), 50],
    ],
    [
      [expect.closeTo(60, 8), 50],
      [90, 50],
    ],
  ]);
  dispose();
});
