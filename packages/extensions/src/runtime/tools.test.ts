// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandRegistry, DocumentHost, SERVICE_DOCUMENT, SERVICE_KERNEL, modelCommands, transformCommands } from '@pushform/commands';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import { ModelDocumentApi } from '../modelApi';
import type { ServiceCall, ExtensionSession } from './host';
import { ExtensionToolHost } from './tools';
import type { ToolInput, ToolSource, ToolStopReason } from '@pushform/extension-protocol';

const kernels: KernelClient[] = [], hosts: ExtensionToolHost[] = [];
afterEach(() => { for (const host of hosts.splice(0)) host.end(); for (const kernel of kernels.splice(0)) kernel.dispose(); });
function setup(write = true) {
  const host = new DocumentHost(), kernel = new KernelClient(new InlineBackend()); kernels.push(kernel);
  const commands = new CommandRegistry({ tx: host, services: new Map<string, unknown>([[SERVICE_DOCUMENT, host], [SERVICE_KERNEL, kernel]]) });
  commands.registerAll([...modelCommands, ...transformCommands]);
  const id = commands.execute('model.addBox', { min: [0, 0, 0], max: [1, 1, 1] }) as number;
  const api = new ModelDocumentApi(commands, 'Part tools'), stopped: ToolStopReason[] = [];
  const apply = vi.fn((input, call: ServiceCall) => api.apply(input, call.signal, call.separateUndo ? () => {} : undefined, undefined, call.amendToolUndo));
  const inputs: ToolInput[] = []; let emit!: (source: ToolSource) => void, contextVersion = 0;
  const session = { openDocument: (id: string) => `opaque:${id}`, notify(component: string, event: string, input: ToolInput) { if (component === 'tools' && event === 'input') inputs.push(input); }, noteUserAction() {} } as unknown as ExtensionSession;
  const tools = new ExtensionToolHost({ open: request => { emit = request.input; return { stamp: () => ({ revision: api.revision, contextVersion, cameraVersion: 0, context: [] }),
    present() {}, close: reason => stopped.push(reason) }; } }, () => session, { grants: new Set(write ? ['model.write'] : []), apply }); hosts.push(tools);
  const services = tools.services(), call = { signal: new AbortController().signal } as ServiceCall;
  const begin = () => tools.begin('model-A', 'Stretch');
  const edit = (session: string) => ({ session, sequence: 0, batch: { expectedRevision: api.revision, label: 'Stretch', operations: [
    { op: 'scale', refs: [{ kind: 'body', id }], origin: [0, 0, 0], factors: [2, 1, 1] },
  ] } });
  return { host, commands, api, tools, apply, services, call, begin, edit, stopped, inputs, resync: () => emit({ kind: 'resync', data: {} }), contextChanged: () => { contextVersion++; }, volume: () => host.doc.rootDefinition.entities.bodies.get(id as never)!.props.volume };
}
describe('tool geometry commits', () => {
  it('binds edits to the tool document/context and blocks acknowledgements or another edit while committing', async () => {
    const s = setup(), tool = s.begin(), input = s.edit(tool.input.session);
    const pending = Promise.resolve(s.services['tools.apply']!(input, s.call));
    await expect(s.services['tools.apply']!(input, s.call)).rejects.toMatchObject({ code: 'unavailable' });
    expect(() => s.services['tools.ack']!({ session: input.session, sequence: 0 }, s.call)).toThrow(/finish/);
    await pending;
    expect(s.volume()).toBeCloseTo(2);
    expect(s.apply.mock.calls[0]![0]).toMatchObject({ document: 'opaque:model-A', container: [] });
    s.host.undo(); expect(s.volume()).toBeCloseTo(1);
  });
  it.each(['cancelled', 'disabled', 'document.closed', 'runtime.failed'] as const)('aborts a pending kernel edit on %s, leaving geometry unchanged', async reason => {
    const s = setup(), tool = s.begin();
    const pending = Promise.resolve(s.services['tools.apply']!(s.edit(tool.input.session), s.call));
    s.tools.end(reason);
    await expect(pending).rejects.toMatchObject({ error: { code: 'cancelled' } });
    expect(s.volume()).toBeCloseTo(1); expect(s.stopped).toEqual([reason]);
  });
  it('refuses missing write permission, stale input revisions and a different target container before editing', async () => {
    const denied = setup(false), first = denied.begin();
    await expect(denied.services['tools.apply']!(denied.edit(first.input.session), denied.call)).rejects.toMatchObject({ code: 'permission.denied' });
    expect(denied.apply).not.toHaveBeenCalled();
    const s = setup(), tool = s.begin(), input = s.edit(tool.input.session);
    await expect(s.services['tools.apply']!({ ...input, batch: { ...input.batch, expectedRevision: input.batch.expectedRevision + 1 } }, s.call)).rejects.toMatchObject({ code: 'revision.stale' });
    await expect(s.services['tools.apply']!({ ...input, batch: { ...input.batch, container: [100] } }, s.call)).rejects.toMatchObject({ code: 'validation.failed' });
    await expect(s.services['tools.apply']!({ ...input, batch: { ...input.batch, document: 'model-B' } }, s.call)).rejects.toMatchObject({ code: 'validation.failed' });
    expect(s.apply).not.toHaveBeenCalled();
  });
});


it('gives consecutive unnamed tool gestures independent Undo entries', async () => {
  const s = setup(), first = s.begin();
  await s.services['tools.apply']!(s.edit(first.input.session), s.call); s.tools.end();
  const second = s.begin(); await s.services['tools.apply']!(s.edit(second.input.session), s.call);
  expect(s.volume()).toBeCloseTo(4); s.host.undo(); expect(s.volume()).toBeCloseTo(2); s.host.undo(); expect(s.volume()).toBeCloseTo(1);
});


it('amends only the same live tool last gesture and retains one Undo action', async () => {
  const s = setup(), tool = s.begin();
  await s.services['tools.apply']!(s.edit(tool.input.session), s.call);
  s.services['tools.ack']!({ session: tool.input.session, sequence: 0 }, s.call); s.resync();
  const next = s.inputs.at(-1)!;
  await s.services['tools.apply']!({ ...s.edit(tool.input.session), sequence: next.sequence, amendPrevious: true }, s.call);
  expect(s.volume()).toBeCloseTo(4); s.host.undo(); expect(s.volume()).toBeCloseTo(1);
});
it.each(['external edit', 'context change', 'replacement'] as const)('refuses amendment after %s', async kind => {
  const s = setup(); let tool = s.begin();
  await s.services['tools.apply']!(s.edit(tool.input.session), s.call);
  s.services['tools.ack']!({ session: tool.input.session, sequence: 0 }, s.call);
  if (kind === 'external edit') s.commands.execute('model.addBox', { min: [4, 0, 0], max: [5, 1, 1] });
  if (kind === 'context change') s.contextChanged();
  if (kind === 'replacement') tool = s.begin(); else s.resync();
  const next = kind === 'replacement' ? tool.input : s.inputs.at(-1)!;
  await expect(s.services['tools.apply']!({ ...s.edit(tool.input.session), sequence: next.sequence, amendPrevious: true }, s.call)).rejects.toMatchObject({ code: 'revision.stale' });
  expect(s.volume()).toBeCloseTo(2);
});
