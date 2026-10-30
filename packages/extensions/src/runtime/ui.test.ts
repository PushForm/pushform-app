// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExtensionError, extensionManifestSchema, type ExtensionManifest } from '@pushform/extension-protocol';
import { startGuest, type ExtensionContext } from './guest';
import { ExtensionSession } from './host';
import { messagePortTransport } from './port';
import { ExtensionUiHost, type UiEventMessage } from './ui';

const manifest: ExtensionManifest = extensionManifestSchema.parse({
  id: 'com.example.parts', name: 'Parts', publisher: 'Example', version: '1.0.0', apiVersion: '^0.1.0',
  editors: ['modeling'], defaultLocale: 'en', license: 'MIT', files: {}, permissions: [],
  contributions: [
    { target: 'model.panel', id: 'com.example.parts.panel', name: 'Parts' },
    { target: 'model.command', id: 'com.example.parts.open', name: 'Open parts' },
  ],
});
const PANEL = 'com.example.parts.panel';
const button = (label: string, disabled = false) => ({ type: 'stack', id: 'root', children: [{ type: 'button', id: 'go', label, disabled }] });

const failure = (run: () => unknown): ExtensionError => {
  try { run(); } catch (error) { if (error instanceof ExtensionError) return error; throw error; }
  throw new Error('expected an ExtensionError');
};

describe('ExtensionUiHost', () => {
  it('mounts, updates with newer sequence numbers, and unmounts, telling listeners each time', () => {
    const host = new ExtensionUiHost(manifest, () => {});
    const ui = host.services();
    const seen: string[] = [];
    host.subscribe((target) => seen.push(target));
    ui['ui.mount']!({ target: PANEL, seq: 1, tree: button('One') }, {} as never);
    ui['ui.update']!({ target: PANEL, seq: 2, tree: button('Two') }, {} as never);
    expect(host.get(PANEL)).toMatchObject({ seq: 2, tree: { children: [{ label: 'Two' }] } });
    ui['ui.unmount']!({ target: PANEL }, {} as never);
    expect(host.get(PANEL)).toBeUndefined();
    expect(seen).toEqual([PANEL, PANEL, PANEL]);
  });

  it('keeps the shown tree when an update is stale, invalid or too large', () => {
    const host = new ExtensionUiHost(manifest, () => {});
    const ui = host.services();
    ui['ui.mount']!({ target: PANEL, seq: 5, tree: button('Kept') }, {} as never);
    expect(failure(() => ui['ui.update']!({ target: PANEL, seq: 5, tree: button('Same seq') }, {} as never)).message).toMatch(/not newer/);
    expect(failure(() => ui['ui.update']!({ target: PANEL, seq: 6, tree: { type: 'script', id: 'x' } }, {} as never)).code).toBe('validation.failed');
    const huge = { type: 'stack', id: 'r', children: Array.from({ length: 3000 }, (_, i) => ({ type: 'divider', id: `d${i}` })) };
    expect(failure(() => ui['ui.update']!({ target: PANEL, seq: 7, tree: huge }, {} as never)).code).toBe('limit.exceeded');
    expect(host.get(PANEL)).toMatchObject({ seq: 5, tree: { children: [{ label: 'Kept' }] } });
  });

  it('accepts only the extension own panel, inspector or settings targets', () => {
    const ui = new ExtensionUiHost(manifest, () => {}).services();
    expect(failure(() => ui['ui.mount']!({ target: 'com.example.parts.open', seq: 1, tree: button('x') }, {} as never)).message).toMatch(/not a panel/);
    expect(failure(() => ui['ui.mount']!({ target: 'com.other.panel', seq: 1, tree: button('x') }, {} as never)).message).toMatch(/not a panel/);
    expect(failure(() => ui['ui.update']!({ target: PANEL, seq: 1, tree: button('x') }, {} as never)).message).toMatch(/not mounted/);
  });

  it('sends only events that fit the tree on screen', () => {
    const sent: UiEventMessage[] = [];
    const host = new ExtensionUiHost(manifest, (e) => sent.push(e));
    const ui = host.services();
    expect(host.dispatch(PANEL, { component: 'go', event: 'press' })).toBe(false);
    ui['ui.mount']!({ target: PANEL, seq: 1, tree: { type: 'stack', id: 'root', children: [
      { type: 'button', id: 'go', label: 'Go' }, { type: 'button', id: 'off', label: 'Off', disabled: true },
      { type: 'numberField', id: 'kerf', label: 'Kerf', value: 0.003, quantity: 'length' },
      { type: 'table', id: 't', label: 'T', selection: 'single', columns: [{ id: 'n', label: 'N', kind: 'text', editable: true }, { id: 'q', label: 'Q', kind: 'number' }],
        rows: [{ id: 'r1', cells: { n: 'a', q: 1 } }] },
    ] } }, {} as never);
    expect(host.dispatch(PANEL, { component: 'go', event: 'press' })).toBe(true);
    expect(host.dispatch(PANEL, { component: 'off', event: 'press' })).toBe(false);
    expect(host.dispatch(PANEL, { component: 'missing', event: 'press' })).toBe(false);
    expect(host.dispatch(PANEL, { component: 'kerf', event: 'change', value: 0.004 })).toBe(true);
    expect(host.dispatch(PANEL, { component: 'kerf', event: 'change', value: 'wide' })).toBe(false);
    expect(host.dispatch(PANEL, { component: 't', event: 'cellEdit', row: 'r1', column: 'n', value: 'b' })).toBe(true);
    expect(host.dispatch(PANEL, { component: 't', event: 'cellEdit', row: 'r1', column: 'q', value: 2 })).toBe(false);
    expect(host.dispatch(PANEL, { component: 't', event: 'rowSelect', rows: ['r1', 'r1'] })).toBe(false);
    host.close(PANEL);
    expect(host.dispatch(PANEL, { component: 'go', event: 'press' })).toBe(false);
    expect(sent.map((e) => e.event)).toEqual(['press', 'change', 'cellEdit']);
    expect(sent[0]).toEqual({ target: PANEL, component: 'go', event: 'press' });
  });
});

