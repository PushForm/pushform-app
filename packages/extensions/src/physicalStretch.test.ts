// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  basisToLocal,
  m4mul,
  m4transformPoint,
  m4translation,
  meshBounds,
  type CurveId,
  type Id,
  type Vec3,
} from '@pushform/core';
import { InlineBackend, KernelClient, meshTopologyProblems } from '@pushform/kernel';
import {
  CommandRegistry,
  DocumentHost,
  SERVICE_DOCUMENT,
  SERVICE_KERNEL,
  componentCommands,
  curvePoints,
  editCommands,
  groupCommands,
  materialCommands,
  modelClipboard,
  modelCommands,
  preparePhysicalStretch,
  transformCommands,
} from '@pushform/commands';
import {
  allocId,
  containerAt,
  contextMatrix,
  createImprintGraph,
  SketchGraph,
  type Body,
  type DocumentState,
  type EntityRef,
} from '@pushform/model';
import { extensionManifestSchema, modelMetadataBatchSchema } from '@pushform/extension-protocol';
import { ModelDocumentApi } from './modelApi';
import { ModelMetadataApi } from './metadataApi';
import { applyModelWithMetadata, applyStagedModelWithMetadata } from './modelMetadataBatch';

const kernels: KernelClient[] = [];
afterEach(() => {
  for (const kernel of kernels.splice(0)) kernel.dispose();
  modelClipboard.set(null);
});
async function setup() {
  const host = new DocumentHost(),
    kernel = new KernelClient(new InlineBackend());
  kernels.push(kernel);
  const commands = new CommandRegistry({
    tx: host,
    services: new Map<string, unknown>([
      [SERVICE_DOCUMENT, host],
      [SERVICE_KERNEL, kernel],
    ]),
  });
  for (const set of [
    editCommands,
    modelCommands,
    groupCommands,
    componentCommands,
    transformCommands,
    materialCommands,
  ])
    commands.registerAll(set);
  const api = new ModelDocumentApi(commands, 'Stretch');
  const profile = await api.apply({
    expectedRevision: host.doc.version,
    label: 'Curved fixture',
    operations: [
      {
        op: 'add_part',
        as: 'source',
        points: Array.from({ length: 24 }, (_, i) => [
          Math.cos((i * Math.PI) / 12 + Math.PI / 24) * 0.1,
          Math.sin((i * Math.PI) / 12 + Math.PI / 24) * 0.1,
          0,
        ]),
        normal: [0, 0, 1],
        distance: 0.6,
        closedCurve: true,
      },
    ],
  });
  const body = profile.results![0]!.refs![0]!.id;
  const inner = (
    commands.execute('component.make', {
      refs: [{ kind: 'body', id: body, path: [] }],
      name: 'Round stock',
    }) as { instanceId: number }
  ).instanceId;
  const sibling = (
    (await commands.execute('transform.apply', {
      refs: [{ kind: 'instance', id: inner, path: [] }],
      matrix: m4translation([0.4, 0, 0]),
      copy: true,
    })) as { refs: EntityRef[] }
  ).refs[0]!.id;
  const outer = (
    commands.execute('component.make', {
      refs: [
        { kind: 'instance', id: inner, path: [] },
        { kind: 'instance', id: sibling, path: [] },
      ],
      name: 'Module',
    }) as { instanceId: number }
  ).instanceId;
  const other = (
    (await commands.execute('transform.apply', {
      refs: [{ kind: 'instance', id: outer, path: [] }],
      matrix: m4translation([0, 3, 0]),
      copy: true,
    })) as { refs: EntityRef[] }
  ).refs[0]!.id;
  host.doc.transact('Opaque fixture', (draft) => {
    const b = containerAt(draft as unknown as DocumentState, [outer, inner] as Id[]).bodies.get(
      body as Id,
    )!;
    const face = [...b.faces.values()].find((f) => f.plane.n[2] > 0.9)!,
      graph = createImprintGraph();
    graph.nativeUnknownFields = [new Uint8Array([255, 0, 128])];
    b.imprints.set(face.id, graph);
    const definition = draft.definitions.get(
      containerAt(draft as unknown as DocumentState, [outer] as Id[]).instances.get(inner as Id)!
        .definitionId,
    )!;
    definition.nativeUnknownFields = { envelopeUnknown: [new Uint8Array([160, 6, 7])] };
    draft.pluginData = new Map([
      [
        'org.example.foreign',
        {
          dataVersion: 99,
          entries: new Map([
            [
              'physical',
              {
                target: { kind: 'bodyOccurrence', id: body as Id, path: [outer, inner] as Id[] },
                payload: new Uint8Array([255, 0, 128]),
                references: [],
              },
            ],
            [
              'shared',
              {
                target: { kind: 'body', id: body as Id },
                payload: new Uint8Array([0, 255]),
                references: [],
              },
            ],
          ]),
        },
      ],
    ]);
  });
  const run = (operations: unknown[], signal?: AbortSignal) =>
    api.apply({ expectedRevision: host.doc.version, label: 'Stretch module', operations }, signal);
  const stretch = (ref: unknown = { kind: 'instance', id: outer, path: [] }, extra = {}) => ({
    op: 'stretch_physical',
    as: 'stretched',
    ref,
    planes: [{ normal: [0, 0, 1], offset: 0.3, side: 'positive', displacement: [0, 0, 0.4] }],
    ...extra,
  });
  return { host, kernel, commands, api, body, inner, sibling, outer, other, run, stretch };
}
function bodyAt(
  s: Awaited<ReturnType<typeof setup>>,
  root: number,
  inner: number,
  id?: number,
): Body {
  const at = containerAt(s.host.doc.state, [root, inner] as Id[]);
  return id === undefined ? [...at.bodies.values()][0]! : at.bodies.get(id as Id)!;
}
function occurrenceBodies(
  s: Awaited<ReturnType<typeof setup>>,
  root: number,
): { path: Id[]; body: Body }[] {
  const at = containerAt(s.host.doc.state, [root] as Id[]);
  return [...at.instances.keys()].map((inner) => ({
    path: [root, inner] as Id[],
    body: bodyAt(s, root, inner),
  }));
}
const stable = (s: Awaited<ReturnType<typeof setup>>) => ({
  ...s.host.doc.state,
  meta: { ...s.host.doc.state.meta, nextId: 0 },
});

