// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterAll, describe, expect, it } from 'vitest';
import {
  builderCommands, builderPartMesh, CommandRegistry, componentCommands, contextCommands, DocumentHost, editCommands, groupCommands, materialCommands, modelCommands, SERVICE_DOCUMENT, SERVICE_KERNEL, tagCommands, transformCommands,
  type BuilderPlan,
} from '@pushform/commands';
import { MODEL_BUILDERS, MODEL_BUILDER_KEYS, modelBuilderInfo, modelBuilderList } from '@pushform/extension-protocol';
import { meshSignedVolume } from '@pushform/core';
import { InlineBackend, KernelClient, validateSolidMesh } from '@pushform/kernel';
import { BUILDER_PLANNERS } from './builders';
import { ModelApiFailure, ModelDocumentApi, runModelTool } from './modelApi';

const kernels: KernelClient[] = [];
afterAll(() => { for (const k of kernels) k.dispose(); });

function setup() {
  const host = new DocumentHost();
  const kernel = new KernelClient(new InlineBackend());
  kernels.push(kernel);
  const commands = new CommandRegistry({ tx: host, services: new Map<string, unknown>([[SERVICE_DOCUMENT, host], [SERVICE_KERNEL, kernel]]) });
  for (const group of [editCommands, modelCommands, transformCommands, groupCommands, componentCommands, contextCommands, tagCommands, materialCommands, builderCommands]) commands.registerAll(group);
  return { host, api: new ModelDocumentApi(commands, 'AI Chat'), root: () => host.doc.rootDefinition.entities };
}
const allParts = (plan: BuilderPlan): BuilderPlan['parts'] => [...plan.parts, ...(plan.children ?? []).flatMap(c => allParts(c))];

/** Every builder inherits these checks by registering; its own tests cover what is particular to it. */
describe.each(MODEL_BUILDER_KEYS)('builder %s', (key) => {
  const spec = MODEL_BUILDERS[key];
  const planner = BUILDER_PLANNERS[key] as (params: never) => BuilderPlan;
  const params = spec.schema.parse(spec.example) as never;

  it('keeps its one-line summary short and says when not to use it', () => {
    expect(spec.summary.length).toBeLessThanOrEqual(90);
    expect(spec.guidance.length).toBeGreaterThan(40);
    expect(modelBuilderList()).toContain(`${key}: `);
    expect(modelBuilderInfo(key).parameters).toMatchObject({ type: 'object' });
  });

  it('plans closed, positive, right-handed parts from its example', async () => {
    const parts = allParts(planner(params));
    expect(parts.length).toBeGreaterThan(0);
    for (const part of parts) {
      expect(part.size.every(s => s > 0), part.name).toBe(true);
      const [a, b, c] = [part.x, part.y, part.z];
      const det = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
      expect(det, `${part.name} must not be mirrored`).toBeCloseTo(1, 9);
      const mesh = builderPartMesh(part);
      await expect(validateSolidMesh(mesh), part.name).resolves.toBeUndefined();
      expect(meshSignedVolume(mesh), part.name).toBeGreaterThan(0);
    }
  });

  it('generates its example as one named group and one undo step, with no overlaps', async () => {
    const s = setup();
    const before = s.root().instances.size;
    const result = await s.api.apply({ expectedRevision: s.api.revision, label: 'Build', operations: [{ op: 'build', as: 'made', builder: key, params: spec.example }] });
    expect(s.root().instances.size).toBe(before + 1);
    expect(result.results[0]).toMatchObject({ op: 'build', id: result.created.made });
    expect(result.results[0]!.parts!.length).toBeGreaterThan(0);
    const report = await s.api.findOverlaps({ container: null, minVolume: null });
    expect(report.overlaps.map(o => `${o.a.name} / ${o.b.name}`)).toEqual([]);
    s.host.undoStack.undo();
    expect(s.root().instances.size).toBe(before);
  }, 60_000);
});

describe('the build operation', () => {
  it('refuses parameters the builder does not accept, changing nothing', async () => {
    const s = setup();
    const revision = s.api.revision;
    await expect(s.api.apply({ expectedRevision: revision, label: 'x', operations: [{ op: 'build', builder: 'countertop', params: {} }] })).rejects.toBeInstanceOf(ModelApiFailure);
    expect(s.api.revision).toBeGreaterThanOrEqual(revision);
    expect(s.root().instances.size).toBe(0);
  });

  it('refuses an unknown builder', async () => {
    const s = setup();
    await expect(s.api.apply({ expectedRevision: s.api.revision, label: 'x', operations: [{ op: 'build', builder: 'nope', params: {} }] })).rejects.toMatchObject({ error: { code: 'invalid_operation' } });
  });

  it('explains a builder through the info tool, and refuses an unknown one', async () => {
    const s = setup();
    const known = await runModelTool(s.api, 'model_builder_info', { builder: MODEL_BUILDER_KEYS[0] });
    expect(known.isError).toBe(false);
    expect(JSON.parse(known.content)).toMatchObject({ builder: MODEL_BUILDER_KEYS[0], parameters: { type: 'object' } });
    expect((await runModelTool(s.api, 'model_builder_info', { builder: 'nope' })).isError).toBe(true);
  });
});
