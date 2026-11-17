// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterAll, describe, expect, it } from 'vitest';
import { builderCommands, CommandRegistry, componentCommands, contextCommands, DocumentHost, editCommands, groupCommands, materialCommands, modelCommands, SERVICE_DOCUMENT, SERVICE_KERNEL, tagCommands, transformCommands } from '@pushform/commands';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import { ModelDocumentApi } from './modelApi';

const inch = 0.0254, i = (n: number) => n * inch;
const kernels: KernelClient[] = [];
afterAll(() => { for (const k of kernels) k.dispose(); });
function api() {
  const host = new DocumentHost(), kernel = new KernelClient(new InlineBackend());
  kernels.push(kernel);
  const commands = new CommandRegistry({ tx: host, services: new Map<string, unknown>([[SERVICE_DOCUMENT, host], [SERVICE_KERNEL, kernel]]) });
  for (const group of [editCommands, modelCommands, transformCommands, groupCommands, componentCommands, contextCommands, tagCommands, materialCommands, builderCommands]) commands.registerAll(group);
  return new ModelDocumentApi(commands, 'AI Chat');
}

describe('kitchen_run around a corner', () => {
  const styles = ['diagonal', 'l_shaped', 'blind'] as const;
  it.each(styles.flatMap(style => (['left', 'right'] as const).map(side => [style, side] as const)))('%s corner on the %s leaves no overlaps', async (style, side) => {
    const a = api();
    const params = {
      base: [{ width: i(24) }, { width: i(30), appliance: 'range' }, { width: i(36), sinkFront: true }], wall: [{ width: i(30) }, { width: i(30) }],
      corner: { style, side, returnBase: [{ width: i(24) }, { width: i(30), appliance: 'range' }, { width: i(18) }], returnWall: [{ width: i(30) }] },
    };
    await a.apply({ expectedRevision: a.revision, label: 'Run', operations: [{ op: 'build', builder: 'kitchen_run', params }] });
    const report = await a.findOverlaps({ container: null, minVolume: null });
    expect(report.overlaps.map(o => `${o.a.name} / ${o.b.name}`)).toEqual([]);
  }, 120_000);

  it('lets cabinets in one run have different finishes', async () => {
    const a = api();
    const result = await a.apply({ expectedRevision: a.revision, label: 'Run', operations: [{ op: 'build', builder: 'kitchen_run', params: { base: [{ width: i(24), doorStyle: 'glass', glass: { type: 'seeded' } }, { width: i(24), doorStyle: 'glass', glass: { type: 'reeded' } }] } }] });
    expect(result.ok).toBe(true);
    const names = a.getDocument().materials.map(m => m.name);
    expect(names).toEqual(expect.arrayContaining(['Seeded Glass', 'Reeded Glass']));
  }, 60_000);
});