describe('physical assembly stretch', () => {
  it('continues proven face and edge attachments through isolation and stretching', async () => {
    const s = await setup();
    s.host.doc.transact('Tracked fixture', (draft) => {
      const record = draft.pluginData!.get('org.example.foreign')!,
        entry = record.entries.get('physical')!;
      const b = containerAt(
        draft as unknown as DocumentState,
        [s.outer, s.inner] as Id[],
      ).bodies.get(s.body as Id)!;
      const face = [...b.faces.values()].find((face) => face.plane.n[2] > 0.9)!,
        edge = [...b.edges.values()].find(
          (edge) => edge.faceA === face.id || edge.faceB === face.id,
        )!;
      entry.references = [
        {
          target: { kind: 'bodyOccurrence', id: b.id, path: [s.outer, s.inner] as Id[] },
          element: { kind: 'face', faceId: face.id, bodyVersion: b.version },
        },
        {
          target: { kind: 'bodyOccurrence', id: b.id, path: [s.outer, s.inner] as Id[] },
          element: { kind: 'edge', edgeKey: edge.key, bodyVersion: b.version },
        },
      ];
    });
    await s.run([s.stretch()]);
    const entry = s.host.doc.state.pluginData!.get('org.example.foreign')!.entries.get('physical')!;
    const target = entry.target;
    if (target.kind !== 'bodyOccurrence') throw Error('Wrong target');
    const b = containerAt(s.host.doc.state, target.path as Id[]).bodies.get(target.id as Id)!;
    for (const reference of entry.references) {
      expect(reference.unresolved).not.toBe(true);
      expect(reference.target).toEqual(target);
      expect(reference.element!.bodyVersion).toBe(b.version);
    }
    expect(entry.references[0]!.element?.kind).toBe('face');
    expect(entry.references[1]!.element?.kind).toBe('edge');
  });
  it('isolates one assembly and its deformed parts, preserves opaque data/curves and restores everything in one Undo', async () => {
    const s = await setup(),
      source = bodyAt(s, s.outer, s.inner),
      initial = stable(s),
      undo = s.host.undoStack.length;
    const selection: EntityRef[] = [{ kind: 'instance', id: s.other as Id, path: [] }];
    s.host.selection.set(selection);
    const clipboard = { marker: 'leave alone' };
    modelClipboard.set(clipboard as never);
    const result = await s.run([s.stretch()]);
    expect(result.results![0]!.refs![0]).toEqual({ kind: 'instance', id: s.outer, path: [] });
    const bodies = occurrenceBodies(s, s.outer),
      untouched = occurrenceBodies(s, s.other);
    expect(bodies).toHaveLength(2);
    for (const row of bodies) {
      expect(meshBounds(row.body.mesh).max[2]).toBeCloseTo(1, 7);
      expect(row.body.curves.size).toBe(2);
      expect(row.body.surfaces.size).toBe(1);
      expect(meshTopologyProblems(row.body.mesh)).toEqual([]);
      expect([...row.body.curves.keys()].some((id) => source.curves.has(id))).toBe(false);
      expect([...row.body.imprints.values()][0]!.nativeUnknownFields).toEqual([
        new Uint8Array([255, 0, 128]),
      ]);
      const def = s.host.doc.state.definitions.get(
        containerAt(s.host.doc.state, [s.outer] as Id[]).instances.get(row.path[1]!)!.definitionId,
      )!;
      expect(def.nativeUnknownFields).toEqual({ envelopeUnknown: [new Uint8Array([160, 6, 7])] });
    }
    expect(new Set(bodies.flatMap((row) => [...row.body.curves.keys()])).size).toBe(4);
    for (const row of untouched) expect(row.body).toBe(source);
    const foreign = s.host.doc.state.pluginData!.get('org.example.foreign')!;
    expect(foreign.dataVersion).toBe(99);
    expect(foreign.entries.get('physical')!.payload).toEqual(new Uint8Array([255, 0, 128]));
    expect(foreign.entries.get('physical')!.target).toEqual({
      kind: 'bodyOccurrence',
      id: bodies[0]!.body.id,
      path: bodies[0]!.path,
    });
    expect([...foreign.entries.values()].filter((e) => e.target.kind === 'body')).toHaveLength(3);
    expect(s.host.selection.refs).toEqual(selection);
    expect(s.host.context.path).toEqual([]);
    expect(modelClipboard.current).toBe(clipboard);
    expect(s.host.undoStack.length).toBe(undo + 1);
    s.host.undo();
    expect(stable(s)).toEqual(initial);
    s.host.redo();
    expect(
      occurrenceBodies(s, s.outer).every((row) => meshBounds(row.body.mesh).max[2] > 0.99),
    ).toBe(true);
  });

  it('moves a uniform linked subassembly by its occurrence transform without copying its definition', async () => {
    const s = await setup(),
      state = s.host.doc.state,
      original = containerAt(state, []).instances.get(s.outer as Id)!;
    const count = state.definitions.size,
      source = bodyAt(s, s.outer, s.inner),
      other = containerAt(state, []).instances.get(s.other as Id)!;
    await s.run([
      s.stretch(undefined, {
        planes: [{ normal: [0, 0, 1], offset: -1, side: 'positive', displacement: [0, 0, 2] }],
      }),
    ]);
    const moved = containerAt(s.host.doc.state, []).instances.get(s.outer as Id)!;
    expect(moved.definitionId).toBe(original.definitionId);
    expect(s.host.doc.state.definitions.size).toBe(count);
    expect(moved.transform).toEqual(m4mul(m4translation([0, 0, 2]), original.transform));
    expect(bodyAt(s, s.outer, s.inner)).toBe(source);
    expect(containerAt(s.host.doc.state, []).instances.get(s.other as Id)!.transform).toEqual(
      other.transform,
    );
  });

  it('uses the captured world frame inside a reflected/sheared ancestor', async () => {
    const s = await setup();
    await s.commands.execute('transform.apply', {
      refs: [{ kind: 'instance', id: s.outer, path: [] }],
      matrix: [-2, 0, 0, 0, 0.5, 3, 0, 0, 0.2, 0, 0.5, 0, 4, -2, 1, 1],
    });
    const result = await s.run([
      s.stretch(
        { kind: 'body', id: s.body, path: [s.outer, s.inner] },
        {
          planes: [
            { normal: [0, 0, 1], offset: 1.15, side: 'positive', displacement: [0.4, 0.3, 1] },
          ],
        },
      ),
    ]);
    const ref = result.results![0]!.refs![0]!,
      b = containerAt(s.host.doc.state, ref.path as Id[]).bodies.get(ref.id as Id)!,
      world = contextMatrix(s.host.doc.state, ref.path as Id[]);
    const z = Array.from(
      { length: b.mesh.verts.length / 3 },
      (_, i) =>
        m4transformPoint(world, [
          b.mesh.verts[i * 3]!,
          b.mesh.verts[i * 3 + 1]!,
          b.mesh.verts[i * 3 + 2]!,
        ])[2],
    );
    expect(Math.min(...z)).toBeCloseTo(1, 7);
    expect(Math.max(...z)).toBeCloseTo(2.3, 7);
    expect(b.curves.size).toBe(2);
    expect(bodyAt(s, s.other, s.inner).mesh.verts).toEqual(
      bodyAt(s, s.other, s.sibling).mesh.verts,
    );
  });

  it('supports explicit shared assembly edits without changing its root placement matrices', async () => {
    const s = await setup(),
      before = containerAt(s.host.doc.state, []).instances.get(s.outer as Id)!,
      other = containerAt(s.host.doc.state, []).instances.get(s.other as Id)!;
    await s.run([s.stretch(undefined, { scope: 'shared' })]);
    const root = containerAt(s.host.doc.state, []).instances.get(s.outer as Id)!;
    expect(root.definitionId).toBe(before.definitionId);
    expect(root.transform).toEqual(before.transform);
    expect(containerAt(s.host.doc.state, []).instances.get(s.other as Id)).toEqual(other);
    for (const root of [s.outer, s.other])
      for (const row of occurrenceBodies(s, root))
        expect(meshBounds(row.body.mesh).max[2]).toBeCloseTo(1, 7);
  });

  it('keeps the anchor fixed and updates earlier/later body aliases through isolation', async () => {
    const s = await setup(),
      source = { kind: 'body', id: s.body, path: [s.outer, s.inner] };
    const result = await s.run([
      s.stretch(source, { as: 'part', anchor: [0, 0, 0.6] }),
      {
        op: 'stretch_physical',
        as: 'again',
        ref: '$part',
        planes: [{ normal: [0, 0, 1], offset: 0, side: 'positive', displacement: [0, 0, 0.1] }],
      },
    ]);
    const first = result.results![0]!.refs![0]!,
      second = result.results![1]!.refs![0]!;
    expect(second).toEqual(first);
    const b = containerAt(s.host.doc.state, second.path as Id[]).bodies.get(second.id as Id)!;
    expect(meshBounds(b.mesh).min[2]).toBeCloseTo(-0.4, 7);
    expect(meshBounds(b.mesh).max[2]).toBeCloseTo(0.7, 7);
  });

  it('rolls back isolation, geometry and metadata on later operation/schema failure', async () => {
    const s = await setup(),
      original = stable(s),
      undo = s.host.undoStack.length;
    await expect(
      s.run([
        s.stretch(),
        {
          op: 'paint_part',
          ref: { kind: 'body', id: 99999, path: [] },
          scope: 'shared',
          materialId: null,
        },
      ]),
    ).rejects.toThrow();
    expect(stable(s)).toEqual(original);
    expect(s.host.undoStack.length).toBe(undo);
    const metadata = new ModelMetadataApi(s.commands),
      manifest = extensionManifestSchema.parse({
        id: 'org.example.stretch',
        name: 'Stretch',
        publisher: 'Example',
        version: '1.0.0',
        apiVersion: '^0.1.0',
        editors: ['modeling'],
        defaultLocale: 'en',
        license: 'MIT',
        permissions: ['model.read', 'model.write'],
        files: {},
        contributions: [{ target: 'model.command', id: 'org.example.stretch.edit', name: 'Edit' }],
        metadata: {
          dataVersion: 1,
          schema: {
            type: 'object',
            properties: { label: { type: 'string' } },
            required: ['label'],
          },
        },
      });
    await expect(
      applyModelWithMetadata(s.api, metadata, manifest, {
        expectedRevision: s.host.doc.version,
        label: 'Bad metadata',
        operations: [s.stretch()],
        metadata: modelMetadataBatchSchema.parse({
          expectedDataVersion: null,
          upserts: [
            {
              id: 'bad',
              target: { kind: 'definition', created: 'stretched' },
              value: { label: 4 },
            },
          ],
        }),
      }),
    ).rejects.toThrow();
    expect(stable(s)).toEqual(original);
    expect(s.host.undoStack.length).toBe(undo);
  });

  it('refuses curves, unsupported contents, locks and shared open-context invalidation without retained changes', async () => {
    const s = await setup(),
      original = stable(s),
      undo = s.host.undoStack.length;
    await expect(
      s.run([
        s.stretch(undefined, {
          planes: [
            { normal: [1, 0, 0], offset: 0.0997, side: 'positive', displacement: [0.1, 0, 0] },
          ],
        }),
      ]),
    ).rejects.toThrow(/curved/);
    expect(stable(s)).toEqual(original);
    expect(s.host.undoStack.length).toBe(undo);
    s.host.setContext([s.outer as Id]);
    const inside = stable(s);
    await expect(
      s.run([s.stretch({ kind: 'body', id: s.body, path: [s.outer, s.inner] })]),
    ).rejects.toThrow(/Leave this shared assembly/);
    expect(stable(s)).toEqual(inside);
    s.host.setContext([]);
    s.commands.execute('instance.setLocked', {
      refs: [{ kind: 'instance', id: s.outer, path: [] }],
      locked: true,
    });
    const locked = stable(s);
    await expect(s.run([s.stretch()])).rejects.toThrow(/Unlock/);
    expect(stable(s)).toEqual(locked);
  });

  it('rejects stale, fabricated, wrong-host and consumed native receipts', async () => {
    const s = await setup(),
      target: EntityRef = { kind: 'instance', id: s.outer as Id, path: [] },
      options = {
        planes: [
          {
            normal: [0, 0, 1] as Vec3,
            offset: 0.3,
            side: 'positive' as const,
            displacement: [0, 0, 0.4] as Vec3,
          },
        ],
      };
    const first = await preparePhysicalStretch(s.host, s.kernel, target, options);
    s.commands.execute('model.addBox', { min: [2, 2, 2], max: [3, 3, 3] });
    expect(() => s.commands.execute('part.stretch', { prepared: first.token })).toThrow(/changed/);
    expect(() => s.commands.execute('part.stretch', { prepared: first.token })).toThrow(
      /not prepared/,
    );
    expect(() => s.commands.execute('part.stretch', { prepared: 'forged' })).toThrow(
      /not prepared/,
    );
    first.dispose();
    const next = await preparePhysicalStretch(s.host, s.kernel, target, options),
      other = await setup();
    expect(() => other.commands.execute('part.stretch', { prepared: next.token })).toThrow(
      /not prepared/,
    );
    next.dispose();
    const final = await preparePhysicalStretch(s.host, s.kernel, target, options);
    s.commands.execute('part.stretch', { prepared: final.token });
    expect(() => s.commands.execute('part.stretch', { prepared: final.token })).toThrow(
      /not prepared/,
    );
    final.dispose();
  });

  it('refuses unsupported non-solid contents before the first geometry operation', async () => {
    const s = await setup();
    s.host.doc.transact('Drawing fixture', (draft) => {
      const root = draft.definitions
        .get(draft.rootDefinitionId)!
        .entities.instances.get(s.outer as Id)!;
      SketchGraph.for(draft, root.definitionId).addEdge([2, 2, 2], [3, 2, 2]);
    });
    const drawing = stable(s),
      run = vi.spyOn(s.kernel, 'autofold');
    await expect(s.run([s.stretch()])).rejects.toThrow(/native solid parts/);
    expect(stable(s)).toEqual(drawing);
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses an out-and-back context change during asynchronous preparation', async () => {
    const s = await setup(),
      original = stable(s),
      run = s.kernel.autofold.bind(s.kernel);
    vi.spyOn(s.kernel, 'autofold').mockImplementationOnce(async (params) => {
      const result = await run(params);
      s.host.setContext([s.outer as Id]);
      s.host.setContext([]);
      return result;
    });
    await expect(s.run([s.stretch()])).rejects.toThrow(/context changed/);
    expect(stable(s)).toEqual(original);
  });

  it('checks cancellation on consumption and enforces the preparation deadline', async () => {
    const s = await setup(),
      original = stable(s),
      target: EntityRef = { kind: 'instance', id: s.outer as Id, path: [] };
    const options = {
      planes: [
        {
          normal: [0, 0, 1] as Vec3,
          offset: 0.3,
          side: 'positive' as const,
          displacement: [0, 0, 0.4] as Vec3,
        },
      ],
    };
    await expect(
      preparePhysicalStretch(s.host, s.kernel, target, { ...options, deadline: Date.now() - 1 }),
    ).rejects.toThrow(/time budget/);
    const abort = new AbortController(),
      prepared = await preparePhysicalStretch(s.host, s.kernel, target, {
        ...options,
        signal: abort.signal,
      });
    abort.abort();
    expect(() => s.commands.execute('part.stretch', { prepared: prepared.token })).toThrow();
    prepared.dispose();
    expect(stable(s)).toEqual(original);
  });

  it('cancels during preparation without any isolation or retained geometry', async () => {
    const s = await setup(),
      original = stable(s),
      undo = s.host.undoStack.length,
      abort = new AbortController(),
      run = s.kernel.autofold.bind(s.kernel);
    vi.spyOn(s.kernel, 'autofold').mockImplementation(async (params) => {
      const result = await run(params);
      abort.abort();
      return result;
    });
    await expect(s.run([s.stretch()], abort.signal)).rejects.toThrow();
    expect(stable(s)).toEqual(original);
    expect(s.host.undoStack.length).toBe(undo);
  });

  it('remaps imprint curve IDs as well as solid rims during native isolation', async () => {
    const s = await setup();
    let original: CurveId;
    s.host.doc.transact('Imprint curve fixture', (draft) => {
      const b = containerAt(
        draft as unknown as DocumentState,
        [s.outer, s.inner] as Id[],
      ).bodies.get(s.body as Id)!;
      const cap = [...b.faces.values()].find((f) => f.plane.n[2] > 0.9)!,
        center = [...b.curves.values()].find((c) => c.center[2] > 0.3)!.center;
      const graph = createImprintGraph(),
        curve = {
          kind: 'circle' as const,
          center,
          normal: [0, 0, 1] as Vec3,
          radius: 0.01,
          startAngle: 0,
          endAngle: 2 * Math.PI,
          segments: 8,
        },
        id = (original = allocId<CurveId>(draft));
      curvePoints(curve).forEach((p, i) => {
        const q = basisToLocal(cap.basis, p);
        graph.vertices.set(i, [q[0], q[1]]);
        graph.edges.set(i, {
          id: i,
          a: i,
          b: (i + 1) % 8,
          soft: false,
          smooth: false,
          hidden: false,
          curveId: id,
        });
      });
      graph.nativeUnknownFields = [new Uint8Array([255, 0, 128])];
      graph.nextId = 8;
      b.imprints.set(cap.id, graph);
      b.curves.set(id, { ...curve, id, edgeRefs: [...graph.edges.keys()] as Id[] });
    });
    const result = await s.run([s.stretch({ kind: 'body', id: s.body, path: [s.outer, s.inner] })]);
    const ref = result.results![0]!.refs![0]!,
      b = containerAt(s.host.doc.state, ref.path as Id[]).bodies.get(ref.id as Id)!;
    const graph = [...b.imprints.values()][0]!,
      id = [...graph.edges.values()][0]!.curveId!;
    expect(id).not.toBe(original!);
    expect(b.curves.has(id)).toBe(true);
    expect(b.curves.get(id)!.radius).toBe(0.01);
    expect(graph.nativeUnknownFields).toEqual([new Uint8Array([255, 0, 128])]);
    expect([...graph.edges.values()].every((edge) => edge.curveId === id)).toBe(true);
    expect(bodyAt(s, s.other, s.inner).curves.has(original!)).toBe(true);
  });

  it('uses actual native definition aliases for ordinary and staged metadata finalization', async () => {
    const s = await setup(),
      metadata = new ModelMetadataApi(s.commands),
      manifest = extensionManifestSchema.parse({
        id: 'org.example.stretch',
        name: 'Stretch',
        publisher: 'Example',
        version: '1.0.0',
        apiVersion: '^0.1.0',
        editors: ['modeling'],
        defaultLocale: 'en',
        license: 'MIT',
        permissions: ['model.read', 'model.write'],
        files: {},
        contributions: [{ target: 'model.command', id: 'org.example.stretch.edit', name: 'Edit' }],
        metadata: {
          dataVersion: 1,
          schema: {
            type: 'object',
            properties: { label: { type: 'string' } },
            required: ['label'],
          },
        },
      });
    for (const staged of [false, true]) {
      const initial = stable(s),
        undo = s.host.undoStack.length;
      const batch = {
        expectedRevision: s.host.doc.version,
        label: 'Typed stretch alias',
        operations: [s.stretch()],
        metadata: modelMetadataBatchSchema.parse({
          expectedDataVersion: null,
          upserts: [
            {
              id: 'made',
              target: { kind: 'definition', created: 'stretched' },
              value: { label: 'Fitted module' },
            },
          ],
        }),
      };
      const result = staged
        ? await applyStagedModelWithMetadata(s.api, metadata, manifest, {
            ...batch,
            metadata: { ...batch.metadata, replaceRecord: false },
          })
        : await applyModelWithMetadata(s.api, metadata, manifest, batch);
      const root = containerAt(s.host.doc.state, []).instances.get(result.results![0]!.id as Id)!;
      expect(s.host.doc.state.pluginData!.get(manifest.id)!.entries.get('made')!.target).toEqual({
        kind: 'definition',
        id: root.definitionId,
      });
      expect(s.host.undoStack.length).toBe(undo + 1);
      s.host.undo();
      expect(stable(s)).toEqual(initial);
    }
  });
});
