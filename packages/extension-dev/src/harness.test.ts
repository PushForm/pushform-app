// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it, vi } from 'vitest';
import type { ExtensionContext, UiNode } from '@pushform/extension-sdk';
import { createTestHost } from './harness.ts';

/** A small extension written against the SDK alone, as a publisher would. */
const counter = {
  async activate(context: ExtensionContext) {
    const settings = context.settings!;
    let count = Number((await settings.get()).count ?? 0);
    let seq = 0;
    const view = (): UiNode => ({ type: 'stack', id: 'root', children: [
      { type: 'text', id: 'count', text: `Pressed ${count} times` },
      { type: 'button', id: 'add', label: 'Add one' },
    ] });
    context.commands.register('com.example.counter.panel', async () => {
      await context.ui.mount({ target: 'com.example.counter.panel', seq: ++seq, tree: view() });
    });
    context.ui.onEvent(async (event) => {
      if (event.event !== 'press' || event.component !== 'add') return;
      count++;
      await settings.set({ value: { count } });
      await context.clipboard!.write({ text: String(count) });
      await context.log.write({ count });
      await context.ui.update({ target: 'com.example.counter.panel', seq: ++seq, tree: view() });
    });
  },
};

const manifest = {
  id: 'com.example.counter', name: 'Counter', publisher: 'Example', version: '1.0.0', apiVersion: '^0.1.0', editors: ['modeling' as const],
  defaultLocale: 'en', license: 'MIT', permissions: ['settings' as const, 'clipboard.write' as const],
  contributions: [{ target: 'model.panel' as const, id: 'com.example.counter.panel', name: 'Counter' }],
  settings: { version: 1, schema: {}, defaults: { count: 0 } },
};

describe('createTestHost', () => {
  it('runs an extension through the real lifecycle, interface, settings and clipboard hosts', async () => {
    const host = await createTestHost({ manifest, module: counter });
    await host.invoke('com.example.counter.panel');
    expect(host.tree('com.example.counter.panel')).toMatchObject({ children: [{ text: 'Pressed 0 times' }, { id: 'add' }] });
    expect(host.press('com.example.counter.panel', 'add')).toBe(true);
    await vi.waitFor(() => expect(host.tree('com.example.counter.panel')).toMatchObject({ children: [{ text: 'Pressed 1 times' }, {}] }));
    expect(host.clipboard).toEqual([{ text: '1' }]);
    expect(host.logs).toEqual([{ count: 1 }]);
    expect(host.press('com.example.counter.panel', 'missing')).toBe(false);
    await host.close();
    expect(host.session.state).toBe('stopped');
  });

  it('applies grants, so missing permissions fail as they would in PushForm', async () => {
    const host = await createTestHost({ manifest, module: counter, grants: ['clipboard.write'] });
    await expect(host.session.activate()).rejects.toMatchObject({ code: 'permission.denied', details: { permissions: ['settings'] } });
  });
});