describe('interface round trip', () => {
  const channels: MessageChannel[] = [];
  afterEach(() => { for (const c of channels.splice(0)) { c.port1.close(); c.port2.close(); } });

  it('lets an extension mount a panel, hear a press and update the panel', async () => {
    const channel = new MessageChannel();
    channels.push(channel);
    const ref: { session?: ExtensionSession } = {};
    const host = new ExtensionUiHost(manifest, (event) => ref.session?.postEvent(event));
    const session = ref.session = new ExtensionSession({ manifest, grants: [], port: messagePortTransport(channel.port1), services: host.services() });
    type Ui = { mount(i: unknown): Promise<unknown>; update(i: unknown): Promise<unknown>; onEvent(h: (e: { component: string; event: string }) => void): () => void };
    void startGuest(messagePortTransport(channel.port2), async () => ({
      async activate(context: ExtensionContext) {
        const ui = context.ui as Ui;
        let presses = 0;
        await ui.mount({ target: PANEL, seq: 1, tree: button('Pressed 0 times') });
        ui.onEvent((e) => {
          if (e.component === 'go' && e.event === 'press') void ui.update({ target: PANEL, seq: ++presses + 1, tree: button(`Pressed ${presses} times`) });
        });
      },
    }));
    await session.activate();
    await vi.waitFor(() => expect(host.get(PANEL)?.seq).toBe(1));
    expect(host.dispatch(PANEL, { component: 'go', event: 'press' })).toBe(true);
    await vi.waitFor(() => expect(host.get(PANEL)).toMatchObject({ seq: 2, tree: { children: [{ label: 'Pressed 1 times' }] } }));
  });
});
